import { constants, accessSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { AgentLaunchProviderSchema, type AgentLaunchProvider } from '@vibecook/puppeteer-core';

interface ExecResponse {
  action: 'exec';
  preparationId: string;
  launch: { command: string; args: string[]; cwd: string; env?: Record<string, string> };
}

type Response = ExecResponse | { action: 'fallback'; reason: string } | { action: 'ack' };

const shimPath = resolve(process.argv[1]!);
const shimDirectory = dirname(shimPath);
const invokedAs = basename(shimPath);

function readLaunchProviders(): AgentLaunchProvider[] {
  try {
    const parsed = AgentLaunchProviderSchema.array().safeParse(
      JSON.parse(process.env.PUPPETEER_LAUNCH_PROVIDERS ?? '[]'),
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const launchProviders = readLaunchProviders();
const commandRoutes = new Map(
  launchProviders.flatMap((provider) =>
    (provider.nativeInvocation?.commands ?? []).map((command) => [command.name, { provider, command }] as const),
  ),
);
const imposterProviders = new Map(
  launchProviders
    .filter((provider) => provider.nativeInvocation?.imposter !== undefined)
    .map((provider) => [provider.id, provider]),
);

/**
 * `ai --<provider>` is the imposter's own invocation, so the provider comes from the
 * flag rather than from the shim's name, and the flag is stripped before the
 * rest of argv is handed on — everything after it belongs to the vendor, just
 * as it does under a provider-named shim.
 *
 * The configured `ai` still has to exist for this to run at all: the shim
 * execs it, and falls back to it when Godview declines. The package manager
 * puts it there — `pnpm ai:link`, and nothing of ours (docs/archive/IMPOSTER.md §11.1).
 */
const imposter = invokedAs === 'ai';
const originalArgv = process.argv.slice(2);
const flagIndex = imposter
  ? originalArgv.findIndex((argument) => argument.startsWith('--') && imposterProviders.has(argument.slice(2)))
  : -1;
const provider = imposter
  ? flagIndex >= 0
    ? imposterProviders.get(originalArgv[flagIndex]!.slice(2))
    : undefined
  : commandRoutes.get(invokedAs)?.provider;
const forwardedArgv = flagIndex >= 0 ? originalArgv.filter((_, index) => index !== flagIndex) : originalArgv;
const originalCwd = process.cwd();

function cleanPath(): string {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry && resolve(entry) !== shimDirectory)
    .join(delimiter);
}

function executableOnPath(name: string, pathValue: string): string | undefined {
  if (isAbsolute(name)) return name;
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (resolve(candidate) !== shimPath) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

function execEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') environment[name] = value;
  }
  Object.assign(environment, extra);
  environment.PATH = cleanPath();
  const originalZDotDirectory = environment.PUPPETEER_ORIGINAL_ZDOTDIR;
  if (originalZDotDirectory) environment.ZDOTDIR = originalZDotDirectory;
  else delete environment.ZDOTDIR;
  delete environment.PUPPETEER_SPAWN_PORT;
  delete environment.PUPPETEER_SPAWN_TOKEN;
  delete environment.PUPPETEER_SHIM_DIR;
  delete environment.PUPPETEER_ORIGINAL_ZDOTDIR;
  delete environment.PUPPETEER_LAUNCH_PROVIDERS;
  delete environment.PUPPETEER_IMPOSTER_EXECUTABLE;
  return environment;
}

function exec(command: string, args: string[], cwd: string, extraEnvironment?: Record<string, string>): never {
  const environment = execEnvironment(extraEnvironment);
  const executable = executableOnPath(command, environment.PATH) ?? command;
  process.chdir(cwd);
  const execve = process.execve;
  if (!execve) throw new Error('this Node.js version does not provide process.execve');
  execve(executable, [executable, ...args], environment);
  throw new Error('process.execve returned without replacing the shim process');
}

function fallback(realExecutable: string): never {
  try {
    exec(realExecutable, originalArgv, originalCwd);
  } catch (error) {
    process.stderr.write(
      `puppeteer: could not launch ${provider?.id ?? invokedAs}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(127);
  }
}

function request(payload: object): Promise<Response> {
  const port = Number(process.env.PUPPETEER_SPAWN_PORT);
  const token = process.env.PUPPETEER_SPAWN_TOKEN;
  if (!Number.isSafeInteger(port) || port <= 0 || !token) return Promise.reject(new Error('gateway unavailable'));
  return new Promise<Response>((resolveResponse, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else {
        try {
          resolveResponse(JSON.parse(response.trim()) as Response);
        } catch (cause) {
          reject(cause);
        }
      }
    };
    socket.setEncoding('utf8');
    socket.setTimeout(28_000, () => finish(new Error('gateway timed out')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ ...payload, token })}\n`));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.includes('\n')) finish();
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      if (!settled) finish(response.trim() ? undefined : new Error('gateway closed without a response'));
    });
  });
}

async function main(): Promise<never> {
  const configuredExecutable = imposter
    ? (process.env.PUPPETEER_IMPOSTER_EXECUTABLE ?? 'ai')
    : (commandRoutes.get(invokedAs)?.command.executable ?? invokedAs);
  const realExecutable = executableOnPath(configuredExecutable, cleanPath());
  if (!realExecutable) {
    process.stderr.write(`puppeteer: ${configuredExecutable} is not installed outside the Godview shim path\n`);
    process.exit(127);
  }
  // `ai` with no persona flag is the imposter's own error to report, not
  // something to guess at: hand it straight through and let it say so.
  if (!provider?.nativeInvocation) return fallback(realExecutable);
  try {
    const environment: Record<string, string> = {};
    for (const name of provider.nativeInvocation.environmentVariables) {
      const value = process.env[name];
      if (typeof value === 'string') environment[name] = value;
    }
    const response = await request({
      type: 'launch',
      providerId: provider.id,
      cwd: originalCwd,
      argv: forwardedArgv,
      environment,
      pid: process.pid,
      parentPid: process.ppid,
      ...(imposter ? { imposter: true } : {}),
    });
    if (response.action !== 'exec') return fallback(realExecutable);
    try {
      exec(response.launch.command, response.launch.args, response.launch.cwd, response.launch.env);
    } catch (error) {
      await request({
        type: 'exec-failed',
        preparationId: response.preparationId,
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      process.chdir(originalCwd);
      return fallback(realExecutable);
    }
  } catch {
    return fallback(realExecutable);
  }
}

void main();
