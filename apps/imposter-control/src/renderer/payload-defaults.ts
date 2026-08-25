const ENVELOPE_FIELDS = new Set(['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode']);

const uuid = (): string => crypto.randomUUID();
const defaults: Record<string, () => unknown> = {
  prompt_id: uuid,
  tool_use_id: () => `toolu_${uuid().replaceAll('-', '').slice(0, 20)}`,
  agent_id: () => uuid().replaceAll('-', '').slice(0, 17),
  message_id: () => `msg_${uuid().replaceAll('-', '').slice(0, 12)}`,
  turn_id: uuid,
  turnId: uuid,
  message: () => 'hello from emulator control',
  notification_type: () => 'emulator',
  tool_name: () => 'Bash',
  tool_input: () => ({ command: 'echo hi' }),
  tool_response: () => ({ output: 'ok' }),
  session_title: () => 'emulator-session',
  source: () => 'startup',
  reason: () => 'other',
  load_reason: () => 'session_start',
  memory_type: () => 'User',
  file_path: () => '/tmp/CLAUDE.md',
  prompt: () => 'triggered by hand',
  last_assistant_message: () => 'emulator: ok',
  stop_hook_active: () => false,
  background_tasks: () => [],
  session_crons: () => [],
  effort: () => ({ level: 'xhigh' }),
  duration_ms: () => 42,
  delta: () => '…',
  index: () => 0,
  final: () => true,
  agent_type: () => 'general-purpose',
  is_interrupt: () => false,
  error: () => 'emulated error',
  permission_suggestions: () => [],
  agent_transcript_path: () => '/tmp/subagent.jsonl',
  text: () => 'driven from the control centre',
  tool: () => 'Bash',
  toolId: () => `toolu_${uuid().replaceAll('-', '').slice(0, 20)}`,
  command: () => 'echo hi',
  input: () => ({ command: 'echo hi' }),
  output: () => 'ok',
};

export function defaultPayload(fields: readonly string[], skipEnvelope = true): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => !skipEnvelope || !ENVELOPE_FIELDS.has(field))
      .map((field) => [field, (defaults[field] ?? (() => ''))()]),
  );
}

export function setDotted(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (current[part] === null || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (last) current[last] = value;
}

export function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
