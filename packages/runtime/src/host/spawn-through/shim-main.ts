/**
 * THE SHIM. A host bundles this entry into one CommonJS file (esbuild, node22)
 * and `materializeShims` copies it into the shim home; a launcher per command
 * name execs a runtime on it. It imports only Core, Node and its siblings here,
 * never the Runtime, so the bundle stays small and starts fast.
 *
 * One invocation: find the provider by the command name, find the real
 * executable, read the rendezvous, ask the gateway, then `execve` in place —
 * the recipe (`exec`), the real executable with the original argv
 * (`fallback`), or nothing (`refuse`, exit 75). It never proxies stdio: the
 * pid the shell started becomes the agent's.
 *
 * Launch environments carry bearer tokens: nothing here logs the token, a
 * recipe or an environment. Before any exec the shim removes its own
 * variables and its directory from PATH, so an agent's tools that run the
 * same command reach the real executable (nested runs are not managed).
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { isatty } from 'node:tty';
import type { AgentLaunchProvider } from '@vibecook/puppeteer-core';
import { spawnThroughLayout } from './layout.js';
import {
  SPAWN_THROUGH_EXIT_REFUSED,
  SPAWN_THROUGH_EXIT_UNAVAILABLE,
  boundSpawnThroughText,
  isSpawnThroughCommandName,
  isSpawnThroughHostLabel,
  parseSpawnThroughResponse,
  type SpawnThroughResponse,
} from './protocol.js';
import { runPs } from './ps.js';
import { DEFAULT_RETRY_MS, readLaunchProviders, readRendezvous, type SpawnThroughRendezvous } from './rendezvous.js';
import { findOwningProcess, readTerminals } from './terminals.js';

/** The answer must come within this, or the shim stops waiting (the gateway drops a socket at 30 s). */
const RESPONSE_TIMEOUT_MS = 28_000;
/** Loopback connects at once or not at all; this only bounds a machine too loaded to say. */
const CONNECT_TIMEOUT_MS = 2_000;

/** The label baked into the launcher (`PUPPETEER_SHIM_LABEL`), when it is one a shim can say. */
const launcherLabel = isSpawnThroughHostLabel(process.env.PUPPETEER_SHIM_LABEL)
  ? process.env.PUPPETEER_SHIM_LABEL
  : undefined;
/** The host's label as the shim knows it: the launcher's until `run` has read the rendezvous. */
let hostLabel = (): string | undefined => launcherLabel;

function say(text: string): void {
  // Gateway text reaches the person's terminal: printable characters only, on at most two lines, bounded. A person
  // reads the name of the host whose terminal it is, not the kit's: the label leads the line, inside the bound.
  const label = hostLabel();
  const line =
    label === undefined ? `puppeteer: ${boundSpawnThroughText(text)}` : boundSpawnThroughText(`${label}: ${text}`);
  process.stderr.write(`${line}\n`);
}

function leave(line: string, code: number): never {
  say(line);
  process.exit(code);
}

type Asked =
  | { kind: 'answer'; response: SpawnThroughResponse }
  /** No live gateway took the request, or it went away before answering: safe to ask again. */
  | { kind: 'unreachable' }
  | { kind: 'failed'; reason: string };

/** `host` names the host in the shim's own sentences: its label, or "the host". */
function ask(rendezvous: SpawnThroughRendezvous, payload: object, host: string): Promise<Asked> {
  return new Promise<Asked>((resolveAsked) => {
    const socket = createConnection({ host: rendezvous.host, port: rendezvous.port });
    let response = '';
    let settled = false;
    const connectTimer = setTimeout(() => finish({ kind: 'unreachable' }), CONNECT_TIMEOUT_MS);
    const finish = (asked: Asked): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      resolveAsked(asked);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      clearTimeout(connectTimer);
      socket.setTimeout(RESPONSE_TIMEOUT_MS, () =>
        finish({ kind: 'failed', reason: `${host} did not answer in time` }),
      );
      socket.write(`${JSON.stringify({ ...payload, token: rendezvous.token })}\n`);
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      let parsed: SpawnThroughResponse | undefined;
      try {
        parsed = parseSpawnThroughResponse(JSON.parse(response.slice(0, newline)));
      } catch {
        parsed = undefined;
      }
      finish(parsed ? { kind: 'answer', response: parsed } : { kind: 'failed', reason: `${host} answered nonsense` });
    });
    // Refused, reset, or closed before an answer: a host that is gone or going.
    socket.once('error', () => finish({ kind: 'unreachable' }));
    socket.once('close', () => finish({ kind: 'unreachable' }));
  });
}

type Execve = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never;

function main(): Promise<void> {
  const name = process.env.PUPPETEER_SHIM_NAME;
  const home = process.env.PUPPETEER_SHIM_HOME;
  if (!name || !home) {
    leave(
      'this launcher is incomplete: PUPPETEER_SHIM_NAME and PUPPETEER_SHIM_HOME are required',
      SPAWN_THROUGH_EXIT_UNAVAILABLE,
    );
  }
  const execve = process.execve;
  if (typeof execve !== 'function') {
    leave(
      `${name}: Node.js ${process.version} cannot exec in place; spawn-through needs Node.js 22.15 or later`,
      SPAWN_THROUGH_EXIT_UNAVAILABLE,
    );
  }
  return run(name, home, execve.bind(process));
}

