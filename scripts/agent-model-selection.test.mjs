import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveAgentModel } from './agent-model-selection.mjs';

function fixture({ groundTruth = 'packages/surface/vendors/fake/groundtruth.json', version = '1.1.0' } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-selection-'));
  mkdirSync(join(repoRoot, 'support'), { recursive: true });
  mkdirSync(join(repoRoot, groundTruth, '..'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/surface/vendors/fake/model', `fake@${version}`), { recursive: true });
  writeFileSync(
    join(repoRoot, groundTruth),
    JSON.stringify({ format: 'puppeteer-groundtruth/1', manifest: { vendor: 'fake', vendorVersion: version } }),
  );
  writeFileSync(
    join(repoRoot, 'packages/surface/vendors/fake/model', `fake@${version}`, 'manifest.json'),
    JSON.stringify({ vendor: 'fake', vendorVersion: version }),
  );
  return { repoRoot, groundTruth };
}

test('selection derives active authoring inputs from the stable canonical file', () => {
  const { repoRoot, groundTruth } = fixture();
  writeFileSync(
    join(repoRoot, 'support', 'agents.json'),
    JSON.stringify({
      agents: [
        {
          id: 'fake',
          groundTruth,
          currentVersion: '1.0.0',
          candidateVersion: '1.1.0',
        },
      ],
    }),
  );

  const selected = resolveAgentModel({ repoRoot, vendor: 'fake' });
  assert.equal(selected.version, '1.1.0');
  assert.equal(selected.groundTruthRelative, groundTruth);
  assert.equal(selected.modelRoot, join(repoRoot, 'packages/surface/vendors/fake/model/fake@1.1.0'));
});

test('selection rejects a ground-truth file outside the canonical vendor root', () => {
  const { repoRoot, groundTruth } = fixture({ groundTruth: 'review-output/groundtruth.json', version: '1.0.0' });
  writeFileSync(
    join(repoRoot, 'support', 'agents.json'),
    JSON.stringify({ agents: [{ id: 'fake', groundTruth, currentVersion: '1.0.0' }] }),
  );

  assert.throws(
    () => resolveAgentModel({ repoRoot, vendor: 'fake' }),
    /not the canonical fake Surface ground-truth path/,
  );
});

test('selection rejects a canonical document that disagrees with support state', () => {
  const { repoRoot, groundTruth } = fixture({ version: '1.1.0' });
  writeFileSync(
    join(repoRoot, 'support', 'agents.json'),
    JSON.stringify({ agents: [{ id: 'fake', groundTruth, currentVersion: '1.0.0' }] }),
  );

  assert.throws(() => resolveAgentModel({ repoRoot, vendor: 'fake' }), /support ledger selects 1\.0\.0/);
});
