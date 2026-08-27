import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireAgentArtifacts, assignmentMap } from './acquire-agent-artifacts.mjs';

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-acquire-'));
  const vendorRoot = join(repoRoot, 'packages/surface/vendors/fake');
  mkdirSync(join(vendorRoot, 'model/fake@1.2.3'), { recursive: true });
  writeFileSync(join(vendorRoot, 'upstream.json'), JSON.stringify({ platforms: ['darwin-arm64', 'linux-x64'] }));
  const first = join(repoRoot, 'darwin.bin');
  const second = join(repoRoot, 'linux.bin');
  writeFileSync(first, 'darwin');
  writeFileSync(second, 'linux');
  return { repoRoot, vendorRoot, first, second };
}

test('acquisition binds every required platform to bytes and version output without executing it', () => {
  const { repoRoot, first, second } = fixture();
  const report = acquireAgentArtifacts({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    artifacts: [
      { platform: 'darwin-arm64', path: first, versionOutput: 'fake 1.2.3' },
      { platform: 'linux-x64', path: second, versionOutput: 'fake-cli 1.2.3' },
    ],
    now: () => new Date('2026-08-09T00:00:00Z'),
  });
  assert.equal(report.status, 'complete');
  assert.equal(report.artifacts.length, 2);
  assert.ok(report.artifacts.every((artifact) => /^sha256:[0-9a-f]{64}$/.test(artifact.sha256)));
  assert.ok(report.artifacts.every((artifact) => !artifact.file.includes(repoRoot)));
});

test('same-version changed bytes are quarantined as a republished artifact', () => {
  const { repoRoot, vendorRoot, first, second } = fixture();
  writeFileSync(
    join(vendorRoot, 'model/fake@1.2.3/evidence.json'),
    JSON.stringify({
      artifacts: [{ platform: 'darwin-arm64', integrity: { sha256: `sha256:${'a'.repeat(64)}` } }],
    }),
  );
  const report = acquireAgentArtifacts({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    artifacts: [
      { platform: 'darwin-arm64', path: first, versionOutput: 'fake 1.2.3' },
      { platform: 'linux-x64', path: second, versionOutput: 'fake 1.2.3' },
    ],
  });
  assert.equal(report.status, 'republished-artifact');
  assert.equal(report.republished[0].platform, 'darwin-arm64');
});

test('CLI assignments reject repeated platform keys instead of silently replacing them', () => {
  assert.throws(
    () => assignmentMap('--artifact', ['darwin-arm64=first', 'darwin-arm64=second']),
    /repeats platform darwin-arm64/,
  );
});

test('executable attestation refuses source-only acquisition policies', () => {
  const { repoRoot, vendorRoot, first } = fixture();
  writeFileSync(
    join(vendorRoot, 'upstream.json'),
    JSON.stringify({ platforms: ['darwin-arm64'], acquisition: { strategy: 'source-revision' } }),
  );
  assert.throws(
    () =>
      acquireAgentArtifacts({
        repoRoot,
        vendor: 'fake',
        version: '1.2.3',
        artifacts: [{ platform: 'darwin-arm64', path: first, versionOutput: 'fake 1.2.3' }],
      }),
    /source archives require an installed-console attestation/,
  );
});
