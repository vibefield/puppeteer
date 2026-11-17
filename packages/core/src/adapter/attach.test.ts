import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../events/index.js';
import {
  AGENT_ATTACH_REFUSAL_CODES,
  AgentAttachRefusedError,
  isAgentAttachRefusedError,
  partitionAttachBootstrap,
} from './attach.js';

describe('AgentAttachRefusedError', () => {
  it('is read by its brand and its next step, never by instanceof', () => {
    const refused = new AgentAttachRefusedError('retry', 'the port is still held');
    expect(isAgentAttachRefusedError(refused)).toBe(true);
    expect(refused).toMatchObject({ name: 'AgentAttachRefusedError', next: 'retry' });
    // another copy of this package throws another class carrying the same registered brand
    const foreign = Object.assign(Object.create(AgentAttachRefusedError.prototype) as object, {
      next: 'resume',
      message: 'the helper is gone',
    });
    expect(isAgentAttachRefusedError(foreign)).toBe(true);
    expect(isAgentAttachRefusedError(new Error('plain'))).toBe(false);
    expect(isAgentAttachRefusedError({ next: 'retry', message: 'no brand' })).toBe(false);
    // a next step this copy does not know is no refusal: the host maps only words it knows
    expect(isAgentAttachRefusedError(new AgentAttachRefusedError('later' as never, 'unknown word'))).toBe(false);
  });

  it('carries a neutral word for why, when the adapter knows it, and the brand rules stand without it', () => {
    expect(AGENT_ATTACH_REFUSAL_CODES).toEqual(['endpoint-held']);
    const held = new AgentAttachRefusedError('retry', 'the hook port is held by another listener', 'endpoint-held');
    expect(isAgentAttachRefusedError(held)).toBe(true);
    expect(held).toMatchObject({ name: 'AgentAttachRefusedError', next: 'retry', code: 'endpoint-held' });
    expect(new AgentAttachRefusedError('retry', 'the helper is still starting').code).toBeUndefined();
    // a word a newer copy names and this one does not know leaves the refusal and its next step standing
    const newer = Object.assign(Object.create(AgentAttachRefusedError.prototype) as object, {
      next: 'retry',
      message: 'held',
      code: 'a-later-word',
    });
    expect(isAgentAttachRefusedError(newer)).toBe(true);
  });
});

describe('partitionAttachBootstrap', () => {
  const asked = (requestId: string): AgentEvent => ({
    type: 'interaction:permission-requested',
    requestId,
    presentation: 'native-tui',
  });

  it('announces each request still open at the end once, as its latest word, and replays everything else in order', () => {
    const events: AgentEvent[] = [
      { type: 'turn:started', turnId: 'turn-1' },
      { type: 'tool:requested', toolCallId: 'tool-1', tool: 'Bash' },
      asked('perm-1'),
      { type: 'interaction:permission-resolved', requestId: 'perm-1', outcome: 'allowed' },
      asked('perm-2'),
      {
        type: 'interaction:question-requested',
        requestId: 'question-1',
        questions: [{ prompt: 'Which branch?' }],
      },
      // the same request raised twice: neither raising stays in the replay, or the announcement would be a repeat
      asked('perm-2'),
    ];
    const { replay, announce } = partitionAttachBootstrap(events);
    expect(replay).toEqual(events.slice(0, 4));
    expect(announce).toEqual([events[5], events[6]]);
  });

  it('replays a request raised, resolved and raised again up to its resolution, and announces the last raising', () => {
    const events: AgentEvent[] = [
      asked('perm-1'),
      { type: 'interaction:permission-resolved', requestId: 'perm-1', outcome: 'denied' },
      asked('perm-1'),
    ];
    const { replay, announce } = partitionAttachBootstrap(events);
    expect(replay).toEqual(events.slice(0, 2));
    expect(announce).toEqual([events[2]]);
  });

  it('announces nothing for a bootstrap with no open request', () => {
    const events: AgentEvent[] = [{ type: 'turn:started', turnId: 'turn-1' }];
    expect(partitionAttachBootstrap(events)).toEqual({ replay: events, announce: [] });
  });
});
