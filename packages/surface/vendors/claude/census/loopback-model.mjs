/**
 * Loopback stand-in for the Anthropic Messages API, used by the hermetic
 * census lanes. It binds 127.0.0.1 only and accepts the placeholder token the
 * lanes pass; no account, credential, or billed model call is ever involved.
 *
 * Two behaviours:
 * - `errorReply` answers every Messages request with one HTTP error so a
 *   print turn ends in Claude's API-error path (StopFailure);
 * - `plan` scripts streamed replies, including tool_use blocks, from markers
 *   the interactive lane types into its own prompts.
 *
 * The lane itself only sees the artifact's native hooks, status lines, and
 * transcripts; this server's request log is census diagnostics, not evidence
 * of native semantics.
 */
import { createServer } from 'node:http';

export const LOOPBACK_MODEL = 'claude-sonnet-4-5-20250929';
export const LOOPBACK_AUTH_TOKEN = 'puppeteer-not-a-real-token';

function sendEvent(response, type, data) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function stream(response, id, model, step) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  sendEvent(response, 'message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  if (step.kind === 'tool') {
    sendEvent(response, 'content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: step.toolUseId, name: step.name, input: {} },
    });
    sendEvent(response, 'content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) },
    });
    sendEvent(response, 'content_block_stop', { index: 0 });
    sendEvent(response, 'message_delta', {
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 12 },
    });
  } else {
    sendEvent(response, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    sendEvent(response, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } });
    sendEvent(response, 'content_block_stop', { index: 0 });
    sendEvent(response, 'message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    });
  }
  sendEvent(response, 'message_stop', {});
  response.end();
}

/**
 * Start the loopback model. Exactly one of `errorReply` and `plan` is required.
 * Resolves to `{ baseUrl, requests, close }`; `requests` records only method,
 * route, and the scripted step kind.
 */
export async function startLoopbackModel({ errorReply, plan } = {}) {
  if (Boolean(errorReply) === Boolean(plan))
    throw new Error('startLoopbackModel needs exactly one of errorReply or plan');
  const requests = [];
  let toolSequence = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const route = (request.url ?? '').split('?')[0];
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      if (route.startsWith('/v1/messages/count_tokens')) {
        requests.push({ method: request.method, route, kind: 'count-tokens' });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 40 }));
        return;
      }
      if (request.method === 'POST' && route.startsWith('/v1/messages')) {
        if (errorReply) {
          requests.push({ method: request.method, route, kind: `error-${errorReply.status}` });
          response.writeHead(errorReply.status, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ type: 'error', error: { type: errorReply.type, message: errorReply.message } }),
          );
          return;
        }
        const step = plan(body);
        if (step.kind === 'tool') {
          toolSequence += 1;
          step.toolUseId = `toolu_loopback_${toolSequence}`;
        }
        requests.push({ method: request.method, route, kind: step.kind, tool: step.name });
        const id = `msg_loopback_${requests.length}`;
        const model = typeof body?.model === 'string' ? body.model : LOOPBACK_MODEL;
        if (body?.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id,
              type: 'message',
              role: 'assistant',
              model,
              content: [{ type: 'text', text: step.text ?? 'ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 40, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            }),
          );
          return;
        }
        stream(response, id, model, step);
        return;
      }
      requests.push({ method: request.method, route, kind: 'unsupported' });
      if (request.method === 'HEAD') {
        response.writeHead(200);
        response.end();
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}
