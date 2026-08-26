const NO_OUTPUT_KIMI_RECORDS = new Set([
  'metadata',
  'permission.set_mode',
  'context.append_message',
  'context.apply_compaction',
  'llm.tools_snapshot',
  'usage.record',
]);

export function kimiAdapterDisposition(type: string): 'no-output' | 'retained-native' {
  return NO_OUTPUT_KIMI_RECORDS.has(type) ? 'no-output' : 'retained-native';
}
