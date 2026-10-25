import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  checkPromotionTree,
  parseRawDiff,
  promotionAllowlist,
  validatePromotionTransaction,
  writePromotionTransaction,
} from './promotion-transaction.mjs';

const vendor = 'fake';
const version = '1.0.0';

function git(repoRoot, ...args) {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const map = (groundTruth, extra = {}) =>
  `${JSON.stringify(
    {
      format: 'puppeteer-adapter-groundtruth-map/1',
      provider: vendor,
      groundTruthSha256: createHash('sha256').update(groundTruth).digest('hex'),
      semanticEvents: ['a'],
      ...extra,
    },
    null,
    2,
  )}\n`;

/** A repository holding every allowlisted file plus one that is not, committed as the attested base. */
function repository() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-promotion-transaction-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(join(repoRoot, path), content);
  };
  for (const path of promotionAllowlist({ vendor, version })) write(path, `${path} before\n`);
  write('packages/surface/vendors/fake/groundtruth.json', '{"version":"before"}\n');
  write('packages/adapter-fake/groundtruth-map.json', map('{"version":"before"}\n'));
  write('packages/adapter-fake/src/driver.ts', 'export {};\n');
  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'add', '--all');
  git(repoRoot, 'commit', '-q', '-m', 'base');
  const base = git(repoRoot, 'rev-parse', 'HEAD').trim();
  return { repoRoot, write, base };
}

/** The changes every real promotion makes: the ledger, the restored evidence, and the re-locked adapter. */
function promote({ repoRoot, write }) {
  write('support/agents.json', 'support/agents.json after\n');
  write('packages/surface/vendors/fake/model/fake@1.0.0/evidence.json', 'evidence after\n');
  write('packages/surface/vendors/fake/groundtruth.json', '{"version":"after"}\n');
  write('packages/adapter-fake/groundtruth-map.json', map('{"version":"after"}\n'));
  git(repoRoot, 'add', '--all');
}

test('the allowlist is derived from the vendor and version alone', () => {
  assert.deepEqual(promotionAllowlist({ vendor: 'grok', version: '1.0.70' }), [
    'support/agents.json',
    'README.md',
    'packages/surface/vendors/grok/groundtruth.json',
    'packages/surface/vendors/grok/groundtruth.html',
    'packages/surface/vendors/grok/model/grok@1.0.70/evidence.json',
    'packages/adapter-grok/groundtruth-map.json',
    'packages/adapter-grok/docs/event-map.html',
  ]);
  assert.throws(() => promotionAllowlist({ vendor: '../x', version }), /vendor/);
  assert.throws(() => promotionAllowlist({ vendor, version: '1.0.0 && x' }), /version/);
  assert.deepEqual(parseRawDiff(`:100644 120000 ${'a'.repeat(40)} ${'b'.repeat(40)} T\0README.md\0`), [
    { srcMode: '100644', dstMode: '120000', status: 'T', path: 'README.md' },
  ]);
});

test('a promotion that rewrites only its allowlisted files passes, staged and committed', () => {
  const fixture = repository();
  promote(fixture);
  const { repoRoot, base } = fixture;
  assert.deepEqual(checkPromotionTree({ repoRoot, vendor, version, base, staged: true }), []);
  git(repoRoot, 'commit', '-q', '-m', 'promote');
  assert.deepEqual(checkPromotionTree({ repoRoot, vendor, version, base, commit: 'HEAD' }), []);
  // What a hook (or anything else) adds to the commit itself is caught after `git commit` too.
  writeFileSync(join(repoRoot, 'hooked.txt'), 'x\n');
  git(repoRoot, 'add', 'hooked.txt');
  git(repoRoot, 'commit', '-q', '--amend', '--no-edit');
  assert.deepEqual(checkPromotionTree({ repoRoot, vendor, version, base, commit: 'HEAD' }), [
    'hooked.txt is outside the promotion allowlist',
  ]);
  git(repoRoot, 'rm', '-q', 'hooked.txt');
  git(repoRoot, 'commit', '-q', '--amend', '--no-edit');
  // A second commit on top is not the one promotion commit on the attested base.
  writeFileSync(join(repoRoot, 'README.md'), 'later\n');
  git(repoRoot, 'commit', '-q', '-am', 'later');
  assert.deepEqual(checkPromotionTree({ repoRoot, vendor, version, base, commit: 'HEAD' }), [
    `HEAD is not one commit directly on ${base}`,
  ]);
});

