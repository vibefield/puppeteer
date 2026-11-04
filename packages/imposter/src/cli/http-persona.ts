/**
 * CLI forks for a REST + SSE persona: native server mode and attached viewer.
 *
 * Every native spelling — readiness line, password variables, attach
 * invocation, route paths, prompt body, SSE envelope — comes from the
 * persona's `http-serve.json`, so one engine serves each release line.
 */

import type { HttpServeAttach, HttpServeDocument, HttpServeRoute, Persona } from '../persona/types.ts';
import { createSseEnvelope, type SseEvent } from '../session/channels/http-sse.ts';
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

type AuthSpec = HttpServeDocument['$server']['auth'];

/** The first declared password variable that is set wins, as the vendor's own env reader does. */
function passwordFrom(auth: AuthSpec, env: Record<string, string | undefined>): string | undefined {
  for (const name of auth.passwordEnv) {
    if (env[name] !== undefined) return env[name];
  }
  return undefined;
}

function usernameFrom(auth: AuthSpec, env: Record<string, string | undefined>): string {
  return (auth.usernameEnv === undefined ? undefined : env[auth.usernameEnv]) ?? auth.defaultUsername;
}

function authHeader(persona: Persona, env: Record<string, string | undefined>): Record<string, string> {
  const auth = persona.httpServe!.$server.auth;
  const password = passwordFrom(auth, env);
  if (!password) return {};
  const username = usernameFrom(auth, env);
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

function scopedUrl(origin: string, path: string, query: string, directory?: string): URL {
  const url = new URL(path, origin.endsWith('/') ? origin : `${origin}/`);
  if (directory) url.searchParams.set(query, directory);
  return url;
}

function routeFor(document: HttpServeDocument, action: HttpServeRoute['action']): HttpServeRoute {
  const route = document.routes.find((candidate) => candidate.action === action);
  // The loader refuses an attach-capable document without these routes.
  if (!route) throw new Error(`http-serve.json has no ${action} route`);
  return route;
}

function routePath(route: HttpServeRoute, params: Record<string, string>): string {
  return route.path
    .split('/')
    .map((component) =>
      component.startsWith(':') ? encodeURIComponent(params[component.slice(1)] ?? component) : component,
    )
    .join('/');
}

/** Whole-string `$text` / `$messageId` substitution over the declared prompt body. */
function promptBody(template: unknown, bindings: Record<string, string>): unknown {
  if (typeof template === 'string') return Object.hasOwn(bindings, template) ? bindings[template] : template;
  if (Array.isArray(template)) return template.map((entry) => promptBody(entry, bindings));
  if (template !== null && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, promptBody(value, bindings)]));
  }
  return template;
}

/** Arguments that are neither flags nor the value of a flag the attach spec knows takes one. */
function positionals(argv: readonly string[], attach: HttpServeAttach): string[] {
  const valued = new Set([
    ...(attach.serverFlag === undefined ? [] : [attach.serverFlag]),
    ...attach.sessionFlag,
    ...(attach.directoryFlag === undefined ? [] : [attach.directoryFlag]),
    ...attach.valueFlags,
  ]);
  const found: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (valued.has(argument)) index += 1;
    else if (!argument.startsWith('-')) found.push(argument);
  }
  return found;
}

/**
 * Whether argv is the vendor's viewer invocation: `<command> <url> …`, or a
 * root `--server <url>` with no subcommand in front of it.
 */
export function matchesHttpAttach(attach: HttpServeAttach, argv: readonly string[]): boolean {
  if (attach.command !== undefined) return argv[0] === attach.command;
  return argv[0]?.startsWith('-') === true && argv.includes(attach.serverFlag!);
}

export interface HttpAttachTarget {
  origin?: string | undefined;
  sessionID?: string | undefined;
  directory?: string | undefined;
}

