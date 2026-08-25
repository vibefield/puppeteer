/** Typed REST client for the verified OpenCode 1.18.16 adapter slice. */

export interface OpenCodeModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface OpenCodeSessionModel {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  slug: string;
  version: string;
  projectID: string;
  directory: string;
  path?: string;
  title: string;
  parentID?: string;
  agent?: string;
  model?: OpenCodeSessionModel;
  permission?: unknown[];
  time: { created: number; updated: number; archived?: number; compacting?: number };
  [extra: string]: unknown;
}

export interface OpenCodeMessage {
  info: Record<string, unknown> & { id: string; sessionID: string; role: 'user' | 'assistant' };
  parts: Array<Record<string, unknown> & { id: string; messageID: string; sessionID: string; type: string }>;
}

export interface OpenCodePermissionRequest extends Record<string, unknown> {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
}

export interface OpenCodeQuestionRequest extends Record<string, unknown> {
  id: string;
  sessionID: string;
  questions: unknown[];
}

export interface OpenCodePromptBody {
  messageID: string;
  parts: Array<{ type: 'text'; text: string }>;
  agent?: string;
  model?: OpenCodeModelSelection;
}

export interface OpenCodeClientOptions {
  origin: string;
  directory: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}

export class OpenCodeHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string, message?: string) {
    super(message ?? `OpenCode HTTP request failed with status ${status}`);
    this.name = 'OpenCodeHttpError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

const MAX_ERROR_BODY = 64 * 1024;

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export class OpenCodeClient {
  readonly origin: string;
  readonly directory: string;
  readonly authorization: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenCodeClientOptions) {
    const origin = new URL(options.origin);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      throw new Error(`OpenCode origin must use HTTP(S), got ${origin.protocol}`);
    }
    this.origin = origin.origin;
    this.directory = options.directory;
    this.authorization = basicAuthorization(options.username, options.password);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  eventUrl(): string {
    return this.url('/event').href;
  }

  headers(extra?: ConstructorParameters<typeof Headers>[0]): Headers {
    const headers = new Headers(extra);
    headers.set('authorization', this.authorization);
    return headers;
  }

  private url(path: string, query?: Record<string, string | undefined>): URL {
    const url = new URL(path, this.origin);
    url.searchParams.set('directory', this.directory);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | undefined>; expected?: readonly number[] } = {},
  ): Promise<T> {
    const headers = this.headers();
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.fetchImpl(this.url(path, options.query), {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const expected = options.expected ?? [200];
    if (!expected.includes(response.status)) {
      const responseBody = (await response.text()).slice(0, MAX_ERROR_BODY);
      throw new OpenCodeHttpError(response.status, responseBody);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  createSession(
    body: {
      title?: string;
      model?: OpenCodeSessionModel;
      permission?: unknown[];
    } = {},
  ): Promise<OpenCodeSessionInfo> {
    return this.request('POST', '/session', { body });
  }

  getSession(sessionID: string): Promise<OpenCodeSessionInfo> {
    return this.request('GET', `/session/${encodeURIComponent(sessionID)}`);
  }

  listMessages(sessionID: string): Promise<OpenCodeMessage[]> {
    return this.request('GET', `/session/${encodeURIComponent(sessionID)}/message`);
  }

  listChildren(sessionID: string): Promise<OpenCodeSessionInfo[]> {
    return this.request('GET', `/session/${encodeURIComponent(sessionID)}/children`);
  }

  getStatuses(): Promise<Record<string, Record<string, unknown>>> {
    return this.request('GET', '/session/status');
  }

  listPermissions(): Promise<OpenCodePermissionRequest[]> {
    return this.request('GET', '/permission');
  }

  listQuestions(): Promise<OpenCodeQuestionRequest[]> {
    return this.request('GET', '/question');
  }

  submitPrompt(sessionID: string, body: OpenCodePromptBody): Promise<void> {
    return this.request('POST', `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      body,
      expected: [204],
    });
  }

  abort(sessionID: string): Promise<boolean> {
    return this.request('POST', `/session/${encodeURIComponent(sessionID)}/abort`);
  }

  replyPermission(requestID: string, reply: 'once' | 'always' | 'reject'): Promise<boolean> {
    return this.request('POST', `/permission/${encodeURIComponent(requestID)}/reply`, { body: { reply } });
  }

  replyQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    return this.request('POST', `/question/${encodeURIComponent(requestID)}/reply`, { body: { answers } });
  }

  rejectQuestion(requestID: string): Promise<boolean> {
    return this.request('POST', `/question/${encodeURIComponent(requestID)}/reject`);
  }

  getTrackedDiff(): Promise<unknown[]> {
    return this.request('GET', '/vcs/diff', { query: { mode: 'git' } });
  }
}
