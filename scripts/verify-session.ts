import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createColors } from 'picocolors';
import { verifySessionLog } from '../src/session-logger.ts';

const c = createColors(Boolean(process.stderr.isTTY));

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function latestSessionDir(rootDir: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best: { dir: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const full = path.join(rootDir, entry.name);
    try {
      const info = await stat(full);
      if (!best || info.mtimeMs > best.mtime) {
        best = { dir: full, mtime: info.mtimeMs };
      }
    } catch {
      // 跳过不可读目录
    }
  }

  return best?.dir ?? null;
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  // 日志根目录候选：当前工作目录优先（默认就在 <cwd>/.cook/sessions），全局兜底
  const roots = [
    path.join(process.cwd(), '.cook', 'sessions'),
    path.join(os.homedir(), '.cook', 'sessions'),
  ];

  let target: string | undefined;

  if (arg) {
    // 参数可能是目录路径
    if (await pathExists(path.resolve(arg))) {
      target = path.resolve(arg);
    } else {
      // 也可能是 session id，逐个候选根查找
      for (const root of roots) {
        const asId = path.join(root, arg);
        if (await pathExists(asId)) {
          target = asId;
          break;
        }
      }
      if (!target) {
        console.error(
          `Session not found: ${arg} (looked in ${roots.join(' and ')}, and as a path)`,
        );
        return 1;
      }
    }
  } else {
    // 无参数：取最近的会话
    for (const root of roots) {
      const latest = await latestSessionDir(root);
      if (latest) {
        target = latest;
        break;
      }
    }
    if (!target) {
      console.error('No session logs found (looked in ' + roots.join(' and ') + ')');
      return 1;
    }
  }

  const result = await verifySessionLog(target);

  console.log(`Session: ${target}`);
  console.log(`Events:  ${result.eventCount}`);
  if (result.valid) {
    console.log(
      `${c.green('Integrity: OK')} — hash chain of ${result.eventCount} events intact (last=${result.lastHash.slice(0, 12)}…)`,
    );
    return 0;
  }

  const badIndex = result.firstBadIndex ?? -1;
  console.log(
    `${c.red('Integrity: TAMPERED')} — chain broke at event #${badIndex + 1} (index ${badIndex})`,
  );
  return 1;
}

process.exit(await main());
