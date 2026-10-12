import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processStartedAt } from './process-watch.js';
import {
  TERMINALS_FILE,
  findOwningProcess,
  readProcessTable,
  readTerminals,
  writeTerminals,
  type ProcessRecord,
  type ProcessTable,
} from './terminals.js';

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pst-'));
  home = join(root, 'home');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const STARTED = '2026-09-27T21:00:00.000Z';

describe('the shells a host owns (terminals.json)', { timeout: 60_000 }, () => {
  it.skipIf(process.platform === 'win32')(
    'publishes the list owner-only, holding each shell to its pid and start, and reads it back',
    async () => {
      // A host can hand over its own terminal records: only the pid and the start are written.
      await writeTerminals(home, [{ pid: 4242, startedAt: STARTED, terminalSessionId: 'pane-1' } as never]);

      expect(await modeOf(home)).toBe(0o700);
      expect(await modeOf(join(home, TERMINALS_FILE))).toBe(0o600);
      const written = JSON.parse(await readFile(join(home, TERMINALS_FILE), 'utf8'));
      expect(written).toMatchObject({ format: 1, terminals: [{ pid: 4242, startedAt: STARTED }] });
      expect(Date.parse(written.writtenAt)).not.toBeNaN();
      expect(written.terminals[0]).not.toHaveProperty('terminalSessionId');
      expect(await readTerminals(home)).toEqual([{ pid: 4242, startedAt: STARTED }]);

      // The last terminal ended: an empty list is still the host's word.
      await writeTerminals(home, []);
      expect(await readTerminals(home)).toEqual([]);
      expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
  );

  it('answers undefined, never throws, for a list a shim could not use', async () => {
    expect(await readTerminals(join(root, 'absent'))).toBeUndefined();
    await mkdir(home, { recursive: true });
    const valid = { format: 1, writtenAt: STARTED, terminals: [{ pid: 4242, startedAt: STARTED }] };
    for (const content of [
      '',
      '{"format":1',
      JSON.stringify({ ...valid, format: 2 }),
      JSON.stringify({ ...valid, terminals: 'all of them' }),
      JSON.stringify({ ...valid, terminals: [{ pid: 0, startedAt: STARTED }] }),
      JSON.stringify({ ...valid, terminals: [{ pid: 4242, startedAt: '' }] }),
      JSON.stringify({ ...valid, terminals: [{ pid: 4242 }] }),
    ]) {
      await writeFile(join(home, TERMINALS_FILE), content);
      expect(await readTerminals(home), content).toBeUndefined();
    }
    // A newer writer's extra keys are not a reason to lose the list.
    await writeFile(
      join(home, TERMINALS_FILE),
      JSON.stringify({ ...valid, later: true, terminals: [{ pid: 4242, startedAt: STARTED, pane: 'x' }] }),
    );
    expect(await readTerminals(home)).toEqual([{ pid: 4242, startedAt: STARTED }]);
    await rm(join(home, TERMINALS_FILE));
    await mkdir(join(home, TERMINALS_FILE));
    expect(await readTerminals(home)).toBeUndefined();
  });

  it('refuses to publish what no shim could use, and publishes nothing', async () => {
    for (const terminals of [
      [{ pid: 0, startedAt: STARTED }],
      [{ pid: -1, startedAt: STARTED }],
      [{ pid: 1.5, startedAt: STARTED }],
      [{ pid: 4242, startedAt: '' }],
      Array.from({ length: 1_025 }, (_, index) => ({ pid: index + 2, startedAt: STARTED })),
    ]) {
      await expect(writeTerminals(home, terminals), JSON.stringify(terminals[0])).rejects.toThrow();
    }
    await expect(readdir(home)).rejects.toThrow();
  });
});

function table(rows: readonly (readonly [pid: number, parentPid: number, startedAt?: string])[]): ProcessTable {
  return new Map(
    rows.map(([pid, parentPid, startedAt]): [number, ProcessRecord] => [pid, { pid, parentPid, startedAt }]),
  );
}

describe('the process table, and the walk from a process up its ancestors', () => {
  it('reads every pid, its parent and its start from one ps call, and nothing when ps cannot say', async () => {
    const lstart = 'Sun Sep 27 17:01:09 2026';
    const ps = vi.fn(
      async () =>
        `    1     0 Sat Sep 26 09:00:00 2026\n 4242     1 ${lstart}   \nnot a row\n   77  4242 no date here\n`,
    );
    const read = await readProcessTable({ ps });
    expect(ps).toHaveBeenCalledTimes(1);
    expect(ps).toHaveBeenCalledWith(['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=']);
    expect(read?.size).toBe(3);
    // The start as processStartedAt reports it: the same parse of the same column.
    expect(read?.get(4242)).toEqual({ pid: 4242, parentPid: 1, startedAt: new Date(Date.parse(lstart)).toISOString() });
    expect(read?.get(77)).toEqual({ pid: 77, parentPid: 4242, startedAt: undefined });

    await expect(readProcessTable({ ps: async () => '' })).resolves.toBeUndefined();
    await expect(
      readProcessTable({
        ps: async () => {
          throw new Error('ps: not found');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("finds the owner among a process and its ancestors, by pid and start time, and answers the host's own record", async () => {
    // 900 ← 800 ← 700 (a shell of the host's) ← 1
    const processTable = table([
      [900, 800, 'c'],
      [800, 700, 'b'],
      [700, 1, 'a'],
      [1, 0, 'init'],
    ]);
    const shell = { pid: 700, startedAt: 'a', terminalSessionId: 'pane-1' };
    await expect(findOwningProcess({ pid: 900, owners: [shell], processTable })).resolves.toBe(shell);
    await expect(findOwningProcess({ pid: 700, owners: [shell], processTable })).resolves.toBe(shell);
    // A pid the system reused: the same number, another start.
    await expect(
      findOwningProcess({ pid: 900, owners: [{ pid: 700, startedAt: 'earlier' }], processTable }),
    ).resolves.toBeUndefined();
    // Below the shell, not above it.
    await expect(
      findOwningProcess({ pid: 700, owners: [{ pid: 800, startedAt: 'b' }], processTable }),
    ).resolves.toBeUndefined();
    // A process the table does not hold.
    await expect(findOwningProcess({ pid: 12_345, owners: [shell], processTable })).resolves.toBeUndefined();
  });

  it('ends the walk at pid 1, at a cycle, and after 32 processes', async () => {
    const withInit = table([
      [900, 1, 'c'],
      [1, 0, 'init'],
    ]);
    await expect(
      findOwningProcess({ pid: 900, owners: [{ pid: 1, startedAt: 'init' }], processTable: withInit }),
    ).resolves.toBeUndefined();
    const cycle = table([
      [10, 11, 'x'],
      [11, 10, 'y'],
    ]);
    await expect(
      findOwningProcess({ pid: 10, owners: [{ pid: 99, startedAt: 'z' }], processTable: cycle }),
    ).resolves.toBeUndefined();
    // 100 ← 101 ← … ← 139: the walk holds 32 processes, the first one among them.
    const chain = table(Array.from({ length: 40 }, (_, index) => [100 + index, 101 + index, `s${index}`] as const));
    const thirtySecond = { pid: 131, startedAt: 's31' };
    await expect(findOwningProcess({ pid: 100, owners: [thirtySecond], processTable: chain })).resolves.toBe(
      thirtySecond,
    );
    await expect(
      findOwningProcess({ pid: 100, owners: [{ pid: 132, startedAt: 's32' }], processTable: chain }),
    ).resolves.toBeUndefined();
  });

  it('reads no process table when there is no owner to find', async () => {
    const ps = vi.fn(async () => '');
    await expect(findOwningProcess({ pid: process.pid, owners: [], ps })).resolves.toBeUndefined();
    expect(ps).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'walks the real process table: this process runs under its parent, started when processStartedAt says',
    async () => {
      const startedAt = await processStartedAt(process.ppid);
      expect(startedAt).toBeDefined();
      const parent = { pid: process.ppid, startedAt: startedAt! };
      await expect(findOwningProcess({ pid: process.pid, owners: [parent] })).resolves.toBe(parent);
      await expect(
        findOwningProcess({ pid: process.pid, owners: [{ ...parent, startedAt: '2000-01-01T00:00:00.000Z' }] }),
      ).resolves.toBeUndefined();
    },
    30_000,
  );
});
