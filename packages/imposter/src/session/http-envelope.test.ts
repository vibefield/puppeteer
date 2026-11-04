/**
 * The HTTP engine reads every native spelling from `http-serve.json`. These
 * tests drive it with a second, 2.x-shaped declaration (envelope `data` plus a
 * `created` clock, `Secure Area` realm, `--server` attach) beside the pinned
 * 1.x persona, without a 2.x ASM: carrier validation is stubbed only where the
 * 1.x carrier schema would, correctly, refuse the other envelope.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchesHttpAttach, parseHttpAttach } from '../cli/http-persona.ts';
import { loadPersona, personaDirectory } from '../persona/load.ts';
import type { HttpServeAttach, HttpServeDocument, Persona } from '../persona/types.ts';
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

/** The pinned persona with a 2.x-shaped `$server` and no carrier check (the 1.x ASM pins `properties`). */
function secondLine(): Persona {
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
      envelope: { payloadKey: 'data', clockKey: 'created', connectedType: 'server.connected' },
      attach: SERVER_ATTACH,
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
  });

  it('frames a clocked data envelope, leaves the clock off the connect frame, and decodes string data', () => {
    const codec = createSseEnvelope({ payloadKey: 'data', clockKey: 'created', connectedType: 'server.connected' });
    const record = codec.wrap('session.created', { sessionID: 'ses_2' });
    expect(Object.keys(record)).toEqual(['id', 'created', 'type', 'data']);
    expect(typeof record.created).toBe('number');
    expect(codec.connected()).toMatchObject({ type: 'server.connected', data: {} });
    expect(Object.keys(codec.connected())).toEqual(['id', 'type', 'data']);
    expect(codec.payloadOf({ data: '{"sessionID":"ses_3"}' })).toEqual({ sessionID: 'ses_3' });
    expect(codec.payloadOf({ data: '[1]' })).toBeUndefined();
    expect(codec.payloadOf({ data: 'not json' })).toBeUndefined();
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
    for (const record of records.slice(1)) {
      expect(Object.keys(record)).toEqual(['id', 'created', 'type', 'data']);
      expect(record).not.toHaveProperty('properties');
    }
    expect(records.find((record) => record.type === 'session.created')).toMatchObject({ data: { sessionID } });

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
      server.attach = { serverFlag: '--server', sessionFlag: ['--session', '-s'], promptBody: { text: '$text' } };
    });
    expect(persona.httpServe!.$server.auth).not.toHaveProperty('usernameEnv');
    expect(persona.httpServe!.$server.auth.passwordEnv).toEqual(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD']);
    expect(persona.httpServe!.$server.attach).toEqual({
      serverFlag: '--server',
      sessionFlag: ['--session', '-s'],
      valueFlags: [],
      promptBody: { text: '$text' },
    });
    expect(pinned.httpServe!.$server.auth.passwordEnv).toEqual(['OPENCODE_SERVER_PASSWORD']);
    expect(pinned.httpServe!.$server.attach.sessionFlag).toEqual(['--session']);
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
  });
});
