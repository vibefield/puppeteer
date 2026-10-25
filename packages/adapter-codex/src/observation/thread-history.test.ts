import { describe, expect, it } from 'vitest';
import { AppServerError, AppServerRequestTimeoutError, type AppServerClient } from '../transport/app-server-client.js';
import { CodexThreadHistory, refusesPaginatedHistory, turnsOf } from './thread-history.js';

/** A client whose answer to each method is scripted: a value, or an error to reject with. */
function scriptedClient(answers: Record<string, ReadonlyArray<unknown>>) {
  const calls: string[] = [];
  const next = new Map(Object.entries(answers).map(([method, list]) => [method, [...list]]));
  const client = {
    request: async (method: string) => {
      calls.push(method);
      const answer = next.get(method)?.shift();
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`unscripted ${method}`);
      return answer;
    },
  } as unknown as AppServerClient;
  return { client, calls };
}

const turn = (id: string) => ({ id, status: 'completed', items: [] });

describe('refusesPaginatedHistory', () => {
  it('recognizes the experimental gate exactly as 0.150.0 answers it', () => {
    // The 0.150.0 pagination probe's answers (critic: the gate is gone at rust-v0.151.0).
    for (const message of [
      'thread/resume.excludeTurns requires experimentalApi capability',
      'thread/turns/list requires experimentalApi capability',
    ]) {
      expect(refusesPaginatedHistory(new AppServerError({ code: -32600, message })), message).toBe(true);
    }
  });

  it('recognizes a server that does not know the method', () => {
    const unknown = 'Invalid request: unknown variant `thread/turns/list`, expected one of `initialize`, …';
    expect(refusesPaginatedHistory(new AppServerError({ code: -32600, message: unknown }))).toBe(true);
    expect(refusesPaginatedHistory(new AppServerError({ code: -32601, message: 'imposter does not serve x' }))).toBe(
      true,
    );
  });

  it('leaves every other failure to the caller', () => {
    for (const error of [
      new AppServerError({ code: -1, message: 'no rollout found for thread id' }),
      new AppServerError({ code: -32600, message: 'invalid thread id: invalid character' }),
      new AppServerError({ code: -32603, message: 'requires experimentalApi capability' }),
      new AppServerRequestTimeoutError('thread/turns/list', 30_000),
      new Error('app-server transport closed'),
      'requires experimentalApi capability',
    ]) {
      expect(refusesPaginatedHistory(error), String(error)).toBe(false);
    }
  });
});

describe('turnsOf', () => {
  it("reads a resume's initial page first, then thread.turns, and nothing from an excluded resume", () => {
    expect(turnsOf({ initialTurnsPage: { data: [{ id: 'paged' }] }, thread: { turns: [{ id: 'full' }] } })).toEqual([
      { id: 'paged' },
    ]);
    expect(turnsOf({ initialTurnsPage: { data: [] }, thread: { turns: [{ id: 'full' }] } })).toEqual([{ id: 'full' }]);
    expect(turnsOf({ thread: { id: 'th', turns: [] } })).toEqual([]);
    expect(turnsOf(undefined)).toEqual([]);
  });
});

describe('CodexThreadHistory.read when the history cannot be paged to the end', () => {
  const firstPage = { data: [turn('t1')], nextCursor: '1' };
  const internal = new AppServerError({ code: -32603, message: 'internal error' });

  async function read(answers: Record<string, ReadonlyArray<unknown>>) {
    const scripted = scriptedClient({ 'thread/resume': [{ thread: { id: 'th', turns: [] } }], ...answers });
    const history = new CodexThreadHistory(scripted.client);
    const resumed = await history.resume('th');
    return { result: await history.read('th', resumed), calls: scripted.calls };
  }

  it('reads the whole thread once when the server answers a page with an error', async () => {
    const { result, calls } = await read({
      'thread/turns/list': [firstPage, internal],
      'thread/read': [{ thread: { id: 'th', path: '/r.jsonl', turns: [turn('t1'), turn('t2')] } }],
    });
    expect(result).toEqual({ turns: [turn('t1'), turn('t2')], path: '/r.jsonl' });
    expect(calls).toEqual(['thread/resume', 'thread/turns/list', 'thread/turns/list', 'thread/read']);
  });

  it('keeps the pages it has and says why the rest is missing when the full read fails too', async () => {
    const { result } = await read({ 'thread/turns/list': [firstPage, internal], 'thread/read': [internal] });
    expect(result).toEqual({ turns: [turn('t1')], incomplete: { reason: 'server error -32603' } });
  });

  it('does not take a full read without turns for the whole history', async () => {
    const { result } = await read({ 'thread/turns/list': [firstPage, internal], 'thread/read': [{ thread: {} }] });
    expect(result).toEqual({ turns: [turn('t1')], incomplete: { reason: 'server error -32603' } });
  });

  it.each([
    ['request timed out', new AppServerRequestTimeoutError('thread/turns/list', 30_000)],
    ['connection lost', new Error('app-server transport closed')],
  ])('asks nothing more of a server that never answered a page (%s)', async (reason, error) => {
    const { result, calls } = await read({ 'thread/turns/list': [firstPage, error] });
    expect(result).toEqual({ turns: [turn('t1')], incomplete: { reason } });
    expect(calls).not.toContain('thread/read');
  });

  it('reports nothing replayable when an excluded resume is followed by a failed full read', async () => {
    const methodNotFound = new AppServerError({ code: -32601, message: 'method not found' });
    const { result } = await read({ 'thread/turns/list': [methodNotFound], 'thread/read': [internal] });
    expect(result).toEqual({ turns: [], incomplete: { reason: 'server error -32603' } });
  });

  it('keeps a hydrated resume as the whole history when the full read fails', async () => {
    const gate = new AppServerError({
      code: -32600,
      message: 'thread/resume.excludeTurns requires experimentalApi capability',
    });
    const scripted = scriptedClient({
      'thread/resume': [gate, { thread: { id: 'th', turns: [turn('t1'), turn('t2')] } }],
      'thread/read': [internal],
    });
    const history = new CodexThreadHistory(scripted.client);
    const resumed = await history.resume('th');
    expect(await history.read('th', resumed)).toEqual({ turns: [turn('t1'), turn('t2')] });
  });
});
