/**
 * Cleanup for opt-in live tests that run a real vendor agent in a throwaway root. A vendor agent can leave
 * helpers running after its own process is gone (Codex's plugin-sync `git`, a TUI that outlives its
 * pseudoconsole on Windows), and they keep the root busy: ENOTEMPTY on POSIX, and on Windows EBUSY,
 * because an open handle or a process's working directory blocks the removal itself, however often it is
 * retried. So the root is removed only after nothing that names it is still running.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';

export interface LiveProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

/** `Get-CimInstance Win32_Process | ConvertTo-Json` rows: one object for a single process, else an array. */
export function parseWindowsProcessTable(json: string): LiveProcess[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((row) => {
    const { ProcessId, ParentProcessId, CommandLine } = (row ?? {}) as Record<string, unknown>;
    return typeof ProcessId === 'number'
      ? [
          {
            pid: ProcessId,
            ppid: typeof ParentProcessId === 'number' ? ParentProcessId : 0,
            command: typeof CommandLine === 'string' ? CommandLine : '',
          },
        ]
      : [];
  });
}

function processTable(): LiveProcess[] {
  try {
    if (process.platform === 'win32') {
      return parseWindowsProcessTable(
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
          ],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        ),
      );
    }
    return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s(.*)$/u.exec(line);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
      });
  } catch {
    return [];
  }
}

/**
 * The processes in `rows` whose command line names `root`, with their descendants. On Windows a process may
 * name the root under its long name or with forward slashes, and paths compare without case.
 */
export function processesUnderRoot(
  rows: readonly LiveProcess[],
  spellings: readonly string[],
  { ownPid = process.pid, platform = process.platform }: { ownPid?: number; platform?: NodeJS.Platform } = {},
): number[] {
  const fold = (value: string): string => (platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value);
  const needles = [...new Set(spellings.filter(Boolean).map(fold))];
  const found = new Set(
    rows
      .filter((row) => row.pid !== ownPid && needles.some((needle) => fold(row.command).includes(needle)))
      .map((row) => row.pid),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (row.pid !== ownPid && found.has(row.ppid) && !found.has(row.pid)) {
        found.add(row.pid);
        grew = true;
      }
    }
  }
  return [...found];
}

function rootSpellings(root: string): string[] {
  try {
    return [root, realpathSync.native(root)];
  } catch {
    return [root];
  }
}

/** Kill what still works under `root` (Windows: TerminateProcess) until nothing names it. */
export async function stopProcessesUnder(root: string): Promise<void> {
  const spellings = rootSpellings(root);
  // Listing processes on Windows starts PowerShell, about a second each, so it is tried fewer times.
  const attempts = process.platform === 'win32' ? 10 : 50;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const survivors = processesUnderRoot(processTable(), spellings);
    if (survivors.length === 0) return;
    for (const pid of survivors) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const REMOVAL_RETRIES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

/**
 * Stop what still works under a live test's root, then remove it. Call it after the test has disposed its
 * own sessions and terminals. On Windows a handle a vendor helper still holds can outlast every attempt;
 * the root is a throwaway temp directory on a disposable runner, so there the leftover is reported instead
 * of raised over the test's own result (and its attestation).
 */
export async function removeLiveRoot(root: string, label = 'live'): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < (process.platform === 'win32' ? 8 : 1); attempt += 1) {
    await stopProcessesUnder(root);
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      return;
    } catch (error) {
      failure = error;
      if (!REMOVAL_RETRIES.has((error as NodeJS.ErrnoException).code ?? '')) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (process.platform !== 'win32') throw failure;
  console.warn(`${label} root left behind: ${failure instanceof Error ? failure.message : String(failure)}`);
}
