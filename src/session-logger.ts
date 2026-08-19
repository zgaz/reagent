import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionEventType, SessionLogger, SessionRunStatus } from './types.ts';

export interface CreateSessionLoggerOptions {
  cwd: string;
  argv: string[];
  agent_name: string;
  provider: string;
  model: string;
  homeDir?: string;
  sessionId?: string;
  /** 日志根目录；不设则默认 ~/.cook/sessions */
  sessionRootDir?: string;
  now?: () => Date;
  onWarning?: (message: string) => void;
}

interface SessionSummary {
  session_id: string;
  session_dir: string;
  status: 'running' | SessionRunStatus;
  started_at: string;
  ended_at?: string;
  updated_at: string;
  event_count: number;
  logging_enabled: boolean;
  disabled_reason?: string;
  error?: string;
  exit_code?: number;
  cwd: string;
  argv: string[];
  agent_name: string;
  provider: string;
  model: string;
}

/** 哈希链的起点：第一条事件的 prev_hash。 */
export const GENESIS_HASH = 'genesis';

/**
 * 计算单条事件哈希。用 sha256(prev_hash + 事件正文) 把每条事件串成链，
 * 任何一条被改动都会导致后续全部校验失败，用于取证防篡改。
 */
export function computeEventHash(
  prevHash: string,
  base: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(`${prevHash}${JSON.stringify(base)}`)
    .digest('hex');
}

export interface SessionLogVerification {
  valid: boolean;
  eventCount: number;
  /** 第一个校验失败的事件序号（0 起）；全部通过则为 undefined */
  firstBadIndex?: number;
  lastHash: string;
}

/** 逐条重算哈希链，验证 events.jsonl 是否被篡改。 */
export async function verifySessionLog(
  sessionDir: string,
): Promise<SessionLogVerification> {
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  const file = Bun.file(eventsPath);
  if (!(await file.exists())) {
    return { valid: false, eventCount: 0, lastHash: GENESIS_HASH };
  }

  const text = await file.text();
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  let lastHash = GENESIS_HASH;

  for (let index = 0; index < lines.length; index += 1) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(lines[index]!) as Record<string, unknown>;
    } catch {
      return { valid: false, eventCount: lines.length, firstBadIndex: index, lastHash };
    }

    const prevHash = event.prev_hash;
    const hash = event.hash;
    if (typeof prevHash !== 'string' || typeof hash !== 'string') {
      return { valid: false, eventCount: lines.length, firstBadIndex: index, lastHash };
    }
    if (prevHash !== lastHash) {
      return { valid: false, eventCount: lines.length, firstBadIndex: index, lastHash };
    }

    const { prev_hash: _prevHash, hash: _hash, ...base } = event;
    if (computeEventHash(prevHash, base) !== hash) {
      return { valid: false, eventCount: lines.length, firstBadIndex: index, lastHash };
    }

    lastHash = hash;
  }

  return { valid: true, eventCount: lines.length, lastHash };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toSerializableError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

class DisabledSessionLogger implements SessionLogger {
  readonly enabled = false;
  readonly session_id: string;
  readonly session_dir = undefined;

  constructor(sessionId: string) {
    this.session_id = sessionId;
  }

  logEvent(_type: SessionEventType, _payload?: Record<string, unknown>): void {
    // no-op
  }

  async finish(_status: SessionRunStatus, _payload?: Record<string, unknown>): Promise<void> {
    // no-op
  }
}

class FileSessionLogger implements SessionLogger {
  readonly session_id: string;
  readonly session_dir: string;
  enabled = true;

  private readonly eventsPath: string;
  private readonly summaryPath: string;
  private readonly now: () => Date;
  private readonly onWarning: (message: string) => void;
  private readonly summary: SessionSummary;

  private queue: Promise<void> = Promise.resolve();
  private seq = 0;
  private finished = false;
  private lastHash = GENESIS_HASH;

