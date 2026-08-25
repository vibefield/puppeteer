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
        'packages/surface/vendors/fake/model/fake@2.0.0/manifest.json',
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

test('candidate ledger may add only the requested candidate pointer', () => {
  const before = { agents: [{ id: 'fake', status: 'verified', currentManifest: 'old' }] };
  const after = {
    agents: [{ id: 'fake', status: 'verified', currentManifest: 'old', candidateManifest: 'new' }],
  };
  assert.deepEqual(validateCandidateLedger({ before, after, vendor: 'fake', manifest: 'new' }), []);
  after.agents[0].status = 'unsupported';
  assert.deepEqual(validateCandidateLedger({ before, after, vendor: 'fake', manifest: 'new' }), [
    'fake candidate staging changed promoted support fields',
  ]);
});

test('changed paths include deletions so the publisher cannot bypass its allowlist', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'chopsticks-candidate-paths-'));
  const runtime = join(repoRoot, 'packages', 'adapter-fake', 'src', 'runtime.ts');
  execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
  mkdirSync(join(runtime, '..'), { recursive: true });
  writeFileSync(runtime, 'export const runtime = true;\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync(
    'git',
    ['-c', 'user.name=Chopsticks Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '-m', 'fixture'],
    { cwd: repoRoot },
  );
  rmSync(runtime);

  assert.deepEqual(changedPaths('HEAD', repoRoot), ['packages/adapter-fake/src/runtime.ts']);
});
