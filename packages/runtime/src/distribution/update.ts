import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import {
  UpdateReceiptSchema,
  type AgentInstallation,
  type DistributionProvider,
  type DistributionService,
  type InstalledAgent,
  type UpdateReceipt,
  type UpdateRecipe,
} from '@vibefield/puppeteer-core';
import { OPERATION_TIMEOUT_MS, installerScriptArgv, operationEnvironment, runOperation } from './operation.js';

/**
 * Run one adapter-declared update recipe.
 *
 * Puppeteer never reimplements an installer. It runs the vendor's own command
 * in the clean agent environment, keeps the output as an opaque 0600
 * transcript that is never parsed for semantics, and decides the outcome by
 * re-inspecting the install afterwards.
 *
 * An update runs unattended: nobody is at its stdin, so it has none (a prompt
 * reads end-of-file instead of waiting forever), and it runs in a session of
 * its own, so nothing it starts can prompt on the host's terminal. Its process
 * GROUP is what a timeout or a stop ends — a git or a curl it started goes too.
 */

/** A stopped updater's grace to exit on SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5_000;

export interface UpdateCommandRequest {
  argv: readonly string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  /** Aborting stops the updater and everything it started. */
  signal?: AbortSignal;
  /** Opaque transcript sink. Callers never interpret the bytes. */
  onOutput(chunk: string): void;
}

export interface UpdateCommandResult {
  exitCode: number | null;
  signal?: string | null;
  /** Short reason when the command could not be started, timed out, or was stopped. */
  error?: string;
}

export type UpdateCommandRunner = (request: UpdateCommandRequest) => Promise<UpdateCommandResult>;

export function defaultUpdateTranscriptsDirectory(home = homedir()): string {
  return join(home, '.puppeteer', 'updates');
}

/** Signal the updater's whole process group (it leads one — see `detached`); a group already gone is fine. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Every member has exited.
  }
}

export const runUpdateCommand: UpdateCommandRunner = (request) =>
  new Promise((resolve) => {
    const [command, ...args] = request.argv;
    let child: ChildProcess;
    try {
      child = spawn(command!, args, {
        env: request.env,
        cwd: request.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A session of its own: no controlling terminal to prompt on, and one group to stop.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolve({ exitCode: null, error: `could not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    let stopped: string | undefined;
    let settled = false;
    const stop = (reason: string): void => {
      if (stopped !== undefined) return;
      stopped = reason;
      signalGroup(child, 'SIGTERM');
      setTimeout(() => signalGroup(child, 'SIGKILL'), STOP_GRACE_MS).unref();
    };
    const budget =
      request.timeoutMs >= 60_000
        ? `${Math.round(request.timeoutMs / 60_000)} min`
        : `${Math.max(1, Math.round(request.timeoutMs / 1_000))} s`;
    const timer = setTimeout(() => stop(`timed out after ${budget}`), request.timeoutMs);
    const onAbort = (): void => stop('stopped before it finished');
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: UpdateCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => request.onOutput(chunk));
    child.stderr?.on('data', (chunk: string) => request.onOutput(chunk));
    child.once('error', (error) => finish({ exitCode: null, error: `could not start: ${error.message}` }));
    child.once('close', (code, signal) =>
      finish({ exitCode: code, signal, ...(stopped === undefined ? {} : { error: stopped }) }),
    );
  });

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the npm that owns a global install.
 *
 * A global package lives at `<prefix>/lib/node_modules/<pkg>`, so the prefix
 * names both the Node that installed it and that Node's bundled npm. Calling
 * them directly keeps a version-managed install (nvm, volta, asdf) from being
 * updated by whichever npm happens to be first on PATH.
 */
