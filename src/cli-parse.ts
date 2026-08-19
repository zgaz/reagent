import { Command } from 'commander';
import { CliError } from './errors.ts';
import { COOK_VERSION } from './version.ts';

export interface CliFlags {
  yes?: boolean;
  quiet?: boolean;
  debug?: boolean;
  verbose?: boolean;
  agent?: string;
  maxSteps?: number;
  timeout?: number;
  allowOutsideCwd?: boolean;
  dryRun?: boolean;
  raw?: boolean;
  sessionLogs?: boolean;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name('cook')
    .description('Shell-native micro agent for natural language tasks')
    .version(COOK_VERSION, '-V, --version', 'Output the current version')
    .argument('[instruction...]', 'Natural-language instruction to execute')
    .allowUnknownOption(true)
    .option('-y, --yes', 'Skip confirmation prompts for mutating actions')
    .option('--quiet', 'Suppress status/progress output')
    .option('--debug', 'Enable debug logs on stderr')
    .option('--verbose', 'Alias for --debug')
    .option('--agent <name>', 'Select configured agent by name')
    .option('--max-steps <n>', 'Override max tool loop steps', value =>
      Number.parseInt(value, 10),
    )
    .option('--timeout <ms>', 'Override bash timeout in ms', value =>
      Number.parseInt(value, 10),
    )
    .option('--allow-outside-cwd', 'Allow file/tool operations outside current working directory')
    .option('--dry-run', 'Preview mutating actions but do not execute them')
    .option('--raw', 'Enable raw Bash terminal output mode (allows isFinal)')
    .option('--session-logs', 'Record a full audit session log (evidence)')
    .addHelpText(
      'after',
      [
        '',
        'Commands:',
        '  cook chat                           Start an interactive conversation',
        '  cook login [openai] [--device-code]  Sign in with ChatGPT',
        '  cook login status                    Show ChatGPT login status',
        '  cook logout [openai]                 Remove the saved ChatGPT login',
        '  cook config init                     Initialize configuration',
      ].join('\n'),
    )
    .showHelpAfterError();

  return program;
}

export function parseCli(argv: string[]): { instruction: string; flags: CliFlags } {
  const program = buildProgram();
  program.parse(argv);
  const flags = program.opts<CliFlags>();
  const instruction = program.args.join(' ').trim();

  if (!instruction) {
    throw new CliError('Missing instruction. Example: cook "find all .py files older than 2 months"');
  }

  return {
    instruction,
    flags,
  };
}

/**
 * 解析 `cook chat [flags]` 的 flags，忽略位置参数（chat 模式下指令在对话内输入）。
 * argv 为完整的 process.argv（[node, script, chat, ...flags]）。
 */
export function parseChatCli(argv: string[]): CliFlags {
  const rest = argv.filter((value, index) => !(index > 1 && value === 'chat'));
  const program = buildProgram();
  program.parse(rest.length > 0 ? rest : ['bun', 'cook']);
  return program.opts<CliFlags>();
}
