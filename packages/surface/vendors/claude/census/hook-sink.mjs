/**
 * Loopback recorder for every census lane, in the adapter's own hook shape:
 * SessionStart and Setup (command-only in Claude) reach it through a
 * shell-free command forwarder, every other event as an HTTP hook whose bearer
 * Claude interpolates from an allow-listed environment variable.
 *
 * HTTP matters for evidence, not only parity: during adaptation a 2.1.283+
 * print-mode process was seen to exit before a StopFailure command forwarder
 * (~100 ms to start) completed, while the HTTP request was already on the
 * wire (an unrecorded bisect; findings.md). A command-hook census can
 * therefore under-report StopFailure; this sink does not.
 *
 * Each payload is appended verbatim to `<outputRoot>/<mode>/<Event>.jsonl`.
 * Status-line payloads go to the auxiliary tree. Arrival order is kept in
 * memory and projected to event names and enum discriminators only.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const HOOK_TOKEN_VAR = 'PUPPETEER_HOOK_TOKEN';
const COMMAND_ONLY = new Set(['SessionStart', 'Setup']);

// Enum-like fields safe to retain in the ordering projection.
const DISCRIMINATORS = [
  'source',
  'reason',
  'trigger',
  'notification_type',
  'load_reason',
  'memory_type',
  'event',
  'error',
  'final',
  'stop_hook_active',
  'expansion_type',
  'cache_ttl',
  'pricing',
];

const FORWARDER = `const [endpoint, tokenEnvVar] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const token = process.env[tokenEnvVar] ?? '';
try {
  await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: input,
    signal: AbortSignal.timeout(4000),
  });
} catch {}
`;

/**
 * `failEvents` answers those managed HTTP hooks with HTTP 500, and any URL
 * carrying `fail=1` is answered the same way (probes of Claude's failure
 * paths). A hook posted with `via=person` is the probe rig's stand-in for the
 * owner's own user-settings hook.
 */
export async function startHookSink({ outputRoot, auxRoot, failEvents = [] }) {
  const token = randomBytes(16).toString('hex');
  const order = [];
  const sink = {
    mode: 'boot',
    token,
    order,
    url: '',
    hookCount(event, mode = sink.mode, predicate = () => true) {
      return order.filter(
        (entry) =>
          entry.channel === 'hook' &&
          entry.mode === mode &&
          entry.payload?.hook_event_name === event &&
          predicate(entry.payload),
      ).length;
    },
  };
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const path = request.url ?? '';
      const channel = path.startsWith('/status/sub')
        ? 'subagentStatusLine'
        : path.startsWith('/status')
          ? 'statusLine'
          : 'hook';
      const bearer =
        request.headers.authorization === `Bearer ${token}`
          ? 'bearer'
          : request.headers.authorization
            ? 'wrong'
            : 'none';
      const entry = { mode: sink.mode, channel, bearer, payload: body };
      if (channel === 'hook') {
        entry.transport = path.includes('via=person') ? 'person' : path.includes('via=command') ? 'command' : 'http';
        const event = body?.hook_event_name;
        if (typeof event === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(event)) {
          const directory = join(outputRoot, sink.mode);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          appendFileSync(join(directory, `${event}.jsonl`), `${JSON.stringify(body)}\n`, { mode: 0o600 });
        }
      } else if (auxRoot) {
        mkdirSync(auxRoot, { recursive: true, mode: 0o700 });
        appendFileSync(join(auxRoot, `${channel}.jsonl`), `${JSON.stringify({ mode: sink.mode, payload: body })}\n`, {
          mode: 0o600,
        });
      }
      order.push(entry);
      if ((entry.transport === 'http' && failEvents.includes(body?.hook_event_name)) || path.includes('fail=1')) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('census failure');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('');
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  sink.url = `http://127.0.0.1:${server.address().port}`;
  sink.close = () =>
    new Promise((resolveClose) => {
      server.closeAllConnections?.();
      server.close(() => resolveClose());
    });
  return sink;
}

/** Write the command forwarder beside a lane's other disposable files. */
export function writeForwarder(directory) {
  const path = join(directory, 'forward.mjs');
  writeFileSync(path, FORWARDER);
  return path;
}

/**
 * Managed hook settings in the adapter's shape. `matchers` adds a native
 * matcher; `omit` names events that must not be registered at all.
 */
export function hookSettings({ events, sinkUrl, forwarder, matchers = {}, omit = [] }) {
  const hooks = {};
  for (const event of events) {
    if (omit.includes(event)) continue;
    const handler = COMMAND_ONLY.has(event)
      ? {
          type: 'command',
          command: process.execPath,
          args: [forwarder, `${sinkUrl}/hook?via=command`, HOOK_TOKEN_VAR],
          timeout: 10,
        }
      : {
          type: 'http',
          url: `${sinkUrl}/hook`,
          headers: { Authorization: `Bearer $${HOOK_TOKEN_VAR}` },
          allowedEnvVars: [HOOK_TOKEN_VAR],
          timeout: 10,
        };
    hooks[event] = [{ ...(matchers[event] ? { matcher: matchers[event] } : {}), hooks: [handler] }];
  }
  return hooks;
}

/** Arrival order with event names and enum discriminators only; no payload values otherwise. */
export function projectOrder(order) {
  const sequence = new Map();
  return order.map((entry) => {
    const seq = (sequence.get(entry.mode) ?? 0) + 1;
    sequence.set(entry.mode, seq);
    const projected = { mode: entry.mode, seq, channel: entry.channel, bearer: entry.bearer };
    if (entry.channel !== 'hook') return projected;
    projected.transport = entry.transport;
    projected.hook = entry.payload?.hook_event_name;
    for (const field of DISCRIMINATORS) {
      // `error` is a closed enum only on StopFailure; elsewhere it is free text.
      if (field === 'error' && projected.hook !== 'StopFailure') continue;
      const value = entry.payload?.[field];
      if (typeof value === 'boolean' || (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value))) {
        projected[field] = value;
      }
    }
    if (typeof entry.payload?.agent_id === 'string') projected.subagent = true;
    if (entry.payload?.agent_type === '') projected.agentTypeEmpty = true;
    return projected;
  });
}
