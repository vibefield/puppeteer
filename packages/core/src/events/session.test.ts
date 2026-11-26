import { describe, expect, it } from 'vitest';
import { parseAgentEvent, safeParseAgentEvent } from './catalog.js';
import { SessionEventSchema, SessionForkedEventSchema } from './session.js';

describe('session:forked', () => {
  it("names the fork's own native id, and the provider's word for how it began", () => {
    const forked = { type: 'session:forked', nativeSessionId: '8c0e5d2a-fork', startSource: 'fork' };
    expect(SessionForkedEventSchema.parse(forked)).toEqual(forked);
    expect(parseAgentEvent('session:forked', forked)).toEqual(forked);
    expect(SessionEventSchema.parse(forked)).toEqual(forked);
  });

  it('parses with and without a start source', () => {
    expect(SessionForkedEventSchema.parse({ type: 'session:forked', nativeSessionId: 'fork-1' })).toEqual({
      type: 'session:forked',
      nativeSessionId: 'fork-1',
    });
    expect(
      SessionForkedEventSchema.parse({ type: 'session:forked', nativeSessionId: ' fork-1 ', startSource: ' fork ' }),
    ).toEqual({ type: 'session:forked', nativeSessionId: 'fork-1', startSource: 'fork' });
    // A start source, when given, is a word: blank is not one.
    expect(
      SessionForkedEventSchema.safeParse({ type: 'session:forked', nativeSessionId: 'fork-1', startSource: '  ' })
        .success,
    ).toBe(false);
  });

  it('refuses a fork that names no id of its own', () => {
    for (const nativeSessionId of ['', '   ', undefined, 42, null]) {
      expect(safeParseAgentEvent('session:forked', { type: 'session:forked', nativeSessionId }).success).toBe(false);
    }
    expect(safeParseAgentEvent('session:forked', { type: 'session:forked' }).success).toBe(false);
  });

  it('is strict: an unknown key is refused, as on every canonical route', () => {
    expect(
      safeParseAgentEvent('session:forked', {
        type: 'session:forked',
        nativeSessionId: 'fork-1',
        parentSessionId: 'observed-1',
      }).success,
    ).toBe(false);
    expect(safeParseAgentEvent('session:forked', { type: 'session:started', nativeSessionId: 'fork-1' }).success).toBe(
      false,
    );
  });
});
