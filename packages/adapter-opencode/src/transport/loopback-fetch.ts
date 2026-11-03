/** Fetch for a private loopback backend whose origin a stopped predecessor may have held. */

/**
 * `opencode serve --port 0` prefers port 4096, so a backend started after another one stopped usually reappears at
 * the same origin. Node's fetch pools sockets per origin; after an aborted SSE subscription to the stopped backend,
 * the next request on that pool can fail with ECONNRESET before the new backend ever receives it (reproduced on
 * linux-x64 with OpenCode 1.18.16 and 1.19.5, and only when the origin is reused). One retry opens a fresh connection.
 * Any response, an aborted request, and every other failure pass through unchanged.
 */
const STALE_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

function staleSocketFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && STALE_SOCKET_CODES.has(code);
}

export function withStaleSocketRetry(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (init?.signal?.aborted || !staleSocketFailure(error)) throw error;
      return fetchImpl(input, init);
    }
  };
}

export const loopbackFetch: typeof fetch = withStaleSocketRetry((input, init) => fetch(input, init));
