/** Private OpenCode `serve` lifecycle and environment-only Basic auth. */

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  inspectOpenCodeVersion,
  OPENCODE_LAUNCH_FLAGS,
  resolveOpenCodeExecutable,
  unsupportedOpenCodeLineMessage,
} from '../detection.js';
import { withoutOpenCodeServerPasswords } from './credentials.js';

/**
 * How one release line starts its server: the argv after the executable and the stdout line that announces the
 * origin. The argv is `[...command, hostname, <host>, port, '0', ...additional]`.
 */
export interface OpenCodeBackendLaunchSpec {
  /** The subcommand words that start the server, such as `['serve']`. */
  readonly command: readonly string[];
  readonly hostnameFlag: string;
  readonly portFlag: string;
  /** Flags appended after the port, such as `--pure`. */
  readonly additional: readonly string[];
  /** The text that precedes the origin on the readiness line. */
  readonly readyPrefix: string;
}

/** OpenCode 1.x (Surface `opencode@1.19.5` detection): `serve --hostname <h> --port 0 --pure`. */
export const OPENCODE_1_BACKEND_LAUNCH: OpenCodeBackendLaunchSpec = Object.freeze({
  command: Object.freeze([OPENCODE_LAUNCH_FLAGS.serve]),
  hostnameFlag: OPENCODE_LAUNCH_FLAGS.hostname,
  portFlag: OPENCODE_LAUNCH_FLAGS.port,
  additional: Object.freeze([OPENCODE_LAUNCH_FLAGS.pure]),
  readyPrefix: 'opencode server listening on ',
});

/** The argv a launch spec composes for one hostname; the port is always `0`. */
export function openCodeBackendArguments(spec: OpenCodeBackendLaunchSpec, hostname: string): string[] {
  return [...spec.command, spec.hostnameFlag, hostname, spec.portFlag, '0', ...spec.additional];
}

/**
 * The executable is OpenCode 2.x, which this adapter refuses. Raised only when a start failed before readiness and
 * the executable's own `--version` then named the 2.x line, so a supported binary never pays for the check.
 */
export class OpenCodeUnsupportedReleaseLineError extends Error {
  readonly code = 'OPENCODE_UNSUPPORTED_RELEASE_LINE';
  readonly line = '2.x';
  readonly version: string;

  constructor(version: string, options?: ErrorOptions) {
    super(unsupportedOpenCodeLineMessage(version), options);
    this.name = 'OpenCodeUnsupportedReleaseLineError';
    this.version = version;
  }
}

export interface StartOpenCodeBackendOptions {
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
  executable?: string | undefined;
  env?: Record<string, string> | undefined;
  /** False when the caller has already constructed a complete, profile-bound environment. */
  inheritEnvironment?: boolean | undefined;
  hostname?: string | undefined;
  startupTimeoutMs?: number | undefined;
  shutdownTimeoutMs?: number | undefined;
  /** How the server starts and announces readiness. Default: {@link OPENCODE_1_BACKEND_LAUNCH}. */
  launch?: OpenCodeBackendLaunchSpec | undefined;
}

export interface OpenCodeBackend {
  readonly origin: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly pid: number | undefined;
  running(): boolean;
  dispose(): Promise<void>;
}

const MAX_STARTUP_OUTPUT = 256 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** The 2.x check after a failed start is bounded so it never holds a failure much longer than the start did. */
const RELEASE_LINE_CHECK_TIMEOUT_MS = 5_000;

export function openCodeReadinessOrigin(
  line: string,
  requestedHostname: string,
  readyPrefix: string = OPENCODE_1_BACKEND_LAUNCH.readyPrefix,
): string | undefined {
  if (!line.startsWith(readyPrefix)) return undefined;
  const candidate = line.slice(readyPrefix.length).trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  if (requestedHostname !== 'localhost' && url.hostname !== requestedHostname) return undefined;
  if (!url.port || url.pathname !== '/') return undefined;
  return url.origin;
}

async function terminateChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs);
    timeout.unref();
  });
  if ((await Promise.race([exited.then(() => 'exit' as const), timedOut])) === 'timeout') {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
    await exited;
  }
  if (timeout) clearTimeout(timeout);
}

