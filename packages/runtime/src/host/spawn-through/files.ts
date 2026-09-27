import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Create a directory of the shim home, owner-only, and hold an existing one to owner-only too. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/**
 * Publish one file of the shim home so no reader ever sees it half-written: a
 * temp file in the same directory, its mode set, then `rename` over the name. A
 * file whose bytes and mode already match is left alone, so republishing the
 * same content changes nothing (a shell may be executing it at that moment).
 */
export async function publishFile(path: string, content: string | Buffer, mode: number): Promise<void> {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  try {
    const [existing, status] = await Promise.all([readFile(path), stat(path)]);
    if (status.isFile() && (status.mode & 0o777) === mode && existing.equals(bytes)) return;
  } catch {
    // Absent or unreadable: publish it.
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode, flag: 'wx' });
    // The creation mode passes through the umask; the published file's mode must not.
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
