import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import path from 'node:path';
import { createColors } from 'picocolors';
import { ChatInput } from './chat-ui.ts';
import { runApprovalFlow } from './approval-flow.ts';
import { runAgent, buildBaseInstructions } from './agent.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import {
  DEFAULT_CONTEXT_LIMIT_CHARS,
  estimateContextChars,
  estimateTokensFromChars,
  formatContextSize,
  KEEP_LAST_MESSAGES,
  maybeCompactConversation,
  parseContextLimitSpec,
  resolveContextStrategyInput,
  type ContextStrategyDecision,
} from './context.ts';
import { applyConfiguredApiKeys } from './auth.ts';
import { createRuntimeConfig } from './cli.ts';
import { parseChatCli, type CliFlags } from './cli-parse.ts';
import { loadConfig } from './config.ts';
import {
  canPromptForConfirmation,
  confirmPendingMutationWithRl,
  parseConfirmationInput,
  summarizePendingApproval,
} from './confirm.ts';
import { EXIT_CODES } from './defaults.ts';
import { hasOpenAICodexCredentials } from './openai-oauth.ts';
import {
  createDebugLogger,
  createToolCommandLogger,
  printAgentLoaded,
  printStderr,
  printStdout,
} from './output.ts';
import { resolveConfigRoot } from './paths.ts';
import { logConfirmationDecision } from './session-log-events.ts';
import { createSessionLogger, serializeSessionError } from './session-logger.ts';
import { StatusSpinner, classifyApiError } from './status.ts';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type {
  CookConfig,
  RuntimeConfig,
  SessionLogger,
  StdinContext,
} from './types.ts';

type Colors = ReturnType<typeof createColors>;

// 交互模式下 stdin 是 TTY，不存在管道输入。
const EMPTY_STDIN: StdinContext = {
  mode: 'none',
  bytes: 0,
  isText: true,
  preview: '',
};

// 交互式长任务（如应急响应调查 + 报告）通常需要远多于默认 12 步，
// 用户未显式指定时，把上限提到这个值，避免工具循环被 stepCountIs 掐断。
const CHAT_DEFAULT_MAX_STEPS = 30;

/** 取消息数组中最后一条 assistant 文本（可能为 undefined）。 */
function lastAssistantText(messages: ModelMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') {
      continue;
    }
    const content = message.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const parts = content as Array<{ type?: string; text?: string }>;
      const text = parts
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('');
      if (text.trim()) {
        return text;
      }
    }
  }
  return undefined;
}

function toConfigOverrides(flags: CliFlags): Partial<CookConfig> {
  return {
    max_steps: flags.maxSteps,
    bash_timeout_ms: flags.timeout,
    allow_outside_cwd: flags.allowOutsideCwd ? true : undefined,
    quiet: flags.quiet ? true : undefined,
    debug: flags.debug || flags.verbose ? true : undefined,
    session_logs: flags.sessionLogs ? true : undefined,
  };
}

