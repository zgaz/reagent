import { stderr } from 'node:process';
import { createColors } from 'picocolors';

const FRAMES = ['◐', '◓', '◑', '◒'] as const;
const VERBS = ['thinking', 'still more thinking', 'working', 'calculating'] as const;
/** 动画帧间隔（ms）：放慢节奏，避免跳动太快 */
const FRAME_INTERVAL_MS = 400;
/** 每多少帧换一次动词（约 4.8s 换一次） */
const VERB_SWITCH_FRAMES = 12;

/**
 * 轻量状态 spinner：agent 思考时在 stderr 单行显示动画 + 提示词 + 整秒计时。
 * 工具调用时 pause（清除状态行），模型思考时 resume。非 TTY 自动跳过。
 */
export class StatusSpinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private frame = 0;
  private verbIndex = 0;
  private label = 'thinking';
  private active = false;
  private readonly c = createColors(Boolean(stderr.isTTY));

  start(): void {
    if (!stderr.isTTY || this.active) {
      return;
    }
    this.active = true;
    this.beginFrame();
  }

  resume(label?: string): void {
    if (!stderr.isTTY || this.active) {
      return;
    }
    if (label) {
      this.label = label;
    }
    this.active = true;
    this.beginFrame();
  }

  /** 清除状态行（工具调用期间调用），模型思考时用 resume 恢复。 */
  pause(): void {
    if (!this.active) {
      return;
    }
    this.stopTimer();
    stderr.write('\r\x1b[K');
    this.active = false;
  }

  /** 停止并清除状态行。 */
  stop(): void {
    this.stopTimer();
    stderr.write('\r\x1b[K');
    this.active = false;
  }

  private beginFrame(): void {
    this.startTime = Date.now();
    this.frame = 0;
    this.verbIndex = 0;
    this.render();
    this.timer = setInterval(() => this.render(), FRAME_INTERVAL_MS);
  }

  private render(): void {
    const frame = FRAMES[this.frame % FRAMES.length];
    const verb = VERBS[this.verbIndex % VERBS.length];
    // 计时以整秒为单位，每秒才变一次，避免 0.1s 跳动
    const seconds = Math.floor((Date.now() - this.startTime) / 1000);
    stderr.write(
      `\r\x1b[K${this.c.dim(frame)} ${this.c.cyan(verb)}... ${this.c.dim(`${seconds}s`)}`,
    );
    this.frame += 1;
    if (this.frame % VERB_SWITCH_FRAMES === 0) {
      this.verbIndex += 1;
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export interface ApiErrorInfo {
  displayName: string;
  message: string;
  hint: string;
}

interface ApiErrorRule {
  test: (message: string, status?: number) => boolean;
  displayName: string;
  hint: string;
}

const API_ERROR_RULES: ApiErrorRule[] = [
  {
    test: m => /ECONNREFUSED|ENOTFOUND|fetch failed|network request/i.test(m),
    displayName: '网络错误',
    hint: '检查网络/代理/API 地址是否可达',
  },
  {
    test: m => /ECONNRESET|socket hang up|EPIPE|connection (reset|closed)/i.test(m),
    displayName: '连接中断',
    hint: '网络不稳定，可重试',
  },
  {
    test: (m, s) => s === 401 || /invalid api key|unauthorized/i.test(m),
    displayName: '认证失败',
    hint: '检查 config.json 里的 API key 是否正确',
  },
  {
    test: (m, s) => s === 403 || /quota|permission|forbidden/i.test(m),
    displayName: '权限/配额',
    hint: '检查账号配额或权限设置',
  },
  {
    test: (m, s) => s === 429 || /rate limit|too many requests/i.test(m),
    displayName: '限流',
    hint: '请求过于频繁，稍后重试',
  },
  {
    test: m => /model (not found|does not exist|unknown)|unknown model/i.test(m),
    displayName: '模型不存在',
    hint: '检查 config.json 里的 model 字段是否可用',
  },
  {
    test: m =>
      /context (length|window)|maximum context|token limit|prompt is too long|too many tokens/i.test(
        m,
      ),
    displayName: '上下文超长',
    hint: '可用 /compact 压缩历史，或 /context 扩大上限',
  },
  {
    test: (m, s) => s === 400 || /bad request/i.test(m),
    displayName: '请求参数错误',
    hint: '内部请求异常，请反馈',
  },
  {
    test: (m, s) => typeof s === 'number' && s >= 500 && s < 600,
    displayName: '服务端错误',
    hint: 'API 服务异常，稍后重试',
  },
  {
    test: m => /json.*parse|invalid response|unexpected response|invalid character/i.test(m),
    displayName: '响应解析失败',
    hint: '模型/网关返回异常，可重试',
  },
  {
    test: m => /timed out|timeout/i.test(m),
    displayName: '请求超时',
    hint: '稍后重试或加长超时',
  },
];

/** 根据错误消息/状态码分类 API 错误，给出友好提示。 */
export function classifyApiError(error: unknown): ApiErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const raw = error as Record<string, unknown>;
  let status: number | undefined;
  if (typeof raw.statusCode === 'number') {
    status = raw.statusCode;
  } else if (typeof raw.status === 'number') {
    status = raw.status as number;
  }

  for (const rule of API_ERROR_RULES) {
    if (rule.test(message, status)) {
      return { displayName: rule.displayName, message, hint: rule.hint };
    }
  }
  return { displayName: 'API 错误', message, hint: '' };
}
