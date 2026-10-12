import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditAdapterGroundTruthMaps, buildAdapterGroundTruthMap } from './check-adapter-groundtruth-maps.mjs';

test('every provider adapter is digest-locked to one canonical ground-truth classification', () => {
  assert.deepEqual(auditAdapterGroundTruthMaps(), []);
});

test('known semantic inputs are classified from adapter-owned normalization modules', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cases = [
    ['claude', 'SessionStart'],
    ['codex', 'turn/started'],
    ['grok', 'session/update'],
    ['hermes', 'message.delta'],
    ['kimi', 'llm.request'],
    ['opencode', 'session.status'],
  ];
  for (const [provider, event] of cases) {
    const map = buildAdapterGroundTruthMap(root, provider);
    assert.ok(
      map.semanticEvents.includes(event) || map.observedOrControlledEvents.includes(event),
      `${provider} must classify ${event}`,
    );
  }
});
