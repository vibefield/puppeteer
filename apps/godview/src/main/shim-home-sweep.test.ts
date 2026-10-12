import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pidIsAlive, sweepStaleShimHomes } from './shim-home-sweep.js';

let root: string;
let temp: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gv-sweep-'));
  temp = join(root, 'T');
  outside = join(root, 'outside');
  await mkdir(temp);
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'kept');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A home as materializeShims leaves one. */
async function home(name: string): Promise<string> {
  const path = join(temp, name);
  await mkdir(join(path, 'bin'), { recursive: true });
  await writeFile(join(path, 'gateway.json'), '{"token":"a dead bearer"}');
  return path;
}

describe('sweepStaleShimHomes', () => {
  it("removes a gone pid's home, and keeps a live pid's, a look-alike, its own, and a link's target", async () => {
    const gone = await home('godview-agent-shims-111');
    await home('godview-agent-shims-222');
    const lookAlikes = [
      'godview-agent-shims-333x',
      'godview-agent-shims-',
      'godview-agent-shims-0',
      'godview-agent-shims-0444',
      'xgodview-agent-shims-555',
      'godview-agent-shims-555.bak',
    ];
    for (const name of lookAlikes) await home(name);
    await home(`godview-agent-shims-${process.pid}`);
    // A link named like a home: unlinked, never followed.
    await symlink(outside, join(temp, 'godview-agent-shims-666'));
    // A gone home holding a link out: removed, and what it links to is untouched.
    const escaping = await home('godview-agent-shims-777');
    await symlink(outside, join(escaping, 'escape'));
    // A file named like a home is not a home.
    await writeFile(join(temp, 'godview-agent-shims-888'), 'not a home');

    const isAlive = vi.fn((pid: number) => pid === 222);
    const sweep = await sweepStaleShimHomes(temp, { isAlive });

    expect(sweep.failed).toEqual([]);
    expect([...sweep.removed].sort()).toEqual([gone, join(temp, 'godview-agent-shims-666'), escaping].sort());
    expect((await readdir(temp)).sort()).toEqual(
      [
        'godview-agent-shims-222',
        `godview-agent-shims-${process.pid}`,
        'godview-agent-shims-888',
        ...lookAlikes,
      ].sort(),
    );
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('kept');
    expect(await readdir(outside)).toEqual(['keep.txt']);
    // Only names that are exactly a home are judged, and its own home never is.
    expect(isAlive.mock.calls.map(([pid]) => pid).sort()).toEqual([111, 222, 666, 777, 888]);
    expect(sweep.examined).toBe(6);
  });

  it('looks at no more homes than its limit', async () => {
    for (const pid of [901, 902, 903]) await home(`godview-agent-shims-${pid}`);
    const sweep = await sweepStaleShimHomes(temp, { isAlive: () => false, limit: 2 });
    expect(sweep.examined).toBe(2);
    expect(sweep.removed).toHaveLength(2);
    expect(await readdir(temp)).toHaveLength(1);
  });

  // chmod cannot make this directory undeletable on Windows or for a POSIX root user.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a home it cannot remove, and goes on',
    async () => {
      const stuck = await home('godview-agent-shims-911');
      await mkdir(join(stuck, 'locked'));
      await writeFile(join(stuck, 'locked', 'file'), 'x');
      await chmod(join(stuck, 'locked'), 0o500);
      const next = await home('godview-agent-shims-912');
      try {
        const sweep = await sweepStaleShimHomes(temp, { isAlive: () => false });
        expect(sweep.failed).toEqual([{ path: stuck, message: expect.stringMatching(/EACCES|permission/iu) }]);
        expect(sweep.removed).toEqual([next]);
      } finally {
        await chmod(join(stuck, 'locked'), 0o700);
      }
    },
  );

  it('never throws: a temp directory it cannot read is a failure it reports', async () => {
    const missing = join(root, 'missing');
    await expect(sweepStaleShimHomes(missing)).resolves.toMatchObject({
      examined: 0,
      removed: [],
      failed: [{ path: missing, message: expect.stringMatching(/ENOENT/u) }],
    });
  });
});

describe('pidIsAlive', () => {
  it('knows this process is alive, and a reaped child is not', () => {
    expect(pidIsAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    expect(pidIsAlive(child.pid)).toBe(false);
  });
});
