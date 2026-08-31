import { describe, expect, it } from 'vitest';
import { AntigravityTranscriptNormalizer } from './pipeline.js';
describe('Antigravity transcript normalization', () => {
  it('maps a command turn using synthesized correlation without claiming a native tool id', () => {
    const normalizer = new AntigravityTranscriptNormalizer();
    expect(
      normalizer.normalize({
        type: 'USER_INPUT',
        step_index: 0,
        created_at: '2026-08-25T00:00:00Z',
        content: '<USER_REQUEST>run it</USER_REQUEST>',
      }).events[0],
    ).toEqual({ type: 'turn:started', turnId: 'turn:0', prompt: 'run it' });
    const request = normalizer.normalize({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      created_at: '2026-08-25T00:00:01Z',
      tool_calls: [{ name: 'run_command', args: { commandLine: 'echo ok' } }],
    });
    expect(request.events[0]).toMatchObject({
      type: 'tool:requested',
      toolCallId: 'step:1:tool:0',
      tool: 'run_command',
    });
    expect(
      normalizer.normalize({
        type: 'RUN_COMMAND',
        step_index: 2,
        created_at: '2026-08-25T00:00:02Z',
        status: 'DONE',
        exit_code: 0,
        content: 'ok',
      }).events[0],
    ).toMatchObject({ type: 'tool:completed', toolCallId: 'step:1:tool:0' });
    expect(
      normalizer
        .normalize({ type: 'PLANNER_RESPONSE', step_index: 3, created_at: '2026-08-25T00:00:03Z', content: 'done' })
        .events.map((event) => event.type),
    ).toEqual(['conversation:assistant-message', 'turn:completed']);
  });
  it('retains unknown native records', () => {
    const normalizer = new AntigravityTranscriptNormalizer();
    normalizer.normalize({ type: 'USER_INPUT', step_index: 0, content: 'go' });
    const request = normalizer.normalize({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      tool_calls: [
        {
          name: 'future',
          args: {},
        },
        {
          name: 'edit_file',
          args: { AbsolutePath: 'a.ts', TargetContent: '', ReplacementContent: 'added' },
        },
      ],
    });
    expect(request.events).toContainEqual({
      type: 'tool:requested',
      toolCallId: 'step:1:tool:0',
      tool: 'future',
      input: {},
      presentation: { kind: 'other', title: 'Using future' },
    });
    expect(request.events).toContainEqual({
      type: 'workspace:file-operation',
      toolCallId: 'step:1:tool:1',
      phase: 'proposed',
      changes: [
        {
          path: 'a.ts',
          kind: 'modify',
          details: [{ representation: 'replacement', basis: 'tool-input', oldText: '', newText: 'added' }],
        },
      ],
    });
    expect(normalizer.normalize({ type: 'FUTURE', step_index: 2 }).events).toEqual([
      { type: 'adapter:native-event', adapter: 'antigravity', nativeType: 'FUTURE' },
    ]);
  });
  it('retains ordinary CHECKPOINT records without inventing compaction', () => {
    const normalized = new AntigravityTranscriptNormalizer().normalize({
      type: 'CHECKPOINT',
      step_index: 2,
      status: 'DONE',
      content: 'turn checkpoint',
    });
    expect(normalized.disposition).toBe('retained-native');
    expect(normalized.events).toEqual([
      { type: 'adapter:native-event', adapter: 'antigravity', nativeType: 'CHECKPOINT' },
    ]);
  });
});
