import { stdin, stdout } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { createColors } from 'picocolors';

export type ChatAskResult =
  | { kind: 'submit'; text: string }
  | { kind: 'cancel' } // Ctrl+C
  | { kind: 'eof' }; // Ctrl+D

interface ActiveAsk {
  resolve: (result: ChatAskResult) => void;
  prompt: string;
  multi: boolean;
}

/** 终端显示宽度：CJK / 全角 / emoji 等宽字符按 2 列计。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff) ||
        (code >= 0x20000 && code <= 0x2fffd) ||
        (code >= 0x30000 && code <= 0x3fffd))
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** 去掉 ANSI 颜色序列，得到纯文本。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 返回 text 中显示宽度首次达到 targetWidth 处的字符索引（中文字符算 2 列）。 */
export function charIndexAtDisplayWidth(text: string, targetWidth: number): number {
  let acc = 0;
  for (let index = 0; index < text.length; index += 1) {
    const w = displayWidth(text[index] ?? '');
    if (acc + w > targetWidth) {
      return index;
    }
    acc += w;
  }
  return text.length;
}

/** 从 startWidth（显示宽度）处开始，取最多 contentWidth 列宽的可显示片段。 */
export function visibleSlice(text: string, startWidth: number, contentWidth: number): string {
  const start = charIndexAtDisplayWidth(text, startWidth);
  let acc = 0;
  let end = start;
  for (; end < text.length; end += 1) {
    const w = displayWidth(text[end] ?? '');
    if (acc + w > contentWidth) {
      break;
    }
    acc += w;
  }
  return text.slice(start, end);
}

/**
 * Claude Code 风格的多行输入框。
 *
 * 输入区渲染在屏幕末尾：一条分隔线 + 提示符 + 若干内容行。
 * 回车提交；Ctrl/Shift+回车 换行；支持方向键、Home/End、退格、Delete、多行粘贴。
 * 输入区固定在最底部，提交时整块清除后继续输出，避免与输出区抢坐标。
 */
export class ChatInput {
  private lines: string[] = [''];
  private row = 0;
  private col = 0;
  private active: ActiveAsk | null = null;
  private rawModeOn = false;
  private rendered = false;
  private interruptHandler: (() => void) | null = null;
  /** 处于 bracketed paste（终端粘贴）模式时，回车应插入换行而非提交 */
  private isPasting = false;
  /** 当前行的横向视口起点（显示宽度偏移），用于超宽行的滚动显示 */
  private viewportStart = 0;
  /** 空输入时显示的占位提示 */
  private placeholder: string | null = null;
  /** 斜杠命令 → 参数提示（Tab 补全与参数提示共用） */
  private commandHints: Record<string, string> = {};
  /** 命令历史（最近的在末尾），上下箭头浏览 */
  private history: string[] = [];
  private historyIndex = -1;
  private pendingInput = '';
  /** Ctrl+R 反向搜索状态 */
  private searchActive = false;
  private searchQuery = '';
  private searchIndex = -1;
  private readonly c = createColors(Boolean(stdout.isTTY));

  /** 设置"无输入挂起时按 Ctrl+C"的中断回调（用于打断正在执行的 agent）。 */
  setInterruptHandler(handler: (() => void) | null): void {
    this.interruptHandler = handler;
  }

  /** 是否有输入请求正在等待。 */
  isAsking(): boolean {
    return this.active !== null;
  }

  /** 取消当前输入请求（视为 Ctrl+C / cancel）。 */
  cancelActive(): void {
    if (this.active) {
      this.finish({ kind: 'cancel' });
    }
  }

  /** 设置空输入时显示的占位提示（如"输入指令，/help 查看命令"）。 */
  setPlaceholder(text: string | null): void {
    this.placeholder = text;
  }

  /** 设置斜杠命令 → 参数提示表（同时用于 Tab 补全）。 */
  setCommandHints(hints: Record<string, string>): void {
    this.commandHints = hints;
  }

  /** 设置命令历史（最近的在末尾）。 */
  setHistory(history: string[]): void {
    this.history = history;
  }

  start(): void {
    if (this.rawModeOn) {
      return;
    }
    emitKeypressEvents(stdin);
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    this.rawModeOn = true;
    stdin.on('keypress', this.handleKeypress);
  }

  stop(): void {
    if (!this.rawModeOn) {
      return;
    }
    stdin.removeListener('keypress', this.handleKeypress);
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    this.rawModeOn = false;
  }

