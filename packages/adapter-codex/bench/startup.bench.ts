import { compareStartup, quantile } from './comparison.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { createCodexObserver } from '../src/observation/observer.js';
import { AppServerClient, type Transport } from '../src/transport/app-server-client.js';
import { spawnAppServer } from '../src/transport/app-server-process.js';
import { connectAppServerEndpoint } from '../src/transport/ws-transport.js';
import { prewarmCodex } from '../src/services/prewarm.js';
import { createCodexObserver as baselineObserver } from 'codex-startup-baseline';
import { spawnAppServer as baselineSpawnAppServer } from 'codex-startup-baseline-process';

// Explicit opt-in: native account/cache, empty archived threads, never a model turn.
const live = process.env.CODEX_STARTUP_LIVE === '1';
const count = Number(process.env.CODEX_STARTUP_SAMPLES ?? '10');
const output = process.env.CODEX_STARTUP_OUT;
const executable = process.env.CODEX_STARTUP_EXECUTABLE ?? 'codex';
const cwd = process.env.CODEX_STARTUP_CWD ?? homedir();
const mode = process.env.CODEX_STARTUP_CACHE ?? 'existing';
const phase = process.env.CODEX_STARTUP_PHASE ?? 'observer';
const delayMs = Number(process.env.CODEX_STARTUP_CATALOG_DELAY_MS ?? '0');

type Span = { method: string; startMs: number; durationMs: number; succeeded: boolean; outcome: 'reply' | 'cancelled' };
type Sample = {
  round: number;
  arm: string;
  cache: string;
  prewarmMs?: number;
  serverReadyMs?: number;
  readyMs?: number;
  cleanupMs?: number;
  archived: boolean;
  threadId?: string;
  failure?: string;
  load: number[];
  spans: Span[];
};
const samples: Sample[] = [];
let codexVersion = 'not-probed';
const repo = resolve(import.meta.dirname, '../../..');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const sourceDirty =
  execFileSync('git', ['status', '--porcelain', '--', 'packages/adapter-codex/src'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim().length > 0;
const sourcePaths = execFileSync('git', ['ls-files', '--', 'packages/adapter-codex/src'], {
  cwd: repo,
  encoding: 'utf8',
})
  .trim()
  .split('\n');
const sourceHashes = Object.fromEntries(
  [
    ...sourcePaths,
    'packages/adapter-codex/bench/startup.bench.ts',
    'packages/adapter-codex/bench/vitest.config.ts',
    'packages/adapter-codex/bench/comparison.ts',
  ].map((path) => [
    path,
    createHash('sha256')
      .update(readFileSync(resolve(repo, path)))
      .digest('hex'),
  ]),
);
const baselineRevision = process.env.CODEX_STARTUP_BASELINE
  ? execFileSync('git', ['rev-parse', '--verify', `${process.env.CODEX_STARTUP_BASELINE}^{commit}`], {
      cwd: repo,
      encoding: 'utf8',
    }).trim()
  : revision;

function save(): void {
  if (!output) return;
  const summary = Object.fromEntries(
    ['baseline', 'current', 'null'].map((arm) => {
      const rows = samples.filter((s) => s.arm === arm && s.round >= 0);
      const times = rows.filter((s) => !s.failure && s.readyMs !== undefined).map((s) => s.readyMs!);
      return [
        arm,
        {
          attempts: rows.length,
          succeeded: times.length,
          p50Ms: quantile(times, 0.5),
          p95Ms: quantile(times, 0.95),
          maxMs: times.length ? Math.max(...times) : null,
        },
      ];
    }),
  );
  const comparison = compareStartup(samples, count);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        measured:
          phase === 'server'
            ? 'private app-server spawn through bound endpoint; excludes protocol initialization and thread creation'
            : 'private app-server start through observer readiness; excludes gateway, shell, TUI and renderer',
        phase,
        cache:
          mode === 'prewarmed'
            ? 'native on-disk cache prewarmed before each sample; new server each time'
            : 'new server each sample; native on-disk cache retained, NOT cache-cold',
        catalogResponseDelayMs: delayMs,
        noModelTurns: true,
        revision,
        sourceDirty,
        sourceHashes,
        baselineModules: ['observation/observer.ts', 'transport/app-server-process.ts'],
        baseline: baselineRevision,
        baselineSource: process.env.CODEX_STARTUP_BASELINE ? 'git-modules' : 'current-working-tree',
        host: {
          node: process.version,
          os: platform(),
          release: release(),
          cpu: cpus()[0]?.model,
          cores: cpus().length,
          memoryBytes: totalmem(),
          codex: codexVersion,
        },
        tailQualification:
          'descriptive only; do not claim a tail improvement without enough samples and a stable paired null control',
        comparison,
        summary,
        samples,
      },
      null,
      2,
    ) + '\n',
  );
}

