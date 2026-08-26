import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedPaths, validateCandidateLedger, validateCandidatePaths } from './validate-agent-candidate-changes.mjs';

test('candidate publisher rejects runtime source and raw evidence changes', () => {
  assert.deepEqual(
    validateCandidatePaths({
      vendor: 'fake',
      version: '2.0.0',
      persona: 'fake',
      paths: [
        'packages/surface/vendors/fake/groundtruth.json',
        'packages/surface/vendors/fake/captures-raw/fake@2.0.0/secret.jsonl',
        'packages/adapter-fake/src/normalizer.ts',
      ],
    }),
    [
      'candidate publisher may not modify packages/adapter-fake/src/normalizer.ts',
      'candidate publisher may not modify packages/surface/vendors/fake/captures-raw/fake@2.0.0/secret.jsonl',
    ],
  );
});

test('candidate ledger may add only the stable path and requested candidate version', () => {
  const before = { agents: [{ id: 'fake', status: 'verified', currentVersion: '1.0.0' }] };
  const after = {
    agents: [
      {
        id: 'fake',
        status: 'verified',
        groundTruth: 'packages/surface/vendors/fake/groundtruth.json',
        currentVersion: '1.0.0',
        candidateVersion: '2.0.0',
      },
    ],
  };
  assert.deepEqual(
    validateCandidateLedger({
      before,
      after,
      vendor: 'fake',
      groundTruth: 'packages/surface/vendors/fake/groundtruth.json',
      version: '2.0.0',
    }),
    [],
  );
  after.agents[0].status = 'unsupported';
  assert.deepEqual(
    validateCandidateLedger({
      before,
      after,
      vendor: 'fake',
      groundTruth: 'packages/surface/vendors/fake/groundtruth.json',
      version: '2.0.0',
    }),
    ['fake candidate staging changed promoted support fields'],
  );
});

test('changed paths include deletions so the publisher cannot bypass its allowlist', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-candidate-paths-'));
  const runtime = join(repoRoot, 'packages', 'adapter-fake', 'src', 'runtime.ts');
  execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
  mkdirSync(join(runtime, '..'), { recursive: true });
  writeFileSync(runtime, 'export const runtime = true;\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync(
    'git',
    ['-c', 'user.name=Puppeteer Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '-m', 'fixture'],
    { cwd: repoRoot },
  );
  rmSync(runtime);

  assert.deepEqual(changedPaths('HEAD', repoRoot), ['packages/adapter-fake/src/runtime.ts']);
});
