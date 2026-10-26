#!/usr/bin/env node
/**
 * The promotion commit's boundary. The read-only transaction job prepares the commit as a patch and checks it
 * here; the protected promote job (the only job holding contents: write) re-checks the same boundary with Node
 * built-ins alone, before and after `git commit`, so no package install or test code ever runs beside the write
 * token.
 *
 *   node scripts/promotion-transaction.mjs check --vendor <v> --version <x> --base <sha> (--staged | --commit <rev>)
 *   node scripts/promotion-transaction.mjs write --vendor <v> --version <x> --base <sha> --directory <dir>
 *   node scripts/promotion-transaction.mjs verify --vendor <v> --version <x> --directory <dir>
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
export const TRANSACTION_PATCH = 'promotion.patch';
export const TRANSACTION_MANIFEST = 'promotion.json';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** The only files a promotion of `vendor` at `version` may change, all of which already exist. */
export function promotionAllowlist({ vendor, version }) {
  if (!VENDOR.test(vendor ?? '')) throw new Error('vendor is required and must be normalized');
  if (!VERSION.test(version ?? '')) throw new Error('version must be an exact normalized vendor version');
  const vendorRoot = `packages/surface/vendors/${vendor}`;
  const adapter = `packages/adapter-${vendor}`;
  return [
    'support/agents.json',
    'README.md',
    `${vendorRoot}/groundtruth.json`,
    `${vendorRoot}/groundtruth.html`,
    `${vendorRoot}/model/${vendor}@${version}/evidence.json`,
    `${adapter}/groundtruth-map.json`,
    `${adapter}/docs/event-map.html`,
  ];
}

/** Parse `git diff --raw -z --no-renames --no-abbrev` (or `git diff-tree` with the same flags). */
export function parseRawDiff(output) {
  const fields = output.split('\0');
  const entries = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([A-Z])\d*$/.exec(fields[index]);
    if (!match || fields[index + 1] === undefined) {
      throw new Error(`unparseable raw diff entry ${JSON.stringify(fields[index])}`);
    }
    entries.push({ srcMode: match[1], dstMode: match[2], status: match[3], path: fields[index + 1] });
  }
  return entries;
}

/**
 * A promotion rewrites existing regular files on its allowlist and nothing else: no additions, deletions,
 * renames, mode or type changes (a symlink or submodule in place of an allowlisted file), and no other path.
 */
export function validatePromotionChanges({ entries, allowlist }) {
  const allowed = new Set(allowlist);
  const issues = [];
  for (const { srcMode, dstMode, status, path } of entries) {
    if (!allowed.has(path)) {
      issues.push(`${path} is outside the promotion allowlist`);
    } else if (status !== 'M') {
      issues.push(`${path} has status ${status}; a promotion only rewrites existing files`);
    } else if (srcMode !== '100644' || dstMode !== '100644') {
      issues.push(`${path} changes mode ${srcMode} to ${dstMode}; a promotion only rewrites regular files`);
    }
  }
  if (!entries.some(({ path }) => path === 'support/agents.json')) {
    issues.push('promotion does not change support/agents.json');
  }
  return issues.sort();
}

/**
 * Re-locking the adapter after the evidence restore may move only its ground-truth digest, and only to the
 * promoted ground truth's bytes: a mapping change (events, unmapped digest) needs its own review.
 */
export function validateAdapterMapChange({ before, after, groundTruth }) {
  let previous;
  let next;
  try {
    previous = JSON.parse(before);
    next = JSON.parse(after);
  } catch {
    return ['adapter groundtruth-map.json is not JSON'];
  }
  const issues = [];
  if (next?.groundTruthSha256 !== sha256(groundTruth)) {
    issues.push('adapter groundtruth-map.json does not lock the promoted ground truth');
  }
  const { groundTruthSha256: _previousDigest, ...previousRest } = previous ?? {};
  const { groundTruthSha256: _nextDigest, ...nextRest } = next ?? {};
  if (!isDeepStrictEqual(previousRest, nextRest)) {
    issues.push('adapter groundtruth-map.json changes more than its ground-truth digest; review the mapping first');
  }
  return issues;
}

function git(args, repoRoot, options = {}) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repoRoot,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Check the staged index (`staged`) or one commit (`commit`) against `base`: the allowlist, file modes, and
 * the adapter lock. Returns the issues; an empty list is a promotable change.
 */
