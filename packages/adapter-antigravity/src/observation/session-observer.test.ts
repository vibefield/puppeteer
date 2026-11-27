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

function observe(root: string, sessionId?: string, ownedRoot?: boolean): AntigravitySessionObserver {
  const observer = createAntigravitySessionObserver({
    root,
    baselineSessionIds: new Set(),
    pollIntervalMs: 60_000,
    ...(sessionId ? { location: antigravitySessionLocation(root, sessionId) } : {}),
    ...(ownedRoot ? { ownedRoot } : {}),
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

describe('Antigravity in a root the run owns', () => {
  it('binds the one new transcript a person typed into, with no prompt sent through puppeteer', async () => {
    const root = await store();
    const observer = observe(root, undefined, true);
    const binds: string[] = [];
    observer.onBind((bound) => binds.push(bound.sessionId));
    // a transcript with no typed prompt yet is not enough
    const { transcriptPath } = antigravitySessionLocation(root, 'session-typed');
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, '');
    await observer.poll();
    expect(observer.sessionId()).toBeUndefined();
    await transcript(root, 'session-typed', 'typed in the pane');
    await observer.poll();
    expect(observer.sessionId()).toBe('session-typed');
    expect(binds).toEqual(['session-typed']);
  });

  it('binds nothing while two transcripts are new, or while another run in the root is unbound', async () => {
    const root = await store();
    const observer = observe(root, undefined, true);
    await transcript(root, 'session-a', 'one');
    await transcript(root, 'session-b', 'two');
    await observer.poll();
    expect(observer.sessionId()).toBeUndefined();

    const shared = await store();
    const first = observe(shared, undefined, true);
    const second = observe(shared, undefined, true);
    await transcript(shared, 'session-c', 'typed');
    await Promise.all([first.poll(), second.poll()]);
    expect([first.sessionId(), second.sessionId()]).toEqual([undefined, undefined]);
    // once the other run binds by its own prompt's echo, the one left is this run's
    const echo = second.expectPrompt('typed', 10_000);
    await second.poll();
    await expect(echo.promise).resolves.toEqual({ matched: true, sessionId: 'session-c' });
    await transcript(shared, 'session-d', 'typed here');
    await first.poll();
    expect(first.sessionId()).toBe('session-d');
  });

  it('decides by the echo alone while a prompt it sent waits, and a root it does not own binds only by echo', async () => {
    const root = await store();
    const owned = observe(root, undefined, true);
    owned.expectPrompt('sent', 10_000);
    await transcript(root, 'session-typed', 'something else');
    await owned.poll();
    expect(owned.sessionId()).toBeUndefined();

    const native = await store();
    const observer = observe(native);
    await transcript(native, 'session-typed', 'typed only');
    await observer.poll();
    expect(observer.sessionId()).toBeUndefined();
  });
});
