import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveAgentModel } from './agent-model-selection.mjs';

test('active selection prefers a candidate while current remains explicit', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'chopsticks-selection-'));
  mkdirSync(join(repoRoot, 'support'), { recursive: true });
  const current = 'packages/surface/vendors/fake/model/fake@1.0.0/manifest.json';
  const candidate = 'packages/surface/vendors/fake/model/fake@1.1.0/manifest.json';
  for (const [path, version] of [
    [current, '1.0.0'],
    [candidate, '1.1.0'],
  ]) {
    mkdirSync(join(repoRoot, path, '..'), { recursive: true });
    writeFileSync(join(repoRoot, path), JSON.stringify({ vendor: 'fake', vendorVersion: version }));
  }
  writeFileSync(
    join(repoRoot, 'support', 'agents.json'),
    JSON.stringify({ agents: [{ id: 'fake', currentManifest: current, candidateManifest: candidate }] }),
  );

  assert.equal(resolveAgentModel({ repoRoot, vendor: 'fake' }).version, '1.1.0');
  assert.equal(resolveAgentModel({ repoRoot, vendor: 'fake', selection: 'current' }).version, '1.0.0');
});

test('selection rejects a manifest-shaped file outside the canonical vendor model tree', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'chopsticks-selection-path-'));
  mkdirSync(join(repoRoot, 'support'), { recursive: true });
  const manifest = 'review-output/fake@1.0.0/manifest.json';
  mkdirSync(join(repoRoot, manifest, '..'), { recursive: true });
  writeFileSync(join(repoRoot, manifest), JSON.stringify({ vendor: 'fake', vendorVersion: '1.0.0' }));
  writeFileSync(
    join(repoRoot, 'support', 'agents.json'),
    JSON.stringify({ agents: [{ id: 'fake', currentManifest: manifest }] }),
  );

  assert.throws(() => resolveAgentModel({ repoRoot, vendor: 'fake' }), /not the canonical fake Surface manifest path/);
});