  constructor(options: {
    sessionId: string;
    sessionDir: string;
    summary: SessionSummary;
    now?: () => Date;
    onWarning?: (message: string) => void;
  }) {
    this.session_id = options.sessionId;
    this.session_dir = options.sessionDir;
    this.eventsPath = path.join(options.sessionDir, 'events.jsonl');
    this.summaryPath = path.join(options.sessionDir, 'session.json');
    this.now = options.now ?? (() => new Date());
    this.onWarning = options.onWarning ?? (() => {});
    this.summary = options.summary;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private disable(reason: string): void {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.summary.logging_enabled = false;
    this.summary.disabled_reason = reason;
    this.summary.updated_at = this.timestamp();
    this.onWarning(`[session-logs] ${reason}`);
  }

  private enqueue(writeOperation: () => Promise<void>): void {
    this.queue = this.queue.then(writeOperation).catch(error => {
      this.disable(`Failed to write session logs: ${errorMessage(error)}`);
    });
  }

  private appendEvent(type: SessionEventType, payload?: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }

    const base = {
      seq: this.seq + 1,
      timestamp: this.timestamp(),
      session_id: this.session_id,
      type,
      ...(payload ?? {}),
    };

    const prevHash = this.lastHash;
    const hash = computeEventHash(prevHash, base);
    const event = {
      ...base,
      prev_hash: prevHash,
      hash,
    };

    this.seq += 1;
    this.lastHash = hash;
    this.summary.event_count = this.seq;
    this.summary.updated_at = event.timestamp;

    this.enqueue(async () => {
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    });
  }

  logEvent(type: SessionEventType, payload?: Record<string, unknown>): void {
    if (this.finished || !this.enabled) {
      return;
    }

    this.appendEvent(type, payload);
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async finish(status: SessionRunStatus, payload?: Record<string, unknown>): Promise<void> {
    if (this.finished) {
      return;
    }

    if (this.enabled) {
      this.appendEvent('session.finish', {
        status,
        ...(payload ?? {}),
      });
    }

    this.finished = true;
    await this.flush();

    const endedAt = this.timestamp();
    this.summary.status = status;
    this.summary.ended_at = endedAt;
    this.summary.updated_at = endedAt;

    const exitCode = payload?.exit_code;
    if (typeof exitCode === 'number') {
      this.summary.exit_code = exitCode;
    }

    const error = payload?.error;
    if (typeof error === 'string' && error.trim()) {
      this.summary.error = error;
    }

    try {
      await Bun.write(this.summaryPath, `${JSON.stringify(this.summary, null, 2)}\n`);
      await chmod(this.summaryPath, 0o600);
    } catch (errorWrite) {
      this.onWarning(
        `[session-logs] Failed to write session metadata: ${errorMessage(errorWrite)}`,
      );
    }
  }
}

export async function createSessionLogger(
  options: CreateSessionLoggerOptions,
): Promise<SessionLogger> {
  const sessionId = options.sessionId ?? randomUUID();
  // 默认生成在 cook 当前工作目录下：<cwd>/.cook/sessions/<id>；
  // 也可通过 session_logs_dir 配置指定其他根目录。
  const sessionDir = options.sessionRootDir
    ? path.join(options.sessionRootDir, sessionId)
    : path.join(options.cwd, '.cook', 'sessions', sessionId);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const onWarning = options.onWarning ?? (() => {});

  const summary: SessionSummary = {
    session_id: sessionId,
    session_dir: sessionDir,
    status: 'running',
    started_at: startedAt,
    updated_at: startedAt,
    event_count: 0,
    logging_enabled: true,
    cwd: options.cwd,
    argv: [...options.argv],
    agent_name: options.agent_name,
    provider: options.provider,
    model: options.model,
  };

  try {
    await mkdir(sessionDir, { recursive: true });
    await chmod(sessionDir, 0o700);
    const summaryPath = path.join(sessionDir, 'session.json');
    await Bun.write(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    await chmod(summaryPath, 0o600);
  } catch (error) {
    onWarning(
      `[session-logs] Failed to initialize session logger: ${errorMessage(error)}. Continuing without session logs.`,
    );
    return new DisabledSessionLogger(sessionId);
  }

  const logger = new FileSessionLogger({
    sessionId,
    sessionDir,
    summary,
    now,
    onWarning,
  });

  logger.logEvent('session.start', {
    cwd: options.cwd,
    argv: [...options.argv],
    agent_name: options.agent_name,
    provider: options.provider,
    model: options.model,
  });

  await logger.flush();

  return logger;
}

export function serializeSessionError(error: unknown): unknown {
  return toSerializableError(error);
}