async function measure(round: number, arm: string): Promise<Sample> {
  const row: Sample = { round, arm, cache: mode, archived: false, load: loadavg(), spans: [] };
  if (mode === 'prewarmed') {
    const warming = performance.now();
    try {
      await prewarmCodex({ executable });
    } catch {
      row.failure = 'prewarm-failed';
    }
    row.prewarmMs = performance.now() - warming;
    if (row.failure) return row;
  }
  const began = performance.now();
  const server = (arm === 'current' ? spawnAppServer : baselineSpawnAppServer)({ executable });
  const timer = setTimeout(() => void server.dispose(), 90_000);
  const pending = new Map<unknown, { method: string; start: number }>();
  let threadId: string | undefined;
  let observer: Awaited<ReturnType<typeof createCodexObserver>> | undefined;
  let cleanup: AppServerClient | undefined;
  let transport: Transport | undefined;
  const delayed = new Set<ReturnType<typeof setTimeout>>();
  try {
    await server.ready();
    row.serverReadyMs = performance.now() - began;
    if (phase === 'server') {
      row.readyMs = row.serverReadyMs;
      return row;
    }
    const real = connectAppServerEndpoint(server.endpoint());
    transport = {
      send(message) {
        const m = message as { id?: unknown; method?: string };
        if (m.id !== undefined && m.method) pending.set(m.id, { method: m.method, start: performance.now() });
        real.send(message);
      },
      onMessage(handler) {
        real.onMessage((message) => {
          const m = message as { id?: unknown; result?: { thread?: { id?: string } }; error?: unknown };
          const request = pending.get(m.id);
          const deliver = () => {
            if (request) {
              pending.delete(m.id);
              row.spans.push({
                method: request.method,
                startMs: request.start - began,
                durationMs: performance.now() - request.start,
                succeeded: m.error === undefined,
                outcome: 'reply',
              });
              if (request.method === 'thread/start') {
                threadId = m.result?.thread?.id;
                if (threadId) row.threadId = threadId;
              }
            }
            handler(message);
          };
          if (request?.method === 'model/list' && delayMs > 0) {
            const wait = setTimeout(() => {
              delayed.delete(wait);
              deliver();
            }, delayMs);
            delayed.add(wait);
          } else deliver();
        });
      },
      onClose: (handler) => real.onClose(handler),
      async close() {
        for (const wait of delayed) clearTimeout(wait);
        delayed.clear();
        for (const request of pending.values()) {
          row.spans.push({
            method: request.method,
            startMs: request.start - began,
            durationMs: performance.now() - request.start,
            succeeded: false,
            outcome: 'cancelled',
          });
        }
        pending.clear();
        await real.close();
      },
    };
    observer = await (arm === 'current' ? createCodexObserver : baselineObserver)({
      transport,
      start: { cwd, permissionDefaults: 'configuration' },
    });
    row.readyMs = performance.now() - began;
    threadId ??= observer.sessionId;
    expect(threadId).toBeTruthy();
  } catch (error) {
    row.failure = error instanceof Error ? error.name : 'unknown';
  } finally {
    const cleanupBegan = performance.now();
    if (threadId) {
      try {
        cleanup = new AppServerClient(connectAppServerEndpoint(server.endpoint()), { requestTimeoutMs: 15_000 });
        await cleanup.request('initialize', {
          clientInfo: { name: 'puppeteer-startup-bench-cleanup', version: '1' },
          capabilities: {},
        });
        cleanup.notify('initialized');
        await cleanup.request('thread/archive', { threadId });
        row.archived = true;
      } catch {
        row.failure ??= 'archive-failed';
      }
    }
    // Cleanup failures must never skip the remaining resources, including an
    // observer whose constructor failed after opening the transport.
    for (const [label, dispose] of [
      ['cleanup-client', () => cleanup?.close()],
      ['observer', () => observer?.dispose()],
      ['transport', () => transport?.close()],
      ['server', () => server.dispose()],
    ] as const) {
      try {
        await dispose();
      } catch {
        row.failure ??= `${label}-cleanup-failed`;
      }
    }
    clearTimeout(timer);
    row.cleanupMs = performance.now() - cleanupBegan;
  }
  return row;
}

it.skipIf(!live)('records interleaved native startup, its unchanged control, and every protocol span', async () => {
  expect(output, 'CODEX_STARTUP_OUT is required').toBeTruthy();
  if (output && existsSync(output)) throw new Error('choose a new CODEX_STARTUP_OUT; preserve prior evidence');
  expect(Number.isInteger(count) && count >= 3 && count <= 100).toBe(true);
  expect(['existing', 'prewarmed']).toContain(mode);
  expect(['server', 'observer']).toContain(phase);
  expect(Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 5000).toBe(true);
  codexVersion = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  const warmup = await measure(-1, 'baseline');
  samples.push(warmup);
  save();
  expect(warmup.failure).toBeUndefined();
  if (phase === 'observer') expect(warmup.archived).toBe(true);
  for (let round = 0; round < count; round++) {
    // Balance all three positions as well as direction over six rounds.
    const orders = [
      ['baseline', 'current', 'null'],
      ['current', 'null', 'baseline'],
      ['null', 'baseline', 'current'],
      ['null', 'current', 'baseline'],
      ['baseline', 'null', 'current'],
      ['current', 'baseline', 'null'],
    ];
    const order = orders[round % orders.length]!;
    for (const arm of order) {
      const row = await measure(round, arm);
      samples.push(row);
      save();
      console.log(JSON.stringify({ round, arm, readyMs: row.readyMs, archived: row.archived, failure: row.failure }));
      expect(row.failure).toBeUndefined();
      if (phase === 'observer') expect(row.archived).toBe(true);
    }
  }
});