export async function resolveNpmCommand(
  install: InstalledAgent,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<string[]> {
  const marker = `${sep}lib${sep}node_modules${sep}`;
  const location = install.location;
  const markerIndex = location?.lastIndexOf(marker) ?? -1;
  if (location && markerIndex > 0) {
    const prefix = location.slice(0, markerIndex);
    const node = join(prefix, 'bin', 'node');
    const npmCli = join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if ((await exists(node)) && (await exists(npmCli))) return [node, npmCli];
  }
  return ['npm'];
}

export async function recipeArgv(
  recipe: UpdateRecipe,
  install: InstalledAgent,
  exists?: (path: string) => Promise<boolean>,
): Promise<string[] | undefined> {
  switch (recipe.kind) {
    case 'native-self-update':
      return [...recipe.argv];
    case 'npm-global': {
      const npm = await resolveNpmCommand(install, exists);
      return [...npm, 'install', '-g', `${recipe.package}@${recipe.version ?? 'latest'}`];
    }
    case 'brew':
      return ['brew', 'upgrade', ...(recipe.cask ? ['--cask'] : []), recipe.name];
    case 'installer-script':
      return installerScriptArgv(recipe.url, 'puppeteer-update', recipe.shell);
    case 'manual':
      return undefined;
  }
}

/** What an update would run for one install: the adapter's recipe resolved the way the runner resolves it. */
export interface InstallationUpdatePlan {
  recipe: UpdateRecipe;
  /** Absent when the recipe is manual. */
  argv?: string[];
}

/**
 * Plan an install's update without running it. The recipe comes from the
 * adapter exactly as {@link runInstallationUpdate} asks for it, so the command
 * a host shows is the command the button runs.
 */
export async function planInstallationUpdate(
  service: DistributionService,
  install: AgentInstallation,
  exists?: (path: string) => Promise<boolean>,
): Promise<InstallationUpdatePlan> {
  const installed = toInstalledAgent(install);
  const recipe = service.recipeFor(installed);
  const argv = await recipeArgv(recipe, installed, exists);
  return argv === undefined ? { recipe } : { recipe, argv };
}

function toInstalledAgent(installation: AgentInstallation): InstalledAgent {
  const { active: _active, origin: _origin, ...install } = installation;
  return install;
}

export interface InstallationUpdateOptions {
  provider: DistributionProvider;
  service: DistributionService;
  install: AgentInstallation;
  /** Fresh inspection after the command finished; the only evidence of success. */
  reinspect(): Promise<AgentInstallation | undefined>;
  transcriptsDirectory?: string;
  run?: UpdateCommandRunner;
  exists?: (path: string) => Promise<boolean>;
  now?: () => Date;
  onError?: (error: Error) => void;
  /** Opaque observer beside the transcript; a throw is contained and reported, never fatal. */
  onOutput?: (chunk: string) => void;
  /** Aborting stops the updater and everything it started; the receipt says so. */
  signal?: AbortSignal;
}

export async function runInstallationUpdate(options: InstallationUpdateOptions): Promise<UpdateReceipt> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const providerId = options.provider.id;
  const before = toInstalledAgent(options.install);
  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  const receipt = (fields: Omit<UpdateReceipt, 'provider' | 'startedAt' | 'finishedAt'>): UpdateReceipt => {
    const candidate = { provider: providerId, startedAt, finishedAt: now().toISOString(), ...fields };
    const parsed = UpdateReceiptSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    report(new Error(`update receipt for ${JSON.stringify(providerId)} failed schema validation`));
    return {
      provider: providerId,
      status: 'failed',
      startedAt,
      finishedAt: now().toISOString(),
      message: 'update receipt could not be assembled',
    };
  };

  let recipe: UpdateRecipe;
  try {
    recipe = options.service.recipeFor(before);
  } catch (error) {
    report(error);
    return receipt({ status: 'failed', before, message: 'adapter could not produce an update recipe' });
  }

  if (recipe.kind === 'manual') {
    return receipt({ status: 'unsupported', recipe, before, message: recipe.instructions });
  }

  const argv = await recipeArgv(recipe, before, options.exists);
  if (!argv || argv.length === 0) {
    return receipt({ status: 'failed', recipe, before, message: 'update recipe produced no command' });
  }

  const { result, transcriptPath } = await runOperation({
    providerId,
    argv,
    env: operationEnvironment({
      path: process.env.PATH,
      scriptEnv: recipe.kind === 'installer-script' ? recipe.env : undefined,
    }),
    timeoutMs:
      (recipe.kind === 'native-self-update' || recipe.kind === 'installer-script' ? recipe.timeoutMs : undefined) ??
      OPERATION_TIMEOUT_MS,
    transcriptsDirectory: options.transcriptsDirectory ?? defaultUpdateTranscriptsDirectory(),
    run: options.run ?? runUpdateCommand,
    signal: options.signal,
    onOutput: options.onOutput,
    report,
  });

  let after: InstalledAgent | undefined;
  try {
    const refreshed = await options.reinspect();
    after = refreshed ? toInstalledAgent(refreshed) : undefined;
  } catch (error) {
    report(error);
  }

  const transcriptFields = transcriptPath === undefined ? {} : { transcriptPath };
  const exitFields = result.exitCode === null ? {} : { exitCode: result.exitCode };
  // A clean exit is one the runner did not end: a stop or a timeout is never success.
  const succeeded = result.exitCode === 0 && result.error === undefined;
  const changed = after !== undefined && after.version !== before.version;

  if (changed) {
    return receipt({
      status: 'updated',
      recipe,
      before,
      after,
      ...exitFields,
      ...transcriptFields,
      message:
        `updated from ${before.version ?? 'unknown'} to ${after?.version ?? 'unknown'}` +
        (result.error === undefined ? '' : `; the updater was then ${result.error}`),
    });
  }
  if (succeeded) {
    // Exit 0 and the same version: current, or an updater that declined —
    // only its output says which, and nothing here reads it.
    return receipt({
      status: 'unchanged',
      recipe,
      before,
      ...(after === undefined ? {} : { after }),
      ...exitFields,
      ...transcriptFields,
      message: `still ${before.version ?? 'the installed version'}`,
    });
  }
  return receipt({
    status: 'failed',
    recipe,
    before,
    ...(after === undefined ? {} : { after }),
    ...exitFields,
    ...transcriptFields,
    message:
      result.error !== undefined && result.exitCode !== 0
        ? `update command ${result.error}`
        : result.exitCode === null
          ? 'update command did not run to completion'
          : `update command exited with ${result.exitCode}`,
  });
}
