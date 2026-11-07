import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapterBinding, PromptSubmission } from '@vibefield/puppeteer-core';
import type { GrokQueueChanged } from '../normalization/queue.js';
import { GrokPromptService, type GrokPromptTurnIds } from './prompt.js';

/** Let a submission register and adapter-acp's answer arrive: microtasks only, so fake timers stay still. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

/**
 * adapter-acp's prompt service as Grok's control composition sees it: it publishes its turn inside submit (the
 * composition hands that to `bindAcpTurn`) and answers 'confirmed' at once.
 */
function fakeAcp(inside: (turnId: string) => void = () => undefined) {
  const submitted: PromptSubmission[] = [];
  const binding: AgentAdapterBinding = {
    sessionId: 'grok-session',
    runtimeSessionId: 'grok-session',
    observationLevel: () => 'structured',
    events: { onCandidate: () => () => undefined },
    services: {
      prompt: {
        async submit(submission) {
          submitted.push(submission);
          const turnId = `acp-turn-${submitted.length}`;
          inside(turnId);
          return { status: 'confirmed', turnId };
        },
      },
    },
    dispose: async () => undefined,
  };
  return { binding, submitted };
}

const listed = (id: string, text: string): GrokQueueChanged => ({ entries: [{ id, text, kind: 'prompt' }] });
const running = (id: string, text: string, entries: GrokQueueChanged['entries'] = []): GrokQueueChanged => ({
  entries,
  running: { promptId: id, text, kind: 'prompt' },
});

