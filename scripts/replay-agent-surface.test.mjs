import assert from 'node:assert/strict';
import test from 'node:test';
import { replayAgentSurface } from './replay-agent-surface.mjs';

test('every committed native capture replays exactly through its Imposter persona contract', () => {
  for (const vendor of ['claude', 'codex', 'grok', 'kimi', 'opencode']) {
    const report = replayAgentSurface({
      vendor,
      ...(vendor === 'opencode'
        ? { manifestPath: 'packages/surface/vendors/opencode/model/opencode@1.18.16/manifest.json' }
        : {}),
    });
    assert.equal(report.status, 'passed', `${vendor}: ${JSON.stringify(report.issues, null, 2)}`);
    assert.ok(report.frames > 0, `${vendor} replay produced no frames`);
    assert.match(report.replayDigest, /^[0-9a-f]{64}$/);
  }
});

test('hermes replay covers exact tui_gateway and plugin-hook carriers', () => {
  const report = replayAgentSurface({
    vendor: 'hermes',
    manifestPath: 'packages/surface/vendors/hermes/model/hermes@0.20.0/manifest.json',
  });
  assert.equal(report.status, 'passed', JSON.stringify(report.issues, null, 2));
  assert.ok(report.frames > 0);
  assert.match(report.replayDigest, /^[0-9a-f]{64}$/);
});

test('opencode replay covers exact SSE carriers and correlated HTTP results', () => {
  const report = replayAgentSurface({
    vendor: 'opencode',
    manifestPath: 'packages/surface/vendors/opencode/model/opencode@1.18.16/manifest.json',
  });
  assert.equal(report.status, 'passed', JSON.stringify(report.issues, null, 2));
  assert.ok(report.frames > 3_000);
  assert.ok(report.results > 100);
  assert.equal(report.unattributedResults, 0);
});

test('codex replay covers correlated results in both request directions', () => {
  const report = replayAgentSurface({ vendor: 'codex' });
  assert.ok(report.results >= 5);
  assert.ok(report.unattributedResults > 0, 'legacy server-output-only fixtures remain explicitly counted');
});

test('directional protocol captures fail closed on an orphaned result', () => {
  const report = replayAgentSurface({
    vendor: 'codex',
    capturesDir: 'scripts/fixtures/replay-codex-orphan',
  });
  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.issues.map(({ kind }) => kind),
    ['unattributed-result'],
  );
  assert.equal(report.unattributedResults, 1);
  assert.match(report.replayDigest, /^[0-9a-f]{64}$/);
});