test('anything but rewriting allowlisted regular files is refused', () => {
  const cases = {
    'a path outside the allowlist': [
      ({ write }) => write('packages/adapter-fake/src/driver.ts', 'export const x = 1;\n'),
      ['packages/adapter-fake/src/driver.ts is outside the promotion allowlist'],
    ],
    'a new file': [
      ({ write }) => write('other/hooked.txt', 'x\n'),
      ['other/hooked.txt is outside the promotion allowlist'],
    ],
    'a deleted allowlisted file': [
      ({ repoRoot }) => rmSync(join(repoRoot, 'README.md')),
      ['README.md has status D; a promotion only rewrites existing files'],
    ],
    'a symlink in place of an allowlisted file': [
      ({ repoRoot }) => {
        rmSync(join(repoRoot, 'README.md'));
        symlinkSync('/etc/passwd', join(repoRoot, 'README.md'));
      },
      ['README.md has status T; a promotion only rewrites existing files'],
    ],
    'an executable bit': [
      ({ repoRoot }) => chmodSync(join(repoRoot, 'README.md'), 0o755),
      ['README.md changes mode 100644 to 100755; a promotion only rewrites regular files'],
    ],
  };
  for (const [name, [mutate, expected]] of Object.entries(cases)) {
    const fixture = repository();
    promote(fixture);
    mutate(fixture);
    git(fixture.repoRoot, 'add', '--all');
    assert.deepEqual(
      checkPromotionTree({ repoRoot: fixture.repoRoot, vendor, version, base: fixture.base, staged: true }),
      expected,
      name,
    );
  }
});

test('the adapter re-lock may move only its digest, and only to the promoted ground truth', () => {
  const remapped = repository();
  promote(remapped);
  remapped.write('packages/adapter-fake/groundtruth-map.json', map('{"version":"after"}\n', { semanticEvents: [] }));
  git(remapped.repoRoot, 'add', '--all');
  assert.deepEqual(
    checkPromotionTree({ repoRoot: remapped.repoRoot, vendor, version, base: remapped.base, staged: true }),
    ['adapter groundtruth-map.json changes more than its ground-truth digest; review the mapping first'],
  );

  const stale = repository();
  promote(stale);
  stale.write('packages/adapter-fake/groundtruth-map.json', map('{"version":"before"}\n'));
  git(stale.repoRoot, 'add', '--all');
  assert.deepEqual(checkPromotionTree({ repoRoot: stale.repoRoot, vendor, version, base: stale.base, staged: true }), [
    'adapter groundtruth-map.json does not lock the promoted ground truth',
  ]);
});

test('the write job applies only the transaction this run attempt prepared on this commit', () => {
  const fixture = repository();
  promote(fixture);
  const { repoRoot, base } = fixture;
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SHA: base,
    GITHUB_REPOSITORY: 'vibefield/puppeteer',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
  };
  const directory = join(repoRoot, '.transaction');
  const manifest = writePromotionTransaction({ repoRoot, vendor, version, base, directory, environment });
  assert.deepEqual(manifest.files, [
    'packages/adapter-fake/groundtruth-map.json',
    'packages/surface/vendors/fake/groundtruth.json',
    'packages/surface/vendors/fake/model/fake@1.0.0/evidence.json',
    'support/agents.json',
  ]);
  const patch = readFileSync(join(directory, 'promotion.patch'));
  const transaction = { manifest, patch, vendor, version };
  assert.deepEqual(validatePromotionTransaction({ ...transaction, environment }), []);
  assert.deepEqual(
    validatePromotionTransaction({ ...transaction, environment: { ...environment, GITHUB_RUN_ATTEMPT: '2' } }),
    ['transaction was not prepared in this workflow run attempt'],
  );
  assert.deepEqual(
    validatePromotionTransaction({ ...transaction, environment: { ...environment, GITHUB_SHA: 'e'.repeat(40) } }),
    ['transaction was not prepared on this commit'],
  );
  assert.deepEqual(validatePromotionTransaction({ ...transaction, patch: Buffer.from('x'), environment }), [
    'transaction patch does not match its manifest',
  ]);
  assert.deepEqual(validatePromotionTransaction({ ...transaction, version: '2.0.0', environment }), [
    'transaction is for a different candidate',
  ]);

  // A fresh checkout of the base applies the patch to exactly the prepared tree.
  const clone = mkdtempSync(join(tmpdir(), 'puppeteer-promotion-apply-'));
  execFileSync('git', ['clone', '-q', repoRoot, clone]);
  git(clone, 'checkout', '-q', base);
  git(clone, 'apply', '--index', join(directory, 'promotion.patch'));
  assert.deepEqual(checkPromotionTree({ repoRoot: clone, vendor, version, base, staged: true }), []);
  assert.equal(git(clone, 'write-tree').trim(), git(repoRoot, 'write-tree').trim());
});
