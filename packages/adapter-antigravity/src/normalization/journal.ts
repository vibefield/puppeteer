import { antigravityRecord } from './types.js';

/**
 * The durable journal shape a record proves. 1.4.12 adds per-response token
 * counts to PLANNER_RESPONSE and renames run_command's argument to
 * `CommandLine`; no 1.1.x journal carries either. A record that proves
 * neither leaves the shape undecided, which keeps the 1.1.20 behaviour.
 */
export type AntigravityJournalShape = '1.1.20' | '1.4.12';

const PLANNER_TOKEN_FIELDS = ['input_tokens', 'cache_read_tokens', 'output_tokens'] as const;

export function antigravityJournalShape(value: unknown): AntigravityJournalShape | undefined {
  const body = antigravityRecord(value);
  if (body?.type !== 'PLANNER_RESPONSE') return undefined;
  if (PLANNER_TOKEN_FIELDS.some((field) => typeof body[field] === 'number')) return '1.4.12';
  if (!Array.isArray(body.tool_calls)) return undefined;
  for (const call of body.tool_calls) {
    const args = antigravityRecord(antigravityRecord(call)?.args);
    if (args && Object.hasOwn(args, 'CommandLine')) return '1.4.12';
  }
  return undefined;
}