/** 生成百分比进度条（20 格），用于 /context 显示占用。 */
function progressBar(pct: number, width = 20): string {
  const clamped = Math.min(Math.max(pct, 0), 100);
  const filled = Math.round((clamped / 100) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function printChatHelp(): void {
  printStderr('[cook] 交互式对话（随时输入指令，cook 会调用工具执行）');
  printStderr('[cook]   /exit 或 /quit — 退出对话');
  printStderr('[cook]   /clear — 清空当前对话上下文');
  printStderr('[cook]   /remember 内容 — 手动把一段背景注入上下文');
  printStderr('[cook]   /remember @文件路径 — 从文件注入上下文');
  printStderr('[cook]   /context — 查看占用；/context 256k 或 /context 1m 设置上限（最大 1m）');
  printStderr('[cook]   /compact — 手动把早期历史压缩为摘要');
  printStderr('[cook]   Ctrl+C — 打断正在执行的 agent 或清空当前输入');
  printStderr('[cook]   /help — 显示本帮助');
  printStderr('[cook]   写文件/破坏性命令会先请求确认（y 批准 / n 拒绝 / a 全部批准 / 文字=纠正）');
}

/**
 * 上下文已满时询问用户：扩充上限 / 压缩 / 跳过。非 TTY 时按默认压缩。
 */
async function askContextStrategy(
  chatInput: ChatInput | null,
  c: Colors,
  size: number,
  limit: number,
): Promise<ContextStrategyDecision> {
  if (!chatInput) {
    return { action: 'compact' };
  }

  printStderr(
    `[上下文] 已满：占用 ${formatContextSize(size)} / 上限 ${formatContextSize(limit)}`,
  );
  printStderr(`  · 输入新上限（如 1m / 256k / 8000）→ 扩充上下文`);
  printStderr(`  · 回车 或 输入 c → 压缩历史为摘要（默认）`);
  printStderr(`  · 输入 n → 跳过，本次不处理`);

  const result = await chatInput.ask(`${c.dim('[回车=压缩]')} `, false);
  if (result.kind === 'submit') {
    return resolveContextStrategyInput(result.text);
  }
  return { action: 'compact' };
}

/**
 * 对话达到上下文上限时的处理：先询问用户策略，再执行。
 * 非 TTY 保持默认自动压缩。
 */
async function handleContextPressure(
  conversation: ModelMessage[],
  runtime: RuntimeConfig,
  limit: number,
  setLimit: (value: number) => void,
  chatInput: ChatInput | null,
  c: Colors,
): Promise<void> {
  const size = estimateContextChars(conversation);
  if (size <= limit || conversation.length <= KEEP_LAST_MESSAGES) {
    return;
  }

  const decision = await askContextStrategy(chatInput, c, size, limit);

  if (decision.action === 'expand') {
    setLimit(decision.newLimit);
    printStderr(
      `[上下文] 上限已扩至 ${formatContextSize(decision.newLimit)}，继续当前对话`,
    );
    return;
  }
  if (decision.action === 'skip') {
    return;
  }

  // 压缩（默认）
  const result = await maybeCompactConversation(conversation, runtime, limit, true);
  conversation.length = 0;
  conversation.push(...result.messages);
  printStderr(
    `[上下文] 已压缩为 ${result.messages.length} 条消息（含历史摘要）`,
  );
}

export async function runChatCommand(processArgv: string[]): Promise<number> {
  const flags = parseChatCli(processArgv);
  const configRoot = await resolveConfigRoot(process.cwd());
  const { config, global_system_path, local_system_path } = await loadConfig(
    { cwd: configRoot },
    toConfigOverrides(flags),
  );
  const openaiOAuth = await hasOpenAICodexCredentials();
  const runtime = createRuntimeConfig(config, flags, { openaiOAuth }, configRoot);
  if (flags.maxSteps === undefined) {
    runtime.max_steps = Math.max(runtime.max_steps, CHAT_DEFAULT_MAX_STEPS);
  }
  const logDebug = createDebugLogger(runtime.debug);
  logDebug(
    `agent=${runtime.agent_name} provider=${runtime.agent.provider} model=${runtime.agent.model} max_steps=${runtime.max_steps} cwd=${runtime.cwd}`,
  );
  const logToolCommand = createToolCommandLogger(!runtime.quiet);
  applyConfiguredApiKeys(runtime, logDebug);

  let sessionLogger: SessionLogger | undefined;
  if (runtime.session_logs) {
    const sessionRootDir = runtime.session_logs_dir
      ? path.resolve(runtime.cwd, runtime.session_logs_dir)
      : undefined;
    sessionLogger = await createSessionLogger({
      cwd: runtime.cwd,
      argv: processArgv.slice(2),
      agent_name: runtime.agent_name,
      provider: runtime.agent.provider,
      model: runtime.agent.model,
      sessionRootDir,
      onWarning: message => {
        printStderr(message);
        logDebug(message);
      },
    });
  }

  if (!runtime.quiet) {
    printAgentLoaded(runtime.agent_name);
  }

  const c = createColors(Boolean(stderr.isTTY));
  printStderr(c.dim('交互式对话已启动（/help 查看命令，Ctrl+C 中断输入，Ctrl+D 退出）'));

  // 对话上下文上限：超过后自动把早期历史压缩为摘要；可用 /context 命令临时调整
  let contextLimit = runtime.context_limit_chars ?? DEFAULT_CONTEXT_LIMIT_CHARS;

  // 跨轮次延续的对话历史，让 cook 记住之前的对话与操作。
  const conversation: ModelMessage[] = [];
  // 用户输入的指令历史（供上下箭头浏览 / Ctrl+R 搜索）
  const commandHistory: string[] = [];

  // TTY：用 Claude Code 风格的多行输入框（ChatInput），主输入与确认共用。
  // 非 TTY（管道）：用单一 readline 一次性迭代所有行。
  const isTty = Boolean(stdin.isTTY);
  let chatInput: ChatInput | null = null;
  let rl: Interface | null = null;
  let pipeIterator: AsyncIterator<string> | null = null;

  if (isTty) {
    chatInput = new ChatInput();
    chatInput.setPlaceholder('输入指令，/help 查看命令');
    chatInput.setCommandHints({
      '/exit': '退出对话',
      '/quit': '退出对话',
      '/clear': '清空对话上下文',
      '/remember': '<内容 或 @文件>',
      '/context': '[256k | 1m] 查看/设置上限',
      '/compact': '把早期历史压缩为摘要',
      '/help': '显示帮助',
    });
    chatInput.setHistory(commandHistory);
    chatInput.start();
  } else {
    rl = createInterface({ input: stdin, output: stderr });
    pipeIterator = rl[Symbol.asyncIterator]();
  }

  type NextInput =
    | { kind: 'line'; text: string }
    | { kind: 'cancel' }
    | { kind: 'eof' };

  const readNextInput = async (prompt: string): Promise<NextInput> => {
    if (chatInput) {
      const result = await chatInput.ask(prompt, true);
      if (result.kind === 'submit') {
        return { kind: 'line', text: result.text };
      }
      return { kind: result.kind }; // 'cancel' | 'eof'
    }

    if (!pipeIterator) {
      return { kind: 'eof' };
    }
    const { value, done } = await pipeIterator.next();
    if (done) {
      return { kind: 'eof' };
    }
    return { kind: 'line', text: value as string };
  };

  // 处理 Ctrl+C（SIGINT）：agent 执行时打断当前工作；输入时取消当前输入。
  // 同时拦截默认的"终止进程"行为，避免按 Ctrl+C 直接退出。
  let activeController: AbortController | null = null;
  const onSigint = (): void => {
    if (activeController) {
      activeController.abort();
    } else if (chatInput?.isAsking()) {
      chatInput.cancelActive();
    }
  };
  process.on('SIGINT', onSigint);

  try {
    while (true) {
      const prompt = `${c.dim('cook')}${c.cyan('❯')} `;
      const answer = await readNextInput(prompt);
      if (answer.kind === 'eof') {
        break;
      }
      if (answer.kind === 'cancel') {
        // Ctrl+C：清空当前输入，继续
        continue;
      }

      const instruction = answer.text.trim();
      if (!instruction) {
        continue;
      }
      // TTY 下提交后输入框被清除，这里把用户指令回显出来，避免"下达的指令消失"
      if (chatInput) {
        printStderr(`${c.dim('cook')}${c.cyan('❯')} ${instruction}`);
      }
      // 记录命令历史（上下箭头 / Ctrl+R 用），最多保留 100 条
      commandHistory.push(instruction);
      if (commandHistory.length > 100) {
        commandHistory.shift();
      }
      if (instruction === '/exit' || instruction === '/quit') {
        break;
      }
      if (instruction === '/clear') {
        conversation.length = 0;
        printStderr('[cook] 对话上下文已清空');
        continue;
      }
      if (instruction === '/help') {
        printChatHelp();
        continue;
      }
      if (instruction.startsWith('/context')) {
        const arg = instruction.slice('/context'.length).trim();
        if (arg) {
          // /context 256k / /context 1m：手动设置本会话上下文上限
          const parsed = parseContextLimitSpec(arg);
          if (parsed === null) {
            printStderr(
              '[上下文] 用法: /context 查看占用；/context 256k 或 /context 1m 设置上限（最大 1m）',
            );
            continue;
          }
          contextLimit = parsed;
          printStderr(
            `[上下文] 上限已设为 ${formatContextSize(contextLimit)}（${contextLimit.toLocaleString()} 字符）`,
          );
          continue;
        }
        const size = estimateContextChars(conversation);
        const messagesTokens = estimateTokensFromChars(size);
        const pct = Math.round((size / contextLimit) * 100);

        // 系统提示词 token：构建一次（读 SYSTEM.md / CLAUDE.md / cook.md 等）
        let systemTokens = 0;
        try {
          const systemRaw = await buildSystemPrompt({
            cwd: runtime.cwd,
            config_cwd: runtime.config_cwd,
            global_system_path,
            local_system_path,
            prompt_files: runtime.agent.prompt_files,
            ignore_agents_md: runtime.agent.ignore_agents_md,
          });
          const base = buildBaseInstructions(runtime.agent.raw_bash_output);
          systemTokens = estimateTokensFromChars(systemRaw.length + base.length);
        } catch {
          systemTokens = 0;
        }

        // 工具定义：Read/Write/Edit/Bash 的 description + schema 粗略估算
        const toolTokens = estimateTokensFromChars(2200);
        const totalTokens = systemTokens + toolTokens + messagesTokens;

        printStderr(
          `${c.bold('[上下文]')} ${runtime.agent.provider}/${runtime.agent.model}`,
        );
        printStderr(
          `  占用: ${formatContextSize(size)} / ${formatContextSize(contextLimit)}（~${(totalTokens / 1000).toFixed(0)}k tokens，${pct}%）`,
        );
        printStderr(`  ${progressBar(pct)} ${c.dim(`${pct}%`)}`);
        printStderr('  分类:');
        printStderr(`    ├ 系统提示词: ~${systemTokens} tokens`);
        printStderr(`    ├ 工具定义:   ~${toolTokens} tokens`);
        printStderr(
          `    ├ 对话历史:   ~${messagesTokens.toLocaleString()} tokens（${conversation.length} 条消息）`,
        );
        printStderr(`    └ 剩余空间:   ${(100 - pct).toFixed(1)}%`);
        continue;
      }
      if (instruction === '/compact') {
        const result = await maybeCompactConversation(
          conversation,
          runtime,
          contextLimit,
          true,
        );
        conversation.length = 0;
        conversation.push(...result.messages);
        printStderr(
          `[上下文] 已压缩为 ${result.messages.length} 条消息（含历史摘要）`,
        );
        continue;
      }
      if (instruction.startsWith('/remember')) {
        const payload = instruction.slice('/remember'.length).trim();
        if (!payload) {
          printStderr('[上下文] 用法: /remember 要记住的内容，或 /remember @文件路径');
          continue;
        }
        let content = payload;
        if (payload.startsWith('@')) {
          const filePath = path.resolve(runtime.cwd, payload.slice(1).trim());
          try {
            content = await Bun.file(filePath).text();
          } catch {
            printStderr(`[上下文] 无法读取文件: ${filePath}`);
            continue;
          }
        }
        conversation.push({
          role: 'user',
          content: `[手动注入的上下文，后续对话请参考]\n${content}`,
        });
        printStderr(
          `[上下文] 已注入 ${content.length} 字符，cook 后续对话会参考这段背景`,
        );
        await handleContextPressure(
          conversation,
          runtime,
          contextLimit,
          value => {
            contextLimit = value;
          },
          chatInput,
          c,
        );
        continue;
      }

      sessionLogger?.logEvent('user.message', { instruction });

      // 本轮可被 Ctrl+C 打断：agent 执行期间（无输入挂起时）按 Ctrl+C 触发 abort
      const controller = new AbortController();
      activeController = controller;
      chatInput?.setInterruptHandler(() => controller.abort());

      // 运行状态提示：思考 spinner（慢节奏 + 整秒计时）+ 工具计数
      const spinner = new StatusSpinner();
      let toolCount = 0;
      spinner.start();

      try {
        const flow = await runApprovalFlow({
          initialMessages: conversation.length > 0 ? conversation : undefined,
          runAgent: ({ messages }) =>
            runAgent({
              instruction,
              runtime,
              stdin: EMPTY_STDIN,
              global_system_path,
              local_system_path,
              logDebug,
              logToolCommand,
              sessionLogger,
              messages,
              abortSignal: controller.signal,
              toolActivity: !runtime.quiet,
              onPhase: phase => {
                if (phase === 'tool') {
                  toolCount += 1;
                  spinner.pause();
                } else {
                  spinner.resume('thinking');
                }
              },
            }),
          confirmApproval: async (approval, index, total) => {
            if (chatInput) {
              // TTY：在输入框上方打印确认摘要，用同一个输入框读确认
              const summary = summarizePendingApproval(approval);
              printStderr(
                `[cook] Mutating action${total > 1 ? ` ${index}/${total}` : ''}: [${approval.toolName.toLowerCase()}] ${summary}`,
              );
              const result = await chatInput.ask(
                `${c.dim('[y/N/a]')} or tell cook what to do: `,
                false,
              );
              if (result.kind === 'submit') {
                return parseConfirmationInput(result.text);
              }
              return { kind: 'decline' };
            }
            if (rl) {
              try {
                return await confirmPendingMutationWithRl(
                  rl,
                  approval,
                  index,
                  total,
                );
              } catch {
                // 非 TTY 下确认异常按拒绝处理
              }
            }
            return { kind: 'decline' };
          },
          printStdout,
          printStderr,
          canPromptForConfirmation,
          onConfirmationDecision: (approval, decision) => {
            logConfirmationDecision(sessionLogger, approval, decision);
          },
        });
        conversation.push(...flow.responseMessages);
        await handleContextPressure(
          conversation,
          runtime,
          contextLimit,
          value => {
            contextLimit = value;
          },
          chatInput,
          c,
        );
        spinner.stop();
        printStderr(
          c.dim(`[cook] Done · ${toolCount} tool${toolCount === 1 ? '' : 's'}`),
        );
        if (
          flow.exitCode === EXIT_CODES.SUCCESS &&
          !lastAssistantText(flow.responseMessages)
        ) {
          printStderr(
            c.dim(
              `（本轮未产生文本回答，可能因达到 max_steps=${runtime.max_steps} 上限被截断；可用 --max-steps N 提高）`,
            ),
          );
        }
      } catch (error) {
        spinner.stop();
        if (controller.signal.aborted) {
          printStderr(c.dim('[cook] 已中断，停止当前操作'));
        } else {
          const info = classifyApiError(error);
          printStderr(`${c.red(`[cook] ${info.displayName}`)}: ${info.message}`);
          if (info.hint) {
            printStderr(c.dim(`[cook] 建议: ${info.hint}`));
          }
          if (runtime.debug && error instanceof Error && error.stack) {
            printStderr(error.stack);
          }
          sessionLogger?.logEvent('session.error', {
            error: serializeSessionError(error),
          });
        }
      } finally {
        activeController = null;
        chatInput?.setInterruptHandler(null);
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (chatInput) {
      chatInput.stop();
    } else {
      try {
        rl?.close();
      } catch {
        // 忽略关闭异常
      }
    }
    await sessionLogger?.finish('success', { exit_code: EXIT_CODES.SUCCESS });
  }

  return EXIT_CODES.SUCCESS;
}
