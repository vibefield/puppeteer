import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';
import { preparePiTuiSession } from './driver.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'puppeteer-pi-tui-'));
  roots.push(value);
  return value;
}

/** What Pi writes when a session's first user or assistant message lands: the header line names the id. */
async function writeSession(sessionDir: string, id: string, entries: readonly object[] = []): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const header = { type: 'session', version: 3, id, timestamp: '2026-10-27T00:00:00Z', cwd: '/repo' };
  await writeFile(
    join(sessionDir, `2026-10-27T00-00-00-000Z_${id}.jsonl`),
    [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join(''),
  );
}

const host = (): AgentHost => ({
  spawnTerminal: vi.fn(),
  automateTerminal: vi.fn(async () => ({ accepted: true as const })),
});

describe('Pi native TUI session: the durable record (RA-D7)', () => {
  it('has not seen its record until Pi writes the session file, though its id is exact from launch', async () => {
    const home = await root();
    const sessionDir = join(home, 'sessions');
    const prepared = await preparePiTuiSession({
      cwd: '/repo',
      host: host(),
      executable: '/opt/pi',
      piAgentDir: join(home, 'agent'),
      sessionDir,
      pollIntervalMs: 60_000,
    });
    expect(prepared.launch.args).toEqual(['--session-dir', sessionDir, '--session-id', prepared.sessionId]);
    const session = await prepared.adopt('runtime-pi');
    expect(session.durableRecordSeen()).toBe(false);
    await writeSession(sessionDir, prepared.sessionId);
    // the observer's final bounded poll at teardown finds the file
    await prepared.dispose();
    expect(session.sessionFile()).toBeDefined();
    expect(session.durableRecordSeen()).toBe(true);
  });

  it('has seen the record of a session it resumes', async () => {
    const home = await root();
    const sessionDir = join(home, 'sessions');
    await writeSession(sessionDir, 'pi-session-resumed');
    const prepared = await preparePiTuiSession({
      cwd: '/repo',
      host: host(),
      executable: '/opt/pi',
      piAgentDir: join(home, 'agent'),
      sessionDir,
      resume: 'pi-session-resumed',
      pollIntervalMs: 60_000,
    });
    const session = await prepared.adopt('runtime-pi-resume');
    expect(session.durableRecordSeen()).toBe(true);
    await prepared.dispose();
  });

  it('resumes a 1.5.0 journal whose first turn stopped after the user message', async () => {
    const home = await root();
    const sessionDir = join(home, 'sessions');
    await writeSession(sessionDir, 'pi-session-user-only', [
      {
        type: 'thinking_level_change',
        id: 'e1',
        parentId: null,
        timestamp: '2026-10-27T00:00:00Z',
        thinkingLevel: 'off',
      },
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-10-27T00:00:01Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 },
      },
    ]);
    const prepared = await preparePiTuiSession({
      cwd: '/repo',
      host: host(),
      executable: '/opt/pi',
      piAgentDir: join(home, 'agent'),
      sessionDir,
      resume: 'pi-session-user-only',
      pollIntervalMs: 60_000,
    });
    expect(prepared.launch.args).toContain('pi-session-user-only');
    const session = await prepared.adopt('runtime-pi-user-only');
    expect(session.durableRecordSeen()).toBe(true);
    await prepared.dispose();
  });

  it('refuses a provider without a model, which Pi 1.5.0 exits on at startup', async () => {
    const home = await root();
    await expect(
      preparePiTuiSession({
        cwd: '/repo',
        host: host(),
        executable: '/opt/pi',
        piAgentDir: join(home, 'agent'),
        sessionDir: join(home, 'sessions'),
        provider: 'openai',
      }),
    ).rejects.toThrow('Pi requires a model whenever a provider is selected');
  });
});
