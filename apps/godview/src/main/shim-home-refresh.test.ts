import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RENDEZVOUS_FILE,
  materializeShims,
  readRendezvous,
  spawnThroughLayout,
  writeRendezvous,
} from '@vibefield/puppeteer-runtime/spawn-through';
import {
  describeShimHomeRefresh,
  refreshShimHome,
  startShimHomeRefresh,
  type ShimHomeRefreshOutcome,
  type ShimHomeValues,
} from './shim-home-refresh.js';

let root: string;
let home: string;
let values: ShimHomeValues;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gv-refresh-'));
  home = join(root, 'godview-agent-shims-4242');
  const script = join(root, 'agent-shim.cjs');
  await writeFile(script, '// the bundled shim\n');
  values = {
    materialize: {
      home,
      names: ['ai', 'example'],
      script,
      runtime: { command: process.execPath },
      hostLabel: 'Godview',
    },
    rendezvous: { port: 4242, token: 'bearer', strict: false, launchProviders: [], hostLabel: 'Godview' },
  };
  // Godview's start.
  await materializeShims(values.materialize);
  await writeRendezvous(home, values.rendezvous);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file under the home: its inode, mtime, mode and bytes. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const status = await stat(path);
    files[relative(home, path)] =
      `${status.ino}:${status.mtimeMs}:${status.mode}:${(await readFile(path)).toString('base64')}`;
  }
  return files;
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

// The spawn-through home relies on POSIX permissions; Godview disables it on Windows.
describe.skipIf(process.platform === 'win32')('refreshShimHome', () => {
  it('leaves a home nothing touched byte for byte: no file rewritten, none counted', async () => {
    const before = await snapshot();
    expect(Object.keys(before).sort()).toEqual(
      ['bin/ai', 'bin/example', 'gateway.json', 'launch-providers.json', 'lib/agent-shim.cjs', 'zsh/.zshenv'].sort(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await refreshShimHome(values)).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("brings back what the temp directory's cleaner took, with its modes, and nothing else", async () => {
    const layout = spawnThroughLayout(home);
    const before = await snapshot();
    // The cleaner deletes files and leaves the directories.
    await rm(layout.script);
    await rm(join(home, RENDEZVOUS_FILE));

    expect(await refreshShimHome(values)).toBe(2);
    expect(await modeOf(layout.script)).toBe(0o600);
    expect(await modeOf(join(home, RENDEZVOUS_FILE))).toBe(0o600);
    expect(await readFile(layout.script, 'utf8')).toBe('// the bundled shim\n');
    expect(await readRendezvous(home)).toMatchObject({
      port: 4242,
      token: 'bearer',
      strict: false,
      hostLabel: 'Godview',
    });
    const after = await snapshot();
    for (const path of ['bin/ai', 'bin/example', 'launch-providers.json', 'zsh/.zshenv']) {
      expect(after[path], path).toBe(before[path]);
    }
  });

  it('fails as the kit fails when a value can no longer be published', async () => {
    await expect(
      refreshShimHome({ ...values, materialize: { ...values.materialize, script: join(root, 'moved.cjs') } }),
    ).rejects.toThrow(/ENOENT/u);
  });
});

describe('describeShimHomeRefresh', () => {
  it('says how many files were restored, and nothing when none were', () => {
    expect(describeShimHomeRefresh(0)).toBeUndefined();
    expect(describeShimHomeRefresh(1)).toBe('spawn-through home: 1 file restored');
    expect(describeShimHomeRefresh(2)).toBe('spawn-through home: 2 files restored');
  });
});

describe.skipIf(process.platform === 'win32')('startShimHomeRefresh', () => {
  const timeouts = (): number => process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;

  it('refreshes on its interval without keeping the process alive, and writes nothing once stopped', async () => {
    const outcomes: ShimHomeRefreshOutcome[] = [];
    const idle = timeouts();
    const refresh = startShimHomeRefresh(values, (outcome) => outcomes.push(outcome), 20);
    try {
      // Its timer is unref'd: nothing of it holds the process open.
      expect(timeouts()).toBe(idle);
      await vi.waitFor(() => expect(outcomes.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 });
      expect(outcomes[0]).toEqual({ restored: 0 });

      await rm(join(home, RENDEZVOUS_FILE));
      await vi.waitFor(() => expect(outcomes).toContainEqual({ restored: 1 }), { timeout: 10_000, interval: 10 });
    } finally {
      await refresh.stop();
    }
    const reported = outcomes.length;
    await rm(join(home, RENDEZVOUS_FILE));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(outcomes).toHaveLength(reported);
    await expect(stat(join(home, RENDEZVOUS_FILE))).rejects.toThrow(/ENOENT/u);
  });

  it('reports a refresh that fails, and tries again at the next', async () => {
    const outcomes: ShimHomeRefreshOutcome[] = [];
    const moved = { ...values, materialize: { ...values.materialize, script: join(root, 'moved.cjs') } };
    const refresh = startShimHomeRefresh(moved, (outcome) => outcomes.push(outcome), 20);
    try {
      await vi.waitFor(() => expect(outcomes.length).toBeGreaterThanOrEqual(2), { timeout: 10_000, interval: 10 });
    } finally {
      await refresh.stop();
    }
    for (const outcome of outcomes) expect(String((outcome as { error: unknown }).error)).toMatch(/ENOENT/u);
  });
});
