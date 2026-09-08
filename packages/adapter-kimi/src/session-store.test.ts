import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeKimiWorkDirKey,
  findKimiAgentJournals,
  findKimiSession,
  listKimiSessionsForCwd,
  readKimiSessionIndex,
  resolveKimiHome,
} from './session-store.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-store-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Kimi session-store addressing', () => {
  it('matches Kimi 0.34.0 workdir keys and home precedence', () => {
    expect(encodeKimiWorkDirKey('/Users/example/Projects/puppeteer')).toBe('wd_puppeteer_8be84339a83f');
    expect(encodeKimiWorkDirKey('/Users/example/Projects/puppeteer/')).toBe('wd_puppeteer_8be84339a83f');
    expect(encodeKimiWorkDirKey('/')).toBe('wd_workspace_8a5edab28263');
    expect(encodeKimiWorkDirKey('C:\\Repo')).toBe('wd_repo_99094984865d');
    expect(resolveKimiHome('/explicit', { KIMI_CODE_HOME: '/ambient' })).toBe(resolve('/explicit'));
    expect(resolveKimiHome(undefined, { KIMI_CODE_HOME: '/ambient' })).toBe(resolve('/ambient'));
  });

  it('folds a safe append-only index and rejects deletions and escaping paths', async () => {
    const home = await temporaryRoot();
    const sessions = join(home, 'sessions', 'wd_repo_deadbeef0000');
    const valid = join(sessions, 'session-valid');
    await mkdir(valid, { recursive: true });
    await writeFile(
      join(home, 'session_index.jsonl'),
      [
        JSON.stringify({ sessionId: 'session-valid', sessionDir: valid, workDir: '/repo' }),
        JSON.stringify({ sessionId: 'session-escape', sessionDir: join(home, '..', 'escape'), workDir: '/repo' }),
        JSON.stringify({
          sessionId: 'session-deleted',
          sessionDir: join(sessions, 'session-deleted'),
          workDir: '/repo',
        }),
        JSON.stringify({ sessionId: 'session-deleted', deleted: true }),
        '{torn',
      ].join('\n'),
    );

    const index = await readKimiSessionIndex(home);
    expect([...index.keys()]).toEqual(['session-valid']);
  });

  it('finds exact-bucket sessions without an index and orders main before subagents', async () => {
    const home = await temporaryRoot();
    const cwd = join(home, 'repo');
    const sessionId = 'session-1';
    const sessionDir = join(home, 'sessions', encodeKimiWorkDirKey(cwd), sessionId);
    await mkdir(join(sessionDir, 'agents', 'child'), { recursive: true });
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ id: sessionId, cwd }));
    await writeFile(join(sessionDir, 'agents', 'child', 'wire.jsonl'), '');
    await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), '');

    await expect(listKimiSessionsForCwd(home, cwd)).resolves.toMatchObject([{ sessionId, sessionDir }]);
    await expect(findKimiSession(home, sessionId, cwd)).resolves.toMatchObject({ sessionId, sessionDir });
    expect((await findKimiAgentJournals(sessionDir)).map((entry) => entry.agentId)).toEqual(['main', 'child']);
  });
});
