import { writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { inheritedProcessEnvironment } from './live-pty-host.js';

export const GROK_LIVE_MODEL = 'puppeteer-grok-live';
export const GROK_LIVE_RESPONSE_MARKER = 'SURFACE_GROK_TUI_OK';

export interface GrokLiveProviderRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly body: unknown;
}

export interface GrokLoopbackProvider {
  readonly baseUrl: string;
  /** Model and model-list traffic. Origin probes are kept apart: they are not model calls. */
  readonly requests: GrokLiveProviderRequest[];
  /** Grok 1.0.70 sends a bare `GET /` to the configured provider origin right after `session/new`. */
  readonly originProbes: GrokLiveProviderRequest[];
  close(): Promise<void>;
}

export type GrokLiveModelRequestKind = 'session-title' | 'dashboard-summary' | 'turn';

export function classifyGrokLiveModelRequest(body: unknown): GrokLiveModelRequestKind {
  if (!body || typeof body !== 'object') return 'turn';
  const toolChoice = (body as { tool_choice?: unknown }).tool_choice;
  if (typeof toolChoice === 'object' && JSON.stringify(toolChoice).includes('session_title')) {
    return 'session-title';
  }
  const messages = (body as { messages?: unknown }).messages;
  if (Array.isArray(messages) && JSON.stringify(messages).includes('ultra-short dashboard line')) {
    return 'dashboard-summary';
  }
  // 1.0.70 also asks for a title with a plain, tool-less chat completion whose
  // last user message is a system reminder.
  const last = Array.isArray(messages) ? (messages.at(-1) as { role?: unknown; content?: unknown }) : undefined;
  if (last?.role === 'user' && JSON.stringify(last.content ?? '').includes('Generate a session title')) {
    return 'session-title';
  }
  return 'turn';
}

/** A prompt containing this word gets one mutating shell tool call, then the reply marker. */
export const GROK_LIVE_TOOL_TRIGGER = 'SURFACE_GROK_TOOL';
export const GROK_LIVE_TOOL_FILE = 'grok-live-tool.txt';
// A redirect makes the command mutating: Grok 1.0.70 runs a command it classes
// safe (a bare echo) without asking for permission at all.
export const GROK_LIVE_TOOL_COMMAND = `echo ${GROK_LIVE_TOOL_TRIGGER}_OK > ${GROK_LIVE_TOOL_FILE}`;

interface ChatTool {
  name?: string;
  function?: { name?: string; parameters?: ToolParameters };
  parameters?: ToolParameters;
}
interface ToolParameters {
  required?: string[];
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
}

function chatMessages(body: unknown): { role?: string; content?: unknown }[] {
  const messages = body && typeof body === 'object' ? (body as { messages?: unknown }).messages : undefined;
  return Array.isArray(messages) ? (messages as { role?: string; content?: unknown }[]) : [];
}

/** The shell tool call the model "chooses", with every required argument filled. */
function shellToolCall(body: unknown): { name: string; arguments: string } | undefined {
  const tools = body && typeof body === 'object' ? (body as { tools?: unknown }).tools : undefined;
  const shell = (Array.isArray(tools) ? (tools as ChatTool[]) : []).find(
    (tool) => (tool.function?.name ?? tool.name) === 'run_terminal_command',
  );
  if (!shell) return undefined;
  const parameters = shell.function?.parameters ?? shell.parameters ?? {};
  const args: Record<string, unknown> = {};
  for (const key of parameters.required ?? []) {
    const property = parameters.properties?.[key] ?? {};
    if (/command|cmd/iu.test(key)) args[key] = GROK_LIVE_TOOL_COMMAND;
    else if (Array.isArray(property.enum) && property.enum.length > 0) args[key] = property.enum[0];
    else if (property.type === 'boolean') args[key] = false;
    else if (property.type === 'integer' || property.type === 'number') args[key] = 10_000;
    else if (property.type === 'array') args[key] = [];
    else args[key] = 'puppeteer live proof';
  }
  return { name: 'run_terminal_command', arguments: JSON.stringify(args) };
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id: 'chatcmpl-puppeteer-grok-live',
    object: 'chat.completion.chunk',
    created: 1_788_019_200,
    model: GROK_LIVE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const CHAT_USAGE_CHUNK = {
  id: 'chatcmpl-puppeteer-grok-live',
  object: 'chat.completion.chunk',
  created: 1_788_019_200,
  model: GROK_LIVE_MODEL,
  choices: [],
  usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
};

function writeChatCompletion(response: ServerResponse, body: unknown): void {
  const kind = classifyGrokLiveModelRequest(body);
  const messages = chatMessages(body);
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const toolCall =
    kind === 'turn' &&
    messages.at(-1)?.role !== 'tool' &&
    JSON.stringify(lastUser?.content ?? '').includes(GROK_LIVE_TOOL_TRIGGER)
      ? shellToolCall(body)
      : undefined;
  if (toolCall) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    const split = Math.ceil(toolCall.arguments.length / 2);
    for (const chunk of [
      chatChunk({ role: 'assistant', content: null }, null),
      chatChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_puppeteer_live_1',
              type: 'function',
              function: { name: toolCall.name, arguments: '' },
            },
          ],
        },
        null,
      ),
      chatChunk({ tool_calls: [{ index: 0, function: { arguments: toolCall.arguments.slice(0, split) } }] }, null),
      chatChunk({ tool_calls: [{ index: 0, function: { arguments: toolCall.arguments.slice(split) } }] }, null),
      chatChunk({}, 'tool_calls'),
      CHAT_USAGE_CHUNK,
    ]) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.end('data: [DONE]\n\n');
    return;
  }
  const text =
    kind === 'session-title'
      ? 'Pinned Grok native TUI proof'
      : kind === 'dashboard-summary'
        ? 'Pinned Grok native TUI proof complete'
        : GROK_LIVE_RESPONSE_MARKER;
  const midpoint = Math.ceil(text.length / 2);
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  for (const chunk of [
    chatChunk({ role: 'assistant', content: '' }, null),
    chatChunk({ content: text.slice(0, midpoint) }, null),
    chatChunk({ content: text.slice(midpoint) }, null),
    chatChunk({}, 'stop'),
    CHAT_USAGE_CHUNK,
  ]) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}

