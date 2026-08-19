import { describe, expect, it } from 'bun:test';
import { runApprovalFlow } from '../src/approval-flow.ts';
import { EXIT_CODES } from '../src/defaults.ts';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { AgentRunResult } from '../src/types.ts';

type RunInput = { messages?: ModelMessage[] };

function runResult(
  partial: Partial<AgentRunResult> & Pick<AgentRunResult, 'text'>,
): AgentRunResult {
  return {
    text: partial.text,
    mutationPlan: partial.mutationPlan ?? [],
    pendingApprovals: partial.pendingApprovals ?? [],
    responseMessages: partial.responseMessages ?? [],
    ...(partial.terminal ? { terminal: partial.terminal } : {}),
  };
}

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

describe('runApprovalFlow cross-turn context', () => {
  it('passes initialMessages to the first run so history carries over', async () => {
    const initial: ModelMessage[] = [userMessage('第一轮：记住 42')];
    const runInputs: RunInput[] = [];

    const result = await runApprovalFlow({
      initialMessages: initial,
      runAgent: async options => {
        runInputs.push({ messages: options.messages });
        return runResult({ text: '好的' });
      },
      confirmApproval: async () => ({ kind: 'approve' }),
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    // 第一轮 runAgent 收到的 messages 应包含传入的初始历史
    expect(runInputs[0]?.messages).toEqual(initial);
  });

  it('returns the full conversation including initial messages and new turns', async () => {
    const initial: ModelMessage[] = [userMessage('第一轮：记住 42')];
    const secondTurn: ModelMessage[] = [userMessage('第二轮：问刚才的数字')];

    const result = await runApprovalFlow({
      initialMessages: initial,
      runAgent: async options => {
        // 首轮用传入历史；后续轮返回新的 responseMessages 模拟新一轮对话
        if (options.messages && options.messages.length === initial.length) {
          return runResult({ text: '记住了', responseMessages: secondTurn });
        }
        return runResult({ text: '42' });
      },
      confirmApproval: async () => ({ kind: 'approve' }),
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    // responseMessages 应 = 初始历史 + 第二轮新增消息
    expect(result.responseMessages).toEqual([...initial, ...secondTurn]);
  });

  it('starts with an empty conversation when no initialMessages are given', async () => {
    const runInputs: RunInput[] = [];
    await runApprovalFlow({
      runAgent: async options => {
        runInputs.push({ messages: options.messages });
        return runResult({ text: 'done' });
      },
      confirmApproval: async () => ({ kind: 'approve' }),
      printStdout: () => {},
      printStderr: () => {},
      canPromptForConfirmation: () => true,
    });

    expect(runInputs[0]?.messages).toBeUndefined();
  });
});
