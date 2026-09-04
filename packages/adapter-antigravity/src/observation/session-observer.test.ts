import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAntigravitySessionObserver, type AntigravitySessionObserver } from './session-observer.js';
import { antigravitySessionLocation } from './session-store.js';

const roots: string[] = [];
const observers: AntigravitySessionObserver[] = [];

afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'puppeteer-antigravity-correlation-'));
  roots.push(root);
  return root;
}

function observe(root: string, sessionId?: string): AntigravitySessionObserver {
  const observer = createAntigravitySessionObserver({
    root,
    baselineSessionIds: new Set(),
    pollIntervalMs: 60_000,
    ...(sessionId ? { location: antigravitySessionLocation(root, sessionId) } : {}),
  });
  observers.push(observer);
  return observer;
}

async function transcript(root: string, sessionId: string, prompt: string): Promise<void> {
  const { transcriptPath } = antigravitySessionLocation(root, sessionId);
  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      status: 'DONE',
      step_index: 0,
      created_at: new Date().toISOString(),
      content: `<USER_REQUEST>${prompt}</USER_REQUEST>`,
    })}\n`,
  );
}

describe('Antigravity transcript correlation', () => {
  it('waits for each launch to echo its own prompt, even when only one new transcript exists', async () => {
    const root = await store();
    const first = observe(root);
    const second = observe(root);
    await transcript(root, 'session-a', 'first prompt');
    await Promise.all([first.poll(), second.poll()]);
    expect(first.sessionId()).toBeUndefined();
    expect(second.sessionId()).toBeUndefined();

    const firstEcho = first.expectPrompt('first prompt', 10_000);
    const secondEcho = second.expectPrompt('second prompt', 10_000);
    await Promise.all([first.poll(), second.poll()]);
    await expect(firstEcho.promise).resolves.toEqual({ matched: true, sessionId: 'session-a' });
    expect(second.sessionId()).toBeUndefined();

    await transcript(root, 'session-b', 'second prompt');
    await second.poll();
    await expect(secondEcho.promise).resolves.toEqual({ matched: true, sessionId: 'session-b' });
    expect(first.sessionId()).toBe('session-a');
    expect(second.sessionId()).toBe('session-b');
  });

  it('does not guess between identical concurrent submissions when their transcripts arrive at different times', async () => {
    const root = await store();
    const first = observe(root);
    const second = observe(root);
    const firstEcho = first.expectPrompt('continue', 10_000);
    second.expectPrompt('continue', 10_000);
    await transcript(root, 'session-a', 'continue');
    await Promise.all([first.poll(), second.poll()]);
    expect(first.sessionId()).toBeUndefined();
    expect(second.sessionId()).toBeUndefined();

    firstEcho.cancel();
    await second.poll();
    expect(second.sessionId()).toBeUndefined();
    await transcript(root, 'session-b', 'continue');
    await Promise.all([first.poll(), second.poll()]);
    expect(first.sessionId()).toBeUndefined();
    expect(second.sessionId()).toBeUndefined();
  });

  it('keeps a peer conversation excluded after its observer stops', async () => {
    const root = await store();
    const first = observe(root);
    const second = observe(root);
    first.expectPrompt('continue', 10_000);
    await transcript(root, 'session-a', 'continue');
    await first.poll();
    expect(first.sessionId()).toBe('session-a');
    await first.stop();

    const secondEcho = second.expectPrompt('continue', 10_000);
    await second.poll();
    expect(second.sessionId()).toBeUndefined();
    await transcript(root, 'session-b', 'continue');
    await second.poll();
    await expect(secondEcho.promise).resolves.toEqual({ matched: true, sessionId: 'session-b' });
  });

  it('leaves multiple matching transcripts unbound', async () => {
    const root = await store();
    const observer = observe(root);
    observer.expectPrompt('continue', 10_000);
    await transcript(root, 'session-a', 'continue');
    await transcript(root, 'session-b', 'continue');
    await observer.poll();
    expect(observer.sessionId()).toBeUndefined();
  });

  it('observes an explicitly resumed session without requiring a new prompt', async () => {
    const root = await store();
    await transcript(root, 'session-a', 'earlier prompt');
    const observer = observe(root, 'session-a');
    const events: string[] = [];
    observer.onEvent(({ event }) => events.push(event.type));
    await observer.poll();
    expect(observer.sessionId()).toBe('session-a');
    expect(events).toContain('turn:started');
  });
});
