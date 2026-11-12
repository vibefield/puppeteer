import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLaunchRefusedError, type AgentHost } from '@vibefield/puppeteer-core';
import { resolveHermesExecutable } from '../detection.js';
import { HERMES_HOME_ENV, HERMES_PYTHON_ENV } from '../generated/detection.js';
import { TUI_GATEWAY_HOST_SOURCE } from '../generated/tui-gateway-host.js';
import { hermesCheckoutFromWrapper, hermesPythonFromWrapper, readHermesWrapper } from '../services/distribution.js';
import { createHermesGatewayToken } from '../transport/gateway-auth.js';

export interface HermesGatewayHost {
  /** The bare WebSocket URL; a client presents `token` with it (`authorizedGatewayUrl`). */
  url: string;
  /** This launch's bearer. The host refuses every connection without it, and every browser Origin. */
  token: string;
  pid: number | undefined;
  close(): Promise<void>;
}

export interface StartHermesGatewayHostOptions {
  python?: string | undefined;
  /** The `hermes` command the session launches; its wrapper names the interpreter and the checkout. */
  executable?: string | undefined;
  /** The Hermes checkout the host script imports from, for a host that names it; a wrapper's is used otherwise. */
  checkout?: string | undefined;
  hermesHome: string;
  cwd: string;
  /** The gateway host's own variables, set over the Hermes home. */
  env?: Record<string, string> | undefined;
  /**
   * The session's host. The gateway host owns the agent and runs its tools, so it runs under the host's helper
   * environment when the host composes one (`AgentHost.helperEnvironment`), never this process's own.
   */
  host?: Pick<AgentHost, 'helperEnvironment'> | undefined;
  startupTimeoutMs?: number | undefined;
}

// Native shutdown budgets up to five seconds for durable flushes, then stops turns and slash workers.
async function terminateChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  if ((await Promise.race([exited.then(() => 'exit' as const), timedOut])) === 'timeout') {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
    await exited;
  }
  if (timer) clearTimeout(timer);
}

interface HostScript {
  path: string;
  /** Python has compiled the script once the host has published its URL or gone, so the launch ends a copy's life. */
  release(): void;
}

// A bundling host keeps neither the script beside this module nor, when it defines
// import.meta.url away as fieldd does, this module's place on disk.
function hostScript(): HostScript {
  const moduleUrl = import.meta.url as string | undefined;
  if (moduleUrl?.startsWith('file:')) {
    const moduleRoot = dirname(fileURLToPath(moduleUrl));
    const onDisk = [
      join(moduleRoot, 'tui-gateway-host.py'),
      join(moduleRoot, '../../scripts/tui-gateway-host.py'),
    ].find((path) => existsSync(path));
    if (onDisk) return { path: onDisk, release: () => undefined };
  }
  const directory = mkdtempSync(join(tmpdir(), 'puppeteer-hermes-host-'));
  const path = join(directory, 'tui-gateway-host.py');
  writeFileSync(path, TUI_GATEWAY_HOST_SOURCE, { mode: 0o600 });
  return {
    path,
    release: () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // A leftover copy in the temp directory does not fail a launch.
      }
    },
  };
}

export function resolveHermesPython(explicit?: string): string {
  return explicit ?? process.env[HERMES_PYTHON_ENV] ?? 'python3';
}

/** The interpreter the gateway host runs, and the checkout its script imports Hermes from when a wrapper names it. */
interface GatewayInterpreter {
  python: string;
  checkout?: string;
}

/** An interpreter, with the checkout the host names in place of any other. */
function withCheckout(python: string, named: string | undefined, found?: string): GatewayInterpreter {
  const checkout = named ?? found;
  return checkout === undefined ? { python } : { python, checkout };
}

/**
 * For a launch that names no interpreter: the interpreter and the checkout the launch's `hermes` wrapper execs, found
 * on the PATH the host runs under; else HERMES_PYTHON. With neither the launch is refused before anything is written
 * or spawned: a bare `python3` cannot import Hermes, and its exit would say nothing a person can act on. A checkout
 * the host names takes the place of the wrapper's.
 */