export function checkPromotionTree({ repoRoot = root, vendor, version, base, staged = false, commit }) {
  if (!COMMIT.test(base ?? '')) return ['--base must be a full commit id'];
  if (staged === Boolean(commit)) return ['check exactly one of --staged or --commit'];
  const issues = [];
  let entries;
  let after;
  if (staged) {
    if (git(['rev-parse', 'HEAD'], repoRoot).trim() !== base) issues.push(`HEAD is not the attested base ${base}`);
    entries = parseRawDiff(git(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', base], repoRoot));
    after = (path, encoding) => git(['show', `:${path}`], repoRoot, { encoding });
  } else {
    const parents = git(['rev-list', '--parents', '-n', '1', commit], repoRoot).trim().split(' ').slice(1);
    if (parents.length !== 1 || parents[0] !== base) issues.push(`${commit} is not one commit directly on ${base}`);
    entries = parseRawDiff(
      git(['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-commit-id', base, commit], repoRoot),
    );
    after = (path, encoding) => git(['show', `${commit}:${path}`], repoRoot, { encoding });
  }
  const allowlist = promotionAllowlist({ vendor, version });
  issues.push(...validatePromotionChanges({ entries, allowlist }));
  const mapPath = `packages/adapter-${vendor}/groundtruth-map.json`;
  const groundTruthPath = `packages/surface/vendors/${vendor}/groundtruth.json`;
  issues.push(
    ...validateAdapterMapChange({
      before: git(['show', `${base}:${mapPath}`], repoRoot),
      after: after(mapPath),
      groundTruth: after(groundTruthPath, 'buffer'),
    }),
  );
  return issues.sort();
}

/** Write the staged change as the transaction artifact: the exact patch and what it is bound to. */
export function writePromotionTransaction({ repoRoot = root, vendor, version, base, directory, environment }) {
  const patch = git(
    ['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff', base],
    repoRoot,
    { encoding: 'buffer' },
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, TRANSACTION_PATCH), patch);
  const manifest = {
    schemaVersion: 1,
    vendor,
    version,
    base,
    repository: environment.GITHUB_REPOSITORY ?? null,
    runId: environment.GITHUB_RUN_ID ?? null,
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    patchSha256: sha256(patch),
    files: parseRawDiff(git(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', base], repoRoot)).map(
      ({ path }) => path,
    ),
  };
  writeFileSync(join(directory, TRANSACTION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * The transaction the write job applies must be this run attempt's, for this commit and candidate: a
 * re-run of the promote job alone (a new attempt) cannot commit a transaction an earlier attempt prepared.
 */
export function validatePromotionTransaction({ manifest, patch, vendor, version, environment }) {
  const issues = [];
  if (manifest?.schemaVersion !== 1) issues.push('transaction manifest has an unsupported schema');
  if (manifest?.vendor !== vendor || manifest?.version !== version) {
    issues.push('transaction is for a different candidate');
  }
  if (!COMMIT.test(manifest?.base ?? '') || manifest.base !== environment.GITHUB_SHA) {
    issues.push('transaction was not prepared on this commit');
  }
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    manifest?.repository !== environment.GITHUB_REPOSITORY ||
    manifest?.runId !== environment.GITHUB_RUN_ID ||
    manifest?.runAttempt !== environment.GITHUB_RUN_ATTEMPT
  ) {
    issues.push('transaction was not prepared in this workflow run attempt');
  }
  if (manifest?.patchSha256 !== sha256(patch)) issues.push('transaction patch does not match its manifest');
  return issues.sort();
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function insideRepo(path) {
  const absolute = resolve(root, path ?? '');
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

function refuse(issues) {
  if (issues.length === 0) return;
  console.error(`promotion transaction refused (${issues.length} issue(s)):`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const command = process.argv[2];
  const vendor = flag('--vendor');
  const version = flag('--version');
  if (command === 'check') {
    refuse(
      checkPromotionTree({
        vendor,
        version,
        base: flag('--base'),
        staged: process.argv.includes('--staged'),
        commit: flag('--commit'),
      }),
    );
    console.log(`promotion change for ${vendor} ${version} stays inside its allowlist`);
  } else if (command === 'write') {
    const base = flag('--base');
    refuse(checkPromotionTree({ vendor, version, base, staged: true }));
    const manifest = writePromotionTransaction({
      vendor,
      version,
      base,
      directory: insideRepo(flag('--directory')),
      environment: process.env,
    });
    console.log(`prepared the ${vendor} ${version} promotion of ${manifest.files.join(', ')}`);
  } else if (command === 'verify') {
    const directory = insideRepo(flag('--directory'));
    refuse(
      validatePromotionTransaction({
        manifest: JSON.parse(readFileSync(join(directory, TRANSACTION_MANIFEST), 'utf8')),
        patch: readFileSync(join(directory, TRANSACTION_PATCH)),
        vendor,
        version,
        environment: process.env,
      }),
    );
    console.log(`the ${vendor} ${version} transaction belongs to this run attempt and commit`);
  } else {
    console.error('usage: promotion-transaction.mjs check|write|verify --vendor <v> --version <x> …');
    process.exit(2);
  }
}
