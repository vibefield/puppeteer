/**
 * Stateful REST-session server behind an HTTP/SSE persona.
 *
 * Native paths and operation ids remain in `http-serve.json`; this module only
 * implements the small action vocabulary declared by `HttpServeRoute`. Every
 * inbound request, successful response, SSE payload, and SSE carrier crosses
 * the persona's capture-derived ASM validator.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Persona } from '../persona/types.ts';
import {
  createSseHub,
  HttpSseError,
  listenHttpSse,
  type HttpSseHandlerResult,
  type HttpSseRequest,
  type HttpSseServer,
  type SseRecord,
} from './channels/http-sse.ts';
import { createImposterSession, type BehaviorDocument, type ImposterSession } from './session.ts';

interface StoredMessage {
  info: Record<string, unknown>;
  parts: Record<string, unknown>[];
}

interface StoredSession {
  info: Record<string, unknown>;
  status: Record<string, unknown>;
  messages: StoredMessage[];
  permissions: Record<string, unknown>[];
  questions: Record<string, unknown>[];
  diff: Record<string, unknown>[];
}

interface StoredDocument {
  version: 1;
  sessions: StoredSession[];
}

interface PendingBlocker {
  sessionID: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface HttpPersonaServerOptions {
  persona: Persona;
  behavior: BehaviorDocument;
  hostname: string;
  port: number;
  env: Record<string, string | undefined>;
  cwd: string;
  username: string;
  password?: string | undefined;
  /** Defaults below PUPPETEER_IMPOSTER_HOME, or an owned temporary root. */
  storePath?: string | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface HttpPersonaServer extends HttpSseServer {
  /** Publish a raw native event through the same ASM/SSE/store boundary. */
  emit(sessionID: string, event: string, properties: Record<string, unknown>): Promise<void>;
  readonly sessionIDs: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function recordBody(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpSseError(400, `${label} must be a JSON object`);
  return value;
}

function nativeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

function sessionIDOf(record: SseRecord): string | undefined {
  const direct = record.properties.sessionID;
  if (typeof direct === 'string') return direct;
  const info = record.properties.info;
  return isRecord(info) && typeof info.id === 'string' ? info.id : undefined;
}

function messageID(message: StoredMessage): string | undefined {
  return typeof message.info.id === 'string' ? message.info.id : undefined;
}

function loadStored(path: string): StoredDocument {
  if (!existsSync(path)) return { version: 1, sessions: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      throw new Error('expected {version:1,sessions:[]}');
    }
    const sessions = parsed.sessions.filter((entry): entry is StoredSession => {
      if (!isRecord(entry) || !isRecord(entry.info) || typeof entry.info.id !== 'string') return false;
      return (
        isRecord(entry.status) &&
        Array.isArray(entry.messages) &&
        Array.isArray(entry.permissions) &&
        Array.isArray(entry.questions) &&
        Array.isArray(entry.diff)
      );
    });
    return { version: 1, sessions };
  } catch (error) {
    throw new Error(`imposter cannot restore HTTP session store ${path}: ${(error as Error).message}`);
  }
}

