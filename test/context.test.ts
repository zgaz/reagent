import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import {
  DEFAULT_CONTEXT_LIMIT_CHARS,
  estimateContextChars,
  estimateTokensFromChars,
  formatContextSize,
  MAX_CONTEXT_LIMIT_CHARS,
  maybeCompactConversation,
  parseContextLimitSpec,
  resolveContextStrategyInput,
} from '../src/context.ts';
import type { RuntimeConfig } from '../src/types.ts';

function textMessage(role: ModelMessage['role'], content: string): ModelMessage {
  return { role, content } as ModelMessage;
}

// 未超阈值/消息过少时不会调用摘要（不触碰模型），传空 runtime 即可
const fakeRuntime = {} as RuntimeConfig;

describe('estimateContextChars', () => {
  it('sums up the text content of all messages', () => {
    const messages = [
      textMessage('user', 'hello'),
      textMessage('assistant', 'hi there'),
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'part' }] },
    ];
    // 5 + 8 + 4 = 17（assistant 的 content 数组只算 text part）
    expect(estimateContextChars(messages)).toBe(17);
  });

  it('ignores non-text parts in structured content', () => {
    const messages = [
      {
        role: 'tool' as const,
        content: [
          { type: 'tool-approval-response' as const, approvalId: 'a', approved: true },
        ],
      },
      textMessage('user', 'x'),
    ];
    expect(estimateContextChars(messages)).toBe(1);
  });
});

describe('maybeCompactConversation', () => {
  it('does nothing when under the limit', async () => {
    const messages = [textMessage('user', 'short')];
    const result = await maybeCompactConversation(messages, fakeRuntime, 1_000_000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.size).toBe(5);
    expect(result.limit).toBe(1_000_000);
  });

  it('does nothing when there are few messages even if force', async () => {
    // force=true 但消息数 <= 保留上限时，没有可压缩的早期内容
    const messages = [
      textMessage('user', 'a'),
      textMessage('assistant', 'b'),
      textMessage('user', 'c'),
    ];
    const result = await maybeCompactConversation(messages, fakeRuntime, 10, true);
    expect(result.compacted).toBe(false);
    expect(result.messages.length).toBe(messages.length);
  });

  it('exposes the default limit constant', () => {
    expect(DEFAULT_CONTEXT_LIMIT_CHARS).toBeGreaterThan(0);
  });
});

describe('estimateTokensFromChars', () => {
  it('estimates roughly one token per 4 chars', () => {
    expect(estimateTokensFromChars(1000)).toBe(250);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(0)).toBe(0);
  });
});

describe('parseContextLimitSpec', () => {
  it('parses k as KB (×1024)', () => {
    expect(parseContextLimitSpec('256k')).toBe(256 * 1024);
    expect(parseContextLimitSpec('1k')).toBe(1024);
  });

  it('parses m as MB (×1024²)', () => {
    expect(parseContextLimitSpec('1m')).toBe(1024 * 1024);
    expect(parseContextLimitSpec('0.5m')).toBe(0.5 * 1024 * 1024);
  });

  it('treats a plain number as characters', () => {
    expect(parseContextLimitSpec('8000')).toBe(8000);
  });

  it('clamps to the maximum of 1m', () => {
    expect(parseContextLimitSpec('10m')).toBe(MAX_CONTEXT_LIMIT_CHARS);
    expect(parseContextLimitSpec('9999m')).toBe(MAX_CONTEXT_LIMIT_CHARS);
  });

  it('rejects invalid input', () => {
    expect(parseContextLimitSpec('abc')).toBeNull();
    expect(parseContextLimitSpec('1x')).toBeNull();
    expect(parseContextLimitSpec('')).toBeNull();
    expect(parseContextLimitSpec('256 k')).toBeNull();
  });
});

describe('formatContextSize', () => {
  it('formats k and m suffixes', () => {
    expect(formatContextSize(120_000)).toBe('117k');
    expect(formatContextSize(1024 * 1024)).toBe('1.0m');
    expect(formatContextSize(500)).toBe('500');
  });
});

describe('resolveContextStrategyInput', () => {
  it('defaults to compact on empty or c/compress', () => {
    expect(resolveContextStrategyInput('')).toEqual({ action: 'compact' });
    expect(resolveContextStrategyInput('  ')).toEqual({ action: 'compact' });
    expect(resolveContextStrategyInput('c')).toEqual({ action: 'compact' });
    expect(resolveContextStrategyInput('compress')).toEqual({ action: 'compact' });
  });

  it('skips on n/no/skip', () => {
    expect(resolveContextStrategyInput('n')).toEqual({ action: 'skip' });
    expect(resolveContextStrategyInput('no')).toEqual({ action: 'skip' });
    expect(resolveContextStrategyInput('skip')).toEqual({ action: 'skip' });
  });

  it('expands on a valid size input', () => {
    expect(resolveContextStrategyInput('256k')).toEqual({
      action: 'expand',
      newLimit: 256 * 1024,
    });
    expect(resolveContextStrategyInput('1m')).toEqual({
      action: 'expand',
      newLimit: MAX_CONTEXT_LIMIT_CHARS,
    });
    expect(resolveContextStrategyInput('8000')).toEqual({
      action: 'expand',
      newLimit: 8000,
    });
  });

  it('falls back to compact on invalid input', () => {
    expect(resolveContextStrategyInput('abc')).toEqual({ action: 'compact' });
    expect(resolveContextStrategyInput('1x')).toEqual({ action: 'compact' });
  });
});
