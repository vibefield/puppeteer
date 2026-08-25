/** CLI forks for a REST + SSE persona: native server mode and attached viewer. */

import type { Persona } from '../persona/types.ts';
import { createHttpPersonaServer } from '../session/http-session-server.ts';
import type { BehaviorDocument } from '../session/session.ts';
import { createPresentation } from '../tui/mount.ts';
import { flagValue } from './argv.ts';
import { installPromptLine } from './prompt-line.ts';

interface HttpPersonaRunOptions {
  persona: Persona;
  argv: readonly string[];
  behavior: BehaviorDocument;
  env: Record<string, string | undefined>;
  cwd: string;
  log: (message: string) => void;
}

function authHeader(persona: Persona, env: Record<string, string | undefined>): Record<string, string> {
  const auth = persona.httpServe!.$server.auth;
  const password = env[auth.passwordEnv];
  if (!password) return {};
  const username = env[auth.usernameEnv] ?? auth.defaultUsername;
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

function scopedUrl(origin: string, path: string, directory?: string): URL {
  const url = new URL(path, origin.endsWith('/') ? origin : `${origin}/`);
  if (directory) url.searchParams.set('directory', directory);
  return url;
}

export async function runHttpPersonaServer(options: HttpPersonaRunOptions): Promise<number> {
  const spec = options.persona.httpServe!.$server;
  const hostname = flagValue(options.argv, [spec.hostnameFlag]) ?? spec.defaultHostname;
  const rawPort = flagValue(options.argv, [spec.portFlag]);
  const port = rawPort === undefined ? spec.defaultPort : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`${spec.portFlag} must be an integer from 0 to 65535\n`);
    return 2;
  }
  const server = await createHttpPersonaServer({
    persona: options.persona,
    behavior: options.behavior,
    hostname,
    port,
    env: options.env,
    cwd: options.cwd,
    username: options.env[spec.auth.usernameEnv] ?? spec.auth.defaultUsername,
    ...(options.env[spec.auth.passwordEnv] === undefined ? {} : { password: options.env[spec.auth.passwordEnv] }),
    log: options.log,
  });
  // This is the real vendor's machine-readable readiness line. Adapters wait
  // for it before opening SSE; nothing else is written to stdout in serve mode.
  process.stdout.write(`${options.persona.vendor} server listening on ${server.origin}\n`);
  let closing = false;
  const shutdown = async (code = 0): Promise<never> => {
    if (closing) await new Promise(() => {});
    closing = true;
    await server.close().catch((error: unknown) => options.log(`HTTP server close failed: ${String(error)}`));
    process.exit(code);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await new Promise(() => {});
  return 0;
}

interface SseWireRecord {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

async function consumeSse(
  response: Response,
  onRecord: (record: SseWireRecord) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.ok) throw new Error(`SSE endpoint returned HTTP ${response.status}`);
  if (!response.body) throw new Error('SSE endpoint returned no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
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
      if (data) {
        const parsed = JSON.parse(data) as unknown;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as SseWireRecord).id === 'string' &&
          typeof (parsed as SseWireRecord).type === 'string' &&
          (parsed as SseWireRecord).properties !== null &&
          typeof (parsed as SseWireRecord).properties === 'object'
        ) {
          onRecord(parsed as SseWireRecord);
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export async function runHttpPersonaAttached(options: HttpPersonaRunOptions): Promise<number> {
  const spec = options.persona.httpServe!.$server;
  const origin = options.argv[1];
  if (!origin) {
    process.stderr.write(`${spec.attach.command} requires a server URL\n`);
    return 2;
  }
  try {
    new URL(origin);
  } catch {
    process.stderr.write(`${spec.attach.command} requires a valid server URL\n`);
    return 2;
  }
  const sessionID = flagValue(options.argv, [spec.attach.sessionFlag]);
  if (!sessionID) {
    process.stderr.write(`${spec.attach.sessionFlag} requires a session id\n`);
    return 2;
  }
  const directory = flagValue(options.argv, [spec.attach.directoryFlag]);
  const headers = { Accept: 'application/json', ...authHeader(options.persona, options.env) };
  const screen = await createPresentation({
    vendor: options.persona.vendor,
    version: options.persona.version,
    sessionId: sessionID,
    channels: [options.persona.channelFor('sse') ?? 'sse', 'terminal'],
  });
  const abort = new AbortController();
  let closing = false;
  const shutdown = async (code = 0): Promise<never> => {
    if (closing) await new Promise(() => {});
    closing = true;
    abort.abort();
    await screen.stop();
    process.exit(code);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  const relevant = (record: SseWireRecord): boolean => {
    const direct = record.properties.sessionID;
    if (typeof direct === 'string') return direct === sessionID;
    const info = record.properties.info;
    return (
      record.type.startsWith('server.') ||
      (info !== null && typeof info === 'object' && (info as { id?: unknown }).id === sessionID)
    );
  };
  const draw = (record: SseWireRecord): void => {
    if (relevant(record)) screen.frame({ at: new Date().toISOString(), op: record.type, with: record.properties });
  };

  const hydrate = async (): Promise<void> => {
    const [sessionResponse, messagesResponse] = await Promise.all([
      fetch(scopedUrl(origin, `/session/${encodeURIComponent(sessionID)}`, directory), {
        headers,
        signal: abort.signal,
      }),
      fetch(scopedUrl(origin, `/session/${encodeURIComponent(sessionID)}/message`, directory), {
        headers,
        signal: abort.signal,
      }),
    ]);
    if (!sessionResponse.ok) throw new Error(`session hydration returned HTTP ${sessionResponse.status}`);
    if (!messagesResponse.ok) throw new Error(`message hydration returned HTTP ${messagesResponse.status}`);
    const session = (await sessionResponse.json()) as Record<string, unknown>;
    const messages = (await messagesResponse.json()) as Array<{
      info: Record<string, unknown>;
      parts: Record<string, unknown>[];
    }>;
    screen.frame({ at: new Date().toISOString(), op: 'session.hydrated', with: session });
    for (const message of messages) {
      screen.frame({ at: new Date().toISOString(), op: 'message.updated', with: { sessionID, info: message.info } });
      for (const part of message.parts) {
        screen.frame({ at: new Date().toISOString(), op: 'message.part.updated', with: { sessionID, part } });
      }
    }
  };

  const stream = async (): Promise<void> => {
    while (!closing) {
      try {
        const response = await fetch(scopedUrl(origin, '/event', directory), {
          headers: { ...headers, Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        await hydrate();
        await consumeSse(response, draw, abort.signal);
      } catch (error) {
        if (closing || abort.signal.aborted) return;
        screen.notice(`event stream disconnected: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!closing) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  void stream();

  installPromptLine({
    interactive: screen.interactive,
    staged: (text) => screen.staged(text),
    submit: (text) => {
      const url = scopedUrl(origin, `/session/${encodeURIComponent(sessionID)}/prompt_async`, directory);
      void fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageID: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
          parts: [{ type: 'text', text }],
        }),
        signal: abort.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`prompt returned HTTP ${response.status}`);
        })
        .catch((error: unknown) =>
          screen.notice(`turn failed: ${error instanceof Error ? error.message : String(error)}`),
        );
    },
    interrupt: () => void shutdown(),
    end: () => void shutdown(),
    log: options.log,
  });

  await new Promise(() => {});
  return 0;
}
