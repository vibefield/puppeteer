import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPiSession, piCwdKey } from './session-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function session(sessionDir: string, id: string): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `2026-08-25T00-00-00-000Z_${id}.jsonl`),
    `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-25T00:00:00Z', cwd: '/repo' })}\n`,
  );
}

describe('Pi session discovery', () => {
  it('uses Pi cwd encoding and resolves only an exact or unique UUID prefix', async () => {
    expect(piCwdKey('/private/tmp/repo')).toBe('--private-tmp-repo--');
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-pi-store-'));
    roots.push(root);
    await session(root, '01abcdef-1111');
    await session(root, '01abc999-2222');
    expect((await findPiSession(root, '01abcdef-1111'))?.sessionId).toBe('01abcdef-1111');
    expect((await findPiSession(root, '01abcd'))?.sessionId).toBe('01abcdef-1111');
    expect(await findPiSession(root, '01abc')).toBeUndefined();
  });
});
