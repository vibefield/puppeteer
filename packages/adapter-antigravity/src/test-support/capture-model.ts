import { createServer } from 'node:http';

/**
 * Loopback Gemini provider for the native-TUI evidence capture (`tui-capture.live.test.ts`) only.
 *
 * The attested live proof keeps its own text-only provider (`live-model.ts`); this one can also answer one
 * prompt with a 1.4.12-schema `run_command` call, so the native TUI runs a real command and journals its
 * result. Prompts steer it with markers, never with the model's own words:
 *
 * - `[capture-reply:NAME]` is answered with the text `CAPTURE_REPLY_NAME_OK`;
 * - `[capture-run-command]` is answered with one `run_command` call, then the tool result with
 *   `CAPTURE_REPLY_TOOL_OK`.
 *
 * The reply tokens never occur in a prompt, so finding one in the journal proves the model's reply was written.
 */

export const ANTIGRAVITY_CAPTURE_TOOL_MARKER = '[capture-run-command]';
export const ANTIGRAVITY_CAPTURE_TOOL_REPLY = 'CAPTURE_REPLY_TOOL_OK';
export const ANTIGRAVITY_CAPTURE_DEFAULT_REPLY = 'CAPTURE_REPLY_OK';
export const ANTIGRAVITY_CAPTURE_TOOL_PROMPT = `Run the capture command now. ${ANTIGRAVITY_CAPTURE_TOOL_MARKER}`;

export type AntigravityCaptureToolVariant = 'success' | 'failure';

/**
 * The commands the call asks for. Both run in a child `sh`, so the failing `exit 3` ends that child and never a
 * shell the agent keeps between commands. macOS only: the capture refuses every other platform.
 */
export const ANTIGRAVITY_CAPTURE_COMMANDS: Readonly<Record<AntigravityCaptureToolVariant, string>> = {
  success: "sh -c 'echo puppeteer-capture-ok'",
  failure: "sh -c 'echo puppeteer-capture-failed; exit 3'",
};

export function antigravityCaptureReplyPrompt(name: string): string {
  return `Reply with the capture token. [capture-reply:${name}]`;
}

export function antigravityCaptureReplyToken(name: string): string {
  return `CAPTURE_REPLY_${name}_OK`;
}

/** What the provider saw and answered, kept for the capture manifest. Never the request bodies themselves. */
export interface AntigravityCaptureRequestRecord {
  index: number;
  route: string;
  streamed: boolean;
  toolNames: string[];
  runCommandDeclared: boolean;
  answer: 'text' | 'function-call' | 'count-tokens' | 'models' | 'not-found';
  replyText?: string | undefined;
  functionCall?: { name: string; args: Record<string, unknown> } | undefined;
  /** The functionResponse parts of the request's latest content: what the binary reports back from the command. */
  functionResponses?: unknown[] | undefined;
}

export interface AntigravityCaptureProvider {
  readonly baseUrl: string;
  readonly records: AntigravityCaptureRequestRecord[];
  /** The `run_command` declaration as the binary sent it, from the first request that declared it. */
  runCommandDeclaration(): unknown;
  functionCallsIssued(): number;
  functionResponsesSeen(): number;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

type CaptureCue =
  | { kind: 'function-response'; responses: unknown[] }
  | { kind: 'tool' }
  | { kind: 'reply'; name: string };

const COMMAND_KEYS = new Set(['commandline', 'command', 'cmd']);

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parts(content: unknown): Json[] {
  if (!isObject(content)) return [];
  const value = content.parts ?? content.Parts;
  if (Array.isArray(value)) return value.filter(isObject);
  return isObject(value) ? [value] : [];
}

function contents(request: Json): Json[] {
  const value = request.contents;
  if (Array.isArray(value)) return value.filter(isObject);
  return isObject(value) ? [value] : [];
}

function declarations(request: Json): Json[] {
  const tools = Array.isArray(request.tools) ? request.tools.filter(isObject) : [];
  return tools.flatMap((tool) => {
    const declared = tool.functionDeclarations ?? tool.function_declarations;
    if (Array.isArray(declared)) return declared.filter(isObject);
    return isObject(declared) ? [declared] : [];
  });
}

function names(entries: Json[]): string[] {
  return entries.flatMap((entry) => (typeof entry.name === 'string' ? [entry.name] : []));
}

function texts(entries: Json[]): string[] {
  return entries.flatMap((part) => (typeof part.text === 'string' ? [part.text] : []));
}

function functionResponseOf(part: Json): unknown {
  return part.functionResponse ?? part.function_response;
}

/**
 * Arguments that satisfy the declared `run_command` schema. 1.4.12 declares `CommandLine`, `toolSummary` and
 * `WaitMsBeforeAsync` as required with no additional properties, and records a call that misses them as INVALID
 * (Rosetta's mock fix 4282c442). Every required key is filled by its declared type, as Rosetta's mock fills it.
 */
export function antigravityRunCommandArguments(
  declaration: Json,
  command: string,
): Record<string, unknown> | undefined {
  const schema = declaration.parametersJsonSchema ?? declaration.parameters;
  if (!isObject(schema) || !isObject(schema.properties)) return undefined;
  const properties = schema.properties;
  const commandKey = Object.keys(properties).find((key) => COMMAND_KEYS.has(key.toLowerCase()));
  if (!commandKey) return undefined;
  const values: Record<string, unknown> = { [commandKey]: command };
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== 'string' || key in values) continue;
    const property = properties[key];
    if (!isObject(property)) continue;
    const kind = String(property.type ?? '').toLowerCase();
    if (kind === 'integer' || kind === 'number') values[key] = key.toLowerCase().includes('ms') ? 5000 : 1;
    else if (kind === 'boolean') values[key] = false;
    else values[key] = 'Capture command check';
  }
  return values;
}

