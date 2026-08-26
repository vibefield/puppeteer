import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveAgentModel } from './agent-model-selection.mjs';

test('active selection prefers a candidate while current remains explicit', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-selection-'));
  mkdirSync(join(repoRoot, 'support'), { recursive: true });
  const current = 'packages/surface/vendors/fake/model/fake@1.0.0/groundtruth.json';
  const candidate = 'packages/surface/vendors/fake/model/fake@1.1.0/groundtruth.json';
  for (const [path, version] of [
    [current, '1.0.0'],
    [candidate, '1.1.0'],
  ]) {
    mkdirSync(join(repoRoot, path, '..'), { recursive: true });
    writeFileSync(
      join(repoRoot, path),
      JSON.stringify({
        format: 'puppeteer-groundtruth/1',
        manifest: { vendor: 'fake', vendorVersion: version },
      }),
    );
  }
  writeFileSync(
    join(repoRoot, 'support', 'agents.json'),
    JSON.stringify({ agents: [{ id: 'fake', currentManifest: current, candidateManifest: candidate }] }),
  );

  assert.equal(resolveAgentModel({ repoRoot, vendor: 'fake' }).version, '1.1.0');
  assert.equal(resolveAgentModel({ repoRoot, vendor: 'fake', selection: 'current' }).version, '1.0.0');
});

test('selection rejects a ground-truth file outside the canonical vendor model tree', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-selection-path-'));
  mkdirSync(join(repoRoot, 'support'), { recursive: true });
  const manifest = 'review-output/fake@1.0.0/groundtruth.json';
  mkdirSync(join(repoRoot, manifest, '..'), { recursive: true });
  writeFileSync(
    join(repoRoot, manifest),
    JSON.stringify({
      format: 'puppeteer-groundtruth/1',
      manifest: { vendor: 'fake', vendorVersion: '1.0.0' },
    }),
  );
  writeFileSync(
    join(repoRoot, 'support', 'agents.json'),
    JSON.stringify({ agents: [{ id: 'fake', currentManifest: manifest }] }),
  );

  assert.throws(
    () => resolveAgentModel({ repoRoot, vendor: 'fake' }),
    /not the canonical fake Surface ground-truth path/,
  );
});
