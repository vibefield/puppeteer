#!/usr/bin/env node

// Godview's paired perf harness (MV-0; build-mv L14, L17; README.md beside this file). It runs
// the REAL app — main, runtime, ghosttead, renderer — with imposter agents that change state on a
// fixed schedule, and measures each monitor view: frame time (p50/p95 of rAF deltas), long
// animation frames, and the React commits that rendered the view. Two builds are compared
// interleaved in one session, judged against an A/A null arm:
//
//   node perf/harness.mjs                                  A/A on this app (the baseline)
//   node perf/harness.mjs --b /path/to/other/apps/godview   A/B/A' rounds (A is --a, this app by default)
//   options: --rounds 7 · --counts 10,20,60 · --views swarm,list,rain,timeline · --warmup-ms 3000
//            --window-ms 10000 · --step-ms 3000 · --fps 60 · --load-max 60 · --out <dir>
//
// Seven paired rounds before z is read (build-mv M24).
//
// Every launch is offscreen (offscreen-main.cjs): never shown, no focus taken, frames at a fixed
// 60 Hz. It runs under a temporary HOME and profile, so it touches no real agent configuration,
// history or account; the agents are the imposter (packages/imposter), driven over its control
// channel (control-plane.mjs). Before each launch the harness waits for the 1-minute load average
// to fall below --load-max and records the load beside that run's numbers.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPage } from './cdp.mjs';
import { startControlPlane } from './control-plane.mjs';
import { summarise } from './summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const thisApp = join(here, '..');
const repo = join(thisApp, '../..');
const electron = createRequire(import.meta.url)('electron');
const imposter = join(repo, 'packages/imposter/bin/ai.mjs');
const VIEW_LABELS = { swarm: 'SWARM', list: 'LIST', rain: 'RAIN', timeline: 'TIMELINE' };
const PROJECTS = 6;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const config = {
  a: resolve(option('a', thisApp)),
  b: option('b') ? resolve(option('b')) : undefined,
  rounds: Number(option('rounds', 7)),
  counts: option('counts', '10,20,60').split(',').map(Number),
  views: option('views', 'swarm,list,rain,timeline').split(','),
  warmupMs: Number(option('warmup-ms', 3000)),
  windowMs: Number(option('window-ms', 10_000)),
  stepMs: Number(option('step-ms', 3000)),
  fps: Number(option('fps', 60)),
  loadMax: Number(option('load-max', 60)),
  loadWaitMs: Number(option('load-wait-ms', 45 * 60_000)),
  out: resolve(option('out', join(thisApp, 'perf/runs', new Date().toISOString().replace(/[:.]/g, '-')))),
};

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
/** What an interrupted run must still tear down: the launched app's process group and its run dir. */
const cleanups = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const cleanup of cleanups) cleanup();
    process.exit(130);
  });
}
const log = (message) => console.log(`[perf ${new Date().toISOString().slice(11, 19)}] ${message}`);

async function until(what, probe, timeoutMs = 60_000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    await delay(everyMs);
  }
}

/** L17: measure only once the machine has room, and say how loaded it was. */
async function waitForLoad() {
  const started = Date.now();
  while (loadavg()[0] >= config.loadMax) {
    if (Date.now() - started > config.loadWaitMs) {
      throw new Error(`load average stayed at or above ${config.loadMax} for ${config.loadWaitMs / 60_000} min`);
    }
    log(`load ${loadavg()[0].toFixed(1)} ≥ ${config.loadMax}; waiting`);
    await delay(15_000);
  }
  return { waitedMs: Date.now() - started, load: loadavg().map((value) => Number(value.toFixed(2))) };
}

/**
 * Each agent walks one turn — prompt, a read, a guarded command that waits on permission, the
 * command, the answer — a step every `stepMs`, its phase offset by its place, so the field
 * changes at n / stepMs a second: working, working, blocked, working, idle.
 */
const TURN = [
  ['turn.start', { text: 'Run the suite and fix what fails' }],
  ['tool.start', { tool: 'Read', input: { file_path: 'src/index.ts' } }],
  ['tool.end', { tool: 'Read', input: { file_path: 'src/index.ts' }, output: 'ok' }],
  ['tool.start', { tool: 'Bash', input: { command: 'pnpm test' } }],
  ['permission.ask', { tool: 'Bash', input: { command: 'pnpm test' } }],
  ['tool.end', { tool: 'Bash', input: { command: 'pnpm test' }, output: 'ok' }],
  ['turn.end', { text: 'Done: the suite is green.' }],
];

function startDriver(plane, stepMs) {
  const timers = new Map();
  const stats = { sent: 0, failed: 0, lastError: undefined };
  let stopped = false;
  const drive = (session, index, total) => {
    let position = 0;
    const tick = () => {
      if (stopped || !plane.sessions.has(session.sessionId)) return;
      const [op, args] = TURN[position % TURN.length];
      position += 1;
      stats.sent += 1;
      session.op(op, args).catch((error) => {
        stats.failed += 1;
        stats.lastError = error instanceof Error ? error.message : String(error);
      });
      timers.set(session.sessionId, setTimeout(tick, stepMs));
    };
    timers.set(session.sessionId, setTimeout(tick, Math.round((index / Math.max(1, total)) * stepMs)));
  };
  return {
    stats,
    add(sessions) {
      const all = [...plane.sessions.values()];
      for (const session of sessions) drive(session, all.indexOf(session), all.length);
    },
    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
    },
  };
}

