import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPackageManager } from './package-manager.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const configRoot = join(root, '.github', 'ci');

export function ghostteaSource(configDirectory = configRoot) {
  const config = JSON.parse(readFileSync(join(configDirectory, 'ghosttea.json'), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(config.revision) || config.patch !== 'ghosttea-sdk.patch') {
    throw new Error('Ghosttea CI requires an exact source revision and its SDK patch');
  }
  const patchPath = join(configDirectory, config.patch);
  const digest = createHash('sha256').update(readFileSync(patchPath)).digest('hex');
  if (digest !== config.patchSha256) throw new Error('Ghosttea SDK patch does not match its pinned digest');
  return { ...config, patchPath };
}

export function prepareGhosttea(destination = resolve(root, '..', 'ghosttea-0.11.2')) {
  // A developer's sibling checkout may contain unpublished work. Only create
  // a fresh checkout; never clean, reset, or patch an existing one.
  if (existsSync(destination)) throw new Error(`Refusing to overwrite existing Ghosttea checkout: ${destination}`);
  const source = ghostteaSource();
  const git = (...args) => execFileSync('git', args, { stdio: 'inherit' });
  git('init', '--quiet', destination);
  git('-C', destination, 'config', 'core.autocrlf', 'false');
  git('-C', destination, 'config', 'core.longpaths', 'true');
  git('-C', destination, 'remote', 'add', 'origin', source.repository);
  git('-C', destination, 'fetch', '--depth=1', 'origin', source.revision);
  git('-C', destination, 'sparse-checkout', 'set', 'packages', 'scripts');
  git('-C', destination, 'checkout', '--detach', 'FETCH_HEAD');
  const revision = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (revision !== source.revision) throw new Error(`Unexpected Ghosttea checkout revision: ${revision}`);
  git('-C', destination, 'apply', '--check', source.patchPath);
  git('-C', destination, 'apply', source.patchPath);
  for (const args of [
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['run', 'build:sdk'],
  ]) {
    const result = spawnPackageManager('npm', args, {
      cwd: destination,
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
    });
    if (result.status !== 0) throw new Error(`Ghosttea SDK ${args.join(' ')} failed`);
  }
  console.log(`Prepared Ghosttea SDK from ${source.revision} with pinned changes from ${source.sdkSourceRevision}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) throw new Error('Usage: node scripts/prepare-ghosttea-ci.mjs [new-checkout-directory]');
    prepareGhosttea(args[0] ? resolve(args[0]) : undefined);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
