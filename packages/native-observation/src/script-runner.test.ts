import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeOnPath, ownScriptRunnerFacts, resolveScriptRunner, type ScriptRunnerFacts } from './script-runner.js';

const NODE = '/opt/node/bin/node';
const ELECTRON = '/Applications/Host.app/Contents/MacOS/Host';

describe('resolveScriptRunner', () => {
  const realNode: ScriptRunnerFacts = { electron: false, sea: false, execPath: NODE, pathNode: undefined };

  it('a single executable has no runner: it runs only its own sealed entry, never a script it is handed', () => {
    expect(resolveScriptRunner({ ...realNode, sea: true })).toBeUndefined();
    // Not even with a Node on PATH: a packaged build names no program the person installed.
    expect(resolveScriptRunner({ ...realNode, sea: true, pathNode: '/usr/local/bin/node' })).toBeUndefined();
    expect(
      resolveScriptRunner({ electron: true, sea: true, execPath: ELECTRON, pathNode: '/usr/local/bin/node' }),
    ).toBeUndefined();
  });

  it('a real Node runs a script itself', () => {
    expect(resolveScriptRunner(realNode)).toEqual({ command: NODE, args: [] });
    expect(resolveScriptRunner({ ...realNode, pathNode: '/usr/local/bin/node' })).toEqual({ command: NODE, args: [] });
  });

  it('Electron prefers a Node on PATH', () => {
    expect(
      resolveScriptRunner({ electron: true, sea: false, execPath: ELECTRON, pathNode: '/usr/local/bin/node' }),
    ).toEqual({ command: '/usr/local/bin/node', args: [] });
  });

  it('Electron with no Node on PATH runs itself as Node', () => {
    expect(resolveScriptRunner({ electron: true, sea: false, execPath: ELECTRON, pathNode: undefined })).toEqual({
      command: ELECTRON,
      args: [],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('reads this process: a test run is a real Node, not a single executable', () => {
    const facts = ownScriptRunnerFacts();
    expect(facts).toMatchObject({ electron: false, sea: false, execPath: process.execPath });
    expect(resolveScriptRunner(facts)).toEqual({ command: process.execPath, args: [] });
  });
});

describe.skipIf(process.platform === 'win32')('nodeOnPath', () => {
  it('finds the first executable node on PATH, past an empty entry and a node that cannot run', () => {
    const root = mkdtempSync(join(tmpdir(), 'script-runner-path-'));
    try {
      const notExecutable = join(root, 'not-executable');
      const executable = join(root, 'executable');
      mkdirSync(notExecutable);
      mkdirSync(executable);
      writeFileSync(join(notExecutable, 'node'), '');
      chmodSync(join(notExecutable, 'node'), 0o644);
      writeFileSync(join(executable, 'node'), '');
      chmodSync(join(executable, 'node'), 0o755);
      expect(nodeOnPath(['', notExecutable, executable].join(delimiter), 'darwin')).toBe(join(executable, 'node'));
      expect(nodeOnPath(notExecutable, 'darwin')).toBeUndefined();
      expect(nodeOnPath('', 'darwin')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
