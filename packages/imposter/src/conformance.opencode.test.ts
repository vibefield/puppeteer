import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPersona, personaDirectory } from './persona/load.ts';
import type { BehaviorDocument } from './session/session.ts';
import { createHttpPersonaServer, type HttpPersonaServer } from './session/http-session-server.ts';
import type { SseRecord } from './session/channels/http-sse.ts';

const persona = loadPersona('opencode');
const roots: string[] = [];
const servers: HttpPersonaServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function behavior(name: string): BehaviorDocument {
  return JSON.parse(
    readFileSync(join(personaDirectory('opencode'), 'behavior', `${name}.json`), 'utf8'),
  ) as BehaviorDocument;
}

async function start(name = 'happy-turn', root = mkdtempSync(join(tmpdir(), 'puppeteer-opencode-imposter-'))) {
  if (!roots.includes(root)) roots.push(root);
  const server = await createHttpPersonaServer({
    persona,
    behavior: behavior(name),
    hostname: '127.0.0.1',
    port: 0,
    env: { PUPPETEER_IMPOSTER_HOME: root },
    cwd: root,
    username: 'opencode',
    password: 'test-password',
  });
  servers.push(server);
  return { server, root };
}

const authorization = `Basic ${Buffer.from('opencode:test-password').toString('base64')}`;
const headers = { Authorization: authorization };

interface EventReader {
  records: SseRecord[];
  next(type?: string): Promise<SseRecord>;
  close(): void;
}

async function eventReader(url: string): Promise<EventReader> {
  const abort = new AbortController();
  const response = await fetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const records: SseRecord[] = [];
  const waiters = new Set<() => void>();
  let buffer = '';
  void (async () => {
    try {
      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) records.push(JSON.parse(data) as SseRecord);
          for (const wake of waiters) wake();
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  let cursor = 0;
  return {
    records,
    async next(type) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const index = records.findIndex(
          (record, candidate) => candidate >= cursor && (type === undefined || record.type === type),
        );
        if (index >= 0) {
          cursor = index + 1;
          return records[index]!;
        }
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
          setTimeout(wake, 50).unref?.();
        });
      }
      throw new Error(
        `timed out waiting for SSE ${type ?? 'record'}; saw ${records.map((record) => record.type).join(', ')}`,
      );
    },
    close() {
      abort.abort();
      void reader.cancel().catch(() => undefined);
    },
  };
}

async function createSession(server: HttpPersonaServer, directory: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.origin}/session?directory=${encodeURIComponent(directory)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Imposter test',
      model: { id: 'opencode-imposter', providerID: 'imposter' },
      permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function prompt(server: HttpPersonaServer, sessionID: string, text = 'hello'): Promise<Response> {
  return fetch(`${server.origin}/session/${sessionID}/prompt_async`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageID: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
      model: { providerID: 'imposter', modelID: 'opencode-imposter' },
      agent: 'build',
      parts: [{ type: 'text', text }],
    }),
  });
}

