import { PUPPETEER_VERSION } from '@vibecook/puppeteer-core';
import { AppServerClient, spawnAppServerTransport, type Transport } from '../transport/app-server-client.js';

export interface PrewarmCodexOptions {
  executable?: string;
  /** The same account root the eventual native invocation will use. */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Total budget for this optional background operation, including initialization. */
  timeoutMs?: number;
  spawnTransport?: (options: { executable?: string; env?: Record<string, string> }) => Transport;
}

/** Populate Codex's native on-disk model cache without creating a thread or starting a turn. */
export async function prewarmCodex(options: PrewarmCodexOptions = {}): Promise<void> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const client = new AppServerClient(
    (options.spawnTransport ?? spawnAppServerTransport)({
      ...(options.executable ? { executable: options.executable } : {}),
      ...(options.env ? { env: options.env } : {}),
    }),
  );
  const abort = (): void => {
    void client.close().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.request('initialize', {
      clientInfo: { name: 'puppeteer-prewarm', version: PUPPETEER_VERSION },
      capabilities: {},
    });
    client.notify('initialized');
    await client.request('model/list', {});
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
    await client.close();
  }
}
