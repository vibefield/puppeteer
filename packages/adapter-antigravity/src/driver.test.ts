import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';
import { antigravitySessionLocation } from './observation/session-store.js';
import { prepareAntigravityTuiSession } from './driver.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'puppeteer-antigravity-tui-'));
  roots.push(root);
  return root;
}

const host = (): AgentHost => ({
  spawnTerminal: vi.fn(),
  automateTerminal: vi.fn(async () => ({ accepted: true as const })),
});

describe('Antigravity native TUI session: the durable record (RA-D7)', () => {
  it('has not seen a record while its id is provisional', async () => {
    const dataRoot = await store();
    const prepared = await prepareAntigravityTuiSession({
      cwd: '/repo',
      host: host(),
      executable: '/opt/agy',
      dataRoot,
      pollIntervalMs: 60_000,
    });
    expect(prepared.sessionId).toMatch(/^antigravity-pending-/);
    const session = await prepared.adopt('runtime-antigravity');
    expect(session.durableRecordSeen()).toBe(false);
    await prepared.dispose();
  });

  it('has seen the transcript of a conversation it resumes', async () => {
    const dataRoot = await store();
    const { transcriptPath } = antigravitySessionLocation(dataRoot, 'conversation-resumed');
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        step_index: 0,
        created_at: '2026-10-27T00:00:00Z',
        content: '<USER_REQUEST>hello</USER_REQUEST>',
      })}\n`,
    );
    const prepared = await prepareAntigravityTuiSession({
      cwd: '/repo',
      host: host(),
      executable: '/opt/agy',
      dataRoot,
      resume: 'conversation-resumed',
      pollIntervalMs: 60_000,
    });
    const session = await prepared.adopt('runtime-antigravity-resume');
    expect(session.durableRecordSeen()).toBe(true);
    await prepared.dispose();
  });
});
