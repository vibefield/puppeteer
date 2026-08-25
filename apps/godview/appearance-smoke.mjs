import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const profile = mkdtempSync(join(tmpdir(), 'godview-appearance-smoke-'));

try {
  const result = spawnSync(electron, [`--user-data-dir=${profile}`, '.', '--appearance-smoke'], {
    cwd: appDirectory,
    env: { ...process.env, GHOSTTEA_TRUFFLE_ENABLED: 'false' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  rmSync(profile, { recursive: true, force: true });
}
