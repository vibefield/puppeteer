import { execFile } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapterBinding, AgentHost } from '@vibefield/puppeteer-core';

/**
 * Every fs.watch the runtime opens, by target, with how many times it was closed. The recorder has its own file so
 * that runtime.test.ts keeps the real node:fs.
 */
const watches = vi.hoisted(() => [] as Array<{ target: string; closes: number }>);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  type Watcher = ReturnType<typeof actual.watch>;
  const watch = (...args: unknown[]): Watcher => {
    const watcher = (actual.watch as (...watchArgs: unknown[]) => Watcher)(...args);
    const record = { target: String(args[0]), closes: 0 };
    watches.push(record);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      record.closes += 1;
      close();
    };
    return watcher;
  };
  return { ...actual, watch };
});

import { createAgentRuntime } from './runtime.js';
import type { AgentProvider } from './types.js';

const execFileAsync = promisify(execFile);

const host: AgentHost = {
  async spawnTerminal() {
    throw new Error('fake providers do not spawn');
  },
  async automateTerminal() {
    return { accepted: true };
  },
};

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'puppeteer-runtime-git-sharing-'));
  const run = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);
  await run('-c', 'init.defaultRefFormat=files', 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await run('add', '.');
  await run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return repo;
}

/** Sessions that emit nothing: the runtime's own Git observation is the subject. */
function quietProvider(id: string): AgentProvider {
  let counter = 0;
  return {
    descriptor: { id, label: id },
    async createSession(): Promise<AgentAdapterBinding> {
      const n = ++counter;
      return {
        sessionId: `${id}-native-${n}`,
        runtimeSessionId: `${id}-runtime-${n}`,
        observationLevel: () => 'structured',
        events: {
          onCandidate() {
            return () => undefined;
          },
        },
        services: {
          prompt: {
            async submit() {
              return { status: 'confirmed' };
            },
          },
        },
        async dispose() {},
      };
    },
  };
}

describe('runtime Git observation', () => {
  it('holds one set of watches for every session in one repository', async () => {
    const repo = await makeRepo();
    const gitDir = join(await realpath(repo), '.git');
    const head = join(gitDir, 'HEAD');
    const live = (target: (path: string) => boolean): number =>
      watches.filter((watch) => watch.closes === 0 && target(watch.target)).length;
    const runtime = createAgentRuntime({ host, defaultCwd: repo, providers: [quietProvider('quiet')] });
    const first = await runtime.createSession({ agent: 'quiet', cwd: repo });
    const second = await runtime.createSession({ agent: 'quiet', cwd: repo });
    if ('error' in first || 'error' in second) throw new Error('unexpected create failure');
    try {
      await vi.waitFor(
        () => {
          expect(runtime.sessionState(first.terminalSessionId)?.environment.git?.value).toMatchObject({
            branch: 'main',
          });
          expect(runtime.sessionState(second.terminalSessionId)?.environment.git?.value).toMatchObject({
            branch: 'main',
          });
        },
        { timeout: 10_000 },
      );
      // Opened minus closed, so a watcher rebuilt after a ref moved is counted once.
      expect(live((target) => target === head)).toBe(1);

      await runtime.handleProcessExit(first.terminalSessionId, { exitCode: 0, signal: null, reason: 'completed' });
      expect(live((target) => target === head)).toBe(1);
      await execFileAsync('git', ['-C', repo, 'checkout', '-b', 'other']);
      await vi.waitFor(
        () => {
          expect(runtime.sessionState(second.terminalSessionId)?.environment.git?.value).toMatchObject({
            branch: 'other',
          });
        },
        { timeout: 10_000 },
      );
    } finally {
      await runtime.dispose();
    }
    expect(live((target) => target === gitDir || target.startsWith(`${gitDir}${sep}`))).toBe(0);
  });
});
