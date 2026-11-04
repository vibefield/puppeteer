import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sameOpenCodeDirectory } from './directory.js';

it('accepts an alias of the session directory but refuses a different or missing workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-directory-'));
  try {
    const directory = join(root, 'workspace');
    const alias = join(root, 'alias');
    const other = join(root, 'other');
    mkdirSync(directory);
    mkdirSync(other);
    symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await sameOpenCodeDirectory(directory, alias)).toBe(true);
    expect(await sameOpenCodeDirectory(alias, directory)).toBe(true);
    expect(await sameOpenCodeDirectory(directory, other)).toBe(false);
    expect(await sameOpenCodeDirectory(directory, join(root, 'missing'))).toBe(false);
    const file = join(root, 'file');
    writeFileSync(file, 'not a directory');
    const fileAlias = join(root, 'file-alias');
    if (process.platform !== 'win32') {
      symlinkSync(file, fileAlias);
      expect(await sameOpenCodeDirectory(file, fileAlias)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
