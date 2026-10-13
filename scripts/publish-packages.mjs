import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNpmViewJson, spawnPackageManager } from './package-manager.mjs';
import { npmRegistry, packReleasePackages, readReleasePackages } from './release-packages.mjs';

export function assertReleaseCheckout(root, version, { provenance = false, environment = process.env } = {}) {
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error(
      'Publishing requires a clean checkout, including untracked files; use --dry-run to validate local changes',
    );
  }
  const tag = `v${version}`;
  let tagCommit;
  try {
    tagCommit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  } catch {
    throw new Error(`Missing ${tag}; Release Please must create the release tag before publication`);
  }
  if (tagCommit !== git(['rev-parse', 'HEAD'])) throw new Error(`Publishing requires HEAD to be exactly ${tag}`);
  if (
    provenance &&
    (environment.GITHUB_ACTIONS !== 'true' ||
      environment.GITHUB_REF !== `refs/tags/${tag}` ||
      environment.GITHUB_SHA !== tagCommit)
  ) {
    throw new Error('Provenance requires a GitHub workflow run from the matching release tag and commit');
  }
}

export function publicationProvenance(environment = process.env) {
  const value = environment.NPM_CONFIG_PROVENANCE;
  if (value === 'true') return true;
  if (value === 'false' || (value === undefined && environment.GITHUB_ACTIONS !== 'true')) return false;
  throw new Error('The release workflow must set NPM_CONFIG_PROVENANCE to true or false');
}

export function registryHasVersion(name, version, { root, run = spawnPackageManager } = {}) {
  const result = run(
    'npm',
    [
      'view',
      `${name}@${version}`,
      'version',
      '--json',
      `--registry=${npmRegistry}`,
      '--fetch-retries=2',
      '--fetch-timeout=15000',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  let data;
  try {
    data = parseNpmViewJson(result.stdout);
  } catch {
    /* A failed process may have no JSON response. */
  }
  if (result.status === 0 && data === version) return true;
  if (result.status !== 0 && data?.error?.code === 'E404' && !result.error) return false;
  // Never interpret a login, permission, or registry outage as an unpublished
  // version. Do not echo registry responses: they can include authentication URLs.
  throw new Error(
    `Cannot verify ${name}@${version} on npm (${data?.error?.code ?? result.error?.code ?? `exit ${result.status}`}); publication stopped`,
  );
}

function assertLatestWillNotRegress(pkg, root, run) {
  const result = run(
    'npm',
    [
      'view',
      pkg.name,
      'dist-tags.latest',
      '--json',
      `--registry=${npmRegistry}`,
      '--fetch-retries=2',
      '--fetch-timeout=15000',
    ],
    { cwd: root, encoding: 'utf8', timeout: 60000 },
  );
  let data;
  try {
    data = parseNpmViewJson(result.stdout);
  } catch {
    /* Fail closed on unexpected registry output. */
  }
  if (result.status !== 0 && data?.error?.code === 'E404' && !result.error) return;
  // An existing package may have no latest tag after a maintainer removes it.
  if (result.status === 0 && !result.stdout.trim()) return;
  const match = typeof data === 'string' && /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(data);
  if (result.status !== 0 || !match)
    throw new Error(`Cannot verify the latest dist-tag for ${pkg.name}; publication stopped`);
  const target = pkg.version.split('.').map(Number);
  const comparison =
    match
      .slice(1, 4)
      .map((part, index) => Number(part) - target[index])
      .find((difference) => difference !== 0) ?? 0;
  if (comparison > 0)
    throw new Error(`${pkg.name} latest is ${data}; refusing to replace it with older ${pkg.version}`);
}

export async function publishReleasePackages(
  packed,
  {
    root,
    run = spawnPackageManager,
    provenance = publicationProvenance(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    verificationTimeoutMs = 10 * 60_000,
    now = Date.now,
    log = console.log,
  } = {},
) {
  // Complete every registry read before the first write. An outage on a later
  // package must not cause an avoidable partial release.
  const plan = packed.map((pkg) => ({ ...pkg, published: registryHasVersion(pkg.name, pkg.version, { root, run }) }));
  for (const pkg of plan.filter((pkg) => !pkg.published)) assertLatestWillNotRegress(pkg, root, run);
  const verifyVisible = async (packages) => {
    const deadline = now() + verificationTimeoutMs;
    let pending = packages;
    while (pending.length) {
      pending = pending.filter((pkg) => {
        if (!registryHasVersion(pkg.name, pkg.version, { root, run })) return true;
        log(`${pkg.name}@${pkg.version} verified on npm`);
        return false;
      });
      if (!pending.length) return;
      if (now() >= deadline) {
        throw new Error(
          `Versions not visible on npm: ${pending.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}; retry this same release after npm finishes processing or the error is resolved`,
        );
      }
      await wait(Math.min(5000, Math.max(0, deadline - now())));
    }
  };
  const accepted = [];
  for (const pkg of plan) {
    const spec = `${pkg.name}@${pkg.version}`;
    if (pkg.published) {
      log(`${spec} already published; skipping`);
      continue;
    }
    const result = run(
      'npm',
      [
        'publish',
        pkg.tarballPath,
        '--access',
        'public',
        `--registry=${npmRegistry}`,
        '--tag',
        'latest',
        `--provenance=${provenance}`,
        '--ignore-scripts',
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (result.status !== 0) {
      // A publish can succeed server-side and lose its response. Resolve that
      // ambiguity before submitting any further packages, without uploading twice.
      await verifyVisible([pkg]);
    } else {
      // npm can accept uploads asynchronously. Submit the train while the 2FA
      // approval is valid, then require every accepted version to become visible.
      accepted.push(pkg);
      log(`${spec} accepted by npm; awaiting registry processing`);
    }
  }
  await verifyVisible(accepted);
}

export async function main(
  args = process.argv.slice(2),
  { root = fileURLToPath(new URL('..', import.meta.url)), run = spawnPackageManager, environment = process.env } = {},
) {
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('Usage: node scripts/publish-packages.mjs [--dry-run]');
  const dryRun = args.includes('--dry-run');
  const descriptors = readReleasePackages(root);
  const version = descriptors[0].version;
  const provenance = dryRun ? false : publicationProvenance(environment);
  if (!dryRun) assertReleaseCheckout(root, version, { provenance, environment });
  const destination = mkdtempSync(join(tmpdir(), 'puppeteer-publish-'));
  try {
    const packed = packReleasePackages(root, destination, descriptors, run);
    if (dryRun) {
      console.log(`Dry run: validated ${packed.length} tarballs for v${version}; no registry requests or uploads`);
      return;
    }
    assertReleaseCheckout(root, version, { provenance, environment });
    await publishReleasePackages(packed, { root, provenance, run });
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