describe('OpenCode HTTP/SSE persona', () => {
  it('loads native routes and channel mappings from the pinned ASM', () => {
    expect(persona.version).toBe('1.18.16');
    expect(persona.channels).toEqual(['argv', 'http', 'sse', 'terminal']);
    expect(persona.channelFor('http')).toBe('http');
    expect(persona.channelFor('sse')).toBe('sse');
    expect(persona.httpServe?.$server).toMatchObject({
      command: 'serve',
      hostnameFlag: '--hostname',
      portFlag: '--port',
    });
    expect(persona.httpServe?.routes.map((route) => route.event)).toEqual(
      expect.arrayContaining([
        'http/event.subscribe',
        'http/session.create',
        'http/session.prompt_async',
        'http/permission.reply',
        'http/question.reply',
      ]),
    );
  });

  it('serves an authenticated happy turn, durable rehydration, reconnect, and restart resume', async () => {
    const { server, root } = await start();
    expect((await fetch(`${server.origin}/session`)).status).toBe(401);

    const events = await eventReader(`${server.origin}/event?directory=${encodeURIComponent(root)}`);
    expect(await events.next('server.connected')).toMatchObject({ type: 'server.connected', properties: {} });
    const info = await createSession(server, root);
    const sessionID = String(info.id);
    expect((await events.next('session.created')).properties.sessionID).toBe(sessionID);

    expect((await prompt(server, sessionID)).status).toBe(204);
    await events.next('session.idle');
    for (const record of events.records) {
      expect(persona.validateRecord(record.type, record, 'sse'), record.type).toEqual([]);
    }

    const messages = (await (
      await fetch(`${server.origin}/session/${sessionID}/message`, { headers })
    ).json()) as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>;
    expect(messages.map((message) => message.info.role)).toEqual(['user', 'assistant']);
    expect(messages[1]!.parts.some((part) => part.type === 'text' && part.text === 'imposter: ok')).toBe(true);
    const statuses = (await (await fetch(`${server.origin}/session/status`, { headers })).json()) as Record<
      string,
      { type: string }
    >;
    expect(statuses[sessionID]).toEqual({ type: 'idle' });

    events.close();
    const reconnected = await eventReader(`${server.origin}/event?directory=${encodeURIComponent(root)}`);
    expect((await reconnected.next()).type).toBe('server.connected');
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(reconnected.records).toHaveLength(1);
    reconnected.close();

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const resumed = await start('happy-turn', root);
    const resumedMessages = (await (
      await fetch(`${resumed.server.origin}/session/${sessionID}/message`, { headers })
    ).json()) as unknown[];
    expect(resumed.server.sessionIDs).toContain(sessionID);
    expect(resumedMessages).toEqual(messages);
  });

  it('holds a permission turn until HTTP allow or deny resolves its SSE blocker', async () => {
    const { server, root } = await start('permission-turn');
    const events = await eventReader(`${server.origin}/event?directory=${encodeURIComponent(root)}`);
    await events.next('server.connected');
    const sessionID = String((await createSession(server, root)).id);
    await events.next('session.created');

    expect((await prompt(server, sessionID, 'needs permission')).status).toBe(204);
    const asked = await events.next('permission.asked');
    const requestID = String(asked.properties.id);
    const listed = (await (await fetch(`${server.origin}/permission`, { headers })).json()) as Array<{ id: string }>;
    expect(listed.map((entry) => entry.id)).toEqual([requestID]);
    expect(events.records.some((record) => record.type === 'session.idle')).toBe(false);

    const reply = await fetch(`${server.origin}/permission/${requestID}/reply`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'once' }),
    });
    expect(await reply.json()).toBe(true);
    expect((await events.next('permission.replied')).properties).toMatchObject({ requestID, reply: 'once' });
    await events.next('session.idle');
    expect(await (await fetch(`${server.origin}/permission`, { headers })).json()).toEqual([]);

    expect((await prompt(server, sessionID, 'deny this one')).status).toBe(204);
    const denied = await events.next('permission.asked');
    const deniedID = String(denied.properties.id);
    const denial = await fetch(`${server.origin}/permission/${deniedID}/reply`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: 'reject' }),
    });
    expect(await denial.json()).toBe(true);
    expect((await events.next('permission.replied')).properties).toMatchObject({
      requestID: deniedID,
      reply: 'reject',
    });
    await events.next('session.idle');
    events.close();
  });

  it('stores and resolves question reply and reject branches over their native endpoints', async () => {
    const { server, root } = await start();
    const events = await eventReader(`${server.origin}/event?directory=${encodeURIComponent(root)}`);
    await events.next('server.connected');
    const sessionID = String((await createSession(server, root)).id);
    await events.next('session.created');

    const question = (id: string) => ({
      id,
      sessionID,
      questions: [
        {
          question: 'Choose one',
          header: 'Choice',
          options: [{ label: 'A', description: 'First option' }],
          multiple: false,
        },
      ],
    });
    await server.emit(sessionID, 'question.asked', question('que_reply'));
    await events.next('question.asked');
    expect(await (await fetch(`${server.origin}/question`, { headers })).json()).toHaveLength(1);
    const answered = await fetch(`${server.origin}/question/que_reply/reply`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['A']] }),
    });
    expect(await answered.json()).toBe(true);
    expect((await events.next('question.replied')).properties.answers).toEqual([['A']]);

    await server.emit(sessionID, 'question.asked', question('que_reject'));
    await events.next('question.asked');
    const rejected = await fetch(`${server.origin}/question/que_reject/reject`, { method: 'POST', headers });
    expect(await rejected.json()).toBe(true);
    expect((await events.next('question.rejected')).properties.requestID).toBe('que_reject');
    expect(await (await fetch(`${server.origin}/question`, { headers })).json()).toEqual([]);
    events.close();
  });

  it('forks, archives, lists, and deletes sessions without crossing directory-scoped streams', async () => {
    const { server, root } = await start();
    const otherDirectory = join(root, 'other');
    const selected = await eventReader(`${server.origin}/event?directory=${encodeURIComponent(root)}`);
    const other = await eventReader(`${server.origin}/event?directory=${encodeURIComponent(otherDirectory)}`);
    await selected.next('server.connected');
    await other.next('server.connected');
    const original = await createSession(server, root);
    const sessionID = String(original.id);
    await selected.next('session.created');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(other.records.map((record) => record.type)).toEqual(['server.connected']);

    expect((await prompt(server, sessionID)).status).toBe(204);
    await selected.next('session.idle');
    const messages = (await (
      await fetch(`${server.origin}/session/${sessionID}/message`, { headers })
    ).json()) as Array<{ info: { id: string; role: string }; parts: Array<{ sessionID: string; messageID: string }> }>;
    const assistantID = messages.find((message) => message.info.role === 'assistant')!.info.id;
    const forkResponse = await fetch(`${server.origin}/session/${sessionID}/fork`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageID: assistantID }),
    });
    expect(forkResponse.status).toBe(200);
    const fork = (await forkResponse.json()) as { id: string };
    await selected.next('session.created');
    const forkMessages = (await (
      await fetch(`${server.origin}/session/${fork.id}/message`, { headers })
    ).json()) as typeof messages;
    expect(forkMessages.map((message) => message.info.role)).toEqual(['user']);
    expect(forkMessages[0]!.info.id).not.toBe(messages[0]!.info.id);
    expect(
      forkMessages[0]!.parts.every((part) => part.sessionID === fork.id && part.messageID === forkMessages[0]!.info.id),
    ).toBe(true);

    const archivedAt = Date.now();
    const archived = await fetch(`${server.origin}/session/${fork.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ time: { archived: archivedAt } }),
    });
    expect((await archived.json()) as { time: { archived: number } }).toMatchObject({ time: { archived: archivedAt } });
    await selected.next('session.updated');
    const listed = (await (
      await fetch(`${server.origin}/session?directory=${encodeURIComponent(root)}`, { headers })
    ).json()) as Array<{ id: string }>;
    expect(listed.map((entry) => entry.id)).toEqual(expect.arrayContaining([sessionID, fork.id]));

    const deleted = await fetch(`${server.origin}/session/${fork.id}`, { method: 'DELETE', headers });
    expect(await deleted.json()).toBe(true);
    expect((await selected.next('session.deleted')).properties.sessionID).toBe(fork.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(other.records.map((record) => record.type)).toEqual(['server.connected']);
    expect(server.sessionIDs).not.toContain(fork.id);
    selected.close();
    other.close();
  });
});