describe('GrokPromptService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function service(acp: AgentAdapterBinding | undefined, turnIds: GrokPromptTurnIds = 'native-prompt') {
    return new GrokPromptService({ control: async () => acp, turnIds });
  }

  it('confirms when Grok runs the prompt it listed with the submitted text, as the published turn', async () => {
    for (const [turnIds, turnId] of [
      ['native-prompt', 'q1'],
      ['acp-turn', 'acp-turn-1'],
    ] as const) {
      let prompts!: GrokPromptService;
      const acp = fakeAcp((acpTurnId) => prompts.bindAcpTurn(acpTurnId));
      prompts = service(acp.binding, turnIds);
      const receipt = prompts.submit({ text: 'hello' });
      await flush();
      prompts.observeQueue(listed('q1', 'hello'));
      expect(prompts.textOf('q1')).toBe('hello');
      prompts.observeQueue(running('q1', 'hello'));
      await expect(receipt).resolves.toEqual({ status: 'confirmed', turnId });
      expect(prompts.textOf('q1')).toBeUndefined();
    }
  });

  it('confirms a prompt Grok lists behind another running prompt', async () => {
    const prompts = service(fakeAcp().binding);
    const receipt = prompts.submit({ text: 'second' });
    await flush();
    prompts.observeQueue(running('q1', 'first', [{ id: 'q2', text: 'second', kind: 'prompt' }]));
    await expect(receipt).resolves.toEqual({ status: 'confirmed', turnId: 'q2' });
  });

  it('binds waiting prompts of equal text first in, first out', async () => {
    const prompts = service(fakeAcp().binding);
    const first = prompts.submit({ text: 'same' });
    const second = prompts.submit({ text: 'same' });
    await flush();
    prompts.observeQueue({
      entries: [
        { id: 'q1', text: 'same', kind: 'prompt' },
        { id: 'q2', text: 'same', kind: 'prompt' },
      ],
    });
    prompts.observeQueue(running('q1', 'same', [{ id: 'q2', text: 'same', kind: 'prompt' }]));
    await expect(first).resolves.toEqual({ status: 'confirmed', turnId: 'q1' });
    await expect(second).resolves.toEqual({ status: 'confirmed', turnId: 'q2' });
  });

  it('never confirms on a queued prompt of another text', async () => {
    vi.useFakeTimers();
    const prompts = service(fakeAcp().binding);
    const receipt = prompts.submit({ text: 'hello' });
    await flush();
    prompts.observeQueue(listed('q1', 'typed in the TUI'));
    prompts.observeQueue(running('q1', 'typed in the TUI'));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(receipt).resolves.toMatchObject({ status: 'uncertain' });
  });

  it('never takes an id Grok listed before the submission registered', async () => {
    vi.useFakeTimers();
    const prompts = service(fakeAcp().binding);
    // The person queued the same words in the TUI first.
    prompts.observeQueue(listed('q0', 'hello'));
    const receipt = prompts.submit({ text: 'hello' });
    await flush();
    prompts.observeQueue(running('q0', 'hello'));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(receipt).resolves.toMatchObject({ status: 'uncertain' });
  });

  it('settles once when Grok runs the prompt before adapter-acp answers, and arms no bound', async () => {
    vi.useFakeTimers();
    let prompts!: GrokPromptService;
    // The capture replay delivers Grok's frames inside the session/prompt request.
    const acp = fakeAcp((acpTurnId) => {
      prompts.bindAcpTurn(acpTurnId);
      prompts.observeQueue(listed('q1', 'hello'));
      prompts.observeQueue(running('q1', 'hello'));
    });
    prompts = service(acp.binding);
    await expect(prompts.submit({ text: 'hello' })).resolves.toEqual({ status: 'confirmed', turnId: 'q1' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers uncertain when Grok accepts nothing within the bound', async () => {
    vi.useFakeTimers();
    const prompts = service(fakeAcp().binding);
    const receipt = prompts.submit({ text: 'hello', confirmationTimeoutMs: 250 });
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    await expect(receipt).resolves.toEqual({ status: 'uncertain', reason: expect.stringContaining('250ms') });
  });

  it('rejects with the error when the request fails before Grok listed the prompt', async () => {
    let prompts!: GrokPromptService;
    const acp = fakeAcp((acpTurnId) => prompts.bindAcpTurn(acpTurnId));
    prompts = service(acp.binding);
    const refused = prompts.submit({ text: 'hello' });
    await flush();
    prompts.requestFailed('acp-turn-1', 'rate limited');
    await expect(refused).resolves.toEqual({ status: 'rejected', reason: 'rate limited' });

    // Once Grok runs it, a failure of the request is the turn's, never the receipt's.
    const accepted = prompts.submit({ text: 'again' });
    await flush();
    prompts.observeQueue(running('q2', 'again'));
    prompts.requestFailed('acp-turn-2', 'transport closed');
    await expect(accepted).resolves.toEqual({ status: 'confirmed', turnId: 'q2' });
  });

  it('refuses while the control rail is down and once disposed, without asking adapter-acp', async () => {
    const acp = fakeAcp();
    const down = service(acp.binding);
    down.transportClosed();
    await expect(down.submit({ text: 'hello' })).resolves.toEqual({
      status: 'rejected',
      reason: 'grok control rail unavailable',
    });
    const disposed = service(acp.binding);
    disposed.dispose();
    await expect(disposed.submit({ text: 'hello' })).resolves.toEqual({
      status: 'rejected',
      reason: 'grok control rail unavailable',
    });

    // The rail can close while the attach is awaited.
    let attach!: (binding: AgentAdapterBinding) => void;
    const attaching = new GrokPromptService({
      control: () =>
        new Promise((resolve) => {
          attach = resolve;
        }),
      turnIds: 'native-prompt',
    });
    const receipt = attaching.submit({ text: 'hello' });
    attaching.transportClosed();
    attach(acp.binding);
    await expect(receipt).resolves.toEqual({ status: 'rejected', reason: 'grok control rail unavailable' });
    expect(acp.submitted).toEqual([]);
  });

  it('refuses when control never attached', async () => {
    await expect(service(undefined).submit({ text: 'hello' })).resolves.toEqual({
      status: 'rejected',
      reason: 'grok control client not attached',
    });
  });

  it('settles every waiting prompt uncertain when the rail closes or the session is disposed', async () => {
    for (const end of ['transportClosed', 'dispose'] as const) {
      const prompts = service(fakeAcp().binding);
      const receipt = prompts.submit({ text: 'hello' });
      await flush();
      prompts[end]();
      await expect(receipt, end).resolves.toMatchObject({ status: 'uncertain' });
    }
  });
});
