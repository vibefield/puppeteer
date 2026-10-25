import type { ClaudeHookDiagnostic, ClaudeHookPayload } from './types.js';

type FieldRequirement = readonly [field: string, kind: 'string' | 'boolean' | 'present'];

const NORMALIZER_REQUIREMENTS: Readonly<Record<string, readonly FieldRequirement[]>> = {
  SessionStart: [['session_id', 'string']],
  UserPromptSubmit: [['prompt', 'string']],
  MessageDisplay: [
    ['message_id', 'string'],
    ['delta', 'string'],
    ['final', 'boolean'],
  ],
  PermissionRequest: [
    ['tool_name', 'string'],
    ['tool_input', 'present'],
  ],
  PreToolUse: [
    ['tool_name', 'string'],
    ['tool_input', 'present'],
  ],
  PostToolUse: [],
  PostToolUseFailure: [],
  PermissionDenied: [
    ['tool_name', 'string'],
    ['tool_input', 'present'],
  ],
  SubagentStart: [['agent_id', 'string']],
  SubagentStop: [['agent_id', 'string']],
  TaskCreated: [['task_id', 'string']],
  TaskCompleted: [['task_id', 'string']],
  TeammateIdle: [
    ['team_name', 'string'],
    ['teammate_name', 'string'],
  ],
  PreCompact: [['trigger', 'string']],
  PostCompact: [['trigger', 'string']],
  DirectoryAdded: [['directory', 'string']],
  FileChanged: [['file_path', 'string']],
  PostModelSwitch: [['to_model', 'string']],
};

export const claudeString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const claudeNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
export const claudeBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
export const claudeRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export function nonEmptyClaudeString(value: unknown): string | undefined {
  const candidate = claudeString(value)?.trim();
  return candidate || undefined;
}

export function claudeHookDiagnostic(name: string, body: ClaudeHookPayload): ClaudeHookDiagnostic | undefined {
  const requirements = NORMALIZER_REQUIREMENTS[name];
  if (!requirements) return undefined;
  const issues: string[] = [];
  for (const [field, kind] of requirements) {
    if (kind === 'present') {
      if (!Object.hasOwn(body, field)) issues.push(`missing ${field}`);
    } else if (typeof body[field] !== kind) {
      issues.push(`${field} must be ${kind}`);
    }
  }
  return issues.length > 0 ? { code: 'malformed-known-hook', hookEventName: name, issues } : undefined;
}

export function canonicalClaudeValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalClaudeValue).join(',')}]`;
  const record = claudeRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalClaudeValue(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function claudeEffortLevel(value: unknown): string | undefined {
  return claudeString(value) ?? claudeString(claudeRecord(value)?.level);
}
