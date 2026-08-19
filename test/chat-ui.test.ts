import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { stdin } from 'node:process';
import {
  ChatInput,
  charIndexAtDisplayWidth,
  visibleSlice,
} from '../src/chat-ui.ts';

// 屏蔽渲染输出，测试只关注输入编辑逻辑
const originalWrite = process.stdout.write;
let writeCalls = 0;

beforeEach(() => {
  writeCalls = 0;
  process.stdout.write = ((..._args: unknown[]) => {
    writeCalls += 1;
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

function press(str: string | undefined, name: string, extra: Record<string, boolean> = {}): void {
  stdin.emit('keypress', str, { name, ctrl: false, shift: false, ...extra });
}

describe('ChatInput', () => {
  it('accumulates typed characters and submits on Enter', async () => {
    const input = new ChatInput();
    input.start();
    const promise = input.ask('cook❯ ', true);

    press('h', 'h');
    press('i', 'i');
    press(undefined, 'return');

    expect(await promise).toEqual({ kind: 'submit', text: 'hi' });
    input.stop();
  });

  it('inserts a newline with Ctrl+Enter in multi mode', async () => {
    const input = new ChatInput();
    input.start();
    const promise = input.ask('cook❯ ', true);

    press('a', 'a');
    press(undefined, 'return', { ctrl: true });
    press('b', 'b');
    press(undefined, 'return');

    expect(await promise).toEqual({ kind: 'submit', text: 'a\nb' });
    input.stop();
  });

  it('handles backspace and moves the cursor left', async () => {
    const input = new ChatInput();
    input.start();
    const promise = input.ask('cook❯ ', true);

    press('a', 'a');
    press('b', 'b');
    press('c', 'c');
    press(undefined, 'backspace'); // 删 c
    press(undefined, 'left'); // 光标到 a|b
    press('x', 'x'); // 插入 x → axb
    press(undefined, 'return');

    expect(await promise).toEqual({ kind: 'submit', text: 'axb' });
    input.stop();
  });

  it('submits multi-line paste content', async () => {
    const input = new ChatInput();
    input.start();
    const promise = input.ask('cook❯ ', true);

    stdin.emit('keypress', 'line1\nline2', { name: undefined, ctrl: false, shift: false });
    press(undefined, 'return');

    expect(await promise).toEqual({ kind: 'submit', text: 'line1\nline2' });
    input.stop();
  });

  it('returns cancel on Ctrl+C and eof on Ctrl+D', async () => {
    const input = new ChatInput();
    input.start();

    const cancelled = input.ask('cook❯ ', true);
    press('x', 'x');
    press(undefined, 'c', { ctrl: true });
    expect(await cancelled).toEqual({ kind: 'cancel' });

    const eof = input.ask('cook❯ ', true);
    press(undefined, 'd', { ctrl: true });
    expect(await eof).toEqual({ kind: 'eof' });

    input.stop();
  });

  it('submits on Enter when the terminal reports name="enter"', async () => {
    const input = new ChatInput();
    input.start();
    const promise = input.ask('cook❯ ', true);

    press('h', 'h');
    // 真实终端（pty/ICRNL）下回车常被 readline 解析为 name="enter"、str="\n"
    stdin.emit('keypress', '\n', { name: 'enter', ctrl: false, shift: false });

    expect(await promise).toEqual({ kind: 'submit', text: 'h' });
    input.stop();
  });

  it('submits a single line in single-line (confirm) mode', async () => {
    const input = new ChatInput();
    input.start();
    const promise = input.ask('[y/N/a]: ', false);

    press('y', 'y');
    press(undefined, 'return');

    expect(await promise).toEqual({ kind: 'submit', text: 'y' });
    input.stop();
  });

  it('triggers interrupt handler when Ctrl+C pressed with no active input', async () => {
    const input = new ChatInput();
    input.start();
    let interrupted = false;
    input.setInterruptHandler(() => {
      interrupted = true;
    });

    // 无挂起输入（agent 执行中）时按 Ctrl+C
    press(undefined, 'c', { ctrl: true });
    expect(interrupted).toBe(true);
    input.stop();
  });

  it('does not trigger interrupt handler when an input is active', async () => {
    const input = new ChatInput();
    input.start();
    let interrupted = false;
    input.setInterruptHandler(() => {
      interrupted = true;
    });

    const promise = input.ask('cook❯ ', true);
    press(undefined, 'c', { ctrl: true }); // 应取消输入，而非触发 interrupt
    expect(interrupted).toBe(false);
    expect(await promise).toEqual({ kind: 'cancel' });
    input.stop();
  });

  it('tracks asking state and cancels the active input', async () => {
    const input = new ChatInput();
    input.start();

    const promise = input.ask('cook❯ ', true);
    expect(input.isAsking()).toBe(true);
    input.cancelActive();
    expect(await promise).toEqual({ kind: 'cancel' });
    expect(input.isAsking()).toBe(false);
    input.stop();
  });
});

describe('viewport helpers', () => {
  it('charIndexAtDisplayWidth counts CJK as 2 columns', () => {
    // "a中文b" 显示宽度：1 + 2 + 2 + 1 = 6
    expect(charIndexAtDisplayWidth('a中文b', 1)).toBe(1); // 第 1 列处
    expect(charIndexAtDisplayWidth('a中文b', 3)).toBe(2); // 中(第1-2列)之后
    expect(charIndexAtDisplayWidth('a中文b', 99)).toBe(4);
  });

  it('visibleSlice returns a windowed substring within width', () => {
    const line = 'a中文bcdef';
    // 从显示宽度 3 开始（即第 2 个字符"中"结束处之后），取 4 列宽
    const slice = visibleSlice(line, 3, 4);
    const width = [...slice].reduce((acc, ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return acc + (code >= 0x4e00 && code <= 0x9fff ? 2 : 1);
    }, 0);
    expect(width).toBeLessThanOrEqual(4);
    expect(line).toContain(slice);
  });

  it('visibleSlice returns the full line when it fits', () => {
    expect(visibleSlice('short', 0, 50)).toBe('short');
    expect(visibleSlice('中文', 0, 10)).toBe('中文');
  });
});

describe('command completion, history and search', () => {
  it('completes a /command with Tab when uniquely matched', async () => {
    const input = new ChatInput();
    input.setCommandHints({ '/context': '上限', '/compact': '压缩' });
    input.start();
    const promise = input.ask('cook❯ ', true);
    for (const ch of '/con') {
      press(ch, ch);
    }
    press(undefined, 'tab');
    press(undefined, 'return');
    expect(await promise).toEqual({ kind: 'submit', text: '/context' });
    input.stop();
  });

  it('browses command history with up/down arrows', async () => {
    const input = new ChatInput();
    input.setHistory(['第一句', '第二句']);
    input.start();
    const promise = input.ask('cook❯ ', true);
    press(undefined, 'up'); // 第二句
    press(undefined, 'up'); // 第一句
    press(undefined, 'down'); // 回到第二句
    press(undefined, 'return');
    expect(await promise).toEqual({ kind: 'submit', text: '第二句' });
    input.stop();
  });

  it('searches history with Ctrl+R and applies the match', async () => {
    const input = new ChatInput();
    input.setHistory(['查进程', '查端口', '写报告']);
    input.start();
    const promise = input.ask('cook❯ ', true);
    press(undefined, 'r', { ctrl: true }); // 进入搜索
    press('查', '查'); // 输入查询词
    press(undefined, 'return'); // 应用匹配
    press(undefined, 'return'); // 提交
    expect(await promise).toEqual({ kind: 'submit', text: '查端口' });
    input.stop();
  });

  it('renders placeholder when the input is empty', async () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const input = new ChatInput();
      input.setPlaceholder('输入指令，/help 查看命令');
      input.start();
      input.ask('cook❯ ', true);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(writes.join('')).toContain('输入指令，/help 查看命令');
      input.stop();
    } finally {
      process.stdout.write = orig;
    }
  });
});
