import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open } from 'node:fs/promises';
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
} from '@vibecook/puppeteer-core';
import { buildAgentEnvironment } from '../host/environment.js';

/**
 * Run one adapter-declared update recipe.
 *
 * Puppeteer never reimplements an installer. It runs the vendor's own command
 * in the clean agent environment, keeps the output as an opaque 0600
 * transcript that is never parsed for semantics, and decides the outcome by
 * re-inspecting the install afterwards.
 */

/** Vendor updaters download and verify archives; a short timeout would abort healthy runs. */
const UPDATE_TIMEOUT_MS = 15 * 60_000;
const TRANSCRIPT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_DIRECTORY_MODE = 0o700;
const TRANSCRIPT_FILE_MODE = 0o600;

export interface UpdateCommandRequest {
  argv: readonly string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  /** Opaque transcript sink. Callers never interpret the bytes. */
  onOutput(chunk: string): void;
}

export interface UpdateCommandResult {
  exitCode: number | null;
  signal?: string | null;
  /** Short reason when the command could not be started or was killed. */
  error?: string;
}

export type UpdateCommandRunner = (request: UpdateCommandRequest) => Promise<UpdateCommandResult>;

export function defaultUpdateTranscriptsDirectory(home = homedir()): string {
  return join(home, '.puppeteer', 'updates');
}

const defaultCommandRunner: UpdateCommandRunner = (request) =>
  new Promise((resolve) => {
    const [command, ...args] = request.argv;
    const child = execFile(
      command!,
      args,
      {
        env: request.env,
        cwd: request.cwd,
        timeout: request.timeoutMs,
        maxBuffer: TRANSCRIPT_MAX_BUFFER_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error) => {
        const failure = error as (Error & { code?: number | string; signal?: string | null }) | null;
        resolve({
          exitCode: typeof failure?.code === 'number' ? failure.code : failure ? null : 0,
          signal: failure?.signal ?? null,
          ...(failure ? { error: failure.message } : {}),
        });
      },
    );
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => request.onOutput(chunk));
    child.stderr?.on('data', (chunk: string) => request.onOutput(chunk));
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
}

interface TranscriptSink {
  path?: string;
  write(chunk: string): void;
  close(): Promise<void>;
}

async function openTranscript(directory: string, providerId: string): Promise<TranscriptSink> {
  await mkdir(directory, { recursive: true, mode: TRANSCRIPT_DIRECTORY_MODE });
  const path = join(directory, `${providerId}-${Date.now()}-${randomUUID()}.log`);
  // 'ax' fails rather than truncating; the mode applies because the file is new.
  const handle = await open(path, 'ax', TRANSCRIPT_FILE_MODE);
  let chain: Promise<unknown> = Promise.resolve();
  return {
    path,
    write(chunk) {
      chain = chain.then(() => handle.write(chunk)).catch(() => undefined);
    },
    async close() {
      await chain;
      await handle.close().catch(() => undefined);
    },
  };
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

  const environment = buildAgentEnvironment({
    ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
    ...(process.env.HOME === undefined ? {} : { home: process.env.HOME }),
  });
  const transcriptsDirectory = options.transcriptsDirectory ?? defaultUpdateTranscriptsDirectory();
  let transcript: TranscriptSink;
  try {
    transcript = await openTranscript(transcriptsDirectory, providerId);
  } catch (error) {
    // A missing transcript must not block an update the user asked for.
    report(error);
    transcript = { write: () => undefined, close: async () => undefined };
  }

  let result: UpdateCommandResult;
  try {
    result = await (options.run ?? defaultCommandRunner)({
      argv,
      env: environment,
      cwd: environment.HOME ?? process.cwd(),
      timeoutMs: UPDATE_TIMEOUT_MS,
      onOutput: (chunk) => {
        transcript.write(chunk);
        if (options.onOutput === undefined) return;
        try {
          options.onOutput(chunk);
        } catch (error) {
          // The person asked for the update; a host's display failing must not stop it.
          report(error);
        }
      },
    });
  } catch (error) {
    report(error);
    result = { exitCode: null, error: 'update command could not be started' };
  } finally {
    await transcript.close();
  }

  let after: InstalledAgent | undefined;
  try {
    const refreshed = await options.reinspect();
    after = refreshed ? toInstalledAgent(refreshed) : undefined;
  } catch (error) {
    report(error);
  }

  const transcriptFields = transcript.path === undefined ? {} : { transcriptPath: transcript.path };
  const exitFields = result.exitCode === null ? {} : { exitCode: result.exitCode };
  const succeeded = result.exitCode === 0;
  const changed = after !== undefined && after.version !== before.version;

  if (changed) {
    return receipt({
      status: 'updated',
      recipe,
      before,
      after,
      ...exitFields,
      ...transcriptFields,
      message: `updated from ${before.version ?? 'unknown'} to ${after?.version ?? 'unknown'}`,
    });
  }
  if (succeeded) {
    return receipt({
      status: 'already-current',
      recipe,
      before,
      ...(after === undefined ? {} : { after }),
      ...exitFields,
      ...transcriptFields,
      message: `already at ${before.version ?? 'the installed version'}`,
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
      result.exitCode === null
        ? 'update command did not run to completion'
        : `update command exited with ${result.exitCode}`,
  });
}
