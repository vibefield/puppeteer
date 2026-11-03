import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexTuiPromptService } from './tui-prompt.js';

function setup() {
  let echo!: (message: { id: string; text: string; turnId?: string }) => void;
  let unavailable!: () => void;
  const automateTerminal = vi.fn(async () => ({ accepted: true as const }));
  const service = new CodexTuiPromptService({
    runtimeSessionId: 'pane',
    host: { automateTerminal },
    observer: {
      observationLevel: () => 'structured',
      onUserMessage: (listener) => {
        echo = listener;
        return () => undefined;
      },
      onUnavailable: (listener) => {
        unavailable = listener;
        return () => undefined;
      },
    },
  });
  return {
    service,
    automateTerminal,
    echo: (id: string, text: string) => echo({ id, text, turnId: 'turn' }),
    unavailable: () => unavailable(),
  };
}

afterEach(() => vi.useRealTimers());

describe('Codex native TUI prompt receipts', () => {
  it('confirms only a matching future native user message', async () => {
    vi.useFakeTimers();
    const t = setup();
    const result = t.service.submit({ text: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    t.echo('unrelated', 'different text');
    await Promise.resolve();
    expect(settled).toBe(false);
    t.echo('matched', 'hello');
    await expect(result).resolves.toEqual({ status: 'confirmed', turnId: 'turn' });
    expect(t.automateTerminal).toHaveBeenCalledWith('pane', { kind: 'paste', text: 'hello', submit: true });
    t.service.dispose();
  });

  it('captures an echo arriving before the host finishes accepting the input', async () => {
    const t = setup();
    t.automateTerminal.mockImplementation(async () => {
      t.echo('early', 'hello');
      return { accepted: true };
    });
    await expect(t.service.submit({ text: 'hello' })).resolves.toMatchObject({ status: 'confirmed' });
    t.service.dispose();
  });

  it.each(['hello', '/model'])('returns uncertain for accepted input without an echo: %s', async (text) => {
    vi.useFakeTimers();
    const t = setup();
    const result = t.service.submit({ text, confirmationTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(26);
    await expect(result).resolves.toMatchObject({ status: 'uncertain' });
    t.service.dispose();
  });

  it('stages paste-only input without claiming agent acceptance', async () => {
    const t = setup();
    await expect(t.service.submit({ text: 'draft', mode: 'paste-only' })).resolves.toMatchObject({
      status: 'uncertain',
    });
    expect(t.automateTerminal).toHaveBeenCalledWith('pane', { kind: 'paste', text: 'draft', submit: false });
    t.service.dispose();
  });

  it('serializes repeated text and ignores a duplicate old echo', async () => {
    vi.useFakeTimers();
    const t = setup();
    const first = t.service.submit({ text: 'same' });
    const second = t.service.submit({ text: 'same', confirmationTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.automateTerminal).toHaveBeenCalledTimes(1);
    t.echo('first', 'same');
    await expect(first).resolves.toMatchObject({ status: 'confirmed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.automateTerminal).toHaveBeenCalledTimes(2);
    t.echo('first', 'same');
    await vi.advanceTimersByTimeAsync(26);
    await expect(second).resolves.toMatchObject({ status: 'uncertain' });
    t.service.dispose();
  });

  it('settles pending input on disconnect and rejects queued input after disposal', async () => {
    vi.useFakeTimers();
    const t = setup();
    const first = t.service.submit({ text: 'pending' });
    const second = t.service.submit({ text: 'queued' });
    await vi.advanceTimersByTimeAsync(0);
    t.unavailable();
    t.service.dispose();
    await expect(first).resolves.toMatchObject({ status: 'uncertain' });
    await expect(second).resolves.toMatchObject({ status: 'rejected' });
    expect(t.automateTerminal).toHaveBeenCalledTimes(1);
  });
});
