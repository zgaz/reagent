import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { createColors } from 'picocolors';
import { truncateForPreview } from './policy.ts';
import type { PendingToolApproval } from './types.ts';

export type ConfirmationDecision =
  | { kind: 'approve'; raw_input?: string }
  | { kind: 'approve_all'; raw_input?: string }
  | { kind: 'decline'; raw_input?: string }
  | { kind: 'guidance'; text: string; raw_input?: string };

export function canPromptForConfirmation(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function getColors() {
  return createColors(Boolean(stderr.isTTY));
}

export function parseConfirmationInput(answer: string): ConfirmationDecision {
  const trimmed = answer.trim();
  if (/^y(es)?$/i.test(trimmed)) {
    return { kind: 'approve' };
  }

  if (/^a(ll)?$/i.test(trimmed)) {
    return { kind: 'approve_all' };
  }

  if (trimmed.length === 0 || /^n(o)?$/i.test(trimmed)) {
    return { kind: 'decline' };
  }

  return {
    kind: 'guidance',
    text: trimmed,
  };
}

export function summarizePendingApproval(approval: PendingToolApproval): string {
  const input =
    typeof approval.input === 'object' && approval.input !== null
      ? (approval.input as Record<string, unknown>)
      : undefined;

  if (approval.toolName === 'Bash') {
    const command = typeof input?.command === 'string' ? input.command : '<unknown command>';
    return truncateForPreview(command, 180);
  }

  if (approval.toolName === 'Write') {
    const targetPath = typeof input?.path === 'string' ? input.path : '<unknown path>';
    const contentLength = typeof input?.content === 'string' ? input.content.length : null;
    if (contentLength === null) {
      return targetPath;
    }

    return `${targetPath} (${contentLength} chars)`;
  }

  if (approval.toolName === 'Edit') {
    const targetPath = typeof input?.path === 'string' ? input.path : '<unknown path>';
    const edits = Array.isArray(input?.edits) ? input.edits.length : null;
    if (edits === null) {
      return targetPath;
    }

    return `${targetPath} (${edits} edit block(s))`;
  }

  const fallback = JSON.stringify(approval.input);
  return truncateForPreview(fallback ?? '<unknown input>', 180);
}

/**
 * 用调用方提供的 readline 实例发起确认。交互模式（chat）复用它持有的
 * 单一 readline，避免多个 readline 实例叠加导致输入字符重复。
 */
export async function confirmPendingMutationWithRl(
  rl: Interface,
  approval: PendingToolApproval,
  index: number,
  total: number,
): Promise<ConfirmationDecision> {
  const c = getColors();
  const cookTag = c.dim('[cook]');
  const toolTag = c.dim(`[${approval.toolName.toLowerCase()}]`);
  const decisionTag = c.dim('[y/N/a]');
  const summary = summarizePendingApproval(approval);

  if (total === 1) {
    stderr.write(`\n${cookTag} Mutating action\n`);
  } else {
    stderr.write(`\n${cookTag} Mutating action ${index}/${total}\n`);
  }
  stderr.write(`${cookTag} ${toolTag} ${summary}\n`);

  const answer = await rl.question(
    `${cookTag} Proceed? ${decisionTag} or tell cook what to do: `,
  );
  const decision = parseConfirmationInput(answer);
  return { ...decision, raw_input: answer.trim() };
}

export async function confirmPendingMutation(
  approval: PendingToolApproval,
  index: number,
  total: number,
): Promise<ConfirmationDecision> {
  const rl = createInterface({ input: stdin, output: stderr });

  try {
    return await confirmPendingMutationWithRl(rl, approval, index, total);
  } finally {
    rl.close();
  }
}
