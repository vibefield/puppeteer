import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/puppeteer-core';
import { createClaudeScenarioRecorder } from './scenario-recorder.js';

function envelope(
  monotonicTime: number,
  nativeEvent: Record<string, unknown>,
  source: AgentEventEnvelope['source'] = 'native-hook',
): AgentEventEnvelope {
  return {
    type: 'adapter:native-event',
    service: 'adapter',
    sequence: monotonicTime + 1,
    sessionId: 'real-session',
    timestamp: '2026-08-10T00:00:00.000Z',
    monotonicTime,
    source,
    confidence: 'authoritative',
    event: { type: 'adapter:native-event', adapter: 'claude-code' },
    nativeEvent,
  };
}

describe('createClaudeScenarioRecorder', () => {
  it('turns raw Claude hooks into portable, ordered scenario steps', () => {
    let tick = 0;
    const recorder = createClaudeScenarioRecorder({
      now: () => new Date(`2026-08-10T00:00:0${tick++}.000Z`),
    });
    recorder.start({ runtimeSessionId: 'runtime-1', filePath: '/tmp/my-session.json', name: 'my-session' });

    recorder.capture(
      'runtime-1',
      envelope(100, {
        session_id: 'real-session',
        transcript_path: '/private/real.jsonl',
        cwd: '/private/repo',
        hook_event_name: 'UserPromptSubmit',
        prompt_id: 'prompt-1',
        prompt: 'hello',
      }),
    );
    recorder.capture(
      'runtime-1',
      envelope(350, {
        session_id: 'real-session',
        transcript_path: '/private/real.jsonl',
        cwd: '/private/repo',
        hook_event_name: 'Stop',
        prompt_id: 'prompt-1',
        last_assistant_message: 'done',
      }),
    );

    const document = recorder.document('runtime-1', true)!;
    expect(document.steps).toEqual([
      {
        at: 0,
        do: {
          emit: {
            channel: 'hook',
            event: 'UserPromptSubmit',
            with: { prompt_id: 'prompt-1', prompt: 'hello' },
          },
        },
      },
      {
        at: 250,
        do: {
          emit: {
            channel: 'hook',
            event: 'Stop',
            with: { prompt_id: 'prompt-1', last_assistant_message: 'done' },
          },
        },
      },
    ]);
    expect(document.recording).toMatchObject({ completed: true, eventCount: 2, droppedEventCount: 0 });
  });

  it('ignores non-hook projections and compresses long recordings for replay', () => {
    const recorder = createClaudeScenarioRecorder({ maxReplayDurationMs: 1_000 });
    recorder.start({ runtimeSessionId: 'runtime-1', filePath: '/tmp/long.json', name: 'long' });
    expect(
      recorder.capture('runtime-1', envelope(0, { hook_event_name: 'MessageDisplay' }, 'native-transcript')),
    ).toBeUndefined();
    recorder.capture('runtime-1', envelope(1_000, { hook_event_name: 'Notification', message: 'first' }));
    recorder.capture('runtime-1', envelope(11_000, { hook_event_name: 'Notification', message: 'last' }));

    const document = recorder.document('runtime-1')!;
    expect(document.steps.map((step) => step.at)).toEqual([0, 1_000]);
    expect(document.recording).toMatchObject({ originalDurationMs: 10_000, replayDurationMs: 1_000 });
  });

  it('records a raw hook once when normalization projects several Core events', () => {
    const recorder = createClaudeScenarioRecorder();
    recorder.start({ runtimeSessionId: 'runtime-1', filePath: '/tmp/once.json', name: 'once' });
    const nativeEvent = { hook_event_name: 'SessionStart', source: 'startup' };

    recorder.capture('runtime-1', envelope(10, nativeEvent));
    recorder.capture('runtime-1', envelope(11, nativeEvent));

    expect(recorder.document('runtime-1')?.steps).toHaveLength(1);
  });

  it('bounds captures to what the scenario runner and control plane can replay', () => {
    const recorder = createClaudeScenarioRecorder({ maxEvents: 1, maxPayloadBytes: 1_024 });
    recorder.start({ runtimeSessionId: 'runtime-1', filePath: '/tmp/bounded.json', name: 'bounded' });
    recorder.capture('runtime-1', envelope(0, { hook_event_name: 'Notification', message: 'kept' }));
    const status = recorder.capture('runtime-1', envelope(1, { hook_event_name: 'Notification', message: 'dropped' }));

    expect(status).toMatchObject({ eventCount: 1, droppedEventCount: 1, truncated: true });
    expect(recorder.document('runtime-1')?.steps).toHaveLength(1);
    expect(recorder.stop('runtime-1')).toMatchObject({ active: false, eventCount: 1 });
    expect(recorder.status('runtime-1')).toBeUndefined();
  });
});
