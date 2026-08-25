import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodePromptConfirmationGate } from './driver.js';

afterEach(() => vi.useRealTimers());

describe('OpenCode exact prompt confirmation', () => {
  it('confirms only the exact caller-generated message ID', async () => {
    const gate = new OpenCodePromptConfirmationGate();
    const pending = gate.expect('msg_exact', 1_000);
    expect(gate.confirm('msg_unrelated')).toBe(false);
    expect(gate.confirm('msg_exact')).toBe(true);
    await expect(pending.promise).resolves.toEqual({ matched: true, turnId: 'msg_exact' });
  });

  it('returns an uncertain result when the exact echo times out', async () => {
    vi.useFakeTimers();
    const gate = new OpenCodePromptConfirmationGate();
    const pending = gate.expect('msg_missing', 250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending.promise).resolves.toMatchObject({
      matched: false,
      reason: expect.stringContaining('msg_missing'),
    });
  });
});