function writeTitleResponse(response: ServerResponse): void {
  const text = 'Pinned Grok native TUI proof';
  const item = {
    type: 'message',
    id: 'msg-puppeteer-grok-title',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], text }],
  };
  const completed = {
    id: 'resp-puppeteer-grok-title',
    object: 'response',
    status: 'completed',
    created_at: 1_788_019_200,
    model: 'grok-4.5',
    output: [item],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 26,
    },
  };
  const started = { ...completed, status: 'in_progress', output: [], usage: null };
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  // Grok 1.0.70 refuses a Responses stream event without `sequence_number`
  // (retrying the request and falling back to prompt text for the title).
  let sequence = 0;
  const sendEvent = (name: string, value: Record<string, unknown>): void => {
    response.write(`event: ${name}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`);
  };
  sendEvent('response.created', { type: 'response.created', response: started });
  sendEvent('response.in_progress', { type: 'response.in_progress', response: started });
  sendEvent('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  sendEvent('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', annotations: [], text: '' },
  });
  sendEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  sendEvent('response.output_text.done', {
    type: 'response.output_text.done',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text,
  });
  sendEvent('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item,
  });
  sendEvent('response.completed', { type: 'response.completed', response: completed });
  response.end();
}

export async function startGrokLoopbackProvider(): Promise<GrokLoopbackProvider> {
  const requests: GrokLiveProviderRequest[] = [];
  const originProbes: GrokLiveProviderRequest[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // Preserve malformed input for the final assertion.
      }
      if (request.method === 'GET' && (request.url === '/' || request.url === '')) {
        originProbes.push({ method: request.method, url: request.url, body });
        response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
        response.end('ok');
        return;
      }
      requests.push({ method: request.method, url: request.url, body });
      if (request.method === 'POST' && request.url?.startsWith('/v1/chat/completions')) {
        writeChatCompletion(response, body);
        return;
      }
      if (request.method === 'POST' && request.url?.startsWith('/v1/responses')) {
        writeTitleResponse(response);
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: GROK_LIVE_MODEL, object: 'model', created: 0, owned_by: 'puppeteer' }],
          }),
        );
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: { message: `unhandled live-test route ${request.url ?? ''}` } }));
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback provider did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    originProbes,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function writeGrokLiveConfiguration(grokHome: string, baseUrl: string): void {
  writeFileSync(
    join(grokHome, 'config.toml'),
    `[cli]\n` +
      `auto_update = false\n\n` +
      `[features]\n` +
      `telemetry = false\n` +
      `feedback = false\n` +
      `codebase_indexing = false\n` +
      `remote_fetch = false\n\n` +
      `[memory]\n` +
      `enabled = false\n\n` +
      `[workflows]\n` +
      `enabled = false\n\n` +
      `[subagents]\n` +
      `enabled = false\n\n` +
      `[models]\n` +
      `default = "${GROK_LIVE_MODEL}"\n\n` +
      `[model.${GROK_LIVE_MODEL}]\n` +
      `model = "${GROK_LIVE_MODEL}"\n` +
      `base_url = "${baseUrl}"\n` +
      `name = "Puppeteer Loopback"\n` +
      `env_key = "XAI_API_KEY"\n` +
      `api_backend = "chat_completions"\n` +
      `context_window = 128000\n`,
    'utf8',
  );
}

export function isolatedGrokLiveEnvironment(root: string, grokHome: string, baseUrl: string): Record<string, string> {
  return {
    ...inheritedProcessEnvironment(),
    HOME: root,
    USERPROFILE: root,
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    GROK_HOME: grokHome,
    XAI_API_KEY: 'xai-not-a-real-key',
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_TELEMETRY_ENABLED: '0',
    GROK_MEMORY: '0',
    GROK_WORKFLOWS: '0',
    GROK_SUBAGENTS: '0',
    GROK_FEEDBACK_ENABLED: '0',
    GROK_WEB_FETCH: '0',
    GROK_MODELS_BASE_URL: baseUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}
