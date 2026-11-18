/**
 * The HTTP engine reads every native spelling from `http-serve.json`. These
 * tests drive it with a second, 2.x-shaped declaration (envelope `data` plus a
 * `created` clock, `location` and `durable` siblings, `Secure Area` realm,
 * `--server` attach) beside the pinned 1.x persona, without a 2.x ASM: carrier
 * validation is stubbed only where the 1.x carrier schema would, correctly,
 * refuse the other envelope. The 2.x shapes are the 2026-11-04 probe's.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hydrationFrames,
  matchesHttpAttach,
  parseHttpAttach,
  passwordFrom,
  planHttpAttach,
  readinessLine,
  resolveHttpServe,
  type HttpAttachPlan,
} from '../cli/http-persona.ts';
import { loadPersona, personaDirectory } from '../persona/load.ts';
import type { HttpServeAttach, HttpServeDocument, HttpServeEnvelope, Persona } from '../persona/types.ts';
import { createSseEnvelope } from './channels/http-sse.ts';
import { createHttpPersonaServer, type HttpPersonaServer } from './http-session-server.ts';
import type { BehaviorDocument } from './session.ts';

const roots: string[] = [];
const servers: HttpPersonaServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const pinned = loadPersona('opencode');
const rawServe = JSON.parse(readFileSync(join(personaDirectory('opencode'), 'http-serve.json'), 'utf8')) as {
  $server: Record<string, unknown>;
  routes: unknown[];
};

const SERVER_ATTACH: HttpServeAttach = {
  serverFlag: '--server',
  sessionFlag: ['--session', '-s'],
  valueFlags: ['--prompt'],
  promptBody: { text: '$text' },
};

/**
 * The 2.x frame grammar. Durable and location-less types here are 1.x event
 * names the pinned behavior emits, standing in for 2.x's `session.*` set.
 */
const SECOND_ENVELOPE: HttpServeEnvelope = {
  payloadKey: 'data',
  encodedPayload: true,
  clockKey: 'created',
  connectedType: 'server.connected',
  location: { key: 'location', omitTypes: ['session.idle'] },
  durable: { key: 'durable', version: 1, types: ['session.created', 'session.status', 'session.idle'] },
};

const planHeaders = (password: string): Record<string, string> => ({
  Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
});

/** The pinned persona with a 2.x-shaped `$server` and no carrier check (the 1.x ASM pins `properties`). */
function secondLine(attach: HttpServeAttach = SERVER_ATTACH): Persona {
  const document: HttpServeDocument = {
    ...pinned.httpServe!,
    $server: {
      ...pinned.httpServe!.$server,
      readiness: 'server listening on $origin',
      auth: {
        passwordEnv: ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'],
        defaultUsername: 'opencode',
        realm: 'Secure Area',
        unauthorizedBody: { _tag: 'UnauthorizedError', message: 'Authentication required' },
      },
      envelope: SECOND_ENVELOPE,
      attach,
    },
  };
  return { ...pinned, httpServe: document, validateRecord: () => [] };
}

function behavior(name: string): BehaviorDocument {
  return JSON.parse(
    readFileSync(join(personaDirectory('opencode'), 'behavior', `${name}.json`), 'utf8'),
  ) as BehaviorDocument;
}

