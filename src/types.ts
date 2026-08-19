import type { ModelMessage } from '@ai-sdk/provider-utils';

export interface BashMutationInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
}

export interface WriteMutationInput {
  path: string;
  content: string;
  createDirs: boolean;
}

export interface EditMutationItem {
  find: string;
  replace: string;
}

export interface EditMutationInput {
  path: string;
  edits: EditMutationItem[];
  expectedCount?: number;
}

export type MutationRecord =
  | {
      tool: 'Bash';
      summary: string;
      input: BashMutationInput;
    }
  | {
      tool: 'Write';
      summary: string;
      input: WriteMutationInput;
    }
  | {
      tool: 'Edit';
      summary: string;
      input: EditMutationInput;
    };

export interface PendingToolApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type AgentProvider =
  | 'gateway'
  | 'google'
  | 'anthropic'
  | 'openai'
  | 'openai-codex'
  | 'groq';

export interface AgentPromptFiles {
  system?: string;
  system_append?: string[];
}

export interface AgentConfig {
  provider: AgentProvider;
  model: string;
  structured_output?: boolean;
  prompt_files?: AgentPromptFiles;
  ignore_agents_md?: boolean;
  raw_bash_output?: boolean;
}

export interface ResolvedAgentConfig extends AgentConfig {
  raw_bash_output: boolean;
}

export interface CookConfig {
  max_steps: number;
  bash_timeout_ms: number;
  bash_output_limit_bytes: number;
  stdin_inline_max_bytes: number;
  require_confirm_mutations: boolean;
  allow_outside_cwd: boolean;
  quiet: boolean;
  debug: boolean;
  session_logs: boolean;
  /** 会话日志根目录；不设则默认 ~/.cook/sessions/ */
  session_logs_dir?: string;
  /** 对话上下文上限（估算字符数）；超过则自动压缩历史为摘要 */
  context_limit_chars?: number;
  ai_gateway_api_key?: string;
  provider_api_keys?: Record<string, string>;
  default_agent?: string;
  agents: Record<string, AgentConfig>;
}

export interface RuntimeConfig {
  max_steps: number;
  bash_timeout_ms: number;
  bash_output_limit_bytes: number;
  stdin_inline_max_bytes: number;
  require_confirm_mutations: boolean;
  allow_outside_cwd: boolean;
  quiet: boolean;
  debug: boolean;
  session_logs: boolean;
  /** 会话日志根目录；不设则默认 ~/.cook/sessions/ */
  session_logs_dir?: string;
  /** 对话上下文上限（估算字符数）；超过则自动压缩历史为摘要 */
  context_limit_chars?: number;
  ai_gateway_api_key?: string;
  provider_api_keys?: Record<string, string>;
  agent_name: string;
  agent: ResolvedAgentConfig;
  cwd: string;
  config_cwd: string;
  always_execute: boolean;
  dry_run: boolean;
}

export interface LoadedConfig {
  config: CookConfig;
  global_path: string;
  local_path: string;
  global_system_path: string;
  local_system_path: string;
}

export type StdinMode = 'none' | 'inline' | 'temp-file';

export interface StdinContext {
  mode: StdinMode;
  bytes: number;
  isText: boolean;
  preview: string;
  inlineText?: string;
  tempFilePath?: string;
  cleanup?: () => Promise<void>;
}

export interface ToolRuntime {
  root_dir: string;
  allow_outside_cwd: boolean;
  bash_timeout_ms: number;
  bash_output_limit_bytes: number;
  raw_bash_output: boolean;
  confirm_mutations: boolean;
  dry_run: boolean;
  mutation_plan: MutationRecord[];
  debug: boolean;
  log_debug: (message: string) => void;
  log_tool_command: (toolName: string, command: string) => void;
}

export type SessionEventType =
  | 'session.start'
  | 'session.finish'
  | 'session.error'
  | 'user.message'
  | 'agent.run.start'
  | 'agent.run.finish'
  | 'agent.call.start'
  | 'agent.call.finish'
  | 'tool.call.start'
  | 'tool.call.finish'
  | 'confirmation.decision';

export type SessionRunStatus = 'success' | 'failure';

export interface SessionLogger {
  readonly enabled: boolean;
  readonly session_id: string;
  readonly session_dir?: string;
  logEvent(type: SessionEventType, payload?: Record<string, unknown>): void;
  finish(status: SessionRunStatus, payload?: Record<string, unknown>): Promise<void>;
}

export interface AgentRunOptions {
  instruction: string;
  runtime: RuntimeConfig;
  stdin: StdinContext;
  global_system_path: string;
  local_system_path: string;
  logDebug: (message: string) => void;
  logToolCommand: (toolName: string, command: string) => void;
  sessionLogger?: SessionLogger;
  messages?: ModelMessage[];
  /** 供中断当前工具循环（如用户按 Ctrl+C 打断 agent 工作） */
  abortSignal?: AbortSignal;
  /** agent 运行阶段回调（模型思考 / 工具调用），用于 UI 状态提示 */
  onPhase?: (phase: 'thinking' | 'tool', toolName?: string) => void;
  /** 实时在 stderr 显示工具执行完成状态（✓/✗ + 耗时） */
  toolActivity?: boolean;
}

export interface AgentRunResult {
  text: string;
  mutationPlan: MutationRecord[];
  pendingApprovals: PendingToolApproval[];
  responseMessages: ModelMessage[];
  terminal?: {
    source: 'bash';
    command: string;
    cwd: string;
    exitCode: number;
  };
}
