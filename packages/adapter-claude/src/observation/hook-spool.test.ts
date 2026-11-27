import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { takeClaudeHookSpool } from './hook-spool.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spoolDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hook-spool-'));
  dirs.push(dir);
  return dir;
}

const line = (fields: Record<string, unknown>): string =>
  `${JSON.stringify({ v: 1, at: '2026-11-27T00:00:00.000Z', hook_event_name: 'SessionStart', ...fields })}\n`;

describe('takeClaudeHookSpool', () => {
  it('reads the starts in the order they ran, and takes the spool by renaming it beside itself', () => {
    const dir = spoolDir();
    const spool = join(dir, 'launch.hook-spool.jsonl');
    writeFileSync(
      spool,
      line({ session_id: 's-clear', source: 'clear', transcript_path: '/root/projects/-tmp/s-clear.jsonl' }) +
        line({ session_id: 's-resume', source: 'resume' }),
    );
    expect(takeClaudeHookSpool(spool)).toEqual([
      {
        at: '2026-11-27T00:00:00.000Z',
        sessionId: 's-clear',
        source: 'clear',
        transcriptPath: '/root/projects/-tmp/s-clear.jsonl',
      },
      { at: '2026-11-27T00:00:00.000Z', sessionId: 's-resume', source: 'resume' },
    ]);
    // taken, never deleted: the run's cleanup removes the launch's files
    expect(existsSync(spool)).toBe(false);
    expect(readdirSync(dir)).toEqual(['launch.hook-spool.jsonl.1.taken']);
    // a later attach reads only what was kept since, and the earlier take keeps its own name
    appendFileSync(spool, line({ session_id: 's-later', source: 'clear' }));
    expect(takeClaudeHookSpool(spool).map((start) => start.sessionId)).toEqual(['s-later']);
    expect(readdirSync(dir).sort()).toEqual(['launch.hook-spool.jsonl.1.taken', 'launch.hook-spool.jsonl.2.taken']);
    expect(readFileSync(join(dir, 'launch.hook-spool.jsonl.1.taken'), 'utf8')).toContain('s-resume');
  });

  it('reads no spool as no starts', () => {
    const dir = spoolDir();
    expect(takeClaudeHookSpool(join(dir, 'never-written.hook-spool.jsonl'))).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('skips a line torn by a forwarder still writing it, and a line that is not a kept start', () => {
    const dir = spoolDir();
    const spool = join(dir, 'torn.hook-spool.jsonl');
    writeFileSync(
      spool,
      line({ session_id: 's-1', source: 'clear' }) +
        'not json\n' +
        `${JSON.stringify({ v: 2, at: 'x', hook_event_name: 'SessionStart', session_id: 's-v2' })}\n` +
        line({ hook_event_name: 'Stop', session_id: 's-stop' }) +
        line({ session_id: '   ' }) +
        line({ session_id: 's-2', source: 'resume' }) +
        '{"v":1,"at":"2026-11-27T00:00:01.000Z","hook_event_name":"Sess',
    );
    expect(takeClaudeHookSpool(spool).map(({ sessionId, source }) => ({ sessionId, source }))).toEqual([
      { sessionId: 's-1', source: 'clear' },
      { sessionId: 's-2', source: 'resume' },
    ]);
  });

  it('reads no more than the forwarder keeps: 256 starts within 64 KiB', () => {
    const dir = spoolDir();
    const spool = join(dir, 'long.hook-spool.jsonl');
    writeFileSync(
      spool,
      Array.from({ length: 300 }, (_, n) => line({ session_id: `s-${n}`, source: 'clear' })).join(''),
    );
    const starts = takeClaudeHookSpool(spool);
    expect(starts).toHaveLength(256);
    expect(starts[0]!.sessionId).toBe('s-0');
    expect(starts.at(-1)!.sessionId).toBe('s-255');
  });

  it('refuses a spool named by a relative path', () => {
    expect(() => takeClaudeHookSpool('relative.hook-spool.jsonl')).toThrow(/absolute/u);
  });
});
