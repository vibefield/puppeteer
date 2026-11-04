import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Compare the actual directory when Windows short names or symlinks give it different spellings. */
export async function sameOpenCodeDirectory(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  try {
    const [a, b] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })]);
    return a.isDirectory() && b.isDirectory() && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch {
    // An unresolvable backend path cannot establish ownership of the requested workspace.
    return false;
  }
}
