import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_ORIGIN,
  createHistorySearchService,
  defaultAnnounceDirectory,
  discoverAnnouncedDaemons,
  isHistoryIdentifier,
  normalizeHistoryQuery,
  parseHistoryAnnouncement,
  parseHistorySearchRequest,
  resolveHistoryOrigin,
  validateHistoryOrigin,
  type AnnounceDirectoryReader,
  type HistoryAnnouncement,
} from './history-search.js';

type Answer = { status?: number; body: unknown } | undefined;
type Route = (url: URL) => Answer | Promise<Answer>;

/** A daemon of one protocol generation, answering from a routing table and recording what it was asked. */
function daemon(version: number, route: Route) {
  const asked: string[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    asked.push(`${url.pathname}${url.search}`);
    const answer = await route(url);
    const headers = { 'x-rosetta-protocol-version': String(version), 'content-type': 'application/json' };
    if (!answer)
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }), { status: 404, headers }),
      );
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers }));
  };
  return { asked, fetch: fetch as typeof globalThis.fetch };
}

const ORIGIN = { origin: 'http://127.0.0.1:4640', source: 'default' as const };

function row(id: string, native: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    native_session_id: native,
    runtime_id: 'rt',
    project_id: null,
    cwd: '/w/project',
    parent_session_id: null,
    delegation: null,
    root_session_id: id,
    role: 'main',
    title: `Title of ${native}`,
    summary: null,
    started_at: 1,
    updated_at: 2,
    stream_state: 'indexed',
    ...extra,
  };
}