  ask(prompt: string, multi: boolean): Promise<ChatAskResult> {
    return new Promise(resolve => {
      this.active = { resolve, prompt, multi };
      this.lines = [''];
      this.row = 0;
      this.col = 0;
      this.render();
    });
  }

  private readonly handleKeypress = (
    str: string | undefined,
    key?: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string },
  ): void => {
    const name = key?.name;
    const ctrl = Boolean(key?.ctrl);

    // bracketed paste：终端粘贴时包裹 \x1b[200~ ... \x1b[201~，readline 解析为
    // name="paste-start"/"paste-end"。粘贴模式下的回车（换行）应插入换行而非提交。
    if (name === 'paste-start') {
      this.isPasting = true;
      return;
    }
    if (name === 'paste-end') {
      this.isPasting = false;
      return;
    }

    // 没有挂起的输入（agent 正在执行）时，Ctrl+C 触发中断回调，用于打断当前工作
    if (!this.active && ctrl && name === 'c') {
      this.interruptHandler?.();
      return;
    }
    if (!this.active) {
      return;
    }

    // 搜索模式（Ctrl+R）下所有按键进入搜索处理
    if (this.searchActive) {
      this.handleSearchKeypress(str, name, ctrl);
      return;
    }

    // 真实终端的回车：不同环境下 readline 会解析成 'return' 或 'enter'
    if (name === 'return' || name === 'enter') {
      // 多行模式：Ctrl/Shift+回车 或 粘贴中回车 换行；否则提交。单行模式：回车即提交。
      if (this.active.multi && (ctrl || key?.shift || this.isPasting)) {
        this.insertText('\n');
      } else {
        this.submit();
      }
      return;
    }

    if (ctrl && name === 'c') {
      this.finish({ kind: 'cancel' });
      return;
    }
    if (ctrl && name === 'd') {
      this.finish({ kind: 'eof' });
      return;
    }
    if (ctrl && name === 'r') {
      this.startSearch();
      return;
    }

    switch (name) {
      case 'backspace':
        this.backspace();
        break;
      case 'delete':
        this.deleteForward();
        break;
      case 'left':
        this.moveCol(-1);
        break;
      case 'right':
        this.moveCol(1);
        break;
      case 'up':
        // 单行输入时，上下箭头用于浏览命令历史；多行时才移动行
        if (this.lines.length === 1) {
          this.historyUp();
        } else {
          this.moveRow(-1);
        }
        break;
      case 'down':
        if (this.lines.length === 1) {
          this.historyDown();
        } else {
          this.moveRow(1);
        }
        break;
      case 'tab':
        this.completeCommand();
        break;
      case 'home':
        this.col = 0;
        break;
      case 'end':
        this.col = (this.lines[this.row] ?? '').length;
        break;
      default:
        if (str) {
          this.insertText(str);
        }
        break;
    }

    this.render();
  };

  /** Ctrl+R 反向搜索：从 history 末尾向前找包含 query 的第一个条目。 */
  private findSearchMatch(fromIndex: number): number {
    if (!this.searchQuery) {
      return -1;
    }
    for (let index = fromIndex; index >= 0; index -= 1) {
      const entry = this.history[index] ?? '';
      if (entry.includes(this.searchQuery)) {
        return index;
      }
    }
    return -1;
  }

  private startSearch(): void {
    this.searchActive = true;
    this.searchQuery = '';
    this.searchIndex = this.findSearchMatch(this.history.length - 1);
    this.render();
  }

  private handleSearchKeypress(
    str: string | undefined,
    name: string | undefined,
    ctrl: boolean,
  ): void {
    if (ctrl && name === 'r') {
      if (this.searchQuery && this.searchIndex > 0) {
        this.searchIndex = this.findSearchMatch(this.searchIndex - 1);
        this.render();
      }
      return;
    }
    if (ctrl && (name === 'c' || name === 'g')) {
      this.cancelSearch();
      return;
    }
    if (name === 'return' || name === 'enter') {
      this.applySearch();
      return;
    }
    if (name === 'backspace') {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.searchIndex = this.findSearchMatch(this.history.length - 1);
      this.render();
      return;
    }
    if (str) {
      this.searchQuery += str;
      this.searchIndex = this.findSearchMatch(this.history.length - 1);
      this.render();
    }
  }

  private applySearch(): void {
    if (this.searchIndex >= 0) {
      const entry = this.history[this.searchIndex] ?? '';
      this.lines = [entry];
      this.row = 0;
      this.col = entry.length;
    }
    this.searchActive = false;
    this.searchQuery = '';
    this.searchIndex = -1;
    this.render();
  }

  private cancelSearch(): void {
    this.searchActive = false;
    this.searchQuery = '';
    this.searchIndex = -1;
    this.render();
  }

  /** 单行输入时，上箭头浏览历史（更早）。 */
  private historyUp(): void {
    if (this.history.length === 0) {
      return;
    }
    if (this.historyIndex === -1) {
      this.pendingInput = this.lines[0] ?? '';
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return;
    }
    this.lines = [this.history[this.historyIndex] ?? ''];
    this.row = 0;
    this.col = (this.lines[0] ?? '').length;
  }

  /** 单行输入时，下箭头浏览历史（更新）或回到当前编辑。 */
  private historyDown(): void {
    if (this.historyIndex === -1) {
      return;
    }
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.lines = [this.history[this.historyIndex] ?? ''];
    } else {
      this.historyIndex = -1;
      this.lines = [this.pendingInput];
    }
    this.row = 0;
    this.col = (this.lines[0] ?? '').length;
  }

  /** Tab 补全：行首的 /命令 前缀匹配唯一命令时补全为完整命令。 */
  private completeCommand(): void {
    if (this.row !== 0) {
      return;
    }
    const line = this.lines[0] ?? '';
    const match = /^(\/\S*)/.exec(line);
    if (!match) {
      return;
    }
    const prefix = match[1] ?? '';
    const candidates = Object.keys(this.commandHints).filter(cmd =>
      cmd.startsWith(prefix),
    );
    if (candidates.length !== 1) {
      return;
    }
    const completed = candidates[0] ?? '';
    this.lines[0] = completed + line.slice(prefix.length);
    this.col = (this.lines[0] ?? '').length;
  }

  private submit(): void {
    const text = this.lines.join('\n');
    this.finish({ kind: 'submit', text });
  }

  private finish(result: ChatAskResult): void {
    if (!this.active) {
      return;
    }
    this.clearInput();
    const { resolve } = this.active;
    this.active = null;
    this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.rendered = false;
    resolve(result);
  }

  private insertText(text: string): void {
    const line = this.lines[this.row] ?? '';
    if (!text.includes('\n')) {
      this.lines[this.row] = line.slice(0, this.col) + text + line.slice(this.col);
      this.col += text.length;
      return;
    }

    // 多行粘贴：首段接在光标前、末段接在光标后，中间段作为新行插入
    const parts = text.split('\n');
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    const head = parts[0] ?? '';
    const middle = parts.slice(1, -1);
    const last = parts[parts.length - 1] ?? '';

    const newLines = [before + head, ...middle, last + after];
    this.lines.splice(this.row, 1, ...newLines);
    this.row += parts.length - 1;
    this.col = (last + after).length;
  }

  private backspace(): void {
    const line = this.lines[this.row] ?? '';
    if (this.col > 0) {
      this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
      this.col -= 1;
      return;
    }
    if (this.row > 0) {
      const prev = this.lines[this.row - 1] ?? '';
      this.lines[this.row - 1] = prev + line;
      this.lines.splice(this.row, 1);
      this.row -= 1;
      this.col = prev.length;
    }
  }

  private deleteForward(): void {
    const line = this.lines[this.row] ?? '';
    if (this.col < line.length) {
      this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
      return;
    }
    if (this.row < this.lines.length - 1) {
      this.lines[this.row] = line + (this.lines[this.row + 1] ?? '');
      this.lines.splice(this.row + 1, 1);
    }
  }

  private moveCol(delta: number): void {
    const line = this.lines[this.row] ?? '';
    if (delta < 0 && this.col > 0) {
      this.col -= 1;
    } else if (delta > 0 && this.col < line.length) {
      this.col += 1;
    } else if (delta < 0 && this.col === 0 && this.row > 0) {
      this.row -= 1;
      this.col = (this.lines[this.row] ?? '').length;
    } else if (delta > 0 && this.col === line.length && this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = 0;
    }
  }

  private moveRow(delta: number): void {
    const target = this.row + delta;
    if (target < 0 || target >= this.lines.length) {
      return;
    }
    this.row = target;
    const line = this.lines[this.row] ?? '';
    if (this.col > line.length) {
      this.col = line.length;
    }
  }

  /** 提示符的显示宽度（剥离 ANSI，中文/宽字符按 2 列）。 */
  private promptDisplayWidth(): number {
    const prompt = this.active?.prompt ?? 'cook❯ ';
    return displayWidth(stripAnsi(prompt));
  }

  /** 把光标移到输入区顶部（分隔线行首），清除整个输入区。 */
  private clearInput(): void {
    stdout.write(`\x1b[${this.row + 1}A`);
    stdout.write('\x1b[G');
    stdout.write('\x1b[J');
  }

  /** 计算当前行的横向视口起点（显示宽度偏移），保证光标始终可见。 */
  private computeViewport(contentWidth: number): void {
    const line = this.lines[this.row] ?? '';
    const totalWidth = displayWidth(line);
    if (totalWidth <= contentWidth) {
      this.viewportStart = 0;
      return;
    }
    const cursorWidth = displayWidth(line.slice(0, this.col));
    if (this.viewportStart > cursorWidth) {
      this.viewportStart = cursorWidth;
    }
    const maxStart = cursorWidth - contentWidth + 1;
    if (this.viewportStart < maxStart) {
      this.viewportStart = maxStart;
    }
    if (this.viewportStart < 0) {
      this.viewportStart = 0;
    }
  }

  private render(): void {
    const { c } = this;
    if (this.rendered) {
      // 重绘：光标当前位于输入区第 row 行，上移到分隔线行、回到行首，清屏尾后整块重绘。
      stdout.write(`\x1b[${this.row + 1}A`);
      stdout.write('\x1b[G');
      stdout.write('\x1b[J');
    }

    const width = stdout.columns || 80;
    stdout.write(c.dim('─'.repeat(width)) + '\n');

    // 搜索模式（Ctrl+R）：显示反向搜索界面（单行）
    if (this.searchActive) {
      const preview =
        this.searchIndex >= 0 ? (this.history[this.searchIndex] ?? '') : '';
      const searchLine = `(reverse-i-search)\`${this.searchQuery}\`: ${preview}`;
      stdout.write(visibleSlice(searchLine, 0, width) + '\n');
      stdout.write('\x1b[G');
      const queryWidth = displayWidth(`(reverse-i-search)\`${this.searchQuery}\``);
      stdout.write(`\x1b[${queryWidth}C`);
      this.rendered = true;
      return;
    }

    const promptWidth = this.promptDisplayWidth();
    const prompt = this.active?.prompt ?? 'cook❯ ';
    const indent = ' '.repeat(promptWidth);
    const contentWidth = Math.max(10, width - promptWidth - 1);

    // 只有超宽行才启用横向滚动，普通行 viewportStart 保持 0，渲染行为不变
    this.computeViewport(contentWidth);

    // placeholder：空输入且光标在开头时显示 dim 占位提示
    const placeholder = this.placeholder;
    const placeholderActive =
      this.lines[0] === '' && placeholder !== null && this.row === 0 && this.col === 0;

    for (let i = 0; i < this.lines.length; i += 1) {
      const line = this.lines[i] ?? '';
      const startWidth = i === this.row ? this.viewportStart : 0;
      const visible = visibleSlice(line, startWidth, contentWidth);

      if (i === 0 && placeholderActive) {
        stdout.write(prompt + c.dim(visibleSlice(placeholder ?? '', 0, contentWidth)));
      } else {
        stdout.write((i === 0 ? prompt : indent) + visible);
        // 参数提示：行首是完整 /命令 且该命令有提示时，在内容后追加 dim 提示
        const cmd = /^\/\S+$/.exec(line)?.[0];
        const hint = i === 0 && cmd ? this.commandHints[cmd] : undefined;
        if (hint && displayWidth(visible) + displayWidth(` ${hint}`) <= contentWidth) {
          stdout.write(c.dim(` ${hint}`));
        }
      }
      if (i < this.lines.length - 1) {
        stdout.write('\n');
      }
    }

    // 光标定位到 (row, col)：画完行后光标在行尾，须先回行首再右移，
    // 否则会在行尾基础上继续右移，导致光标跑到提示符右侧很远。
    const up = this.lines.length - 1 - this.row;
    if (up > 0) {
      stdout.write(`\x1b[${up}A`);
    }
    stdout.write('\x1b[G');
    const line = this.lines[this.row] ?? '';
    if (placeholderActive) {
      stdout.write(`\x1b[${promptWidth}C`);
    } else {
      const viewStartChar = charIndexAtDisplayWidth(line, this.viewportStart);
      const x = promptWidth + displayWidth(line.slice(viewStartChar, this.col));
      if (x > 0) {
        stdout.write(`\x1b[${x}C`);
      }
    }
    this.rendered = true;
  }
}
