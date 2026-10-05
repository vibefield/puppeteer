#!/usr/bin/env node

// THE ELECTRON 43 SIGTRAP PROBE (build-mv M14, M32; MV-5's deliverable 5).
//
// Twice in this program Electron 43's main process died with SIGTRAP when a
// window opened after another window — one whose page had run a dedicated
// worker — was destroyed (the SDK's bundling proof, and the goldens' capture,
// which reuses one window since). The swarm's physics now run in a worker the
// view brings (MV-D7), in every Godview window, so the risk is Godview's own:
// close a window, open another, and the app must live.
//
// This runs the REAL Godview (main, runtime, ghosttead, renderer) in a
// throwaway profile with every window offscreen (perf/offscreen-main.cjs's
// shape), and drives it from the main process:
//   1. the first window's swarm reports `physics: worker` (the slot's attribute,
//      never the view's DOM — W5);
//   2. a second window opens through Godview's own door (`window.desktop.newWindow`);
//   3. the FIRST window — the one whose page ran the worker — is destroyed;
//   4. a third window opens after it, and its swarm reports `worker` too.
// The main process then exits 0. A main process that dies instead comes back as
// a signal here, and the probe says so. Nothing is shown and no input reaches
// the operating system.
//
//   node worker-windows-probe.mjs        (from apps/godview, after `node build.mjs`)

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron');
// A throwaway HOME beside the profile, as the perf harness does: James's own Godview state (its
// restored workspace, its sessions) is never read, never written.
const runDirectory = mkdtempSync(join(tmpdir(), 'godview-worker-windows-probe-'));
const profile = join(runDirectory, 'profile');
const home = join(runDirectory, 'home');
mkdirSync(profile);
mkdirSync(home);
const environment = {
  ...process.env,
  HOME: home,
  TMPDIR: '/tmp',
  GHOSTTEA_TRUFFLE_ENABLED: 'false',
  NODE_OPTIONS: `--require ${join(appDirectory, 'worker-windows-probe-main.cjs')}`,
};
for (const key of [
  'GHOSTTEA_EXTERNAL_CONTROL_SOCKET',
  'GHOSTTEA_EXTERNAL_FRAME_SOCKET',
  'GHOSTTEA_EXTERNAL_AUTH_TOKEN',
  'ELECTRON_RUN_AS_NODE',
]) {
  delete environment[key];
}

try {
  const run = spawnSync(electron, [`--user-data-dir=${profile}`, '--use-mock-keychain', '.'], {
    cwd: appDirectory,
    env: environment,
    encoding: 'utf8',
    timeout: 180_000,
    killSignal: 'SIGKILL',
  });
  const lines = `${run.stdout ?? ''}`.split('\n').filter((line) => line.startsWith('PROBE'));
  for (const line of lines) console.log(line);
  // Electron can leave a helper behind its parent; only this run's directory names it (launcher-smoke's rule).
  spawnSync('pkill', ['-9', '-f', runDirectory]);
  if (run.signal) {
    console.log(`PROBE FAIL: electron died with ${run.signal}`);
    console.error(`${run.stderr ?? ''}`.split('\n').slice(-12).join('\n'));
    process.exitCode = 1;
  } else if (run.status !== 0) {
    console.log(`PROBE FAIL: electron exited ${run.status}`);
    console.error(`${run.stderr ?? ''}`.split('\n').slice(-12).join('\n'));
    process.exitCode = run.status ?? 1;
  } else {
    console.log('WORKER WINDOWS PROBE OK');
  }
} finally {
  rmSync(runDirectory, { recursive: true, force: true });
}
