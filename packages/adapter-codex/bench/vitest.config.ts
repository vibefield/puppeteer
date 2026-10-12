import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repo = resolve(import.meta.dirname, '../../..');
const revision = process.env.CODEX_STARTUP_BASELINE;
const virtual = resolve(repo, 'packages/adapter-codex/src/observation/observer.benchmark-baseline.ts');
const processVirtual = resolve(repo, 'packages/adapter-codex/src/transport/app-server-process.benchmark-baseline.ts');
const processBaseline = revision
  ? execFileSync('git', ['show', `${revision}:packages/adapter-codex/src/transport/app-server-process.ts`], {
      cwd: repo,
      encoding: 'utf8',
    })
  : undefined;
const baseline = revision
  ? execFileSync('git', ['show', `${revision}:packages/adapter-codex/src/observation/observer.ts`], {
      cwd: repo,
      encoding: 'utf8',
    })
  : undefined;

export default defineConfig({
  plugins: [
    {
      name: 'startup-baseline',
      resolveId(id) {
        if (id === 'codex-startup-baseline') return virtual;
        if (id === 'codex-startup-baseline-process') return processVirtual;
      },
      load(id) {
        if (id === processVirtual)
          return processBaseline ?? `export { spawnAppServer } from './app-server-process.js';`;
        if (id === virtual) return baseline ?? `export { createCodexObserver } from './observer.js';`;
      },
    },
  ],
  test: {
    include: ['bench/startup.bench.ts', 'bench/comparison.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 1_800_000,
  },
});
