import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeVersionOutput,
  probeAgentArtifact,
  validateProbeMetadata,
  validateVersionOutput,
} from './probe-agent-artifact.mjs';

test('Copilot normalizes only its reviewed native version banner and fixed hint', () => {
  const raw = "GitHub Copilot CLI 1.0.105.\nRun 'copilot update' to check for updates.\n";
  assert.equal(normalizeVersionOutput(raw, '1.0.105', 'copilot-cli'), 'GitHub Copilot CLI 1.0.105.');
  assert.equal(
    normalizeVersionOutput(raw.replaceAll('\n', '\r\n'), '1.0.105', 'copilot-cli'),
    'GitHub Copilot CLI 1.0.105.',
  );
  assert.throws(() => normalizeVersionOutput(raw, '1.0.105'), /one bounded line/);
  assert.throws(() => normalizeVersionOutput(raw, '1.0.104', 'copilot-cli'), /reviewed two-line grammar/);
  assert.throws(
    () => normalizeVersionOutput(raw + 'unexpected output', '1.0.105', 'copilot-cli'),
    /reviewed two-line grammar/,
  );
});

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

test(
  'Antigravity version probes pin the native update switch and reject changed executable bytes',
  { skip: process.platform === 'win32' },
  () => {
    const parent = fileURLToPath(new URL('../.agent-adaptation/', import.meta.url));
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'probe-update-test-'));
    const artifact = join(root, 'agent');
    const script = '#!/bin/sh\n[ "$AGY_CLI_DISABLE_AUTO_UPDATE" = true ] || exit 23\nprintf "1.1.20\\n"\n';
    const options = {
      artifact,
      artifactKind: 'standalone-executable',
      vendor: 'antigravity',
      version: '1.1.20',
      output: join(root, 'version.txt'),
      home: join(root, 'home'),
    };
    try {
      writeFileSync(artifact, script);
      assert.equal(probeAgentArtifact(options), '1.1.20');
      writeFileSync(artifact, script + 'printf "# replaced\\n" >> "$0"\n');
      assert.throws(() => probeAgentArtifact(options), /artifact changed during the version probe/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