async function frames(url: string, headers: Record<string, string>, until: string, signal: AbortSignal) {
  const response = await fetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const raw: string[] = [];
  let buffer = '';
  const deadline = Date.now() + 5000;
  return {
    raw,
    async drain(): Promise<string[]> {
      while (!raw.some((line) => line.includes(`"type":"${until}"`))) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${until}; saw ${raw.join('\n')}`);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          raw.push(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
      return raw;
    },
  };
}

describe('SSE envelope codec', () => {
  it('frames the 1.x carrier exactly as {id,type,properties}', () => {
    const codec = createSseEnvelope(pinned.httpServe!.$server.envelope);
    const record = codec.wrap('session.idle', { sessionID: 'ses_1' });
    expect(Object.keys(record)).toEqual(['id', 'type', 'properties']);
    expect(record.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(Object.keys(codec.connected())).toEqual(['id', 'type', 'properties']);
    expect(codec.read(record)).toEqual({ type: 'session.idle', payload: { sessionID: 'ses_1' } });
    expect(codec.read({ id: 'evt_1', type: 'x', data: {} })).toBeUndefined();
    // 1.x stays object-only: an encoded string carrier was never drawn or reduced.
    expect(codec.read({ id: 'evt_1', type: 'x', properties: '{"sessionID":"ses_1"}' })).toBeUndefined();
    // A scope adds nothing when the envelope declares no siblings.
    const scoped = codec.wrap(
      'session.idle',
      { sessionID: 'ses_1' },
      { directory: '/w', aggregateID: 'ses_1', seq: 3 },
    );
    expect(Object.keys(scoped)).toEqual(['id', 'type', 'properties']);
    expect(codec.isDurable('session.idle')).toBe(false);
  });

  it('frames the 2.x grammar: clock, location between type and data, durable after data', () => {
    const codec = createSseEnvelope(SECOND_ENVELOPE);
    const before = Date.now();
    const scope = { directory: '/work', aggregateID: 'ses_2', seq: 4 };
    const durable = codec.wrap('session.created', { sessionID: 'ses_2' }, scope);
    const after = Date.now();
    expect(Object.keys(durable)).toEqual(['id', 'created', 'type', 'location', 'data', 'durable']);
    expect(durable).toMatchObject({
      location: { directory: '/work' },
      durable: { aggregateID: 'ses_2', seq: 4, version: 1 },
    });
    expect(durable.created as number).toBeGreaterThanOrEqual(before);
    expect(durable.created as number).toBeLessThanOrEqual(after);
    // As 2.x `session.renamed`: durable without a location.
    expect(Object.keys(codec.wrap('session.idle', { sessionID: 'ses_2' }, scope))).toEqual([
      'id',
      'created',
      'type',
      'data',
      'durable',
    ]);
    // As 2.x `permission.asked`: located, not durable.
    expect(Object.keys(codec.wrap('permission.asked', { id: 'per_1' }, scope))).toEqual([
      'id',
      'created',
      'type',
      'location',
      'data',
    ]);
    // Without a known directory or seq the siblings are left off, never invented.
    expect(Object.keys(codec.wrap('session.created', {}))).toEqual(['id', 'created', 'type', 'data']);
    // The connect frame is `{id,type,data}`: no clock, location, or cursor.
    expect(codec.connected()).toMatchObject({ type: 'server.connected', data: {} });
    expect(Object.keys(codec.connected())).toEqual(['id', 'type', 'data']);

    expect(codec.isDurable('session.created')).toBe(true);
    expect(codec.read(durable)).toEqual({
      type: 'session.created',
      payload: { sessionID: 'ses_2' },
      durable: { aggregateID: 'ses_2', seq: 4, version: 1 },
    });
    // A probe frame read back whole, `data` as the declared encoded string.
    expect(
      codec.read({
        id: 'evt_1a7ea7849001dJSHQP6Hw7G1vm',
        created: 1793818523721,
        type: 'session.created',
        location: { directory: '/work' },
        data: '{"sessionID":"ses_e581587bbffes70cVKlri9YOGP"}',
        durable: { aggregateID: 'ses_e581587bbffes70cVKlri9YOGP', seq: 0, version: 1 },
      }),
    ).toMatchObject({ payload: { sessionID: 'ses_e581587bbffes70cVKlri9YOGP' }, durable: { seq: 0 } });
    expect(codec.read({ id: 'e', type: 't', data: {}, durable: { aggregateID: 'a', seq: '1' } })).toEqual({
      type: 't',
      payload: {},
    });
    expect(codec.payloadOf({ data: '[1]' })).toBeUndefined();
    expect(codec.payloadOf({ data: 'not json' })).toBeUndefined();
    // The session log stream's `log.synced` has no id or payload key; it is not an event-stream frame.
    expect(codec.read({ type: 'log.synced', aggregateID: 'ses_2', seq: 10 })).toBeUndefined();
  });
});

describe('data-driven HTTP engine', () => {
  it('serves the declared realm, unauthorized body, and envelope through the same session store', async () => {
    const root = scratch('puppeteer-http-envelope-');
    const persona = secondLine();
    const server = await createHttpPersonaServer({
      persona,
      behavior: behavior('happy-turn'),
      hostname: '127.0.0.1',
      port: 0,
      env: { PUPPETEER_IMPOSTER_HOME: root },
      cwd: root,
      username: 'opencode',
      password: 'pw',
    });
    servers.push(server);

    const denied = await fetch(`${server.origin}/session`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Basic realm="Secure Area"');
    expect(await denied.json()).toEqual({ _tag: 'UnauthorizedError', message: 'Authentication required' });

    const headers = { Authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}` };
    const abort = new AbortController();
    const stream = await frames(
      `${server.origin}/event?directory=${encodeURIComponent(root)}`,
      headers,
      'session.idle',
      abort.signal,
    );
    const created = await fetch(`${server.origin}/session?directory=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'second line' }),
    });
    const sessionID = String(((await created.json()) as { id: string }).id);
    const prompt = await fetch(`${server.origin}/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg_second', parts: [{ type: 'text', text: 'hi' }] }),
    });
    expect(prompt.status).toBe(204);
    const records = (await stream.drain()).map(
      (line) => JSON.parse(line.replace(/^data: /, '')) as Record<string, unknown>,
    );
    abort.abort();

    expect(Object.keys(records[0]!)).toEqual(['id', 'type', 'data']);
    expect(records[0]).toMatchObject({ type: 'server.connected', data: {} });
    const durable = SECOND_ENVELOPE.durable!.types;
    const locationless = SECOND_ENVELOPE.location!.omitTypes;
    for (const record of records.slice(1)) {
      const type = String(record.type);
      expect(Object.keys(record)).toEqual([
        'id',
        'created',
        'type',
        ...(locationless.includes(type) ? [] : ['location']),
        'data',
        ...(durable.includes(type) ? ['durable'] : []),
      ]);
      expect(record).not.toHaveProperty('properties');
      if (!locationless.includes(type)) expect(record.location).toEqual({ directory: root });
    }
    expect(records.find((record) => record.type === 'session.created')).toMatchObject({ data: { sessionID } });
    // Per-session seq from 0 with no gap while connected.
    const seqs = records
      .filter((record) => durable.includes(String(record.type)))
      .map((record) => record.durable as { aggregateID: string; seq: number; version: number });
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs.map((cursor) => cursor.seq)).toEqual(seqs.map((_, index) => index));
    expect(new Set(seqs.map((cursor) => cursor.aggregateID))).toEqual(new Set([sessionID]));

    // The store reduced the same events through the codec, so REST rehydration still works.
    const messages = (await (
      await fetch(`${server.origin}/session/${sessionID}/message`, { headers })
    ).json()) as Array<{ info: { role: string } }>;
    expect(messages.map((message) => message.info.role)).toEqual(['user', 'assistant']);
    const statuses = (await (await fetch(`${server.origin}/session/status`, { headers })).json()) as Record<
      string,
      unknown
    >;
    expect(statuses[sessionID]).toEqual({ type: 'idle' });
  });

  it('spends durable seq while no reader is connected, so a reconnect sees the gap, and resumes it after restart', async () => {
    const root = scratch('puppeteer-http-seq-');
    const persona = secondLine();
    const start = {
      persona,
      behavior: behavior('happy-turn'),
      hostname: '127.0.0.1',
      port: 0,
      env: { PUPPETEER_IMPOSTER_HOME: root },
      cwd: root,
      username: 'opencode',
      password: 'pw',
    };
    const headers = { Authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}` };
    const cursors = async (server: HttpPersonaServer, sessionID: string): Promise<number[]> => {
      const abort = new AbortController();
      const stream = await frames(`${server.origin}/event`, headers, 'session.idle', abort.signal);
      await server.emit(sessionID, 'session.idle', { sessionID });
      const lines = await stream.drain();
      abort.abort();
      return lines
        .map((line) => JSON.parse(line.replace(/^data: /, '')) as { durable?: { seq: number } })
        .flatMap((record) => (record.durable === undefined ? [] : [record.durable.seq]));
    };

    const server = await createHttpPersonaServer(start);
    servers.push(server);
    const created = await fetch(`${server.origin}/session`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'gap' }),
    });
    const sessionID = String(((await created.json()) as { id: string }).id);
    const first = await cursors(server, sessionID);
    expect(first).toHaveLength(1);
    // Nobody is subscribed: the vendor still spends a seq on this event.
    await server.emit(sessionID, 'session.idle', { sessionID });
    expect(await cursors(server, sessionID)).toEqual([first[0]! + 2]);

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const store = JSON.parse(readFileSync(join(root, 'http-session-store.json'), 'utf8')) as {
      sessions: Array<{ seq?: number }>;
    };
    expect(store.sessions[0]!.seq).toBe(first[0]! + 3);
    const restarted = await createHttpPersonaServer(start);
    servers.push(restarted);
    expect(await cursors(restarted, sessionID)).toEqual([first[0]! + 3]);
  });

  it('runs the --server viewer plan against a live server: routes, positional directory, $messageId, password order', async () => {
    const root = scratch('puppeteer-http-plan-');
    const attach: HttpServeAttach = {
      ...SERVER_ATTACH,
      // The pinned 1.x routes validate prompt bodies, so the template keeps their shape.
      promptBody: { messageID: '$messageId', parts: [{ type: 'text', text: '$text' }] },
    };
    const persona = secondLine(attach);
    const spec = persona.httpServe!.$server;
    // Both variables set: the first declared one is the password, as 2.x `cli/src/env.ts` reads them.
    const env = { OPENCODE_PASSWORD: 'first', OPENCODE_SERVER_PASSWORD: 'second' };
    const start = resolveHttpServe(spec, ['serve', '--hostname', '127.0.0.1', '--port', '0'], env);
    if ('error' in start) throw new Error(start.error);
    expect(start).toEqual({ hostname: '127.0.0.1', port: 0, username: 'opencode', password: 'first' });
    const server = await createHttpPersonaServer({
      persona,
      behavior: behavior('happy-turn'),
      ...start,
      env: { PUPPETEER_IMPOSTER_HOME: root },
      cwd: root,
    });
    servers.push(server);
    expect(readinessLine(spec, server.origin)).toBe(`server listening on ${server.origin}`);

    const created = await fetch(`${server.origin}/session?directory=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: { ...planHeaders('first'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'planned' }),
    });
    const sessionID = String(((await created.json()) as { id: string }).id);

    const argv = ['--server', server.origin, '-s', sessionID, '--prompt', 'ignored', root];
    expect(matchesHttpAttach(attach, argv)).toBe(true);
    const plan = planHttpAttach(persona.httpServe!, argv, env) as HttpAttachPlan;
    expect(plan.sessionID).toBe(sessionID);
    expect(plan.directory).toBe(root);
    expect(plan.url('session.messages').searchParams.get('directory')).toBe(root);

    const abort = new AbortController();
    const stream = await frames(plan.url('event.subscribe').href, plan.headers, 'session.idle', abort.signal);
    const session = await fetch(plan.url('session.get'), { headers: plan.headers });
    expect(session.status).toBe(200);
    expect(((await session.json()) as { id: string }).id).toBe(sessionID);
    const prompt = plan.prompt('hello from --server', 'msg_planned');
    expect(prompt.body).toEqual({ messageID: 'msg_planned', parts: [{ type: 'text', text: 'hello from --server' }] });
    const submitted = await fetch(prompt.url, {
      method: prompt.method,
      headers: { ...plan.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt.body),
    });
    expect(submitted.status).toBe(204);
    await stream.drain();
    abort.abort();
    const messages = (await (await fetch(plan.url('session.messages'), { headers: plan.headers })).json()) as Array<{
      info: { id: string; role: string };
    }>;
    expect(messages[0]!.info).toMatchObject({ id: 'msg_planned', role: 'user' });

    // Only the later variable set: it supplies the password. The earlier one set wrong: refused.
    const onlySecond = planHttpAttach(persona.httpServe!, argv, {
      OPENCODE_SERVER_PASSWORD: 'first',
    }) as HttpAttachPlan;
    expect((await fetch(onlySecond.url('session.get'), { headers: onlySecond.headers })).status).toBe(200);
    const wrongFirst = planHttpAttach(persona.httpServe!, argv, {
      OPENCODE_PASSWORD: 'wrong',
      OPENCODE_SERVER_PASSWORD: 'first',
    }) as HttpAttachPlan;
    expect((await fetch(wrongFirst.url('session.get'), { headers: wrongFirst.headers })).status).toBe(401);
    // Set-but-empty still counts as set, as Effect's `Config.orElse` treats it.
    expect(passwordFrom(spec.auth, { OPENCODE_PASSWORD: '', OPENCODE_SERVER_PASSWORD: 'x' })).toBe('');

    expect(planHttpAttach(persona.httpServe!, ['--server'], env)).toEqual({ error: '--server requires a server URL' });
    expect(planHttpAttach(persona.httpServe!, ['--server', 'nope', '-s', 'ses_1'], env)).toEqual({
      error: '--server requires a valid server URL',
    });
    expect(planHttpAttach(persona.httpServe!, ['--server', server.origin], env)).toEqual({
      error: '--session requires a session id',
    });
    expect(resolveHttpServe(spec, ['serve', '--port', '70000'], env)).toEqual({
      error: '--port must be an integer from 0 to 65535',
    });
  });

  it('draws 1.x hydration as native frames and throws on other shapes; a declared page draws whole', () => {
    const pinnedAttach = pinned.httpServe!.$server.attach;
    const info = { id: 'msg_1', role: 'user' };
    const part = { id: 'prt_1', type: 'text' };
    expect([...hydrationFrames(pinnedAttach, 'ses_1', [{ info, parts: [part] }])]).toEqual([
      { op: 'message.updated', with: { sessionID: 'ses_1', info } },
      { op: 'message.part.updated', with: { sessionID: 'ses_1', part } },
    ]);
    // As before the codec change: a 1.x answer that is not `{info, parts}[]` throws (the viewer reports and retries).
    expect(() => [...hydrationFrames(pinnedAttach, 'ses_1', { data: [] })]).toThrow(TypeError);
    const drawn: string[] = [];
    expect(() => {
      for (const frame of hydrationFrames(pinnedAttach, 'ses_1', [{ info, parts: [] }, { info }])) drawn.push(frame.op);
    }).toThrow(TypeError);
    expect(drawn).toEqual(['message.updated', 'message.updated']);

    // 2.x pages `{data, cursor}` with `{id, type, content, …}` messages (probe 40).
    const paged = { ...SERVER_ATTACH, messageListKey: 'data' };
    const message = { id: 'msg_2', type: 'assistant', content: [{ type: 'text', text: 'seeded' }] };
    expect([...hydrationFrames(paged, 'ses_2', { data: [message], cursor: { previous: null, next: null } })]).toEqual([
      { op: 'message.hydrated', with: { sessionID: 'ses_2', message } },
    ]);
    expect(() => [...hydrationFrames(paged, 'ses_2', [message])]).toThrow(/no data list/);
  });

  it('resolves the subcommand and the root --server attach invocations from data', () => {
    const pinnedAttach = pinned.httpServe!.$server.attach;
    const legacy = ['attach', 'http://127.0.0.1:1', '--dir', '/work', '--session', 'ses_1', '--pure'];
    expect(matchesHttpAttach(pinnedAttach, legacy)).toBe(true);
    expect(matchesHttpAttach(pinnedAttach, ['serve', '--port', '0'])).toBe(false);
    expect(parseHttpAttach(pinnedAttach, legacy)).toEqual({
      origin: 'http://127.0.0.1:1',
      sessionID: 'ses_1',
      directory: '/work',
    });

    const rooted = ['--server', 'http://127.0.0.1:2', '-s', 'ses_2', '--prompt', 'go', '--auto', '/repo'];
    expect(matchesHttpAttach(SERVER_ATTACH, rooted)).toBe(true);
    expect(matchesHttpAttach(SERVER_ATTACH, ['serve', '--server', 'x'])).toBe(false);
    expect(matchesHttpAttach(SERVER_ATTACH, ['--session', 'ses_2'])).toBe(false);
    expect(parseHttpAttach(SERVER_ATTACH, rooted)).toEqual({
      origin: 'http://127.0.0.1:2',
      sessionID: 'ses_2',
      directory: '/repo',
    });
    expect(parseHttpAttach(SERVER_ATTACH, ['--server', 'http://h', '--session', 'ses_3']).directory).toBeUndefined();
  });
});