const READY = { readiness: 'ready', progress: null, projection_epoch: 'e1', revision: 9 };
const CURRENT_WIRE = JSON.parse(readFileSync(new URL('./fixtures/rosetta-protocol-20.json', import.meta.url), 'utf8'));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('validateHistoryOrigin', () => {
  it('accepts only a bare loopback http origin', () => {
    expect(validateHistoryOrigin('http://127.0.0.1:4640')).toBe('http://127.0.0.1:4640');
    expect(validateHistoryOrigin('http://localhost:4640/')).toBe('http://localhost:4640');
    expect(validateHistoryOrigin('http://[::1]:5000')).toBe('http://[::1]:5000');
    for (const bad of [
      'https://127.0.0.1:4640',
      'http://example.com:4640',
      'http://127.0.0.1:4640/api',
      'http://user:pw@127.0.0.1:4640',
      'http://127.0.0.1:4640?x=1',
      'http://127.0.0.1:4640#f',
      ' http://127.0.0.1:4640',
      'not a url',
      42,
      undefined,
    ]) {
      expect(validateHistoryOrigin(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('announcements', () => {
  const alive: HistoryAnnouncement = {
    origin: 'http://127.0.0.1:53412',
    pid: 100,
    protocolVersion: 18,
    db: '/tmp/projection.sqlite',
    startedAt: 2_000,
  };

  function reader(files: Record<string, string>, livePids: number[]): AnnounceDirectoryReader {
    return {
      list: () => Object.keys(files),
      read: (path) => files[path.split('/').pop() ?? ''] ?? '',
      isAlive: (pid) => livePids.includes(pid),
    };
  }

  function text(announcement: HistoryAnnouncement, schema = 'rosetta-daemon/1'): string {
    return JSON.stringify({
      schema,
      origin: announcement.origin,
      pid: announcement.pid,
      protocol_version: announcement.protocolVersion,
      db: announcement.db,
      started_at: announcement.startedAt,
    });
  }

  it('parses the daemon file and refuses other schemas or foreign origins', () => {
    expect(parseHistoryAnnouncement(text(alive))).toEqual(alive);
    expect(parseHistoryAnnouncement(text(alive, 'rosetta-daemon/2'))).toBeUndefined();
    expect(parseHistoryAnnouncement(text({ ...alive, origin: 'http://10.0.0.5:80' }))).toBeUndefined();
    expect(parseHistoryAnnouncement('{')).toBeUndefined();
  });

  it('lists only live daemons, newest first', () => {
    const older = { ...alive, pid: 90, startedAt: 1_000, origin: 'http://127.0.0.1:50000' };
    const dead = { ...alive, pid: 80, startedAt: 3_000 };
    const found = discoverAnnouncedDaemons(
      '/d',
      reader(
        { '100.json': text(alive), '90.json': text(older), '80.json': text(dead), 'junk.json': 'nope' },
        [100, 90],
      ),
    );
    expect(found.map((entry) => entry.pid)).toEqual([100, 90]);
    expect(discoverAnnouncedDaemons(undefined, reader({}, []))).toEqual([]);
  });

  it('derives the same directory as the daemon', () => {
    expect(defaultAnnounceDirectory('darwin', { HOME: '/Users/me' })).toBe(
      '/Users/me/Library/Application Support/rosetta/daemons',
    );
    expect(defaultAnnounceDirectory('linux', { HOME: '/home/me' })).toBe('/home/me/.local/state/rosetta/daemons');
    expect(defaultAnnounceDirectory('linux', { HOME: '/home/me', XDG_STATE_HOME: '/state' })).toBe(
      '/state/rosetta/daemons',
    );
    expect(defaultAnnounceDirectory('linux', { HOME: '/home/me', ROSETTA_ANNOUNCE_DIR: '/x' })).toBe('/x');
    expect(defaultAnnounceDirectory('linux', {})).toBeUndefined();
  });

  it('prefers a setting, then the environment, then an announcement, then the default', () => {
    expect(
      resolveHistoryOrigin({ configured: 'http://127.0.0.1:1', environment: 'http://127.0.0.1:2', announced: [alive] }),
    ).toEqual({ origin: 'http://127.0.0.1:1', source: 'setting' });
    expect(resolveHistoryOrigin({ configured: 'bad', environment: 'http://127.0.0.1:2', announced: [alive] })).toEqual({
      origin: 'http://127.0.0.1:2',
      source: 'environment',
    });
    expect(resolveHistoryOrigin({ announced: [alive] })).toEqual({
      origin: alive.origin,
      source: 'announcement',
      generation: JSON.stringify([alive.pid, alive.startedAt, alive.db]),
    });
    expect(resolveHistoryOrigin({ announced: [{ ...alive, protocolVersion: 99 }] })).toEqual({
      origin: DEFAULT_HISTORY_ORIGIN,
      source: 'default',
    });
  });

  it('discovers protocol 20 and retains its process identity for explicit origins too', () => {
    const latest = { ...alive, protocolVersion: 20 };
    const discovered = resolveHistoryOrigin({ announced: [latest] });
    expect(discovered).toMatchObject({ origin: latest.origin, source: 'announcement' });
    expect(resolveHistoryOrigin({ configured: latest.origin, announced: [latest] })).toMatchObject({
      source: 'setting',
      generation: discovered.generation,
    });
    expect(resolveHistoryOrigin({ announced: [{ ...latest, startedAt: latest.startedAt + 1 }] }).generation).not.toBe(
      discovered.generation,
    );
  });
});

describe('request validation', () => {
  it('keeps identities opaque and queries plain', () => {
    expect(isHistoryIdentifier('2842b6dd-eacb-4547-833e-0031c2c4d1e1')).toBe(true);
    expect(isHistoryIdentifier('a/b')).toBe(false);
    expect(isHistoryIdentifier('a,b')).toBe(false);
    expect(isHistoryIdentifier(' a')).toBe(false);
    expect(normalizeHistoryQuery('  fuzzy\u0000  search\n\tfeature ')).toBe('fuzzy search feature');
    expect(normalizeHistoryQuery('x'.repeat(600))).toHaveLength(512);
    expect(
      parseHistorySearchRequest({ query: 'q', nativeSessionIds: ['a', 'a', 'b'], afterMs: 5.5, limit: 5000 }),
    ).toEqual({
      query: 'q',
      nativeSessionIds: ['a', 'b'],
      afterMs: 5,
      limit: 1000,
    });
    expect(parseHistorySearchRequest({ query: 'q', nativeSessionIds: ['../x'] })).toBeUndefined();
    expect(parseHistorySearchRequest('q')).toBeUndefined();
  });
});

describe('createHistorySearchService', () => {
  it.each([18, 19, 20])(
    'asks a protocol %i daemon one scoped, prefixed question and attributes child hits to their root',
    async (version) => {
      const d = daemon(version, (url) => {
        if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
        if (url.pathname === '/api/sessions') {
          expect(url.searchParams.get('native_session_id')).toBe('native-a,native-b');
          return { body: { sessions: [row('root-a', 'native-a'), row('root-b', 'native-b')] } };
        }
        if (url.pathname === '/api/sessions/child-a') {
          return {
            body: {
              session: row('child-a', 'native-child', {
                parent_session_id: 'root-a',
                root_session_id: 'root-a',
                role: 'subagent',
              }),
            },
          };
        }
        if (url.pathname === '/api/search') {
          expect(url.searchParams.get('sessions')?.split(',').sort()).toEqual(['root-a', 'root-b']);
          expect(url.searchParams.get('prefix')).toBe('true');
          expect(url.searchParams.get('after_ts')).toBeNull();
          return {
            body: {
              state: READY,
              hits: [
                {
                  timeline_id: 't1',
                  session_id: 'root-a',
                  kind: 'user',
                  at: 10,
                  snippet: 'the [puppet]eer',
                  score: -1,
                },
                {
                  timeline_id: 't2',
                  session_id: 'child-a',
                  kind: 'agent',
                  at: 11,
                  snippet: '[puppet] show',
                  score: -0.5,
                },
              ],
            },
          };
        }
        return undefined;
      });
      const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN, now: () => 1_000 });

      const facts = await service.facts(['native-a', 'native-b']);
      expect(facts.map((entry) => [entry.nativeSessionId, entry.title])).toEqual([
        ['native-a', 'Title of native-a'],
        ['native-b', 'Title of native-b'],
      ]);

      const response = await service.search({
        query: 'puppet',
        nativeSessionIds: ['native-a', 'native-b'],
        afterMs: 1,
      });
      expect(response.answered).toBe(true);
      expect(response.status.readiness).toBe('ready');
      expect(response.status.capabilities).toEqual({ sessionScope: true, prefix: true });
      expect(response.hits.map((hit) => [hit.timelineId, hit.rootSessionId, hit.nativeSessionId])).toEqual([
        ['t1', 'root-a', 'native-a'],
        ['t2', 'root-a', 'native-a'],
      ]);
      // Facts were cached: the second question did not list sessions again.
      expect(d.asked.filter((path) => path.startsWith('/api/sessions?'))).toHaveLength(1);
    },
  );

  it('asks a protocol 17 daemon the long way and keeps only the live roots', async () => {
    const d = daemon(17, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      if (url.pathname === '/api/sessions') {
        expect(url.searchParams.get('native_session_id')).toBeNull();
        return { body: { sessions: [row('root-a', 'native-a'), row('root-z', 'native-z')] } };
      }
      if (url.pathname === '/api/search') {
        expect(url.searchParams.get('sessions')).toBeNull();
        expect(url.searchParams.get('prefix')).toBeNull();
        expect(url.searchParams.get('after_ts')).toBe('123');
        expect(url.searchParams.get('limit')).toBe('1000');
        return {
          body: {
            state: READY,
            hits: [
              { timeline_id: 't1', session_id: 'root-a', kind: 'user', at: 10, snippet: 'a', score: -1 },
              { timeline_id: 't9', session_id: 'root-z', kind: 'user', at: 10, snippet: 'z', score: -1 },
            ],
          },
        };
      }
      return undefined;
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    const response = await service.search({ query: 'a', nativeSessionIds: ['native-a'], afterMs: 123 });
    expect(response.answered).toBe(true);
    expect(response.status.capabilities).toEqual({ sessionScope: false, prefix: false });
    expect(response.hits.map((hit) => hit.timelineId)).toEqual(['t1']);
  });

  it('reports a building or failed index as unanswered, never as no matches', async () => {
    const building = {
      readiness: 'building',
      progress: { stage: 'indexing', documents_done: 4, documents_total: 10 },
      projection_epoch: 'e1',
      revision: null,
    };
    const d = daemon(18, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: building } };
      if (url.pathname === '/api/sessions') return { body: { sessions: [row('root-a', 'native-a')] } };
      if (url.pathname === '/api/search') return { body: { state: building, hits: [] } };
      return undefined;
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    const response = await service.search({ query: 'a', nativeSessionIds: ['native-a'] });
    expect(response.answered).toBe(false);
    expect(response.status.readiness).toBe('building');
    expect(response.status.progress).toEqual({ done: 4, total: 10 });
  });

  it('serves hits the daemon labels catching-up', async () => {
    const behind = { ...READY, readiness: 'catching-up' };
    const d = daemon(18, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      if (url.pathname === '/api/sessions') return { body: { sessions: [row('root-a', 'native-a')] } };
      if (url.pathname === '/api/search') {
        return {
          body: {
            state: behind,
            hits: [{ timeline_id: 't1', session_id: 'root-a', kind: 'agent', at: null, snippet: 's', score: 0 }],
          },
        };
      }
      return undefined;
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    const response = await service.search({ query: 'a', nativeSessionIds: ['native-a'] });
    expect(response.answered).toBe(true);
    expect(response.status.readiness).toBe('catching-up');
    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]?.at).toBeUndefined();
  });

  it('says when no live session is indexed yet, and when nothing is listening', async () => {
    const empty = daemon(18, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      if (url.pathname === '/api/sessions') return { body: { sessions: [] } };
      return undefined;
    });
    const service = createHistorySearchService({ fetch: empty.fetch, origin: () => ORIGIN });
    const response = await service.search({ query: 'a', nativeSessionIds: ['native-a'] });
    expect(response.answered).toBe(true);
    expect(response.hits).toEqual([]);
    expect(response.status.detail).toMatch(/in the history index yet/);
    expect(empty.asked.some((path) => path.startsWith('/api/search'))).toBe(false);

    const refused = createHistorySearchService({
      fetch: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
      origin: () => ORIGIN,
    });
    const status = await refused.status();
    expect(status.reachable).toBe(false);
    expect(status.detail).toBe('no history daemon is listening');
    const unanswered = await refused.search({ query: 'a', nativeSessionIds: [] });
    expect(unanswered.answered).toBe(false);

    const off = createHistorySearchService({ fetch: empty.fetch, origin: () => undefined });
    expect((await off.status()).detail).toBe('no history daemon is configured');
  });

  it('refuses a daemon generation it does not understand', async () => {
    const future = daemon(21, () => ({ body: { canonical_ready: true, search: READY } }));
    const service = createHistorySearchService({ fetch: future.fetch, origin: () => ORIGIN });
    const status = await service.status();
    expect(status.reachable).toBe(false);
    expect(status.detail).toMatch(/protocol 21/);
  });

  it('reads protocol 20 status, sessions and search from Rosetta’s pinned wire golden', async () => {
    const root = row('s0', 'native-s0');
    const d = daemon(CURRENT_WIRE.protocol_version, (url) => {
      if (url.pathname === '/api/status') return { body: CURRENT_WIRE.status };
      if (url.pathname === '/api/sessions') return { body: CURRENT_WIRE.sessions };
      if (url.pathname === '/api/sessions/s1') return { body: CURRENT_WIRE.session };
      if (url.pathname === '/api/sessions/s0') return { body: { session: root } };
      if (url.pathname === '/api/search') return { body: CURRENT_WIRE.search_response };
      return undefined;
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    expect(await service.status()).toMatchObject({
      reachable: true,
      protocolVersion: 20,
      readiness: 'catching-up',
      canonicalReady: true,
    });
    expect(await service.facts(['native-s1'])).toMatchObject([
      { nativeSessionId: 'native-s1', sessionId: 's1', rootSessionId: 's0', title: 'Named', updatedAt: 20_000 },
    ]);
    const result = await service.search({ query: 'needle', nativeSessionIds: [] });
    expect(result).toMatchObject({
      answered: true,
      status: { readiness: 'catching-up' },
      hits: [
        { rootSessionId: 's0', nativeSessionId: 'native-s0', timelineId: 't1', snippet: '[needle] in a haystack' },
      ],
    });
  });

  it.each([17, 20])(
    'preserves facts and reports a failed protocol %i lookup as unanswered, then retries immediately',
    async (version) => {
      let now = 0;
      let unavailable = false;
      const d = daemon(version, (url) => {
        if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
        if (url.pathname === '/api/sessions')
          return unavailable
            ? { status: 503, body: { error: { message: 'session lookup unavailable' } } }
            : { body: { sessions: [row('root-a', 'native-a')] } };
        if (url.pathname === '/api/search')
          return { body: { state: READY, hits: [{ timeline_id: 't1', session_id: 'root-a', snippet: 'hello' }] } };
        return undefined;
      });
      const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN, now: () => now });
      const original = await service.facts(['native-a']);
      now = 16_000;
      unavailable = true;
      const failed = await service.search({ query: 'hello', nativeSessionIds: ['native-a'] });
      expect(failed).toMatchObject({
        answered: false,
        status: { reachable: true, detail: 'session lookup unavailable' },
      });
      expect(await service.facts(['native-a'])).toEqual(original);
      expect(d.asked.some((path) => path.startsWith('/api/search'))).toBe(false);
      unavailable = false;
      expect(await service.search({ query: 'hello', nativeSessionIds: ['native-a'] })).toMatchObject({
        answered: true,
        hits: [{ timelineId: 't1' }],
      });
    },
  );

  it('does not answer a partial scope or cache misses when one lookup chunk fails', async () => {
    const ids = Array.from({ length: 65 }, (_, i) => `native-${i}`);
    let unavailable = true;
    const d = daemon(20, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      if (url.pathname === '/api/sessions') {
        const last = url.searchParams.get('native_session_id') === 'native-64';
        if (last && unavailable) return { status: 503, body: {} };
        return { body: { sessions: [row(last ? 'r64' : 'r0', last ? 'native-64' : 'native-0')] } };
      }
      if (url.pathname === '/api/search') {
        expect(url.searchParams.get('sessions')?.split(',').sort()).toEqual(['r0', 'r64']);
        return { body: { state: READY, hits: [] } };
      }
      return undefined;
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    expect((await service.search({ query: 'hello', nativeSessionIds: ids })).answered).toBe(false);
    expect(d.asked.some((path) => path.startsWith('/api/search'))).toBe(false);
    unavailable = false;
    expect((await service.search({ query: 'hello', nativeSessionIds: ids })).answered).toBe(true);
  });

  it.each([{}, { sessions: [{}] }])(
    'does not treat a malformed session response as an empty index: %j',
    async (body) => {
      const d = daemon(20, (url) =>
        url.pathname === '/api/status' ? { body: { canonical_ready: true, search: READY } } : { body },
      );
      const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
      expect((await service.search({ query: 'hello', nativeSessionIds: ['native-a'] })).answered).toBe(false);
    },
  );

  it('does not report an empty, still-building projection as no matches', async () => {
    const d = daemon(20, (url) =>
      url.pathname === '/api/status'
        ? { body: { canonical_ready: false, search: { ...READY, readiness: 'building' } } }
        : { body: { sessions: [] } },
    );
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    expect(await service.search({ query: 'hello', nativeSessionIds: ['native-a'] })).toMatchObject({
      answered: false,
      status: { canonicalReady: false, readiness: 'building' },
    });
  });

  it('keeps a failed child lookup from erasing valid search results', async () => {
    const d = daemon(20, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      if (url.pathname === '/api/sessions') return { body: { sessions: [row('root-a', 'native-a')] } };
      if (url.pathname === '/api/search')
        return { body: { state: READY, hits: [{ session_id: 'child-a', timeline_id: 't1', snippet: 'hello' }] } };
      return { status: 503, body: { error: { message: 'child lookup unavailable' } } };
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    expect(await service.search({ query: 'hello', nativeSessionIds: ['native-a'] })).toMatchObject({
      answered: false,
      status: { detail: 'child lookup unavailable' },
    });
  });

  it('refreshes cached hits and misses when switching origins, including switching back', async () => {
    let origin = ORIGIN.origin;
    let title = 'A';
    const d = daemon(20, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      return {
        body: {
          sessions: [row('root-a', 'native-a', { title }), ...(title === 'B' ? [row('root-b', 'native-b')] : [])],
        },
      };
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ({ ...ORIGIN, origin }) });
    expect(await service.facts(['native-a', 'native-b'])).toMatchObject([{ title: 'A' }]);
    origin = 'http://127.0.0.1:5050';
    title = 'B';
    expect(await service.facts(['native-a', 'native-b'])).toMatchObject([
      { title: 'B' },
      { nativeSessionId: 'native-b' },
    ]);
    origin = ORIGIN.origin;
    title = 'A restarted';
    expect(await service.facts(['native-a'])).toMatchObject([{ title: 'A restarted' }]);
  });

  it('invalidates cached facts while disabled and before re-enabling the same origin', async () => {
    let enabled = true;
    let title = 'before';
    const d = daemon(20, (url) =>
      url.pathname === '/api/status'
        ? { body: { canonical_ready: true, search: READY } }
        : { body: { sessions: [row('root-a', 'native-a', { title })] } },
    );
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => (enabled ? ORIGIN : undefined) });
    await service.facts(['native-a']);
    enabled = false;
    const count = d.asked.length;
    expect(await service.facts(['native-a'])).toEqual([]);
    expect(d.asked).toHaveLength(count);
    enabled = true;
    title = 'after';
    expect(await service.facts(['native-a'])).toMatchObject([{ title: 'after' }]);
  });

  it.each(['projection', 'process'])('invalidates facts after a same-origin %s change', async (kind) => {
    let epoch = 'e1';
    let startedAt = 1;
    let title = 'before';
    const d = daemon(20, (url) =>
      url.pathname === '/api/status'
        ? {
            body: {
              canonical_ready: true,
              daemon: { started_at: startedAt },
              search: { ...READY, projection_epoch: epoch },
            },
          }
        : { body: { sessions: [row('root-a', 'native-a', { title })] } },
    );
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    await service.facts(['native-a']);
    if (kind === 'projection') epoch = 'e2';
    else startedAt = 2;
    title = 'after';
    await service.status();
    expect(await service.facts(['native-a'])).toMatchObject([{ title: 'after' }]);
  });

  it('refreshes facts when an announcement changes at the same origin', async () => {
    let generation = 'first-process';
    const d = daemon(20, (url) =>
      url.pathname === '/api/status'
        ? { body: { canonical_ready: true, search: READY } }
        : { body: { sessions: [row('root-a', 'native-a', { title: generation })] } },
    );
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ({ ...ORIGIN, generation }) });
    expect(await service.facts(['native-a'])).toMatchObject([{ title: 'first-process' }]);
    generation = 'replacement-process';
    expect(await service.facts(['native-a'])).toMatchObject([{ title: 'replacement-process' }]);
  });

  it('discards an in-flight lookup from a previous daemon without poisoning its replacement', async () => {
    let origin = ORIGIN.origin;
    const started = deferred<void>();
    const pending = deferred<Answer>();
    const d = daemon(20, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      if (url.origin === ORIGIN.origin) {
        started.resolve();
        return pending.promise;
      }
      return { body: { sessions: [row('root-b', 'native-a', { title: 'new daemon' })] } };
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ({ ...ORIGIN, origin }) });
    const stale = service.facts(['native-a']);
    await started.promise;
    origin = 'http://127.0.0.1:5050';
    expect(await service.facts(['native-a'])).toMatchObject([{ title: 'new daemon' }]);
    pending.resolve({ body: { sessions: [row('root-a', 'native-a', { title: 'old daemon' })] } });
    expect(await stale).toEqual([]);
    expect(await service.facts(['native-a'])).toMatchObject([{ title: 'new daemon' }]);
  });

  it('never resolves old search hits against a newly selected daemon', async () => {
    let origin = ORIGIN.origin;
    const started = deferred<void>();
    const pending = deferred<Answer>();
    const d = daemon(20, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      if (url.pathname === '/api/sessions') return { body: { sessions: [row(url.port, 'native-a')] } };
      if (url.pathname === '/api/search') {
        started.resolve();
        return pending.promise;
      }
      throw new Error('old search hits must never cause a child lookup');
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ({ ...ORIGIN, origin }) });
    const old = service.search({ query: 'hello', nativeSessionIds: ['native-a'] });
    await started.promise;
    origin = 'http://127.0.0.1:5050';
    expect(await service.facts(['native-a'])).toMatchObject([{ sessionId: '5050' }]);
    pending.resolve({ body: { state: READY, hits: [{ session_id: 'old-child', timeline_id: 't1' }] } });
    expect(await old).toMatchObject({
      answered: false,
      hits: [],
      status: { detail: expect.stringContaining('daemon changed') },
    });
    expect(await service.facts(['native-a'])).toMatchObject([{ sessionId: '5050' }]);
    expect(d.asked.some((path) => path === '/api/sessions/old-child')).toBe(false);
  });

  it('re-resolves the scope when a search reveals a new projection epoch', async () => {
    let epoch = 'e1';
    const d = daemon(20, (url) => {
      const state = { ...READY, projection_epoch: epoch };
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: state } };
      if (url.pathname === '/api/sessions') return { body: { sessions: [row(epoch, 'native-a')] } };
      if (url.pathname === '/api/search')
        return { body: { state, hits: [{ session_id: epoch, timeline_id: 't1', snippet: 'hello' }] } };
      return undefined;
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN });
    await service.facts(['native-a']);
    epoch = 'e2';
    expect(await service.search({ query: 'hello', nativeSessionIds: ['native-a'] })).toMatchObject({
      answered: false,
      status: { detail: expect.stringContaining('index changed') },
    });
    expect(await service.search({ query: 'hello', nativeSessionIds: ['native-a'] })).toMatchObject({
      answered: true,
      hits: [{ rootSessionId: 'e2' }],
    });
    expect(
      d.asked
        .filter((path) => path.startsWith('/api/search'))
        .map((path) => new URL(path, ORIGIN.origin).searchParams.get('sessions')),
    ).toEqual(['e1', 'e2']);
  });

  it('preserves facts through a lookup timeout and retries on the next request', async () => {
    let now = 0;
    let timeout = false;
    const d = daemon(20, (url) => {
      if (url.pathname === '/api/status') return { body: { canonical_ready: true, search: READY } };
      if (timeout) throw new DOMException('expired', 'TimeoutError');
      return { body: { sessions: [row('root-a', 'native-a')] } };
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN, now: () => now });
    const original = await service.facts(['native-a']);
    now = 16_000;
    timeout = true;
    expect(await service.search({ query: 'hello', nativeSessionIds: ['native-a'] })).toMatchObject({
      answered: false,
      status: { reachable: false, detail: 'the history daemon did not answer in time' },
    });
    expect(await service.facts(['native-a'])).toEqual(original);
    timeout = false;
    expect(await service.facts(['native-a'])).toEqual(original);
    expect(d.asked.filter((path) => path.startsWith('/api/sessions?'))).toHaveLength(4);
  });
});