async function run(name: string, home: string, execve: Execve): Promise<void> {
  const shimDirectory = spawnThroughLayout(home).shimDirectory;
  const originalArgv = process.argv.slice(2);
  const originalCwd = process.cwd();

  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const canonicalShimDirectory = canonical(shimDirectory);
  // The shim directory under any spelling (a symlinked /tmp, a trailing slash) is not a way out of it.
  const isShimDirectory = (directory: string): boolean =>
    resolve(directory) === resolve(shimDirectory) || canonical(directory) === canonicalShimDirectory;
  const cleanPath = (value: string): string =>
    value
      .split(delimiter)
      .filter((entry) => entry && !isShimDirectory(entry))
      .join(delimiter);
  const isExecutableFile = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile() && !isShimDirectory(dirname(canonical(path)));
    } catch {
      return false;
    }
  };
  const onPath = (command: string, pathValue: string): string | undefined => {
    if (command.includes('/')) return isExecutableFile(command) ? command : undefined;
    for (const directory of pathValue.split(delimiter)) {
      const candidate = directory ? join(directory, command) : undefined;
      if (candidate && isExecutableFile(candidate)) return candidate;
    }
    return undefined;
  };

  const strip = new Set((process.env.PUPPETEER_SHIM_STRIP ?? '').split(' ').filter(Boolean));
  const kitOwned = (variable: string): boolean =>
    variable.startsWith('PUPPETEER_SHIM_') || variable === 'PUPPETEER_ORIGINAL_ZDOTDIR';
  const environmentFor = (recipe: Record<string, string> = {}): Record<string, string> => {
    const environment: Record<string, string> = {};
    for (const [variable, value] of Object.entries(process.env)) {
      // The runtime's variables (e.g. ELECTRON_RUN_AS_NODE) were the launcher's, never the agent's.
      if (typeof value === 'string' && !strip.has(variable)) environment[variable] = value;
    }
    // The recipe is exact: its variables stand, a runtime's name among them. The kit's own never reach an agent.
    Object.assign(environment, recipe);
    for (const variable of Object.keys(environment)) if (kitOwned(variable)) delete environment[variable];
    if (environment.PATH !== undefined) environment.PATH = cleanPath(environment.PATH);
    return environment;
  };
  const execInPlace = (
    command: string,
    args: readonly string[],
    cwd: string,
    recipe?: Record<string, string>,
  ): never => {
    const environment = environmentFor(recipe);
    const executable = isAbsolute(command) ? command : (onPath(command, environment.PATH ?? '') ?? command);
    process.chdir(cwd);
    return execve(executable, [executable, ...args], environment);
  };

  const launchProviders: AgentLaunchProvider[] = (await readLaunchProviders(home)) ?? [];
  let rendezvous = await readRendezvous(home);
  // The host's name, at the head of every line and in the shim's own sentences: its latest readable word, else the
  // launcher's.
  hostLabel = () => rendezvous?.hostLabel ?? launcherLabel;
  const theHost = (): string => hostLabel() ?? 'the host';

  /**
   * `ai --<provider>` is the imposter's own invocation: the provider comes from
   * the flag, not the name, and the flag is not the vendor's to see. The
   * imposter's `ai` must still exist: the shim falls back to it.
   */
  const imposter = name === 'ai';
  const imposterProviders = new Map(
    launchProviders
      .filter((provider) => provider.nativeInvocation?.imposter !== undefined)
      .map((provider) => [provider.id, provider]),
  );
  const route = launchProviders
    .flatMap((provider) => (provider.nativeInvocation?.commands ?? []).map((command) => ({ provider, command })))
    .find(({ command }) => command.name === name);
  const flagIndex = imposter
    ? originalArgv.findIndex((argument) => argument.startsWith('--') && imposterProviders.has(argument.slice(2)))
    : -1;
  const provider = imposter
    ? flagIndex >= 0
      ? imposterProviders.get(originalArgv[flagIndex]!.slice(2))
      : undefined
    : route?.provider;
  const forwardedArgv = flagIndex >= 0 ? originalArgv.filter((_, index) => index !== flagIndex) : originalArgv;

  // The table's executable when it is absolute and runs; else the PATH, the shim directory left out.
  const configured = imposter ? rendezvous?.imposterExecutable : route?.command.executable;
  const realExecutable =
    configured !== undefined && isAbsolute(configured) && isExecutableFile(configured)
      ? configured
      : onPath(
          configured !== undefined && !configured.includes('/') ? configured : name,
          cleanPath(process.env.PATH ?? ''),
        );
  if (!realExecutable)
    leave(`${name} is not installed outside the spawn-through shim directory`, SPAWN_THROUGH_EXIT_UNAVAILABLE);

  const fallback = (): never => {
    try {
      return execInPlace(realExecutable, originalArgv, originalCwd);
    } catch (error) {
      return leave(
        `could not run ${name}: ${error instanceof Error ? error.message : String(error)}`,
        SPAWN_THROUGH_EXIT_UNAVAILABLE,
      );
    }
  };
  const refuse = (message: string): never => leave(`${name}: ${message}`, SPAWN_THROUGH_EXIT_REFUSED);

  // Not a launch a host could manage (`ai` without a persona flag is the imposter's own error to report).
  if (!provider?.nativeInvocation) return fallback();

  const environment: Record<string, string> = {};
  for (const variable of provider.nativeInvocation.environmentVariables) {
    const value = process.env[variable];
    if (typeof value === 'string') environment[variable] = value;
  }
  const launch = {
    type: 'launch',
    providerId: provider.id,
    cwd: originalCwd,
    argv: forwardedArgv,
    environment,
    pid: process.pid,
    parentPid: process.ppid,
    ...(imposter ? { imposter: true } : {}),
    ...(isSpawnThroughCommandName(name) ? { command: name } : {}),
    // `isatty`, never `process.stdin.isTTY`: that getter opens the terminal as a stream, and libuv leaves
    // fd 0 non-blocking — a state the agent would inherit at exec.
    interactive: isatty(0) && isatty(1),
  };

  /**
   * THE RULE OF REFUSAL, held here when the host cannot hold it — an answer
   * the shim could not get or read, a refusal the host could not place: a
   * strict shim waits, or refuses on its own authority, only for an
   * interactive launch inside one of the host's terminals, found by walking
   * its own ancestors against the shells the host lists (terminals.json).
   * Anywhere the launcher's directory leaked to (an editor's terminal, a
   * detached job), or when nobody can say, the agent runs as typed, at once.
   * The process table is read once, and only if it is needed.
   */
  let inHostTerminal: Promise<boolean> | undefined;
  const refusableHere = (): Promise<boolean> =>
    (inHostTerminal ??= (async () => {
      if (!launch.interactive) return false;
      const terminals = await readTerminals(home);
      if (!terminals) return false;
      // No launcher is ever taken for `ps`.
      const ps = (args: readonly string[]) => runPs(args, { ...process.env, PATH: cleanPath(process.env.PATH ?? '') });
      return (await findOwningProcess({ pid: process.pid, owners: terminals, ps })) !== undefined;
    })());

  // The host's latest readable word decides; the launcher's only while none has been readable.
  let strict = rendezvous?.strict ?? process.env.PUPPETEER_SHIM_STRICT === '1';
  let retryMs = rendezvous?.retryMs ?? DEFAULT_RETRY_MS;
  // The wait starts once the shim knows it may wait: reading the process table does not spend the host's time.
  let waitingSince: number | undefined;
  let delayMs = 100;
  let waiting = false;
  let asked: Asked;
  for (;;) {
    asked = rendezvous ? await ask(rendezvous, launch, theHost()) : { kind: 'unreachable' };
    if (asked.kind !== 'unreachable' || !strict) break;
    // Wait for the host only in one of its own terminals; anywhere else there is nothing to wait for.
    if (!(await refusableHere())) return fallback();
    waitingSince ??= Date.now();
    const remainingMs = waitingSince + retryMs - Date.now();
    if (remainingMs <= 0) refuse(`not started: ${theHost()} did not answer within ${Math.round(retryMs / 1_000)} s`);
    if (!waiting) {
      waiting = true;
      say(`${name}: waiting for ${theHost()} to start it as a managed session…`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(delayMs, remainingMs)));
    delayMs = Math.min(delayMs * 2, 1_000);
    const reread = await readRendezvous(home);
    rendezvous = reread;
    if (reread) {
      strict = reread.strict;
      retryMs = reread.retryMs;
    }
  }

  if (asked.kind !== 'answer') {
    const reason = asked.kind === 'failed' ? asked.reason : `${theHost()} is unreachable`;
    return strict && (await refusableHere()) ? refuse(`not started: ${reason}`) : fallback();
  }
  const response = asked.response;
  switch (response.action) {
    case 'fallback':
      return fallback();
    case 'refuse':
      // A placed refusal is the host's word on its own terminal. One it could not place binds only in one.
      return response.placed || (await refusableHere()) ? refuse(response.message) : fallback();
    case 'exec':
      try {
        return execInPlace(response.launch.command, response.launch.args, response.launch.cwd, response.launch.env);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The host owns the preparation and its record: tell it, then fall through as for any decline.
        if (rendezvous) {
          await ask(rendezvous, { type: 'exec-failed', preparationId: response.preparationId, message }, theHost());
        }
        process.chdir(originalCwd);
        // The host answered `exec`, so it had placed this launch: a strict host's refusal needs no walk.
        return strict ? refuse(`not started: the managed launch could not run (${message})`) : fallback();
      }
    default:
      return strict && (await refusableHere()) ? refuse(`not started: ${theHost()} answered nonsense`) : fallback();
  }
}

main().catch((error: unknown) => {
  leave(
    `spawn-through failed: ${error instanceof Error ? error.message : String(error)}`,
    SPAWN_THROUGH_EXIT_UNAVAILABLE,
  );
});