describe('http-serve.json loader', () => {
  function loadWith(mutate: (server: Record<string, unknown>) => void): Persona {
    const directory = join(scratch('puppeteer-http-serve-'), 'opencode');
    cpSync(personaDirectory('opencode'), directory, { recursive: true });
    const document = structuredClone(rawServe);
    mutate(document.$server);
    writeFileSync(join(directory, 'http-serve.json'), `${JSON.stringify(document, null, 2)}\n`);
    return loadPersona('opencode', { directory });
  }

  it('normalizes alias lists and accepts a --server attach with a positional directory', () => {
    const persona = loadWith((server) => {
      server.auth = {
        passwordEnv: ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'],
        defaultUsername: 'opencode',
        realm: 'Secure Area',
        unauthorizedBody: { _tag: 'UnauthorizedError' },
      };
      server.attach = {
        serverFlag: '--server',
        sessionFlag: ['--session', '-s'],
        promptBody: { text: '$text' },
        messageListKey: 'data',
      };
      server.envelope = {
        payloadKey: 'data',
        encodedPayload: true,
        clockKey: 'created',
        connectedType: 'server.connected',
        location: { key: 'location' },
        durable: { key: 'durable', version: 1, types: ['session.created'] },
      };
    });
    expect(persona.httpServe!.$server.auth).not.toHaveProperty('usernameEnv');
    expect(persona.httpServe!.$server.auth.passwordEnv).toEqual(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD']);
    expect(persona.httpServe!.$server.attach).toEqual({
      serverFlag: '--server',
      sessionFlag: ['--session', '-s'],
      valueFlags: [],
      promptBody: { text: '$text' },
      messageListKey: 'data',
    });
    expect(persona.httpServe!.$server.envelope).toEqual({
      payloadKey: 'data',
      encodedPayload: true,
      clockKey: 'created',
      connectedType: 'server.connected',
      location: { key: 'location', omitTypes: [] },
      durable: { key: 'durable', version: 1, types: ['session.created'] },
    });
    expect(pinned.httpServe!.$server.auth.passwordEnv).toEqual(['OPENCODE_SERVER_PASSWORD']);
    expect(pinned.httpServe!.$server.attach.sessionFlag).toEqual(['--session']);
    // The pinned 1.x envelope declares no 2.x sibling or encoded payload.
    expect(pinned.httpServe!.$server.envelope).toEqual({ payloadKey: 'properties', connectedType: 'server.connected' });
  });

  it('refuses ambiguous attach, a readiness line without $origin, and colliding envelope keys', () => {
    expect(() =>
      loadWith((server) => {
        (server.attach as Record<string, unknown>).serverFlag = '--server';
      }),
    ).toThrow(/exactly one of "command" or "serverFlag"/);
    expect(() =>
      loadWith((server) => {
        server.readiness = 'server listening';
      }),
    ).toThrow(/readiness must contain \$origin/);
    expect(() =>
      loadWith((server) => {
        server.envelope = { payloadKey: 'type', connectedType: 'server.connected' };
      }),
    ).toThrow(/envelope keys must be distinct/);
    expect(() =>
      loadWith((server) => {
        (server.auth as Record<string, unknown>).realm = 'a"b';
      }),
    ).toThrow(/realm must not contain quotes/);
    const envelope = (extra: Record<string, unknown>) => (server: Record<string, unknown>) => {
      server.envelope = { payloadKey: 'data', clockKey: 'created', connectedType: 'server.connected', ...extra };
    };
    expect(() => loadWith(envelope({ location: { key: 'created' } }))).toThrow(/envelope keys must be distinct/);
    expect(() => loadWith(envelope({ durable: { key: 'data', version: 1, types: ['x'] } }))).toThrow(
      /envelope keys must be distinct/,
    );
    expect(() => loadWith(envelope({ durable: { key: 'durable', version: 1, types: [] } }))).toThrow(
      /durable.types must not be empty/,
    );
    expect(() => loadWith(envelope({ durable: { key: 'durable', version: 1.5, types: ['x'] } }))).toThrow(
      /durable.version must be a non-negative integer/,
    );
    expect(() => loadWith(envelope({ encodedPayload: 'yes' }))).toThrow(/encodedPayload must be a boolean/);
    expect(() => loadWith(envelope({ location: { key: 'location', directoryKey: 'dir' } }))).toThrow(
      /unknown field\(s\): directoryKey/,
    );
  });
});
