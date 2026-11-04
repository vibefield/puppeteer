import assert from 'node:assert/strict';
import test from 'node:test';
import { replayAgentSurface } from './replay-agent-surface.mjs';

test('every committed native capture replays through its declared fidelity and Imposter event inventory', () => {
  for (const vendor of ['claude', 'codex', 'grok', 'kimi', 'opencode']) {
    const report = replayAgentSurface({
      vendor,
      ...(vendor === 'opencode' ? { groundTruthPath: 'packages/surface/vendors/opencode/groundtruth.json' } : {}),
    });
    assert.equal(report.status, 'passed', `${vendor}: ${JSON.stringify(report.issues, null, 2)}`);
    assert.ok(report.frames > 0, `${vendor} replay produced no frames`);
    assert.match(report.replayDigest, /^[0-9a-f]{64}$/);
  }
});

test('hermes replay shape-validates every tui_gateway frame, correlated result, server request, and plugin hook', () => {
  const report = replayAgentSurface({
    vendor: 'hermes',
    groundTruthPath: 'packages/surface/vendors/hermes/groundtruth.json',
  });
  assert.equal(report.status, 'passed', JSON.stringify(report.issues, null, 2));
  assert.ok(report.frames > 100);
  // Method results and the answer to the `approval` server request correlate through the census's inline
  // `"direction": "client"` marker; none may be skipped as unattributed.
  assert.equal(report.results, 17);
  assert.equal(report.unattributedResults, 0);
  assert.equal(report.captureFidelity.defaultRepresentation, 'type-preserving-redaction');
  assert.equal(report.shapeValidatedRecords, report.frames + report.results);
  assert.equal(report.projectionOnlyRecords, 0);
  assert.match(report.replayDigest, /^[0-9a-f]{64}$/);
});

test('inline-marked Hermes captures fail closed on an orphaned result in either direction', () => {
  const report = replayAgentSurface({
    vendor: 'hermes',
    groundTruthPath: 'packages/surface/vendors/hermes/groundtruth.json',
    capturesDir: 'scripts/fixtures/replay-hermes-orphan',
  });
  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.issues.map(({ kind }) => kind),
    ['unattributed-result', 'unattributed-result'],
  );
  assert.equal(report.unattributedResults, 2);
});

test('opencode replay covers exact SSE carriers and correlated HTTP results', () => {
  const report = replayAgentSurface({
    vendor: 'opencode',
    groundTruthPath: 'packages/surface/vendors/opencode/groundtruth.json',
  });
  assert.equal(report.status, 'passed', JSON.stringify(report.issues, null, 2));
  assert.ok(report.frames > 3_000);
  assert.ok(report.results > 100);
  assert.equal(report.captureFidelity.defaultRepresentation, 'type-preserving-redaction');
  assert.ok(report.shapeValidatedRecords > 3_000);
  assert.equal(report.projectionOnlyRecords, 0);
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
