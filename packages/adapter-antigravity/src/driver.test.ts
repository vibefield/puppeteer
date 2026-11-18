import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEventCandidate, AgentHost } from '@vibefield/puppeteer-core';
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

describe('Antigravity native TUI session: the journal chooses the monitor contract', () => {
  it('re-announces the capabilities under 1.4.12 once a 1.4.12 record is observed', async () => {
    const dataRoot = await store();
    const { transcriptPath } = antigravitySessionLocation(dataRoot, 'conversation-1-4-12');
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(
      transcriptPath,
      await readFile(
        new URL('../../surface/vendors/antigravity/captures/antigravity@1.4.12/tool-use/events.jsonl', import.meta.url),
      ),
    );
    const prepared = await prepareAntigravityTuiSession({
      cwd: '/repo',
      host: host(),
      executable: '/opt/agy',
      dataRoot,
      resume: 'conversation-1-4-12',
      pollIntervalMs: 60_000,
    });
    const session = await prepared.adopt('runtime-antigravity-1-4-12');
    const candidates: AdapterEventCandidate[] = [];
    session.events.onCandidate((candidate) => candidates.push(candidate));
    await prepared.dispose();
    const contracts = candidates.flatMap(({ event }) =>
      event.type === 'monitor:batch' ? [event.batch.producer.contractVersion] : [],
    );
    expect(contracts).toEqual(['antigravity-transcript@1.1.20', 'antigravity-transcript@1.4.12']);
    expect(candidates.map(({ event }) => event.type)).toContain('tool:completed');
  });
});
