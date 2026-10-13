import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNpmViewJson, spawnPackageManager } from './package-manager.mjs';
import { npmRegistry, readReleasePackages, releaseRepository, releaseWorkflow } from './release-packages.mjs';

// npm 12 emits one JSON object per trust record, rather than one JSON array.
export function parseTrustRecords(stdout) {
  if (!stdout.trim()) return [];
  const records = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < stdout.length; i += 1) {
    const char = stdout[i];
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== '{' && char !== '[') throw new Error('Unexpected npm trust response');
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        const data = JSON.parse(stdout.slice(start, i + 1));
        records.push(...(Array.isArray(data) ? data : [data]));
        start = -1;
      }
    }
  }
  if (start !== -1 || records.some((record) => !record || typeof record.type !== 'string')) {
    throw new Error('Invalid npm trust response');
  }
  return records;
}

export function matchesReleaseTrust(record) {
  return (
    record.type === 'github' &&
    record.repository === releaseRepository &&
    record.file === releaseWorkflow &&
    !record.environment &&
    Array.isArray(record.permissions) &&
    record.permissions.includes('createPackage')
  );
}

export async function configureTrust({
  root,
  checkOnly = false,
  run = spawnPackageManager,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
} = {}) {
  const packages = readReleasePackages(root);
  const npm = (args, options = {}) => run('npm', [...args, `--registry=${npmRegistry}`], { cwd: root, ...options });
  const versionResult = npm(['--version'], { encoding: 'utf8' });
  const version = /^(\d+)\.(\d+)\./.exec(versionResult.stdout ?? '');
  if (
    versionResult.status !== 0 ||
    !version ||
    Number(version[1]) < 11 ||
    (Number(version[1]) === 11 && Number(version[2]) < 15)
  ) {
    throw new Error('npm 11.15 or newer is required for npm trust');
  }
  const login = npm(['whoami', '--json'], { encoding: 'utf8' });
  if (login.status !== 0)
    throw new Error(
      `npm authentication failed; run npm login --registry=${npmRegistry} with a package-maintainer account`,
    );

  const missing = [];
  for (const { name } of packages) {
    const result = npm(['view', name, 'name', '--json', '--fetch-retries=2', '--fetch-timeout=15000'], {
      encoding: 'utf8',
      timeout: 60000,
    });
    let data;
    try {
      data = parseNpmViewJson(result.stdout);
    } catch {
      /* Report malformed or failed registry responses below. */
    }
    if (result.status !== 0 && data?.error?.code === 'E404' && !result.error) {
      missing.push(name);
      continue;
    }
    if (result.status !== 0 || data !== name)
      throw new Error(`Cannot verify npm package ${name}; resolve registry access before configuring trust`);
  }
  if (missing.length)
    throw new Error(
      `Initial authenticated publication is required before npm trust can be configured:\n${missing.join('\n')}`,
    );

  const list = (name) => {
    const read = () =>
      npm(['trust', 'list', name, '--json'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
    let result = read();
    let code;
    try {
      code = JSON.parse(result.stdout).error?.code;
    } catch {
      /* Normal output is a sequence of trust records. */
    }
    if (result.status !== 0 && code === 'EOTP' && interactive) {
      // npm only opens its 2FA flow when stdin AND stdout are terminals. Use
      // an interactive read to obtain the approval window, then capture JSON.
      log('Approve npm 2FA in your browser and enable the five-minute approval window for this package train.');
      const approval = npm(['trust', 'list', name], { stdio: 'inherit' });
      if (approval.status === 0) result = read();
    }
    if (result.status !== 0) {
      throw new Error(
        `Cannot inspect trust for ${name}; run npm trust list ${name} in your terminal, approve 2FA with the five-minute window, and verify package-maintainer access before retrying`,
      );
    }
    return parseTrustRecords(result.stdout);
  };
  const pending = [];
  for (const { name } of packages) {
    const records = list(name);
    if (records.some(matchesReleaseTrust)) {
      log(`${name}: release trust configured`);
      continue;
    }
    if (records.length)
      throw new Error(
        `${name} has a different trust configuration; review it in npm package settings before replacing it`,
      );
    pending.push(name);
  }
  if (checkOnly && pending.length)
    throw new Error(`Missing trust for ${releaseRepository} / ${releaseWorkflow}:\n${pending.join('\n')}`);
  for (const [index, name] of pending.entries()) {
    const result = npm(
      ['trust', 'github', name, '--file', releaseWorkflow, '--repo', releaseRepository, '--allow-publish', '--yes'],
      { stdio: 'inherit' },
    );
    if (result.status !== 0)
      throw new Error(
        `Could not configure npm trust for ${name}; previously configured packages will be skipped on retry`,
      );
    if (!list(name).some(matchesReleaseTrust)) throw new Error(`npm did not confirm the requested trust for ${name}`);
    if (index + 1 < pending.length) await wait(2000);
  }
  log(
    `Verified release trust configuration for ${packages.length} packages; a successful OIDC publish is still required to validate new trust`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const task = args.every((arg) => arg === '--check')
    ? configureTrust({ root: fileURLToPath(new URL('..', import.meta.url)), checkOnly: args.includes('--check') })
    : Promise.reject(new Error('Usage: node scripts/trust-packages.mjs [--check]'));
  task.catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
