import assert from 'node:assert/strict';
import test from 'node:test';
import { auditAdapterGroundTruthMaps, buildAdapterGroundTruthMap } from './check-adapter-groundtruth-maps.mjs';

test('every provider adapter is locked to one immutable ground-truth classification', () => {
  assert.deepEqual(auditAdapterGroundTruthMaps(), []);
});

test('known semantic inputs are classified from adapter-owned normalization modules', () => {
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const cases = [
    ['claude', '2.1.226', 'SessionStart'],
    ['codex', '0.147.0', 'turn/started'],
    ['grok', '1.0.0', 'signals.json'],
    ['hermes', '0.20.0', 'message.delta'],
    ['kimi', '0.34.0', 'llm.request'],
    ['opencode', '1.18.16', 'session.status'],
  ];
  for (const [provider, version, event] of cases) {
    const map = buildAdapterGroundTruthMap(root, provider, version);
    assert.ok(
      map.semanticEvents.includes(event) || map.observedOrControlledEvents.includes(event),
      `${provider} must classify ${event}`,
    );
  }
});
