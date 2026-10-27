import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';
import { copilotSessionLocation } from './observation/session-store.js';
import { prepareCopilotTuiSession } from './driver.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'puppeteer-copilot-tui-'));
  roots.push(value);
  return value;
}

/** The first record of a session's events.jsonl, trimmed from the copilot@1.0.80 basic-chat capture (packages/surface). */
async function writeEvents(home: string, sessionId: string): Promise<void> {
  const location = copilotSessionLocation(home, sessionId);
  await mkdir(location.sessionDir, { recursive: true });
  await writeFile(
    location.eventsPath,
    `${JSON.stringify({
      type: 'session.start',
      data: { sessionId },
      id: 'record-1',
      parentId: null,
      timestamp: '2026-10-27T00:00:00Z',
    })}\n`,
  );
}

const host = (): AgentHost => ({
  spawnTerminal: vi.fn(),
  automateTerminal: vi.fn(async () => ({ accepted: true as const })),
});

describe('Copilot native TUI session: the durable record (RA-D7)', () => {
  it('has not seen its record until the tail reads events.jsonl, though its id is fixed at launch', async () => {
    const home = await root();
    const prepared = await prepareCopilotTuiSession({
      cwd: '/repo',
      host: host(),
      executable: '/opt/copilot',
      copilotHome: home,
      pollIntervalMs: 60_000,
    });
    expect(prepared.launch.args).toEqual(['--session-id', prepared.sessionId]);
    const session = await prepared.adopt('runtime-copilot');
    expect(session.durableRecordSeen()).toBe(false);
    await writeEvents(home, prepared.sessionId);
    // the observer's final bounded poll at teardown reads the record
    await prepared.dispose();
    expect(session.durableRecordSeen()).toBe(true);
  });

  it('has seen the record of a session it resumes', async () => {
    const home = await root();
    await writeEvents(home, 'copilot-session-resumed');
    const prepared = await prepareCopilotTuiSession({
      cwd: '/repo',
      host: host(),
      executable: '/opt/copilot',
      copilotHome: home,
      resume: 'copilot-session-resumed',
      pollIntervalMs: 60_000,
    });
    const session = await prepared.adopt('runtime-copilot-resume');
    expect(session.durableRecordSeen()).toBe(true);
    await prepared.dispose();
  });
});
