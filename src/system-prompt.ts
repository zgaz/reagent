import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPromptFiles } from './types.ts';

interface BuildSystemPromptOptions {
  cwd: string;
  config_cwd?: string;
  global_system_path: string;
  local_system_path: string;
  prompt_files?: AgentPromptFiles;
  ignore_agents_md?: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  return Bun.file(filePath).exists();
}

async function readRequiredFile(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  return file.text();
}

function resolveFromCwd(cwd: string, filePath: string): string {
  return path.resolve(cwd, filePath);
}

function wrapSection(source: string, content: string): string {
  return [`[${source}]`, content.trim()].join('\n');
}

async function resolveDefaultSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<{ source: string; content: string } | undefined> {
  if (await fileExists(options.local_system_path)) {
    return {
      source: options.local_system_path,
      content: await readRequiredFile(options.local_system_path),
    };
  }

  if (await fileExists(options.global_system_path)) {
    return {
      source: options.global_system_path,
      content: await readRequiredFile(options.global_system_path),
    };
  }

  return undefined;
}

async function findFileByLowerName(
  dir: string,
  lowerName: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.toLowerCase() === lowerName) {
      return path.join(dir, entry.name);
    }
  }

  return undefined;
}

async function discoverContextFiles(
  cwd: string,
  ignore_agents_md: boolean,
  configCwd?: string,
): Promise<Array<{ source: string; path: string }>> {
  // 优先在配置文件所在目录（可执行文件旁的 .cook）找，再回退启动目录。
  const searchDirs: Array<{ dir: string; label: string }> = [];
  if (configCwd && configCwd !== cwd) {
    searchDirs.push({ dir: configCwd, label: `${configCwd}（配置目录）` });
  }
  searchDirs.push({ dir: cwd, label: cwd });

  const orderedTargets: Array<{ name: string; source: string }> = [];
  if (!ignore_agents_md) {
    orderedTargets.push(
      { name: 'agents.md', source: 'AGENTS.md' },
      { name: 'claude.md', source: 'CLAUDE.md' },
    );
  }
  orderedTargets.push({ name: 'cook.md', source: 'cook.md' });

  const discovered: Array<{ source: string; path: string }> = [];
  for (const target of orderedTargets) {
    for (const searchDir of searchDirs) {
      const found = await findFileByLowerName(searchDir.dir, target.name);
      if (found) {
        discovered.push({
          source: `${searchDir.label}/${target.source}`,
          path: found,
        });
        break;
      }
    }
  }

  return discovered;
}

export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string> {
  const sections: string[] = [];
  const promptFiles = options.prompt_files;
  // prompt_files 里的相对路径相对配置文件所在目录解析（默认退化为项目目录）
  const promptRoot = options.config_cwd ?? options.cwd;

  if (promptFiles?.system) {
    const systemPath = resolveFromCwd(promptRoot, promptFiles.system);
    const content = await readRequiredFile(systemPath);
    sections.push(wrapSection(`SYSTEM:${systemPath}`, content));
  } else {
    const defaultSystem = await resolveDefaultSystemPrompt(options);
    if (defaultSystem !== undefined) {
      sections.push(wrapSection(`SYSTEM:${defaultSystem.source}`, defaultSystem.content));
    }
  }

  const appendFiles = promptFiles?.system_append ?? [];
  for (const appendFile of appendFiles) {
    const appendPath = resolveFromCwd(promptRoot, appendFile);
    const content = await readRequiredFile(appendPath);
    sections.push(wrapSection(`SYSTEM_APPEND:${appendPath}`, content));
  }

  const contextFiles = await discoverContextFiles(
    options.cwd,
    Boolean(options.ignore_agents_md),
    options.config_cwd,
  );
  for (const contextFile of contextFiles) {
    const content = await readRequiredFile(contextFile.path);
    sections.push(wrapSection(`CONTEXT:${contextFile.source}`, content));
  }

  return sections.join('\n\n').trim();
}