/**
 * Start one adapter-owned backend. The generated password exists only in this
 * process, the child environment, and the caller-owned TUI launch recipe.
 */
export async function startOpenCodeBackend(options: StartOpenCodeBackendOptions = {}): Promise<OpenCodeBackend> {
  options.signal?.throwIfAborted();
  const executable = resolveOpenCodeExecutable(options.executable);
  const hostname = options.hostname ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`OpenCode backend must bind loopback, got ${hostname}`);
  }
  const launch = options.launch ?? OPENCODE_1_BACKEND_LAUNCH;
  const username = 'opencode';
  const password = randomBytes(32).toString('base64url');
  // Node scripts (including the conformance fixture) cannot be spawned via
  // a shebang on Windows. Keep argv as an array and avoid a command shell.
  const nodeScript = /\.(?:mjs|cjs|js)$/i.test(executable);
  // A password this start did not generate never reaches the server; only its own is set below.
  const baseEnvironment = withoutOpenCodeServerPasswords({
    ...(options.inheritEnvironment === false ? {} : process.env),
    ...options.env,
  });
  const child = spawn(
    nodeScript ? process.execPath : executable,
    [...(nodeScript ? [executable] : []), ...openCodeBackendArguments(launch, hostname)],
    {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...baseEnvironment,
        ...(nodeScript && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      },
    },
  );

  let startupOutput = '';
  let settled = false;
  // Set when the start failed in a way a 2.x binary would cause: it exited or never announced readiness.
  let checkReleaseLine = false;
  let timeout: NodeJS.Timeout | undefined;
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;

  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, readyOrigin?: string): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        child.stdout?.off('data', inspect);
        child.stdout?.resume();
        child.off('error', onError);
        child.off('exit', onExit);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(readyOrigin!);
      };
      const inspect = (chunk: Buffer | string): void => {
        startupOutput += chunk.toString();
        if (startupOutput.length > MAX_STARTUP_OUTPUT) {
          finish(new Error('OpenCode backend exceeded the bounded startup output limit'));
          return;
        }
        const lines = startupOutput.split(/\r?\n/);
        startupOutput = lines.pop() ?? '';
        for (const line of lines) {
          const readyOrigin = openCodeReadinessOrigin(line.trim(), hostname, launch.readyPrefix);
          if (readyOrigin) {
            finish(undefined, readyOrigin);
            return;
          }
        }
      };
      const onError = (error: Error): void => finish(error);
      const onAbort = (): void =>
        finish(
          options.signal?.reason instanceof Error ? options.signal.reason : new Error('OpenCode startup cancelled'),
        );
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`;
        checkReleaseLine = true;
        finish(new Error(`OpenCode backend stopped before readiness (${detail})`));
      };

      child.stdout?.on('data', inspect);
      // Drain stderr without logging it: startup diagnostics can contain paths,
      // while credentials must never enter a log or error string.
      child.stderr?.resume();
      child.once('error', onError);
      child.once('exit', onExit);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      timeout = setTimeout(() => {
        checkReleaseLine = true;
        finish(new Error(`OpenCode backend did not become ready within ${startupTimeoutMs}ms`));
      }, startupTimeoutMs);
      timeout.unref();
    });

    let disposed = false;
    return {
      origin,
      hostname,
      username,
      password,
      pid: child.pid,
      running: () => !disposed && child.exitCode === null && child.signalCode === null,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await terminateChild(child, options.shutdownTimeoutMs ?? 2_000);
      },
    };
  } catch (error) {
    await terminateChild(child, options.shutdownTimeoutMs ?? 2_000);
    if (checkReleaseLine && !options.signal?.aborted) {
      const reading = await inspectOpenCodeVersion(executable, {
        env: baseEnvironment,
        timeoutMs: RELEASE_LINE_CHECK_TIMEOUT_MS,
      });
      if (reading.status === 'unsupported-release-line') {
        throw new OpenCodeUnsupportedReleaseLineError(reading.version, { cause: error });
      }
    }
    throw error;
  }
}
