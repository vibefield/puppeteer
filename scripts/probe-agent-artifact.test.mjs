import assert from 'node:assert/strict';
import test from 'node:test';
import { probeAgentArtifact, validateProbeMetadata, validateVersionOutput } from './probe-agent-artifact.mjs';

test('version probes require the exact requested version in one bounded line', () => {
  assert.equal(validateVersionOutput('codex-cli 0.147.0\n', '0.147.0'), 'codex-cli 0.147.0');
  assert.throws(() => validateVersionOutput('codex-cli 0.147.1', '0.147.0'), /does not identify/);
  assert.throws(() => validateVersionOutput('first\nsecond', '0.147.0'), /one bounded line/);
});

test('probes require download metadata for the same standalone executable', () => {
  const metadata = {
    artifactKind: 'standalone-executable',
    version: '1.2.3',
    output: '.agent-adaptation/artifacts/linux-x64/agent',
  };
  assert.equal(
    validateProbeMetadata(metadata, {
      artifact: '.agent-adaptation/artifacts/linux-x64/agent',
      version: '1.2.3',
    }),
    metadata,
  );
  assert.throws(
    () => validateProbeMetadata({ ...metadata, artifactKind: 'source-archive' }, metadata),
    /cannot execute artifact kind source-archive/,
  );
  assert.throws(
    () => validateProbeMetadata(metadata, { artifact: metadata.output, version: '1.2.4' }),
    /version differs/,
  );
});

test('the probe refuses source archives before touching their bytes', () => {
  assert.throws(() => probeAgentArtifact({ artifactKind: 'source-archive' }), /cannot execute artifact kind/);
});