/** The latest content that carries a capture marker or a tool result decides the answer. */
function latestCue(request: Json): CaptureCue | undefined {
  const all = contents(request);
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const entries = parts(all[index]);
    const responses = entries.map(functionResponseOf).filter((value) => value !== undefined);
    if (responses.length > 0) return { kind: 'function-response', responses };
    let reply: string | undefined;
    for (const text of texts(entries)) {
      if (text.includes(ANTIGRAVITY_CAPTURE_TOOL_MARKER)) return { kind: 'tool' };
      const matches = [...text.matchAll(/\[capture-reply:([A-Z0-9]+)\]/g)];
      reply = matches.at(-1)?.[1] ?? reply;
    }
    if (reply) return { kind: 'reply', name: reply };
  }
  return undefined;
}

function generated(part: Json) {
  return {
    candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 27, candidatesTokenCount: 7, totalTokenCount: 34 },
    modelVersion: 'gemini-3.1-pro',
  };
}

/**
 * Start the capture provider. `tool` selects the command a `[capture-run-command]` prompt runs; at most one call is
 * issued per provider, so a request that repeats the marker after the result can never loop the agent.
 */
export async function startAntigravityCaptureProvider(
  options: { tool?: AntigravityCaptureToolVariant | undefined } = {},
): Promise<AntigravityCaptureProvider> {
  const records: AntigravityCaptureRequestRecord[] = [];
  let declaration: Json | undefined;
  let callsIssued = 0;
  let responsesSeen = 0;
  const answer = (record: AntigravityCaptureRequestRecord, request: Json): unknown => {
    const declared = declarations(request);
    record.toolNames = names(declared);
    const runCommand = declared.find((entry) => entry.name === 'run_command');
    record.runCommandDeclared = runCommand !== undefined;
    declaration ??= runCommand;
    const cue = latestCue(request);
    if (cue?.kind === 'function-response') {
      responsesSeen += 1;
      record.functionResponses = cue.responses;
      record.answer = 'text';
      record.replyText = ANTIGRAVITY_CAPTURE_TOOL_REPLY;
      return generated({ text: ANTIGRAVITY_CAPTURE_TOOL_REPLY });
    }
    if (cue?.kind === 'tool' && options.tool && runCommand && callsIssued === 0) {
      const args = antigravityRunCommandArguments(runCommand, ANTIGRAVITY_CAPTURE_COMMANDS[options.tool]);
      if (args) {
        callsIssued += 1;
        record.answer = 'function-call';
        record.functionCall = { name: 'run_command', args };
        return generated({ functionCall: { name: 'run_command', args } });
      }
    }
    const text = cue?.kind === 'reply' ? antigravityCaptureReplyToken(cue.name) : ANTIGRAVITY_CAPTURE_DEFAULT_REPLY;
    record.answer = 'text';
    record.replyText = text;
    return generated({ text });
  };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    // The query can carry the (dummy) API key; only the route is kept.
    const route = (request.url ?? '').split('?')[0] ?? '';
    const record: AntigravityCaptureRequestRecord = {
      index: records.length,
      route,
      streamed: route.includes(':streamGenerateContent'),
      toolNames: [],
      runCommandDeclared: false,
      answer: 'not-found',
    };
    records.push(record);
    response.setHeader('content-type', 'application/json');
    if (route.includes(':countTokens')) {
      record.answer = 'count-tokens';
      response.end(JSON.stringify({ totalTokens: 27 }));
    } else if (route.includes(':generateContent') || route.includes(':streamGenerateContent')) {
      let parsed: Json = {};
      try {
        const value: unknown = JSON.parse(body);
        if (isObject(value)) parsed = value;
      } catch {
        // An unparseable body is answered as an ordinary turn and recorded with no tools.
      }
      const value = answer(record, parsed);
      response.setHeader('content-type', record.streamed ? 'text/event-stream' : 'application/json');
      response.end(record.streamed ? `data: ${JSON.stringify(value)}\n\n` : JSON.stringify(value));
    } else if (route.includes('/models')) {
      record.answer = 'models';
      response.end(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-3.1-pro',
              version: 'mock',
              displayName: 'Gemini 3.1 Pro',
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
          ],
        }),
      );
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback listener has no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    records,
    runCommandDeclaration: () => declaration,
    functionCallsIssued: () => callsIssued,
    functionResponsesSeen: () => responsesSeen,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