function writeStored(path: string, sessions: Iterable<StoredSession>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.next`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions: [...sessions] } satisfies StoredDocument)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export async function createHttpPersonaServer(options: HttpPersonaServerOptions): Promise<HttpPersonaServer> {
  const { persona } = options;
  const document = persona.httpServe;
  if (!document) throw new Error(`persona ${persona.vendor} has no HTTP serve document`);
  const log = options.log ?? (() => {});
  const ownedRoot = options.storePath === undefined && options.env.PUPPETEER_IMPOSTER_HOME === undefined;
  const root = options.env.PUPPETEER_IMPOSTER_HOME ?? mkdtempSync(join(tmpdir(), `puppeteer-${persona.vendor}-http-`));
  const storePath = options.storePath ?? join(root, 'http-session-store.json');
  const restored = loadStored(storePath);
  const sessions = new Map<string, StoredSession>();
  for (const session of restored.sessions) sessions.set(String(session.info.id), session);
  const runtimes = new Map<string, ImposterSession>();
  const pending = new Map<string, PendingBlocker>();
  let closing = false;

  const persist = (): void => writeStored(storePath, sessions.values());

  const apply = (record: SseRecord): void => {
    const sessionID = sessionIDOf(record);
    if (!sessionID) return;
    let stored = sessions.get(sessionID);
    if (record.type === 'session.deleted') {
      sessions.delete(sessionID);
      persist();
      return;
    }
    if (!stored) return;

    const properties = record.properties;
    if ((record.type === 'session.created' || record.type === 'session.updated') && isRecord(properties.info)) {
      stored.info = { ...stored.info, ...cloneRecord(properties.info) };
    } else if (record.type === 'session.status' && isRecord(properties.status)) {
      stored.status = cloneRecord(properties.status);
    } else if (record.type === 'session.idle') {
      stored.status = { type: 'idle' };
    } else if (record.type === 'message.updated' && isRecord(properties.info)) {
      const id = properties.info.id;
      if (typeof id === 'string') {
        const found = stored.messages.find((message) => messageID(message) === id);
        if (found) found.info = { ...found.info, ...cloneRecord(properties.info) };
        else stored.messages.push({ info: cloneRecord(properties.info), parts: [] });
      }
    } else if (record.type === 'message.part.updated' && isRecord(properties.part)) {
      const part = properties.part;
      const owner = typeof part.messageID === 'string' ? part.messageID : undefined;
      const id = typeof part.id === 'string' ? part.id : undefined;
      const message = stored.messages.find((entry) => messageID(entry) === owner);
      if (message && id) {
        const index = message.parts.findIndex((entry) => entry.id === id);
        if (index >= 0) message.parts[index] = { ...message.parts[index], ...cloneRecord(part) };
        else message.parts.push(cloneRecord(part));
      }
    } else if (record.type === 'permission.asked') {
      stored.permissions = [
        ...stored.permissions.filter((entry) => entry.id !== properties.id),
        cloneRecord(properties),
      ];
    } else if (record.type === 'permission.replied') {
      stored.permissions = stored.permissions.filter((entry) => entry.id !== properties.requestID);
    } else if (record.type === 'question.asked') {
      stored.questions = [...stored.questions.filter((entry) => entry.id !== properties.id), cloneRecord(properties)];
    } else if (record.type === 'question.replied' || record.type === 'question.rejected') {
      stored.questions = stored.questions.filter((entry) => entry.id !== properties.requestID);
    }
    persist();
  };

  const connectedRecord = (): SseRecord => ({
    id: nativeId('evt'),
    type: 'server.connected',
    properties: {},
  });
  const hub = createSseHub({
    connected: connectedRecord,
    validate: (record) => persona.validateRecord(record.type, record, persona.channelFor('sse')),
  });

  const directoryFor = (sessionID: string): string | undefined => {
    const directory = sessions.get(sessionID)?.info.directory;
    return typeof directory === 'string' ? directory : undefined;
  };

  const publish = (record: SseRecord, sessionID: string): void => {
    // Resolve scope before applying a deletion: the durable entity is gone
    // afterwards, but its final event must not leak onto another directory's
    // stream merely because the lookup no longer has an answer.
    const directory = directoryFor(sessionID);
    apply(record);
    hub.publish(record, directory);
  };

  const configureRuntime = (runtime: ImposterSession, stored: StoredSession): void => {
    const info = stored.info;
    runtime.bindings.$sessionTitle = info.title;
    runtime.bindings.$sessionSlug = info.slug;
    runtime.bindings.$projectId = info.projectID;
    runtime.bindings.$sessionModel = info.model ?? { id: `${persona.vendor}-imposter`, providerID: 'imposter' };
    runtime.bindings.$sessionPermission = info.permission ?? [];
    if (isRecord(info.time)) {
      runtime.bindings.$sessionCreatedAt = info.time.created;
      runtime.bindings.$sessionUpdatedAt = info.time.updated;
    }
  };

  const runtimeFor = (sessionID: string): ImposterSession => {
    const existing = runtimes.get(sessionID);
    if (existing) return existing;
    const stored = sessions.get(sessionID);
    if (!stored) throw new HttpSseError(404, `session ${sessionID} was not found`);
    const directory = typeof stored.info.directory === 'string' ? stored.info.directory : options.cwd;
    const title = typeof stored.info.title === 'string' ? stored.info.title : 'imposter-session';
    const model =
      isRecord(stored.info.model) && typeof stored.info.model.id === 'string' ? stored.info.model.id : undefined;
    const runtime = createImposterSession({
      persona,
      argv: ['--session-id', sessionID, '--name', title, ...(model ? ['--model', model] : [])],
      env: { ...options.env, PUPPETEER_IMPOSTER_HOME: root },
      cwd: directory,
      behavior: options.behavior,
      sse: {
        publish: (record) => publish(record, sessionID),
        request: (record) => {
          const requestID = record.properties.id;
          if (typeof requestID !== 'string' || requestID.length === 0) {
            return Promise.reject(new Error(`${record.type} blocker has no id`));
          }
          if (pending.has(requestID)) return Promise.reject(new Error(`blocker ${requestID} is already pending`));
          return new Promise<unknown>((resolve, reject) => {
            pending.set(requestID, { sessionID, resolve, reject });
            publish(record, sessionID);
          });
        },
      },
      log,
    });
    configureRuntime(runtime, stored);
    runtimes.set(sessionID, runtime);
    return runtime;
  };

  const emit = async (sessionID: string, event: string, properties: Record<string, unknown>): Promise<void> => {
    await runtimeFor(sessionID).emit(event, properties, persona.channelFor('sse'));
  };

  const findBlocker = (
    kind: 'permission' | 'question',
    requestID: string,
  ): { sessionID: string; blocker: Record<string, unknown> } => {
    for (const [sessionID, stored] of sessions) {
      const blockers = kind === 'permission' ? stored.permissions : stored.questions;
      const blocker = blockers.find((entry) => entry.id === requestID);
      if (blocker) return { sessionID, blocker };
    }
    throw new HttpSseError(404, `${kind} request ${requestID} was not found`);
  };

  const requestRecord = (request: HttpSseRequest): Record<string, unknown> => ({
    method: request.route.method,
    route: request.route.path,
    ...(Object.keys(request.params).length === 0 ? {} : { params: request.params }),
    ...(Object.keys(request.query).length === 0 ? {} : { query: request.query }),
    ...(request.body === undefined ? {} : { body: request.body }),
  });

  const checkedRequest = (request: HttpSseRequest): void => {
    const violations = persona.validate(request.route.event, requestRecord(request));
    if (violations.length > 0) {
      throw new HttpSseError(400, `off-model ${request.route.event} request: ${violations.join('; ')}`);
    }
  };

  const result = (
    request: HttpSseRequest,
    status: number,
    body?: unknown,
  ): Exclude<HttpSseHandlerResult, { stream: true }> => {
    const carrier: Record<string, unknown> = {
      method: request.route.method,
      route: request.route.path,
      status,
      ...(Object.keys(request.params).length === 0 ? {} : { params: request.params }),
      ...(Object.keys(request.query).length === 0 ? {} : { query: request.query }),
      ...(body === undefined ? {} : { body }),
    };
    const violations = persona.validateResult(request.route.event, carrier);
    if (violations.length > 0) {
      throw new Error(`off-model ${request.route.event} response: ${violations.join('; ')}`);
    }
    return { status, ...(body === undefined ? {} : { body }) };
  };

  const newInfo = (body: Record<string, unknown>, directory: string): Record<string, unknown> => {
    const now = Date.now();
    const id = nativeId('ses');
    return {
      id,
      slug: nativeId('imposter'),
      version: persona.version,
      projectID: typeof body.workspaceID === 'string' ? body.workspaceID : 'imposter-project',
      directory,
      path: directory,
      title: typeof body.title === 'string' ? body.title : 'New session',
      ...(isRecord(body.model) ? { model: cloneRecord(body.model) } : {}),
      ...(Array.isArray(body.permission) ? { permission: cloneRecord(body.permission) } : {}),
      ...(typeof body.parentID === 'string' ? { parentID: body.parentID } : {}),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
    };
  };

  const storedFor = (sessionID: string): StoredSession => {
    const stored = sessions.get(sessionID);
    if (!stored) throw new HttpSseError(404, `session ${sessionID} was not found`);
    return stored;
  };

  const scoped = (request: HttpSseRequest): StoredSession[] =>
    [...sessions.values()].filter(
      (stored) => request.directory === undefined || stored.info.directory === request.directory,
    );

  const cloneMessagesForFork = (source: StoredSession, throughMessageID?: string): StoredMessage[] => {
    const stop = throughMessageID
      ? source.messages.findIndex((message) => messageID(message) === throughMessageID)
      : source.messages.length;
    const selected = source.messages.slice(0, stop < 0 ? source.messages.length : stop);
    const ids = new Map<string, string>();
    for (const message of selected) {
      const old = messageID(message);
      if (old) ids.set(old, nativeId('msg'));
    }
    return selected.map((message) => {
      const old = messageID(message)!;
      const id = ids.get(old)!;
      const info = cloneRecord(message.info);
      info.id = id;
      if (typeof info.parentID === 'string' && ids.has(info.parentID)) info.parentID = ids.get(info.parentID)!;
      return {
        info,
        parts: message.parts.map((part) => ({ ...cloneRecord(part), id: nativeId('prt'), messageID: id })),
      };
    });
  };

  const handle = async (request: HttpSseRequest): Promise<HttpSseHandlerResult> => {
    checkedRequest(request);
    const action = request.route.action;
    if (action === 'event.subscribe') {
      result(request, 200);
      return { stream: true, ...(request.directory === undefined ? {} : { directory: request.directory }) };
    }
    if (action === 'session.create') {
      const body = request.body === undefined ? {} : recordBody(request.body, 'session create body');
      const info = newInfo(body, request.directory ?? options.cwd);
      const sessionID = String(info.id);
      const stored: StoredSession = {
        info,
        status: { type: 'idle' },
        messages: [],
        permissions: [],
        questions: [],
        diff: [],
      };
      sessions.set(sessionID, stored);
      persist();
      const runtime = runtimeFor(sessionID);
      await runtime.boot();
      return result(request, 200, stored.info);
    }
    if (action === 'session.list') {
      const listed = scoped(request)
        .map((stored) => stored.info)
        .sort(
          (left, right) =>
            Number((right.time as Record<string, unknown>)?.updated ?? 0) -
            Number((left.time as Record<string, unknown>)?.updated ?? 0),
        );
      return result(request, 200, listed);
    }
    if (action === 'session.status') {
      return result(
        request,
        200,
        Object.fromEntries(scoped(request).map((stored) => [String(stored.info.id), stored.status])),
      );
    }
    if (action === 'session.get') return result(request, 200, storedFor(request.params.sessionID!).info);
    if (action === 'session.messages') return result(request, 200, storedFor(request.params.sessionID!).messages);
    if (action === 'session.children') {
      return result(
        request,
        200,
        [...sessions.values()]
          .filter((stored) => stored.info.parentID === request.params.sessionID)
          .map((stored) => stored.info),
      );
    }
    if (action === 'session.diff') return result(request, 200, storedFor(request.params.sessionID!).diff);
    if (action === 'vcs.diff') return result(request, 200, []);
    if (action === 'session.prompt') {
      const stored = storedFor(request.params.sessionID!);
      const body = recordBody(request.body, 'prompt body');
      if (!Array.isArray(body.parts)) throw new HttpSseError(400, 'prompt body.parts must be an array');
      const text = body.parts
        .filter(isRecord)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => String(part.text))
        .join('\n');
      const runtime = runtimeFor(String(stored.info.id));
      runtime.bindings.$userMessageId = typeof body.messageID === 'string' ? body.messageID : nativeId('msg');
      runtime.bindings.$promptCreatedAt = Date.now();
      runtime.bindings.$promptAgent = typeof body.agent === 'string' ? body.agent : 'build';
      if (isRecord(body.model)) {
        runtime.bindings.$promptModel = cloneRecord(body.model);
        if (typeof body.model.modelID === 'string') runtime.bindings.$modelId = body.model.modelID;
      }
      void runtime.turn(text).catch(async (error: unknown) => {
        if (closing) return;
        const message = error instanceof Error ? error.message : String(error);
        log(`turn failed for ${String(stored.info.id)}: ${message}`);
        await runtime
          .emit('session.error', {
            sessionID: stored.info.id,
            error: { name: 'UnknownError', data: { message } },
          })
          .catch((emitError: unknown) => log(`could not emit session.error: ${String(emitError)}`));
      });
      return result(request, 204);
    }
    if (action === 'session.abort') {
      const stored = storedFor(request.params.sessionID!);
      for (const [id, blocker] of pending) {
        if (blocker.sessionID !== stored.info.id) continue;
        pending.delete(id);
        blocker.reject(new Error('session aborted'));
      }
      await emit(String(stored.info.id), 'session.status', { sessionID: stored.info.id, status: { type: 'idle' } });
      await emit(String(stored.info.id), 'session.idle', { sessionID: stored.info.id });
      return result(request, 200, true);
    }
    if (action === 'session.update') {
      const stored = storedFor(request.params.sessionID!);
      const body = request.body === undefined ? {} : recordBody(request.body, 'session update body');
      const next = { ...stored.info, ...cloneRecord(body) };
      if (isRecord(stored.info.time) && isRecord(body.time)) next.time = { ...stored.info.time, ...body.time };
      await emit(String(stored.info.id), 'session.updated', { sessionID: stored.info.id, info: next });
      return result(request, 200, stored.info);
    }
    if (action === 'session.fork') {
      const source = storedFor(request.params.sessionID!);
      const body = request.body === undefined ? {} : recordBody(request.body, 'session fork body');
      const info = newInfo(
        { ...source.info, title: `${String(source.info.title)} (fork)` },
        String(source.info.directory),
      );
      delete info.parentID;
      const fork: StoredSession = {
        info,
        status: { type: 'idle' },
        messages: cloneMessagesForFork(source, typeof body.messageID === 'string' ? body.messageID : undefined),
        permissions: [],
        questions: [],
        diff: cloneRecord(source.diff),
      };
      const forkID = String(info.id);
      for (const message of fork.messages) {
        message.info.sessionID = forkID;
        for (const part of message.parts) part.sessionID = forkID;
      }
      sessions.set(forkID, fork);
      persist();
      await runtimeFor(forkID).boot();
      return result(request, 200, fork.info);
    }
    if (action === 'session.delete') {
      const sessionID = request.params.sessionID!;
      const stored = storedFor(sessionID);
      await emit(sessionID, 'session.deleted', { sessionID, info: stored.info });
      runtimes.delete(sessionID);
      return result(request, 200, true);
    }
    if (action === 'permission.list') {
      return result(
        request,
        200,
        scoped(request).flatMap((stored) => stored.permissions),
      );
    }
    if (action === 'question.list') {
      return result(
        request,
        200,
        scoped(request).flatMap((stored) => stored.questions),
      );
    }
    if (action === 'permission.reply') {
      const requestID = request.params.requestID!;
      const { sessionID } = findBlocker('permission', requestID);
      const body = recordBody(request.body, 'permission reply body');
      if (typeof body.reply !== 'string') throw new HttpSseError(400, 'permission reply body.reply must be a string');
      await emit(sessionID, 'permission.replied', { sessionID, requestID, reply: body.reply });
      const blocker = pending.get(requestID);
      pending.delete(requestID);
      blocker?.resolve({ reply: body.reply });
      return result(request, 200, true);
    }
    if (action === 'question.reply') {
      const requestID = request.params.requestID!;
      const { sessionID } = findBlocker('question', requestID);
      const body = recordBody(request.body, 'question reply body');
      if (!Array.isArray(body.answers)) throw new HttpSseError(400, 'question reply body.answers must be an array');
      await emit(sessionID, 'question.replied', { sessionID, requestID, answers: body.answers });
      const blocker = pending.get(requestID);
      pending.delete(requestID);
      blocker?.resolve({ answers: body.answers });
      return result(request, 200, true);
    }
    if (action === 'question.reject') {
      const requestID = request.params.requestID!;
      const { sessionID } = findBlocker('question', requestID);
      await emit(sessionID, 'question.rejected', { sessionID, requestID });
      const blocker = pending.get(requestID);
      pending.delete(requestID);
      blocker?.resolve({ rejected: true });
      return result(request, 200, true);
    }
    throw new Error(`unhandled HTTP serve action ${String(action)}`);
  };

  const server = await listenHttpSse({
    document,
    hostname: options.hostname,
    port: options.port,
    username: options.username,
    ...(options.password === undefined ? {} : { password: options.password }),
    hub,
    handle,
    log,
  });

  return {
    ...server,
    emit,
    get sessionIDs() {
      return [...sessions.keys()];
    },
    async close() {
      closing = true;
      for (const blocker of pending.values()) blocker.reject(new Error('HTTP persona server closed'));
      pending.clear();
      await Promise.all([...runtimes.values()].map((runtime) => runtime.end().catch(() => undefined)));
      await server.close();
      if (ownedRoot) rmSync(root, { recursive: true, force: true });
    },
  };
}