async function resolveGatewayInterpreter(
  options: StartHermesGatewayHostOptions,
  env: Record<string, string | undefined>,
): Promise<GatewayInterpreter> {
  try {
    const wrapper = await readHermesWrapper(resolveHermesExecutable(options.executable), env);
    const python = wrapper === undefined ? undefined : hermesPythonFromWrapper(wrapper);
    const checkout = wrapper === undefined ? undefined : hermesCheckoutFromWrapper(wrapper);
    if (python) return withCheckout(python, options.checkout, checkout);
  } catch {
    // An unreadable wrapper names nothing.
  }
  const fromEnvironment = process.env[HERMES_PYTHON_ENV];
  if (fromEnvironment) return withCheckout(fromEnvironment, options.checkout);
  throw new AgentLaunchRefusedError(
    'INTERPRETER_UNAVAILABLE',
    'no interpreter is named for the Hermes gateway host, and no hermes wrapper on its PATH names one',
  );
}

export async function startHermesGatewayHost(options: StartHermesGatewayHostOptions): Promise<HermesGatewayHost> {
  const own: Record<string, string> = {
    [HERMES_HOME_ENV]: options.hermesHome,
    HOME: options.hermesHome,
    ...(options.env ?? {}),
  };
  // The agent's environment, as the host composes it for every helper that runs the agent's turns and tools. A host
  // that composes none gets the minimal set it always had: this process's PATH, and nothing else of its own.
  const env = options.host?.helperEnvironment?.(own) ?? { PATH: process.env.PATH, ...own };
  // The explicit python with the checkout named beside it, if any; then the wrapper's python and checkout; then
  // HERMES_PYTHON. A named checkout takes the place of the wrapper's. A named interpreter is taken with nothing
  // awaited, so that launch spawns in the same turn as before.
  const interpreter = options.python
    ? withCheckout(options.python, options.checkout)
    : await resolveGatewayInterpreter(options, env);
  const token = createHermesGatewayToken();
  // The script runs from the command line, isolated (-I): nothing is written for it, and neither the agent's working
  // directory, PYTHONPATH nor the user's site reaches its imports. It is the adapter's own source, with nothing of the
  // launch in it, so a same-user `ps` that reads it learns nothing. Windows keeps the file, whose command line is
  // quoted another way.
  const script = process.platform === 'win32' ? hostScript() : undefined;
  let child: ChildProcess;
  try {
    // The checkout, when there is one, is the script's one argument: it imports Hermes from there.
    const checkout = interpreter.checkout === undefined ? [] : [interpreter.checkout];
    const args = script ? [script.path, ...checkout] : ['-I', '-B', '-c', TUI_GATEWAY_HOST_SOURCE, ...checkout];
    child = spawn(interpreter.python, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    script?.release();
    throw error;
  }
  // The bearer rides stdin, never argv or the environment: any same-user
  // process can read both with ps, and the host's environment reaches every
  // tool the agent runs. A write to a host that has already gone fails with
  // EPIPE; its exit reports that.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(`${token}\n`);

  // Importing the exact locked Hermes graph can take tens of seconds on a
  // cold machine even though gateway.ready is fast after import completes.
  const timeoutMs = options.startupTimeoutMs ?? 90_000;
  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl?.close();
        child.off('error', fail);
        child.off('exit', exited);
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(
        () => finish(new Error('Hermes gateway host did not publish a WebSocket URL')),
        timeoutMs,
      );
      let rl: ReturnType<typeof createInterface> | undefined;
      const fail = (error: Error): void => finish(error);
      const exited = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(new Error(`Hermes gateway host exited (${code ?? signal})`));
      child.once('error', fail);
      child.once('exit', exited);
      const stdout = child.stdout;
      if (!stdout) {
        finish(new Error('Hermes gateway host has no stdout'));
        return;
      }
      // Diagnostics can contain local paths or provider configuration. Drain
      // them without reflecting their contents into an application error.
      child.stderr?.resume();
      rl = createInterface({ input: stdout });
      rl.once('line', (line) => {
        try {
          const parsed = JSON.parse(line) as { url?: string; error?: string };
          if (parsed.error) throw new Error('Hermes gateway host reported a startup error');
          if (!parsed.url) throw new Error('Hermes gateway host printed no URL');
          finish(undefined, parsed.url);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } catch (error) {
    await terminateChild(child);
    throw error;
  } finally {
    script?.release();
  }

  return {
    url,
    token,
    pid: child.pid,
    async close() {
      await terminateChild(child);
    },
  };
}
