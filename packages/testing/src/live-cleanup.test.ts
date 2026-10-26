import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWindowsProcessTable, processesUnderRoot, removeLiveRoot } from './live-cleanup.js';

describe('stopping what a live root leaves running', () => {
  // The windows-2025 promotion lane failed with EBUSY: Codex's plugin-sync git still held
  // codex-home\.tmp\plugins-clone-* open, and nothing listed Windows processes.
  it('finds a helper under any spelling of the root on Windows, with its descendants', () => {
    const table = parseWindowsProcessTable(
      JSON.stringify([
        { ProcessId: 10, ParentProcessId: 1, CommandLine: 'node vitest' },
        {
          ProcessId: 20,
          ParentProcessId: 7,
          CommandLine:
            '"C:\\Program Files\\Git\\cmd\\git.exe" -C C:/Users/runneradmin/AppData/Local/Temp/puppeteer-codex-live-KhAe5T/codex-home/.tmp/plugins-clone-Ubeta9 fetch --depth 1',
        },
        { ProcessId: 21, ParentProcessId: 20, CommandLine: 'git index-pack --stdin' },
        { ProcessId: 30, ParentProcessId: 1, CommandLine: null },
        { ProcessId: 40, ParentProcessId: 10, CommandLine: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\other' },
      ]),
    );
    expect(table).toHaveLength(5);
    expect(
      processesUnderRoot(
        table,
        [
          'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\puppeteer-codex-live-KhAe5T',
          'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\puppeteer-codex-live-KhAe5T',
        ],
        { ownPid: 10, platform: 'win32' },
      ).sort(),
    ).toEqual([20, 21]);
    // A single process is serialized as an object, not an array; unparseable output lists nothing.
    expect(parseWindowsProcessTable('{"ProcessId":5,"ParentProcessId":1,"CommandLine":"x"}')).toEqual([
      { pid: 5, ppid: 1, command: 'x' },
    ]);
    expect(parseWindowsProcessTable('')).toEqual([]);
  });

  // The windows-2025 Claude lane failed with EBUSY on its workspace: the Claude TUI outlived its pseudoconsole
  // with the workspace as its working directory, and its command line names the root's settings file.
  it('finds a TUI that names the root only through an argument', () => {
    const rows = [
      {
        pid: 50,
        ppid: 1,
        command:
          'D:\\a\\agent.exe --settings C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\puppeteer-claude-live-yA\\settings.json',
      },
      { pid: 51, ppid: 50, command: 'conhost.exe' },
    ];
    expect(
      processesUnderRoot(rows, ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\puppeteer-claude-live-yA'], {
        ownPid: 1,
        platform: 'win32',
      }).sort(),
    ).toEqual([50, 51]);
  });

  it('matches POSIX command lines exactly and never names its own process', () => {
    const rows = [
      { pid: 1, ppid: 0, command: 'git -C /tmp/live-root/codex-home/.tmp/plugins-clone-x fetch' },
      { pid: 2, ppid: 1, command: 'git index-pack' },
      { pid: 3, ppid: 0, command: 'git -C /TMP/LIVE-ROOT fetch' },
      { pid: 4, ppid: 0, command: 'node /tmp/live-root/vitest' },
    ];
    expect(processesUnderRoot(rows, ['/tmp/live-root'], { ownPid: 4, platform: 'darwin' }).sort()).toEqual([1, 2]);
  });

  it('removes a root once nothing works under it', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'live-remove-')));
    writeFileSync(join(root, 'file'), 'x');
    await removeLiveRoot(root);
    expect(existsSync(root)).toBe(false);
  });
});
