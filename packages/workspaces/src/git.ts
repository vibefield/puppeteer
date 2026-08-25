/**
 * Minimal git plumbing for workspace providers. execFile only — arguments are
 * never shell-interpolated (DESIGN §23.1), and every call is rooted with -C.
 */

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { normalize } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git reports paths with forward slashes on every platform, Windows included.
 * Rewrite them to the platform separator before comparing against anything
 * Node produced (realpath, join, …), which uses backslashes on win32.
 */
export function gitPath(value: string): string {
  return normalize(value);
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trimEnd();
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await git(path, 'rev-parse', '--git-dir');
    return true;
  } catch {
    return false;
  }
}

/** HEAD commit, or undefined for a repo with no commits yet. */
export async function headCommit(cwd: string): Promise<string | undefined> {
  try {
    return await git(cwd, 'rev-parse', 'HEAD');
  } catch {
    return undefined;
  }
}

export async function porcelainStatus(cwd: string): Promise<string> {
  return git(cwd, 'status', '--porcelain');
}

/** NUL-delimited porcelain avoids quoting and whitespace ambiguity in provenance capture. */
export async function porcelainStatusNull(cwd: string): Promise<string> {
  return git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
}

/** Full symbolic HEAD ref, including for an unborn branch. */
export async function headRef(cwd: string): Promise<string | undefined> {
  try {
    return await git(cwd, 'symbolic-ref', '--quiet', 'HEAD');
  } catch {
    return undefined;
  }
}

/** Canonical common Git directory; identical for every worktree of one repository. */
export async function commonGitDirectory(cwd: string): Promise<string> {
  let value: string;
  try {
    value = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  } catch {
    const relative = await git(cwd, 'rev-parse', '--git-common-dir');
    value = isAbsolute(relative) ? relative : resolve(cwd, relative);
  }
  return realpath(value);
}

/** Paths from `status --porcelain` output; renames yield the NEW path. */
export function filesFromPorcelain(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const renameArrow = path.indexOf(' -> ');
      const chosen = renameArrow === -1 ? path : path.slice(renameArrow + 4);
      return chosen.replace(/^"(.*)"$/, '$1');
    });
}

/** Parse `diff --shortstat` (" 2 files changed, 10 insertions(+), 3 deletions(-)"). */
export function parseShortstat(shortstat: string): { insertions: number; deletions: number } {
  const insertions = /(\d+) insertion/.exec(shortstat);
  const deletions = /(\d+) deletion/.exec(shortstat);
  return {
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}
