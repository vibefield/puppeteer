const NO_OUTPUT_KIMI_RECORDS = new Set([
  'metadata',
  'permission.set_mode',
  'context.append_message',
  'context.apply_compaction',
  'llm.tools_snapshot',
  'usage.record',
  // 2.4.1 engine-journal projections of facts the canonical records above and
  // `turn.ended` already carry (`src/agent/loop/machine/storeJournal.ts`).
  'agent.message.appended',
  'agent.turn.started',
  'agent.turn.ended',
  // 2.4.1 session configuration snapshots with no portable meaning.
  'runtime.set_binding',
  'changeNotifier.snapshot',
  'plugin.session_start',
]);

export function kimiAdapterDisposition(type: string): 'no-output' | 'retained-native' {
  return NO_OUTPUT_KIMI_RECORDS.has(type) ? 'no-output' : 'retained-native';
}
