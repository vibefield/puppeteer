/**
 * Census-owned egress recorder for every execution of a pinned Claude Code
 * artifact.
 *
 * A fail-closed ANTHROPIC_BASE_URL only redirects the model endpoint. The
 * artifact also reaches hard-coded account and OAuth endpoints (BASE_API_URL:
 * api.anthropic.com, platform.claude.com) that no base URL controls, and on a
 * host where it finds a credential outside the disposable environment those
 * requests could carry it. Every census process therefore names this recorder
 * as its HTTP(S) proxy, with only loopback exempt through NO_PROXY: a proxied
 * request reaches no remote host, and the recorder keeps the attempted
 * destination (host and port only; never a header, path, or body) so the
 * harness can fail any lane that tried to leave loopback.
 *
 * Synchronous probes (`spawnSync`) cannot serve a recorder in-process; they get
 * the refusing FAIL_CLOSED_PROXY_URL from census/isolation.mjs instead, which
 * blocks the same traffic without recording it. Neither mechanism covers a
 * client that ignores the proxy variables; that needs a network-deny sandbox.
 */
import { createServer } from 'node:http';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** `host:port` of a CONNECT authority or absolute-form request target, or `unparsed`. */
export function egressDestination(method, target) {
  if (method === 'CONNECT') {
    return /^[^\s/@]+:\d+$/.test(target ?? '') ? target.toLowerCase() : 'unparsed';
  }
  try {
    const url = new URL(target ?? '');
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return 'unparsed';
  }
}

export function isLoopbackDestination(destination) {
  const host = destination.slice(0, destination.lastIndexOf(':'));
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Start the recorder. Resolves to `{ url, attempts, nonLoopback, close }`;
 * every attempt is refused with 403 and recorded as `{ lane, destination }`.
 * Set `recorder.lane` before each lane so attempts are attributed.
 */
export async function startEgressRecorder() {
  const attempts = [];
  const recorder = {
    lane: 'unattributed',
    attempts,
    url: '',
    nonLoopback: (lane) =>
      attempts.filter(
        (attempt) => (lane === undefined || attempt.lane === lane) && !isLoopbackDestination(attempt.destination),
      ),
  };
  const server = createServer((request, response) => {
    attempts.push({ lane: recorder.lane, destination: egressDestination(request.method, request.url) });
    request.resume();
    response.writeHead(403, { connection: 'close' });
    response.end();
  });
  server.on('connect', (request, socket) => {
    attempts.push({ lane: recorder.lane, destination: egressDestination('CONNECT', request.url) });
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  recorder.url = `http://127.0.0.1:${server.address().port}`;
  recorder.close = () =>
    new Promise((resolveClose) => {
      server.closeAllConnections?.();
      server.close(() => resolveClose());
    });
  return recorder;
}

/** Throw when `lane` (or any lane) attempted a non-loopback destination. */
export function assertNoEgress(recorder, lane) {
  const escaped = recorder.nonLoopback(lane);
  if (escaped.length === 0) return;
  const destinations = [...new Set(escaped.map((attempt) => `${attempt.lane} -> ${attempt.destination}`))];
  throw new Error(
    `Claude census refused: the artifact attempted ${escaped.length} non-loopback connection(s) (${destinations.join(', ')}); discard this run`,
  );
}