describe('the launcher catalogue and recent sessions', () => {
  const PROJECTS = {
    projects: [{ id: 'p1', name: 'rosetta', root_paths: ['/w/rosetta', '/w/rosetta-wt'], git_repo: 'x' }],
  };
  const RUNTIMES = {
    runtimes: [{ id: 'rt1', kind: 'claude-code', data_root: '/home/.claude', enabled: true, discovered_at: 1 }],
  };

  it('reads projects and runtimes once per window, and top-level sessions by project from the pinned wire', async () => {
    let clock = 1_000;
    const d = daemon(20, (url) => {
      if (url.pathname === '/api/status') return { body: CURRENT_WIRE.status };
      if (url.pathname === '/api/projects') return { body: PROJECTS };
      if (url.pathname === '/api/runtimes') return { body: RUNTIMES };
      if (url.pathname === '/api/sessions') return { body: CURRENT_WIRE.sessions };
      if (url.pathname === '/api/search') return { body: { state: READY, hits: [] } };
      return undefined;
    });
    const service = createHistorySearchService({ fetch: d.fetch, origin: () => ORIGIN, now: () => clock });

    const first = await service.catalogue();
    expect(first.answered && first.projects).toEqual([
      { id: 'p1', name: 'rosetta', rootPaths: ['/w/rosetta', '/w/rosetta-wt'] },
    ]);
    expect(first.answered && first.runtimes).toEqual([{ id: 'rt1', kind: 'claude-code', dataRoot: '/home/.claude' }]);
    await service.catalogue();
    expect(d.asked.filter((path) => path === '/api/projects')).toHaveLength(1);
    clock += 20_000;
    await service.catalogue();
    expect(d.asked.filter((path) => path === '/api/projects')).toHaveLength(2);

    const recent = await service.recent({ project: 'p1', limit: 100 });
    expect(d.asked).toContain('/api/sessions?limit=100&project=p1');
    expect(recent.answered && recent.sessions).toEqual([
      {
        id: 's1',
        nativeSessionId: 'native-s1',
        runtimeId: 'rt1',
        projectId: 'p1',
        cwd: '/w/rosetta',
        title: 'Named',
        summary: 'A summary',
        startedAt: 10_000,
        updatedAt: 20_000,
        lastActivityAt: 19_000,
      },
    ]);

    await service.search({ query: 'puppet', nativeSessionIds: [] }, { project: 'p1' });
    expect(d.asked.find((path) => path.startsWith('/api/search'))).toContain('project=p1');
  });

  it('says a silent daemon is not reachable rather than listing nothing', async () => {
    const fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof globalThis.fetch;
    const service = createHistorySearchService({ fetch, origin: () => ORIGIN });
    const catalogue = await service.catalogue();
    expect(catalogue.answered).toBe(false);
    expect(catalogue.status).toMatchObject({ reachable: false, detail: 'no history daemon is listening' });
    const recent = await service.recent({ limit: 10 });
    expect(recent.answered).toBe(false);
  });
});