function frameStats(deltas) {
  const sorted = [...deltas].sort((left, right) => left - right);
  const at = (q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

/** One launch of one build: agents up to each count in turn, every view measured at each. */
async function runArm(appDir, round, label, viewOrder) {
  const runDir = mkdtempSync('/tmp/gvp-');
  const profile = join(runDir, 'profile');
  const home = join(runDir, 'home');
  const bin = join(runDir, 'bin');
  for (const directory of [profile, home, bin]) mkdirSync(directory, { recursive: true });
  for (let project = 0; project < PROJECTS; project += 1) {
    mkdirSync(join(runDir, `projects/project-${project}`), { recursive: true });
  }
  const gate = join(runDir, 'gate');
  const socketPath = join(runDir, 'ctl.sock');
  const tokenPath = join(runDir, 'ctl.token');
  const plane = await startControlPlane({ socketPath, tokenPath });
  // Godview hands an agent a clean environment, so the wrapper carries the imposter's own settings.
  const wrapper = join(bin, 'claude');
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'export PUPPETEER_IMPOSTER_TUI=off',
      `export PUPPETEER_IMPOSTER_SOCKET='${socketPath}'`,
      `export PUPPETEER_IMPOSTER_TOKEN_FILE='${tokenPath}'`,
      `exec '${process.execPath}' '${imposter}' --claude "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);

  const environment = {
    ...process.env,
    HOME: home,
    TMPDIR: '/tmp',
    GHOSTTEA_TRUFFLE_ENABLED: 'false',
    PUPPETEER_CLAUDE_BIN: wrapper,
    PUPPETEER_IMPOSTER_BIN: imposter,
    NODE_OPTIONS: `--require ${join(here, 'offscreen-main.cjs')}`,
    GODVIEW_PERF_DPR: '2',
    GODVIEW_PERF_FPS: String(config.fps),
    GODVIEW_PERF_GATE: gate,
  };
  for (const key of [
    'GHOSTTEA_EXTERNAL_CONTROL_SOCKET',
    'GHOSTTEA_EXTERNAL_FRAME_SOCKET',
    'GHOSTTEA_EXTERNAL_AUTH_TOKEN',
  ]) {
    delete environment[key];
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  const output = openSync(join(config.out, `round${round}-${label}.log`), 'w');
  const child = spawn(
    electron,
    [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', appDir],
    { cwd: appDir, env: environment, stdio: ['ignore', output, output], detached: true },
  );
  let page;
  let driver;
  const measurements = [];
  const abandon = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    spawnSync('pkill', ['-9', '-f', runDir]);
    rmSync(runDir, { recursive: true, force: true });
  };
  cleanups.add(abandon);
  try {
    const port = await until(
      'the DevTools port',
      async () =>
        existsSync(join(profile, 'DevToolsActivePort')) &&
        readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]?.trim(),
    );
    // The window is still blank: offscreen-main.cjs holds its document until the gate opens.
    const target = await until('the Godview window', async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find((candidate) => candidate.type === 'page');
    });
    page = await connectPage(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: readFileSync(join(here, 'page-probe.js'), 'utf8'),
    });
    writeFileSync(gate, '');
    await until('the probe and the monitor stage', async () => {
      const parts = await page.evaluate(
        `({ probe: Boolean(window.__gvPerf), hook: window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size ?? 0, stage: Boolean(document.querySelector('section.vf-godview-monitor-stage')), bridge: Boolean(window.puppeteer), url: location.href })`,
      );
      if (parts.probe && parts.stage && parts.bridge) return parts;
      throw new Error(JSON.stringify(parts));
    }).then((parts) => log(`page ready: ${JSON.stringify(parts)}`));
    driver = startDriver(plane, config.stepMs);
    let spawned = 0;
    for (const count of config.counts) {
      const before = new Set(plane.sessions.keys());
      while (spawned < count) {
        const batch = Math.min(10, count - spawned);
        const results = await page.evaluate(
          `Promise.all(Array.from({ length: ${batch} }, (_, i) => window.puppeteer.createAgentSession({ agent: 'claude', cwd: ${JSON.stringify(join(runDir, 'projects'))} + '/project-' + ((${spawned} + i) % ${PROJECTS}), workspace: { mode: 'direct' } }).then((r) => (r && r.error ? 'error: ' + r.error.message : 'ok'), (e) => 'threw: ' + e.message)))`,
          120_000,
        );
        const refused = results.filter((result) => result !== 'ok');
        if (refused.length > 0) throw new Error(`agent spawn failed: ${refused.slice(0, 3).join(' | ')}`);
        spawned += batch;
      }
      await until(`${count} imposters on the control channel`, () => plane.sessions.size >= count, 120_000, 500);
      driver.add([...plane.sessions.values()].filter((session) => !before.has(session.sessionId)));
      // Let every new agent's first states reach the board before anything is timed.
      await delay(Math.max(2000, config.stepMs));
      for (const view of viewOrder) {
        const button = VIEW_LABELS[view];
        await page.evaluate(
          `(() => { const button = document.querySelector('[aria-label="${button} view"]'); if (!button) throw new Error('no ${button} view button'); button.click(); return true; })()`,
        );
        await until(
          `the ${view} view`,
          () =>
            page.evaluate(
              `document.querySelector('[aria-label="${button} view"]')?.getAttribute('aria-pressed') === 'true'`,
            ),
          10_000,
        );
        await delay(config.warmupMs);
        const sentBefore = driver.stats.sent;
        await page.evaluate('window.__gvPerf.begin()');
        await delay(config.windowMs);
        const sample = await page.evaluate('window.__gvPerf.end()');
        // The list's rows by status: evidence that the agents really walk working → blocked → idle.
        const board = await page.evaluate(
          `(() => { const rows = [...document.querySelectorAll('.vf-monitor-list-row')]; if (rows.length === 0) return null; const tally = { rows: rows.length, working: 0, blocked: 0, idle: 0 }; for (const row of rows) for (const status of ['working', 'blocked', 'idle']) if (row.classList.contains('is-' + status)) tally[status] += 1; return tally; })()`,
        );
        const loafs = sample.loafs;
        measurements.push({
          count,
          view,
          ms: sample.ms,
          frames: frameStats(sample.frameDeltas),
          loaf: {
            supported: sample.loafSupported,
            count: loafs.length,
            totalMs: loafs.reduce((sum, entry) => sum + entry.duration, 0),
            blockingMs: loafs.reduce((sum, entry) => sum + entry.blocking, 0),
            maxMs: loafs.reduce((max, entry) => Math.max(max, entry.duration), 0),
          },
          raf: { workMs: sample.rafWorkMs, callbacks: sample.rafCallbacks, maxMs: sample.rafMaxMs },
          react: {
            seen: sample.seen,
            commits: sample.commits,
            viewCommits: sample.viewCommits,
            viewRenderMs: sample.viewRenderMs,
            viewNames: sample.viewNames,
          },
          ops: driver.stats.sent - sentBefore,
          agents: plane.sessions.size,
          ...(board ? { board } : {}),
        });
        log(
          `round ${round} ${label} n=${count} ${view}: p50 ${measurements.at(-1).frames.p50?.toFixed(1)} ms · p95 ${measurements.at(-1).frames.p95?.toFixed(1)} ms · LoAF ${loafs.length} · view commits ${sample.viewCommits}`,
        );
      }
    }
    return { measurements, driver: { ...driver.stats } };
  } finally {
    driver?.stop();
    page?.close();
    const pids = [...plane.sessions.values()].map((session) => session.pid).filter(Boolean);
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await Promise.race([new Promise((done) => child.once('exit', done)), delay(10_000)]);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    // The terminal daemon and its agents can outlive the app's process group.
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    spawnSync('pkill', ['-9', '-f', runDir]);
    await plane.close();
    rmSync(runDir, { recursive: true, force: true });
    cleanups.delete(abandon);
  }
}

async function main() {
  for (const app of [config.a, config.b].filter(Boolean)) {
    if (!existsSync(join(app, 'dist/main.cjs')))
      throw new Error(`${app} is not built: run \`node build.mjs\` there first`);
  }
  mkdirSync(config.out, { recursive: true });
  const builds = { A: config.a, ...(config.b ? { B: config.b } : {}) };
  const plan = [];
  for (let round = 0; round < config.rounds; round += 1) {
    // A' is the null arm: the same build as A, measured in the same round.
    const arms = config.b ? ['A', 'B', "A'"] : ['A', "A'"];
    const rotated = arms.map((_, index) => arms[(index + round) % arms.length]);
    const viewOrder = config.views.map((_, index) => config.views[(index + round) % config.views.length]);
    for (const arm of rotated) plan.push({ round, arm, app: arm === 'B' ? builds.B : builds.A, viewOrder });
  }
  const results = { config: { ...config, builds }, startedAt: new Date().toISOString(), runs: [] };
  const save = () => writeFileSync(join(config.out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  for (const step of plan) {
    const before = await waitForLoad();
    log(`round ${step.round} arm ${step.arm} (${step.app}) at load ${before.load[0]}`);
    const started = Date.now();
    try {
      const outcome = await runArm(step.app, step.round, step.arm.replace("'", '2'), step.viewOrder);
      results.runs.push({
        ...step,
        load: { before, after: loadavg().map((value) => Number(value.toFixed(2))) },
        ms: Date.now() - started,
        ...outcome,
      });
    } catch (error) {
      results.runs.push({ ...step, load: { before }, failed: error instanceof Error ? error.message : String(error) });
      log(`round ${step.round} arm ${step.arm} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    save();
  }
  results.finishedAt = new Date().toISOString();
  save();
  writeFileSync(join(config.out, 'summary.md'), summarise(results));
  log(`results: ${join(config.out, 'results.json')} · summary: ${join(config.out, 'summary.md')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
