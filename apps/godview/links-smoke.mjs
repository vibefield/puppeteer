import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const profile = mkdtempSync(join(tmpdir(), 'godview-links-smoke-'));
const environment = { ...process.env, GHOSTTEA_TRUFFLE_ENABLED: 'false' };
for (const key of [
  'GHOSTTEA_EXTERNAL_CONTROL_SOCKET',
  'GHOSTTEA_EXTERNAL_FRAME_SOCKET',
  'GHOSTTEA_EXTERNAL_AUTH_TOKEN',
]) {
  delete environment[key];
}
try {
  const result = spawnSync(electron, [`--user-data-dir=${profile}`, '.', '--links-smoke'], {
    cwd: appDirectory,
    env: environment,
    stdio: 'inherit',
    timeout: 90_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  if (process.env.GODVIEW_KEEP_LINK_SMOKE === '1') console.log(`Link smoke artifacts: ${profile}`);
  else rmSync(profile, { recursive: true, force: true });
}
