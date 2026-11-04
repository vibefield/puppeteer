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

test('a monitor-capability family that shares a native event name does not mark that event consumed', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Pi's monitor capabilities declare the Core `usage` family; Pi 1.5.0's writer-only `usage` entry is not consumed.
  const map = buildAdapterGroundTruthMap(root, 'pi');
  for (const event of ['usage', 'context_edit']) {
    assert.ok(!map.semanticEvents.includes(event), `pi must not classify ${event} as semantic`);
    assert.ok(!map.observedOrControlledEvents.includes(event), `pi must not classify ${event} as observed`);
  }
  assert.ok(map.semanticEvents.includes('message'));
  assert.equal(map.totals.semantic, 5);
});
