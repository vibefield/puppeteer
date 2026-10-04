// A small DevTools-protocol client for the perf harness: Node's own WebSocket, one page target,
// every call bounded by a timeout so a page that stops answering fails the run instead of
// hanging it (macOS ships no `timeout`).

export async function connectPage(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot reach ${webSocketUrl}`)), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const waiting = message.id === undefined ? undefined : pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
    else waiting.resolve(message.result);
  });
  const send = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    /** The expression's value, awaited when it is a promise; a page exception rejects. */
    async evaluate(expression, timeoutMs = 30_000) {
      const result = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
        timeoutMs + 5_000,
      );
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    },
    close() {
      for (const waiting of pending.values()) clearTimeout(waiting.timer);
      pending.clear();
      socket.close();
    },
  };
}
