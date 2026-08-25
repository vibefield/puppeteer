import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RestoreSnapshot } from '../restore-snapshot.js';
import {
  discardDurableRestoreState,
  durableRestoreSlotPaths,
  readDurableRestoreState,
  writeDurableRestoreState,
} from './restore-store.js';

const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'godview-restore-store-'));
  directories.push(path);
  return path;
}

function snapshot(updatedAtMs: number): RestoreSnapshot {
  return {
    version: 2,
    updatedAtMs,
    agents: [
      {
        runtimeSessionId: 'terminal-agent',
        kind: 'agent',
        agent: 'claude',
        nativeSessionId: 'native-agent',
        cwd: '/repo',
        workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      },
    ],
    windows: [],
  };
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('durable restore store', () => {
  it('alternates generations and reads the newest verified snapshot', () => {
    const root = directory();
    const first = writeDurableRestoreState(root, snapshot(1));
    const second = writeDurableRestoreState(root, snapshot(2), first.generation);

    expect(second.generation).toBe(2);
    expect(readDurableRestoreState(root)).toEqual({ generation: 2, snapshot: snapshot(2) });
    if (process.platform !== 'win32') {
      const modes = durableRestoreSlotPaths(root).map((path) => statSync(path).mode & 0o777);
      expect(modes).toEqual([0o600, 0o600]);
    }
  });

  it('falls back to the prior generation when the newest slot is truncated', () => {
    const root = directory();
    const first = writeDurableRestoreState(root, snapshot(1));
    writeDurableRestoreState(root, snapshot(2), first.generation);
    const newestPath = durableRestoreSlotPaths(root)[0]!;
    writeFileSync(newestPath, '{"truncated":');

    expect(readDurableRestoreState(root)).toEqual({ generation: 1, snapshot: snapshot(1) });
  });

  it('rejects a valid-looking payload whose checksum no longer matches', () => {
    const root = directory();
    writeDurableRestoreState(root, snapshot(1));
    const path = durableRestoreSlotPaths(root)[1]!;
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { snapshot: { updatedAtMs: number } };
    envelope.snapshot.updatedAtMs = 99;
    writeFileSync(path, JSON.stringify(envelope));

    expect(readDurableRestoreState(root)).toBeUndefined();
  });

  it('detects added unknown fields instead of normalizing them out before digest verification', () => {
    const root = directory();
    writeDurableRestoreState(root, snapshot(1));
    const path = durableRestoreSlotPaths(root)[1]!;
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { snapshot: Record<string, unknown> };
    envelope.snapshot['injected'] = true;
    writeFileSync(path, JSON.stringify(envelope));

    expect(readDurableRestoreState(root)).toBeUndefined();
  });

  it('ignores abandoned temporary writes and removes all committed state on discard', () => {
    const root = directory();
    writeDurableRestoreState(root, snapshot(1));
    writeFileSync(join(root, '.restore-state-deadbeef.tmp'), '{');
    expect(readDurableRestoreState(root)?.generation).toBe(1);
    discardDurableRestoreState(root);
    expect(readDurableRestoreState(root)).toBeUndefined();
  });
});
