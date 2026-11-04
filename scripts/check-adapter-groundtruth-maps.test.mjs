import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditAdapterGroundTruthMaps,
  buildAdapterGroundTruthMap,
  writeMaps,
} from './check-adapter-groundtruth-maps.mjs';

test('candidate lock refresh touches only the selected adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'puppeteer-map-scope-'));
  for (const vendor of ['codex', 'hermes']) {
    const adapter = join(root, 'packages', `adapter-${vendor}`);
    const surface = join(root, 'packages', 'surface', 'vendors', vendor);
    mkdirSync(join(adapter, 'src'), { recursive: true });
    mkdirSync(surface, { recursive: true });
    writeFileSync(join(adapter, 'groundtruth-map.json'), 'untouched');
    writeFileSync(join(surface, 'groundtruth.json'), JSON.stringify({ format: 'puppeteer-groundtruth/1', events: [] }));
  }
  writeMaps(root, ['hermes']);
  assert.equal(readFileSync(join(root, 'packages/adapter-codex/groundtruth-map.json'), 'utf8'), 'untouched');
  assert.equal(JSON.parse(readFileSync(join(root, 'packages/adapter-hermes/groundtruth-map.json'))).provider, 'hermes');
  assert.throws(() => writeMaps(root, ['../escape']), /unknown adapter provider/);
});

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
