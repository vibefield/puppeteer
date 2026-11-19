import { describe, expect, it } from 'vitest';
import type { AdapterEventCandidate, AgentAdapterEventSource } from '@vibefield/puppeteer-core';
import { CodexPromptEchoes, echoText } from './prompt-echo.js';

/** The observer's stream as the session sees it: listeners in, `turn:started` candidates out. */
function observerStream() {
  const listeners = new Set<(candidate: AdapterEventCandidate) => void>();
  const events: AgentAdapterEventSource = {
    onCandidate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  function started(prompt: string | undefined, turnId: string, replay = false): void {
    const candidate: AdapterEventCandidate = {
      type: 'turn:started',
      sessionId: 'thread-1',
      timestamp: '2026-11-19T00:00:00.000Z',
      monotonicTime: 0,
      source: 'native-hook',
      confidence: 'authoritative',
      replay,
      event: { type: 'turn:started', turnId, prompt },
    };
    for (const listener of [...listeners]) listener(candidate);
  }
  return { events, listeners, started };
}

describe('CodexPromptEchoes', () => {
  it("confirms on the thread's own record of the pasted text, with its turn", async () => {
    const stream = observerStream();
    const echoes = new CodexPromptEchoes(stream.events);
    const wait = echoes.expect('run the tests');
    wait.arm(1_000);
    stream.started('run the tests', 'turn-1');
    expect(await wait.receipt).toEqual({ status: 'confirmed', turnId: 'turn-1' });
    expect(stream.listeners.size).toBe(0);
  });

  it('hears an echo that arrives inside the paste, before the bound is armed', async () => {
    const stream = observerStream();
    const wait = new CodexPromptEchoes(stream.events).expect('hello');
    stream.started('hello', 'turn-1');
    wait.arm(1_000);
    expect(await wait.receipt).toEqual({ status: 'confirmed', turnId: 'turn-1' });
  });

  it("never claims someone else's input: a different text keeps waiting, then is uncertain", async () => {
    const stream = observerStream();
    const wait = new CodexPromptEchoes(stream.events).expect('my prompt');
    wait.arm(60);
    stream.started('something the person typed', 'turn-person');
    // A draft glued to the paste is a different text too.
    stream.started('draft words my prompt', 'turn-glued');
    const receipt = await wait.receipt;
    expect(receipt.status).toBe('uncertain');
    expect(receipt).toMatchObject({ reason: expect.stringContaining('no matching input on the thread within 60ms') });
  });

  it('is uncertain when the thread records nothing in time', async () => {
    const stream = observerStream();
    const wait = new CodexPromptEchoes(stream.events).expect('hello');
    wait.arm(60);
    expect((await wait.receipt).status).toBe('uncertain');
    expect(stream.listeners.size).toBe(0);
  });

  it("ignores the thread's replayed history", async () => {
    const stream = observerStream();
    const wait = new CodexPromptEchoes(stream.events).expect('hello');
    wait.arm(60);
    stream.started('hello', 'turn-old', true);
    expect((await wait.receipt).status).toBe('uncertain');
  });

  it('ignores a turn that names no prompt', async () => {
    const stream = observerStream();
    const wait = new CodexPromptEchoes(stream.events).expect('hello');
    wait.arm(60);
    stream.started(undefined, 'turn-1');
    expect((await wait.receipt).status).toBe('uncertain');
  });

  it('matches waiting submissions of equal text first in, first out', async () => {
    const stream = observerStream();
    const echoes = new CodexPromptEchoes(stream.events);
    const first = echoes.expect('again');
    const second = echoes.expect('again');
    first.arm(1_000);
    second.arm(60);
    stream.started('again', 'turn-1');
    expect(await first.receipt).toEqual({ status: 'confirmed', turnId: 'turn-1' });
    expect((await second.receipt).status).toBe('uncertain');
  });

  it('compares with line endings normalized and trailing whitespace dropped', async () => {
    expect(echoText('line one\r\nline two\n  ')).toBe('line one\nline two');
    const stream = observerStream();
    const wait = new CodexPromptEchoes(stream.events).expect('line one\r\nline two\n');
    wait.arm(1_000);
    stream.started('line one\nline two', 'turn-1');
    expect((await wait.receipt).status).toBe('confirmed');
  });

  it('subscribes only while a submission waits, and a withdrawn one settles as told', async () => {
    const stream = observerStream();
    const echoes = new CodexPromptEchoes(stream.events);
    expect(stream.listeners.size).toBe(0);
    const wait = echoes.expect('hello');
    expect(stream.listeners.size).toBe(1);
    wait.withdraw({ status: 'rejected', reason: 'human-input-conflict' });
    expect(await wait.receipt).toEqual({ status: 'rejected', reason: 'human-input-conflict' });
    expect(stream.listeners.size).toBe(0);
  });

  it('settles waiting submissions as uncertain on dispose, and refuses later ones', async () => {
    const stream = observerStream();
    const echoes = new CodexPromptEchoes(stream.events);
    const wait = echoes.expect('hello');
    echoes.dispose();
    expect(await wait.receipt).toMatchObject({ status: 'uncertain' });
    expect(await echoes.expect('later').receipt).toEqual({
      status: 'rejected',
      reason: 'codex session is disposed',
      retryable: false,
    });
    expect(stream.listeners.size).toBe(0);
  });
});
