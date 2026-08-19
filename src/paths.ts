import path from 'node:path';

/**
 * Bun 编译单二进制后，源码模块位于虚拟文件系统内，import.meta.dir
 * 固定为 /$bunfs/root，无法用于定位真实目录。据此区分编译二进制与源码运行。
 */
const BUNFS_ROOT = '/$bunfs/root';

export function isCompiledBinary(): boolean {
  return import.meta.dir === BUNFS_ROOT || import.meta.dir == null;
}

/**
 * 编译后的单二进制：返回可执行文件所在目录（例如 .../dist）。
 * 源码运行（bun run src/cli.ts）：返回 null，调用方应回退到 process.cwd()。
 */
export function getCookExecutableDir(): string | null {
  if (!isCompiledBinary()) {
    return null;
  }
  return path.dirname(process.execPath);
}

/**
 * 决定 .cook 配置体系的定位根目录：
 * 1. 可执行文件所在目录下存在 .cook/config.json → 用该目录（便携绑定，
 *    二进制走到哪、配置跟到哪）；
 * 2. 否则回退到启动目录（保持原行为：配置跟随当前项目）。
 */
export async function resolveConfigRoot(cwd: string): Promise<string> {
  const execDir = getCookExecutableDir();
  if (execDir) {
    const configFile = path.join(execDir, '.cook', 'config.json');
    if (await Bun.file(configFile).exists()) {
      return execDir;
    }
  }
  return cwd;
}
