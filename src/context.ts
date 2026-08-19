import { generateText } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { createProviderModel } from './agent.ts';
import type { RuntimeConfig } from './types.ts';

/** 对话上下文默认上限（估算字符数），约合 30k token */
export const DEFAULT_CONTEXT_LIMIT_CHARS = 120_000;

/** 手动设置的上限最大值：1m（1 MB = 1024² 字符） */
export const MAX_CONTEXT_LIMIT_CHARS = 1024 * 1024;

/** 把字符数格式化成 k/m 显示，如 "117k"、"1.0m"。 */
export function formatContextSize(chars: number): string {
  if (chars >= 1024 * 1024) {
    return `${(chars / (1024 * 1024)).toFixed(1)}m`;
  }
  if (chars >= 1024) {
    return `${(chars / 1024).toFixed(0)}k`;
  }
  return `${chars}`;
}

/**
 * 解析上下文大小设置，如 "256k"、"1m"、"8000"。
 * k 代表 KB（×1024），m 代表 MB（×1024²）；上限 MAX_CONTEXT_LIMIT_CHARS。
 * 非法输入返回 null。
 */
export function parseContextLimitSpec(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const num = parseFloat(match[1]!);
  const unit = match[2];
  let chars = num;
  if (unit === 'k') {
    chars *= 1024;
  } else if (unit === 'm') {
    chars *= 1024 * 1024;
  }
  return Math.min(Math.round(chars), MAX_CONTEXT_LIMIT_CHARS);
}

export type ContextStrategyDecision =
  | { action: 'expand'; newLimit: number }
  | { action: 'compact' }
  | { action: 'skip' };

/**
 * 把用户在"上下文已满"提示下的输入映射为决策（纯函数，便于测试）。
 * 默认（回车、c、非法输入）= 压缩；n = 跳过；合法的 k/m/数字 = 扩充上限。
 */
export function resolveContextStrategyInput(input: string): ContextStrategyDecision {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'c' || trimmed === 'compress') {
    return { action: 'compact' };
  }
  if (trimmed === 'n' || trimmed === 'no' || trimmed === 'skip') {
    return { action: 'skip' };
  }
  const parsed = parseContextLimitSpec(trimmed);
  if (parsed !== null) {
    return { action: 'expand', newLimit: parsed };
  }
  return { action: 'compact' };
}

/** 自动压缩时保留的最新消息条数（保留最近一轮完整对话） */
export const KEEP_LAST_MESSAGES = 8;

function messageText(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text ?? '')
      .join('');
  }
  return '';
}

/** 粗略估算整段对话占用的字符数（token ≈ 字符数 / 4）。 */
export function estimateContextChars(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += messageText(message).length;
  }
  return total;
}

/** 从字符数粗略估算 token 数（混合中英文场景约 4 字符/token）。 */
export function estimateTokensFromChars(chars: number): number {
  return Math.round(chars / 4);
}

function formatMessageForSummary(message: ModelMessage): string {
  const role = message.role;
  const text = messageText(message);
  // 工具消息通常很长（含完整输出），摘要时截断保留关键信息
  const preview = text.length > 800 ? `${text.slice(0, 800)}…` : text;
  return `[${role}] ${preview}`;
}

/** 用当前模型把一段历史对话压缩成简洁摘要。 */
export async function summarizeMessages(
  messages: ModelMessage[],
  runtime: RuntimeConfig,
): Promise<string> {
  const body = messages.map(formatMessageForSummary).join('\n');
  const { text } = await generateText({
    model: createProviderModel({ runtime }),
    system:
      '你是对话压缩助手。把给定的一段 agent 对话压缩成简洁中文摘要，' +
      '保留：用户的意图与指令、执行过的关键操作（读写文件/执行命令）、得到的关键结论、未完成的待办。' +
      '用要点式输出，300 字以内，不要遗漏重要事实，不要编造。',
    prompt: body,
  });
  return text.trim();
}

export interface CompactResult {
  messages: ModelMessage[];
  compacted: boolean;
  size: number;
  limit: number;
}

/**
 * 上下文管理：当对话历史超过 limitChars 时，把最早的消息压缩成一条摘要，
 * 保留最近 KEEP_LAST_MESSAGES 条完整消息。返回新的消息数组。
 */
export async function maybeCompactConversation(
  conversation: ModelMessage[],
  runtime: RuntimeConfig,
  limitChars = DEFAULT_CONTEXT_LIMIT_CHARS,
  force = false,
): Promise<CompactResult> {
  const size = estimateContextChars(conversation);
  if (
    !force &&
    (size <= limitChars || conversation.length <= KEEP_LAST_MESSAGES)
  ) {
    return { messages: conversation, compacted: false, size, limit: limitChars };
  }

  const splitAt = conversation.length - KEEP_LAST_MESSAGES;
  const toSummarize = conversation.slice(0, splitAt);
  const keep = conversation.slice(splitAt);

  // 没有可压缩的早期内容时，保持原样
  if (toSummarize.length === 0) {
    return { messages: conversation, compacted: false, size, limit: limitChars };
  }

  let summary = '';
  try {
    summary = await summarizeMessages(toSummarize, runtime);
  } catch {
    // 摘要失败时退化为直接截断，不阻塞对话
    return { messages: keep, compacted: true, size, limit: limitChars };
  }

  const summaryMessage: ModelMessage = {
    role: 'user',
    content: `[以下为此前对话的历史摘要，供后续参考]\n${summary}`,
  };
  return {
    messages: [summaryMessage, ...keep],
    compacted: true,
    size,
    limit: limitChars,
  };
}
