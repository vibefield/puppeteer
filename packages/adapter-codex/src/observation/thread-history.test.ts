import { describe, expect, it } from 'vitest';
import { AppServerError, AppServerRequestTimeoutError, type AppServerClient } from '../transport/app-server-client.js';
import { CodexThreadHistory, refusesPaginatedHistory, turnsOf, type CodexHistoryLimits } from './thread-history.js';

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

describe('CodexThreadHistory.read within its limits', () => {
  const page = (cursor: string | null, ...ids: string[]) => ({ data: ids.map(turn), nextCursor: cursor });

  async function read(limits: CodexHistoryLimits, pages: ReadonlyArray<unknown>) {
    const scripted = scriptedClient({
      'thread/resume': [{ thread: { id: 'th', turns: [] } }],
      'thread/turns/list': pages,
      'thread/read': [{ thread: { id: 'th', turns: [turn('t1'), turn('t2'), turn('t3'), turn('t4')] } }],
    });
    const history = new CodexThreadHistory(scripted.client, limits);
    const resumed = await history.resume('th');
    return { result: await history.read('th', resumed), calls: scripted.calls };
  }

  it('stops after its page limit, keeps what it read and says the rest is missing', async () => {
    const { result, calls } = await read({ pages: 2, turns: 100 }, [
      page('1', 't1'),
      page('2', 't2'),
      page(null, 't3'),
    ]);
    expect(result).toEqual({ turns: [turn('t1'), turn('t2')], incomplete: { reason: 'stopped after 2 pages' } });
    // The full read would load the history the limit refuses.
    expect(calls).toEqual(['thread/resume', 'thread/turns/list', 'thread/turns/list']);
  });

  it('takes a history that ends on its last allowed page as complete', async () => {
    const { result } = await read({ pages: 2, turns: 100 }, [page('1', 't1'), page(null, 't2')]);
    expect(result).toEqual({ turns: [turn('t1'), turn('t2')] });
  });

  it('keeps no more turns than its turn limit and says the rest is missing', async () => {
    const { result, calls } = await read({ pages: 100, turns: 3 }, [page('1', 't1', 't2'), page(null, 't3', 't4')]);
    expect(result).toEqual({
      turns: [turn('t1'), turn('t2'), turn('t3')],
      incomplete: { reason: 'stopped at 3 turns' },
    });
    expect(calls).toEqual(['thread/resume', 'thread/turns/list', 'thread/turns/list']);
  });

  it('asks for no page past its turn limit', async () => {
    const { result, calls } = await read({ pages: 100, turns: 2 }, [page('1', 't1', 't2'), page(null, 't3')]);
    expect(result).toEqual({ turns: [turn('t1'), turn('t2')], incomplete: { reason: 'stopped at 2 turns' } });
    expect(calls).toEqual(['thread/resume', 'thread/turns/list']);
  });

  it('takes a history exactly as long as its turn limit as complete', async () => {
    const { result } = await read({ pages: 100, turns: 2 }, [page(null, 't1', 't2')]);
    expect(result).toEqual({ turns: [turn('t1'), turn('t2')] });
  });

  const internal = (): AppServerError => new AppServerError({ code: -32603, message: 'internal error' });

  it('keeps no more turns than its turn limit from the full read after a failed page', async () => {
    const { result, calls } = await read({ pages: 100, turns: 2 }, [page('1', 't1'), internal()]);
    expect(result).toEqual({ turns: [turn('t1'), turn('t2')], incomplete: { reason: 'stopped at 2 turns' } });
    expect(calls).toEqual(['thread/resume', 'thread/turns/list', 'thread/turns/list', 'thread/read']);
  });

  it('takes a full read after a failed page as complete within its turn limit', async () => {
    const { result } = await read({ pages: 100, turns: 4 }, [page('1', 't1'), internal()]);
    expect(result).toEqual({ turns: [turn('t1'), turn('t2'), turn('t3'), turn('t4')] });
  });

  it('keeps no more turns than its turn limit from a server without paginated history', async () => {
    const gate = new AppServerError({
      code: -32600,
      message: 'thread/resume.excludeTurns requires experimentalApi capability',
    });
    const all = [turn('t1'), turn('t2'), turn('t3'), turn('t4')];
    // Its full read, and when that fails, its hydrated resume.
    for (const answer of [{ thread: { id: 'th', path: '/r.jsonl', turns: all } }, internal()]) {
      const scripted = scriptedClient({
        'thread/resume': [gate, { thread: { id: 'th', turns: all } }],
        'thread/read': [answer],
      });
      const history = new CodexThreadHistory(scripted.client, { pages: 100, turns: 3 });
      const result = await history.read('th', await history.resume('th'));
      expect(result.turns).toEqual(all.slice(0, 3));
      expect(result.incomplete).toEqual({ reason: 'stopped at 3 turns' });
    }
  });
});
