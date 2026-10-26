import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACP_SESSION_UPDATE_KINDS, GROK_RUNTIME_VERIFIED_UPDATES, grokExtensionEvents } from './adapter.js';
import { GrokUpdateNormalizer } from './pipeline.js';

interface GroundTruthEvent {
  event: string;
  variants?: { match: Record<string, string>; confidence: string }[];
}

const groundTruth = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../surface/vendors/grok/groundtruth.json'), 'utf8'),
) as { events: GroundTruthEvent[] };

function variants(event: string, verified: boolean): Set<string> {
  const document = groundTruth.events.find((entry) => entry.event === event);
  return new Set(
    (document?.variants ?? [])
      .filter((variant) => variant.confidence.startsWith('verified') === verified)
      .map((variant) => variant.match['update.sessionUpdate'])
      .filter((kind): kind is string => typeof kind === 'string'),
  );
}

function durable(method: string, update: Record<string, unknown>, promptId = 'prompt-1'): unknown {
  return {
    timestamp: 1_000_000_000,
    method,
    params: { sessionId: 'grok-session', update, _meta: { promptId, agentTimestampMs: 1_784_669_125_000 } },
  };
}

describe('Grok extension provenance and confidence', () => {
  it('labels exactly the runtime-verified xAI kinds of the selected ground truth authoritative', () => {
    const verified = new Set([
      ...variants('_x.ai/session_notification', true),
      ...variants('_x.ai/session/update', true),
    ]);
    expect([...GROK_RUNTIME_VERIFIED_UPDATES].sort()).toEqual([...verified].sort());
  });

  it('keeps the ACP branch list identical to the ground-truth session/update variants', () => {
    const acp = new Set([...variants('session/update', true), ...variants('session/update', false)]);
    expect([...ACP_SESSION_UPDATE_KINDS].sort()).toEqual([...acp].sort());
  });

  it('retains every durable xAI-only kind with Grok provenance instead of the generic ACP label', () => {
    const normalizer = new GrokUpdateNormalizer();
    const cases: [method: string, kind: string, confidence: string][] = [
      ['_x.ai/session/update', 'background_tasks', 'authoritative'],
      ['session/update', 'hook_run_started', 'authoritative'],
      ['session/update', 'last_turn_summary', 'authoritative'],
      ['session/update', 'tool_call_delta_chunk', 'authoritative'],
      ['_x.ai/session/update', 'compaction_checkpoint', 'authoritative'],
      ['session/update', 'model_changed', 'authoritative'],
      ['session/update', 'pending_interaction', 'authoritative'],
      ['session/update', 'interaction_resolved', 'authoritative'],
      // Mirror-source or binary-string leads only: retained, never promoted.
      ['session/update', 'served_model', 'inferred'],
      ['session/update', 'plan_kept', 'inferred'],
      ['_x.ai/session/update', 'login_refused', 'inferred'],
      ['_x.ai/session/update', 'backend_responsive', 'inferred'],
      ['_x.ai/session/update', 'session_ended', 'inferred'],
      ['session/update', 'never_seen_kind', 'inferred'],
    ];
    for (const [method, kind, confidence] of cases) {
      expect(normalizer.normalize(durable(method, { sessionUpdate: kind }))).toEqual([
        expect.objectContaining({
          promptId: 'prompt-1',
          source: 'native-log',
          confidence,
          event: { type: 'adapter:native-event', adapter: 'grok', nativeType: kind },
        }),
      ]);
    }
  });

  it('leaves standard ACP kinds on the standard carrier to ACP category normalization', () => {
    const normalizer = new GrokUpdateNormalizer();
    expect(
      normalizer
        .normalize(durable('session/update', { sessionUpdate: 'available_commands_update', availableCommands: [] }))
        .map(({ event }) => event),
    ).toEqual([{ type: 'adapter:native-event', adapter: 'acp', nativeType: 'available_commands_update' }]);
  });

  it('treats an xAI-carrier record as Grok-native even when its kind name collides with ACP', () => {
    const normalizer = new GrokUpdateNormalizer();
    expect(
      normalizer.normalize(durable('_x.ai/session/update', { sessionUpdate: 'plan', entries: [] })).map((e) => e.event),
    ).toEqual([{ type: 'adapter:native-event', adapter: 'grok', nativeType: 'plan' }]);
  });

  it('labels runtime-verified subagent endpoints authoritative', () => {
    const normalizer = new GrokUpdateNormalizer();
    const events = [
      durable('_x.ai/session/update', { sessionUpdate: 'subagent_spawned', subagent_id: 'c1', subagent_type: 'x' }),
      durable('_x.ai/session/update', { sessionUpdate: 'subagent_finished', subagent_id: 'c1', status: 'completed' }),
    ].flatMap((record) => normalizer.normalize(record));
    expect(events.map(({ event, confidence }) => [event.type, confidence])).toEqual([
      ['delegation:subagent-started', 'authoritative'],
      ['delegation:subagent-stopped', 'authoritative'],
    ]);
  });

  it('preserves live xAI identity for new 1.0.70 notifications', () => {
    for (const sessionUpdate of ['background_tasks', 'hook_run_started']) {
      expect(grokExtensionEvents('_x.ai/session_notification', { sessionId: 's', update: { sessionUpdate } })).toEqual([
        { type: 'adapter:native-event', adapter: 'grok', nativeType: sessionUpdate },
      ]);
    }
    expect(grokExtensionEvents('_x.ai/session/setup', { method: 'session/new', phase: 'auth' })).toEqual([
      { type: 'adapter:native-event', adapter: 'grok', nativeType: '_x.ai/session/setup' },
    ]);
  });
});
