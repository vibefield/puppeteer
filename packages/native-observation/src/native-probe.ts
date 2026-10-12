/** Bounded subprocess reads for native metadata. No provider names, model policy, or Core dependencies. */
import { spawn } from 'node:child_process';

export class NativeProbeError extends Error {
  constructor(
    readonly code:
      'not-found' | 'timeout' | 'cancelled' | 'invalid-response' | 'auth-required' | 'unsupported' | 'native-error',
  ) {
    super(`Native metadata probe: ${code}`);
  }
}

export interface NativeProbeOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  /** Complete environment, with profile bindings already applied by the adapter. */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
}

export interface NativeModelProbeOptions {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Named account reads must not borrow a credential from the host's process environment. */
export function nativeModelEnvironment(
  ambient: NodeJS.ProcessEnv,
  binding?: Record<string, string>,
  resetRoot?: string,
): NodeJS.ProcessEnv {
  const env = { ...ambient };
  if (binding) {
    for (const name of Object.keys(env)) {
      if (/(?:API_KEY|TOKEN|SECRET|ACCESS_KEY|PASSWORD)$/iu.test(name)) delete env[name];
    }
    if (resetRoot) delete env[resetRoot];
    Object.assign(env, binding);
  }
  return env;
}

export function nativeStrings(value: unknown): string[] {
  return nativeArray(value).map((item) => {
    const text = nativeString(item);
    if (!text) throw new NativeProbeError('invalid-response');
    return text;
  });
}

function failureCode(text: string): 'auth-required' | 'unsupported' | 'native-error' {
  if (/not authenticated|authentication required|not logged in|please (?:log|sign) in/i.test(text))
    return 'auth-required';
  if (/unknown (?:option|command|argument)|unrecognized (?:option|command|argument)|method not found/i.test(text))
    return 'unsupported';
  return 'native-error';
}

function ownProcess(options: NativeProbeOptions, onData: (chunk: Buffer) => void, onFailure: (error: Error) => void) {
  if (options.signal?.aborted)
    throw new NativeProbeError(options.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000)
    throw new RangeError('metadata timeout must be between 1 and 120000 ms');
  const script = /\.(?:mjs|cjs|js)$/iu.test(options.executable);
  const child = spawn(
    script ? process.execPath : options.executable,
    [...(script ? [options.executable] : []), ...options.args],
    {
      cwd: options.cwd,
      env: { ...options.env, ...(script && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
  );
  let exited = false,
    outputBytes = 0,
    stderr = '',
    failed: Error | undefined;
  let closing: Promise<void> | undefined;
  const completion = new Promise<{ code: number | null }>((resolve) => {
    child.once('close', (code) => {
      exited = true;
      resolve({ code });
    });
    child.once('error', (error) => {
      fail(new NativeProbeError('code' in error && error.code === 'ENOENT' ? 'not-found' : 'native-error'));
    });
  });
  const signal = (kind: NodeJS.Signals) => {
    if (exited || child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(kind);
      else process.kill(-child.pid, kind);
    } catch {
      /* Already stopped. */
    }
  };
  let forcedStop: ReturnType<typeof setTimeout> | undefined;
  const scheduleStop = () => {
    forcedStop ??= setTimeout(() => signal('SIGKILL'), 250);
  };
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    onFailure(error);
    signal('SIGTERM');
    scheduleStop();
  };
  const abort = () =>
    fail(new NativeProbeError(options.signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  // Close the check/listener race before writing to the native process.
  if (options.signal?.aborted) abort();
  const deadline = setTimeout(() => fail(new NativeProbeError('timeout')), timeoutMs);
  child.stdin.on('error', () => fail(new NativeProbeError('native-error')));
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed) return;
    outputBytes += chunk.length;
    if (outputBytes > (options.maxOutputBytes ?? 16 * 1024 * 1024)) {
      fail(new NativeProbeError('invalid-response'));
      return;
    }
    try {
      onData(chunk);
    } catch {
      fail(new NativeProbeError('invalid-response'));
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    stderr = (stderr + chunk.toString()).slice(-8_192);
    if (outputBytes > (options.maxOutputBytes ?? 16 * 1024 * 1024)) fail(new NativeProbeError('invalid-response'));
  });
  void completion.then(() => {
    clearTimeout(deadline);
    clearTimeout(forcedStop);
    options.signal?.removeEventListener('abort', abort);
  });
  return {
    write(value: string | Buffer) {
      if (failed) throw failed;
      child.stdin.write(value);
    },
    end() {
      child.stdin.end();
    },
    completion,
    error: () => failed,
    stderr: () => stderr,
    close(): Promise<void> {
      closing ??= (async () => {
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', abort);
        if (exited) return;
        signal('SIGTERM');
        scheduleStop();
        await completion;
      })();
      return closing;
    },
  };
}

export async function runNativeCommand(options: NativeProbeOptions): Promise<{ stdout: string; stderr: string }> {
  const chunks: Buffer[] = [];
  const child = ownProcess(
    options,
    (chunk) => chunks.push(chunk),
    () => {},
  );
  try {
    child.end();
    const result = await child.completion;
    if (child.error()) throw child.error();
    if (result.code !== 0) throw new NativeProbeError(failureCode(child.stderr()));
    return { stdout: Buffer.concat(chunks).toString('utf8'), stderr: child.stderr() };
  } finally {
    await child.close();
  }
}

export interface NativeRpcCodec {
  framing?: 'lines' | 'headers';
  request?(id: number, method: string, params: unknown): unknown;
  response?(message: Record<string, unknown>): { id: unknown; result?: unknown; error?: unknown };
}

export function createNativeRpc(options: NativeProbeOptions, codec: NativeRpcCodec = {}) {
  let buffer = Buffer.alloc(0),
    nextId = 0,
    ended = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const rejectAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const receive = (body: Buffer) => {
    const message = nativeRecord(JSON.parse(body.toString('utf8')));
    if (!message) throw new NativeProbeError('invalid-response');
    const decoded = codec.response?.(message) ?? { id: message.id, result: message.result, error: message.error };
    if (typeof message.method === 'string' && message.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Metadata probe does not provide client methods.' },
      });
      return;
    }
    const waiter = typeof decoded.id === 'number' ? pending.get(decoded.id) : undefined;
    if (!waiter) return;
    pending.delete(decoded.id as number);
    if (decoded.error !== undefined) {
      const error = nativeRecord(decoded.error);
      waiter.reject(
        new NativeProbeError(
          error?.code === -32601 ? 'unsupported' : failureCode(String(error?.message ?? decoded.error)),
        ),
      );
    } else waiter.resolve(decoded.result);
  };
  const child = ownProcess(
    options,
    (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (codec.framing === 'headers') {
          const index = buffer.indexOf('\r\n\r\n');
          if (index < 0) break;
          const header = buffer.subarray(0, index).toString('ascii');
          const raw = /^Content-Length:\s*(\d+)\s*$/im.exec(header)?.[1];
          const length = raw === undefined ? NaN : Number(raw);
          if (!Number.isSafeInteger(length) || length < 0 || length > (options.maxOutputBytes ?? 16 * 1024 * 1024))
            throw new NativeProbeError('invalid-response');
          if (buffer.length < index + 4 + length) break;
          const body = buffer.subarray(index + 4, index + 4 + length);
          buffer = buffer.subarray(index + 4 + length);
          receive(body);
        } else {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          const body = buffer.subarray(0, index);
          buffer = buffer.subarray(index + 1);
          if (body.toString().trim()) receive(body);
        }
      }
    },
    rejectAll,
  );
  const send = (message: unknown) => {
    const body = JSON.stringify(message);
    child.write(
      codec.framing === 'headers' ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : body + '\n',
    );
  };
  void child.completion.then(() => {
    ended = true;
    rejectAll(child.error() ?? new NativeProbeError(failureCode(child.stderr())));
  });
  return {
    request(method: string, params: unknown = {}): Promise<unknown> {
      if (ended || child.error()) return Promise.reject(child.error() ?? new NativeProbeError('native-error'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          send(codec.request?.(id, method, params) ?? { jsonrpc: '2.0', id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method: string, params: unknown = {}) {
      send({ jsonrpc: '2.0', method, params });
    },
    async close() {
      ended = true;
      rejectAll(new NativeProbeError('cancelled'));
      await child.close();
    },
  };
}

export const nativeRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export const nativeString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
export function nativeProbeOptions(
  executable: string,
  context: { cwd: string; signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
  env: NodeJS.ProcessEnv,
): Omit<NativeProbeOptions, 'args'> {
  const timeoutMs = context.timeoutMs ?? 20_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new RangeError('invalid metadata timeout');
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    executable,
    cwd: context.cwd,
    env,
    timeoutMs,
    signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
  };
}
export function nativeArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new NativeProbeError('invalid-response');
  return value;
}

/** Restrict catalog version metadata to the CLI's version token; never publish its raw diagnostic output. */
export async function nativeVersion(options: Omit<NativeProbeOptions, 'args'>): Promise<string | undefined> {
  const { stdout } = await runNativeCommand({ ...options, args: ['--version'], maxOutputBytes: 64 * 1024 });
  return /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?!\w|\.\d)/u.exec(stdout)?.[1];
}

export async function readNativeJsonResponse(response: Response, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  if (!response.ok)
    throw new NativeProbeError(
      response.status === 401 || response.status === 403
        ? 'auth-required'
        : response.status === 404
          ? 'unsupported'
          : 'native-error',
    );
  if (!response.body) throw new NativeProbeError('invalid-response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > maxBytes) throw new NativeProbeError('invalid-response');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
