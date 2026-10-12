import { loadavg } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AgentMonitorState } from '@vibefield/puppeteer-core';
import { T0, facts, hostRun, iso, monitorState, testBackend } from './testing/fixtures.js';

// The per-change cost bench (MV-1a step 11). Skipped unless MONITOR_BENCH=1:
//
//   MONITOR_BENCH=1 pnpm exec vitest run src/backend/backend.bench.test.ts
//
// It drives the backend through the manual clock and scheduler, so a tick is
// exactly "k state pushes, then one flush", with the states built outside the
// timed region (the runtime's cost, not ours). Per L17 it first waits for the
// load average to fall below 60 and prints the load beside its numbers; the
// numbers are medians, and they are reference, never a bound (L14).

const ENABLED = process.env.MONITOR_BENCH === '1';
const SIZES = [10, 20, 60, 200];
const WARMUP = 20;
const TICKS = 200;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** A realistic priced, working state: an activity line, a model, context, a reply, 20 cost buckets. */
function seedState(index: number, revision: number, tick: number, drawn: boolean): AgentMonitorState {
  return monitorState({
    runtimeRunId: `run-${index}`,
    revision,
    activity: { kind: 'tool', line: drawn ? `Edit · file-${tick}.ts` : 'Edit · file.ts', since: iso(T0) },
    model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
    context: { usedPercent: 40 + (index % 50), percentageSource: 'provider', asOf: iso(T0) },
    lastAssistantMessage: {
      text: `Reply ${index}: the change is in, tests are green, moving on.`,
      at: iso(T0),
      final: true,
    },
    usage: {
      samples: [],
      cumulativeTokens: 10_000 + index * 97 + tick,
      costUsd: 0.5 + index * 0.01,
      costCoverage: 'complete',
      costRatePerMin: 0.02,
      costHistory: Array.from({ length: 20 }, (_, step) => ({ at: iso(T0 - (19 - step) * 30_000), costUsd: 0.01 })),
    },
    session: { nativeSessionId: `native-${index}` },
    freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: iso(T0 + tick) },
  });
}

describe.skipIf(!ENABLED)("the backend's per-change cost", () => {
  it('scales with what changed, not with the board', { timeout: 1_800_000 }, async () => {
    while ((loadavg()[0] ?? 0) >= 60) await new Promise((resolve) => setTimeout(resolve, 5_000));
    const loadBefore = loadavg().map((value) => value.toFixed(1));
    const lines: string[] = [
      '| n | tick | k changed | median tick | per changed row | upserts/tick |',
      '|---|---|---|---|---|---|',
    ];
    for (const n of SIZES) {
      const t = testBackend({
        facts: facts({
          runs: Array.from({ length: n }, (_, index) =>
            hostRun({
              runtimeRunId: `run-${index}`,
              terminalSessionId: `pty-${index}`,
              createdAt: T0 - (n - index) * 1000,
              projectKey: `/repo-${index % 7}`,
            }),
          ),
        }),
        states: Array.from({ length: n }, (_, index) => seedState(index, 1, 0, true)),
      });
      await t.backend.ready;
      expect(t.rows()).toHaveLength(n);
      let revision = 1;
      const shapes: Array<[string, number, boolean]> = [
        ['1 row', 1, true],
        ['10 %', Math.max(1, Math.round(n / 10)), true],
        ['all', n, true],
        ['all, nothing drawn moved', n, false],
      ];
      for (const [label, k, drawn] of shapes) {
        const samples: number[] = [];
        let upserts = 0;
        for (let tick = 0; tick < WARMUP + TICKS; tick += 1) {
          revision += 1;
          const first = (tick * k) % n;
          const batch = Array.from({ length: k }, (_, offset) =>
            seedState((first + offset) % n, revision, tick + 1, drawn),
          );
          const before = t.changes.length;
          const start = performance.now();
          for (const state of batch) t.source.push(state);
          t.scheduler.flush();
          const elapsed = performance.now() - start;
          if (tick >= WARMUP) {
            samples.push(elapsed);
            upserts += t.changes.length > before ? (t.changes.at(-1)?.upserts.length ?? 0) : 0;
          }
        }
        const tickMs = median(samples);
        lines.push(
          `| ${n} | ${label} | ${k} | ${(tickMs * 1000).toFixed(0)} µs | ${((tickMs * 1000) / k).toFixed(1)} µs | ${(upserts / TICKS).toFixed(1)} |`,
        );
      }
      // the idle recompute: the host republishes identical facts, so the tick scans every row and emits nothing
      const idle: number[] = [];
      for (let tick = 0; tick < WARMUP + TICKS; tick += 1) {
        const same = t.host.current();
        const start = performance.now();
        t.host.set({ ...same, runs: [...same.runs] });
        t.scheduler.flush();
        if (tick >= WARMUP) idle.push(performance.now() - start);
      }
      lines.push(`| ${n} | idle recompute, nothing changed | 0 | ${(median(idle) * 1000).toFixed(1)} µs | — | 0 |`);
      t.backend.dispose();
    }
    const loadAfter = loadavg().map((value) => value.toFixed(1));
    process.stdout.write(
      `\n${lines.join('\n')}\n\nload average before ${loadBefore.join(' ')} · after ${loadAfter.join(' ')} · ${TICKS} ticks after ${WARMUP} warm-up\n\n`,
    );
  });
});
