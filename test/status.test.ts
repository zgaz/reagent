import { describe, expect, it } from 'bun:test';
import { classifyApiError } from '../src/status.ts';

describe('classifyApiError', () => {
  it('classifies network errors', () => {
    const info = classifyApiError(new Error('fetch failed: ECONNREFUSED 127.0.0.1'));
    expect(info.displayName).toBe('网络错误');
    expect(info.hint).toBeTruthy();
  });

  it('classifies auth failures by status code and message', () => {
    const byStatus = classifyApiError(Object.assign(new Error('unauthorized'), { statusCode: 401 }));
    expect(byStatus.displayName).toBe('认证失败');

    const byMessage = classifyApiError(new Error('invalid api key provided'));
    expect(byMessage.displayName).toBe('认证失败');
  });

  it('classifies rate limiting', () => {
    const info = classifyApiError(Object.assign(new Error('rate limit'), { statusCode: 429 }));
    expect(info.displayName).toBe('限流');
  });

  it('classifies context length and suggests compaction', () => {
    const info = classifyApiError(new Error('This model maximum context length is 128000 tokens'));
    expect(info.displayName).toBe('上下文超长');
    expect(info.hint).toContain('/compact');
  });

  it('classifies unknown models', () => {
    const info = classifyApiError(new Error('model not found: mimo-v2.5'));
    expect(info.displayName).toBe('模型不存在');
    expect(info.hint).toContain('model');
  });

  it('classifies server errors by 5xx status', () => {
    const info = classifyApiError(Object.assign(new Error('boom'), { statusCode: 503 }));
    expect(info.displayName).toBe('服务端错误');
  });

  it('falls back to generic API error', () => {
    const info = classifyApiError(new Error('some weird failure'));
    expect(info.displayName).toBe('API 错误');
    expect(info.hint).toBe('');
  });
});
