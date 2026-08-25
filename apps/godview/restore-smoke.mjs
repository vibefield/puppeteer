import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const profile = mkdtempSync(join(tmpdir(), 'godview-restore-smoke-'));
const environment = { ...process.env, GHOSTTEA_TRUFFLE_ENABLED: 'false' };

function run(phase) {
  return spawnSync(electron, [`--user-data-dir=${profile}`, '.', `--restore-smoke=${phase}`], {
    cwd: appDirectory,
    env: environment,
    stdio: 'inherit',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
}

try {
  const seeded = run('seed');
  if (seeded.error) throw seeded.error;
  if (seeded.status !== 73) {
    throw new Error(`restore seed exited ${seeded.status ?? seeded.signal ?? 'without status'} instead of 73`);
  }

  // Damage only the newest committed slot. The second Electron process must
  // reject its digest/schema and fall back to the other fsynced generation.
  const stateDirectory = join(profile, 'restore-state');
  const generations = readdirSync(stateDirectory)
    .filter((name) => /^restore-state-[01]\.json$/.test(name))
    .map((name) => {
      const path = join(stateDirectory, name);
      const envelope = JSON.parse(readFileSync(path, 'utf8'));
      return { path, generation: Number(envelope.generation) };
    })
    .sort((left, right) => right.generation - left.generation);
  if (generations.length !== 2 || !Number.isSafeInteger(generations[0]?.generation)) {
    throw new Error('restore seed did not create two journal generations');
  }
  writeFileSync(generations[0].path, '{"truncated":');

  const verified = run('verify');
  if (verified.error) throw verified.error;
  if (verified.status !== 0) process.exitCode = verified.status ?? 1;
} finally {
  rmSync(profile, { recursive: true, force: true });
}