/** Resolve the viewer's server, session, and directory from vendor argv. */
export function parseHttpAttach(attach: HttpServeAttach, argv: readonly string[]): HttpAttachTarget {
  return {
    origin: attach.command !== undefined ? argv[1] : flagValue(argv, [attach.serverFlag!]),
    sessionID: flagValue(argv, attach.sessionFlag),
    // Without a directory flag the directory is the first positional after the
    // subcommand and its URL (`opencode --server <url> -s <id> <dir>`).
    directory:
      attach.directoryFlag !== undefined
        ? flagValue(argv, [attach.directoryFlag])
        : positionals(argv, attach).slice(attach.command === undefined ? 0 : 2)[0],
  };
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
  const password = passwordFrom(spec.auth, options.env);
  const server = await createHttpPersonaServer({
    persona: options.persona,
    behavior: options.behavior,
    hostname,
    port,
    env: options.env,
    cwd: options.cwd,
    username: usernameFrom(spec.auth, options.env),
    ...(password === undefined ? {} : { password }),
    log: options.log,
  });
  // This is the real vendor's machine-readable readiness line. Adapters wait
  // for it before opening SSE; nothing else is written to stdout in serve mode.
  process.stdout.write(`${spec.readiness.replaceAll('$origin', server.origin)}\n`);
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

async function consumeSse(
  response: Response,
  read: (value: unknown) => SseEvent | undefined,
  onEvent: (event: SseEvent) => void,
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
        const event = read(JSON.parse(data) as unknown);
        if (event) onEvent(event);
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export async function runHttpPersonaAttached(options: HttpPersonaRunOptions): Promise<number> {
  const document = options.persona.httpServe!;
  const spec = document.$server;
  const attach = spec.attach;
  const via = attach.command ?? attach.serverFlag!;
  const { origin, sessionID, directory } = parseHttpAttach(attach, options.argv);
  if (!origin) {
    process.stderr.write(`${via} requires a server URL\n`);
    return 2;
  }
  try {
    new URL(origin);
  } catch {
    process.stderr.write(`${via} requires a valid server URL\n`);
    return 2;
  }
  if (!sessionID) {
    process.stderr.write(`${attach.sessionFlag[0]} requires a session id\n`);
    return 2;
  }
  const envelope = createSseEnvelope(spec.envelope);
  const url = (action: HttpServeRoute['action']): URL =>
    scopedUrl(origin, routePath(routeFor(document, action), { sessionID }), spec.directoryQuery, directory);
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

  const relevant = ({ type, payload }: SseEvent): boolean => {
    const direct = payload.sessionID;
    if (typeof direct === 'string') return direct === sessionID;
    const info = payload.info;
    return (
      type.startsWith('server.') ||
      (info !== null && typeof info === 'object' && (info as { id?: unknown }).id === sessionID)
    );
  };
  const draw = (event: SseEvent): void => {
    if (relevant(event)) screen.frame({ at: new Date().toISOString(), op: event.type, with: event.payload });
  };

  const hydrate = async (): Promise<void> => {
    const [sessionResponse, messagesResponse] = await Promise.all([
      fetch(url('session.get'), { headers, signal: abort.signal }),
      fetch(url('session.messages'), { headers, signal: abort.signal }),
    ]);
    if (!sessionResponse.ok) throw new Error(`session hydration returned HTTP ${sessionResponse.status}`);
    if (!messagesResponse.ok) throw new Error(`message hydration returned HTTP ${messagesResponse.status}`);
    const session = (await sessionResponse.json()) as Record<string, unknown>;
    const messages = (await messagesResponse.json()) as unknown;
    screen.frame({ at: new Date().toISOString(), op: 'session.hydrated', with: session });
    // Presentation only: an `{info, parts}` message draws as its native
    // update frames; any other message shape draws whole.
    for (const message of Array.isArray(messages) ? (messages as Record<string, unknown>[]) : []) {
      if (message?.info === undefined || !Array.isArray(message.parts)) {
        screen.frame({ at: new Date().toISOString(), op: 'message.hydrated', with: { sessionID, message } });
        continue;
      }
      screen.frame({ at: new Date().toISOString(), op: 'message.updated', with: { sessionID, info: message.info } });
      for (const part of message.parts as Record<string, unknown>[]) {
        screen.frame({ at: new Date().toISOString(), op: 'message.part.updated', with: { sessionID, part } });
      }
    }
  };

  const stream = async (): Promise<void> => {
    while (!closing) {
      try {
        const response = await fetch(url('event.subscribe'), {
          headers: { ...headers, Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        await hydrate();
        await consumeSse(response, envelope.read, draw, abort.signal);
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
      const prompt = routeFor(document, 'session.prompt');
      void fetch(url('session.prompt'), {
        method: prompt.method,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          promptBody(attach.promptBody, {
            $text: text,
            $messageId: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
          }),
        ),
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
