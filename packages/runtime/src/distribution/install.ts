import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import {
  InstallReceiptSchema,
  InstallRecipeSchema,
  type AgentInstallation,
  type DistributionProvider,
  type DistributionService,
  type InstallReceipt,
  type InstallRecipe,
  type InstalledAgent,
} from '@vibefield/puppeteer-core';
import { searchPathDirectories } from './inventory.js';
import { OPERATION_TIMEOUT_MS, installerScriptArgv, operationEnvironment, runOperation } from './operation.js';
import { defaultUpdateTranscriptsDirectory, runUpdateCommand, type UpdateCommandRunner } from './update.js';

/**
 * Install an agent this machine does not have, with the vendor's own
 * documented installer (RFC 006, "Installs").
 *
 * The same rule as an update: Puppeteer never reimplements an installer. The
 * recipe is the adapter's; the command runs through the update runner,
 * unattended, in the clean agent environment, with its output kept as an
 * opaque 0600 transcript; the outcome is a fresh inspection. The installer
 * runs with the search path the inventory reads, so the commands it needs and
 * the agent it leaves are looked for in one place.
 */

/** The command an install recipe runs, resolved the way the runner resolves it; absent when it is manual. */
export function installArgv(recipe: InstallRecipe): string[] | undefined {
  switch (recipe.kind) {
    case 'installer-script':
      return installerScriptArgv(recipe.url, 'puppeteer-install', recipe.shell);
    case 'npm-global':
      // Nothing is installed yet, so no install names the npm that owns it: the search path's npm installs.
      return ['npm', 'install', '-g', `${recipe.package}@${recipe.version ?? 'latest'}`];
    case 'brew':
      return ['brew', 'install', ...(recipe.cask ? ['--cask'] : []), recipe.name];
    case 'manual':
      return undefined;
  }
}

/** The commands an install recipe runs from the search path, and those its script says it needs. */
export function installRequires(recipe: InstallRecipe): string[] {
  switch (recipe.kind) {
    case 'installer-script':
      return [...new Set(['curl', recipe.shell ?? 'bash', ...(recipe.needs ?? [])])];
    case 'npm-global':
      return ['npm'];
    case 'brew':
      return ['brew'];
    case 'manual':
      return [];
  }
}

/** An adapter's install recipe as read, or why it could not be: absent when the adapter declares no install. */
export type InstallRecipeRead = { ok: true; recipe: InstallRecipe | undefined } | { ok: false; message: string };

/** Ask the adapter for its install recipe and hold it to the schema before anything is planned or run. */
export function readInstallRecipe(service: DistributionService, report: (error: unknown) => void): InstallRecipeRead {
  let declared: unknown;
  try {
    declared = service.installRecipe?.();
  } catch (error) {
    report(error);
    return { ok: false, message: 'adapter could not produce an install recipe' };
  }
  if (declared === undefined) return { ok: true, recipe: undefined };
  const parsed = InstallRecipeSchema.safeParse(declared);
  if (!parsed.success) {
    report(new Error(`install recipe failed schema validation: ${parsed.error.message}`));
    return { ok: false, message: 'adapter produced an invalid install recipe' };
  }
  return { ok: true, recipe: parsed.data };
}

/** Why a recipe cannot run on this platform, or undefined when it can. */
export function installUnsupportedHere(
  provider: DistributionProvider,
  recipe: InstallRecipe,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (recipe.kind === 'installer-script' && platform === 'win32') {
    return `${provider.label}'s install script runs on macOS and Linux only`;
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function missingCommands(
  commands: readonly string[],
  searchPath: string | undefined,
  executable: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const directories = searchPathDirectories(searchPath);
  const missing: string[] = [];
  for (const command of commands) {
    let found = false;
    for (const directory of directories) {
      if (await executable(join(directory, command))) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(command);
  }
  return missing;
}

/** What an install would run, said before anything runs. */
export interface AgentInstallPlan {
  recipe: InstallRecipe;
  /** The command the runner would execute; absent when the recipe is manual. */
  argv?: string[];
  /** The commands {@link argv} runs from the search path. */
  requires: string[];
  /** Of those, the ones the search path does not hold now: the install would not run. */
  missing: string[];
}

export async function planAgentInstall(
  recipe: InstallRecipe,
  options: { searchPath: string | undefined; executable?: (path: string) => Promise<boolean> },
): Promise<AgentInstallPlan> {
  const argv = installArgv(recipe);
  const requires = installRequires(recipe);
  const missing = await missingCommands(requires, options.searchPath, options.executable ?? isExecutable);
  return argv === undefined ? { recipe, requires, missing } : { recipe, argv, requires, missing };
}

export interface AgentInstallOptions {
  provider: DistributionProvider;
  service: DistributionService;
  /**
   * A fresh inspection of the provider's installs: before the installer, one
   * found means nothing runs; after it, the only evidence of success.
   */
  inspect(): Promise<AgentInstallation | undefined>;
  /** PATH-style list the installer runs with and the inventory searches. */
  searchPath: string | undefined;
  /** The person's login shell, which an installer reads to choose the rc file it edits; defaults to SHELL. */
  shell?: string;
  platform?: NodeJS.Platform;
  transcriptsDirectory?: string;
  run?: UpdateCommandRunner;
  /** Whether a path is an executable file; the search for the commands a recipe needs. */
  executable?: (path: string) => Promise<boolean>;
  now?: () => Date;
  onError?: (error: Error) => void;
  /** Opaque observer beside the transcript; a throw is contained and reported, never fatal. */
  onOutput?: (chunk: string) => void;
  /** Aborting stops the installer and everything it started; the receipt says so. */
  signal?: AbortSignal;
}

function toInstalledAgent(installation: AgentInstallation): InstalledAgent {
  const { active: _active, origin: _origin, ...install } = installation;
  return install;
}

export async function runAgentInstall(options: AgentInstallOptions): Promise<InstallReceipt> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { provider } = options;
  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));

  const receipt = (fields: Omit<InstallReceipt, 'provider' | 'startedAt' | 'finishedAt'>): InstallReceipt => {
    const candidate = { provider: provider.id, startedAt, finishedAt: now().toISOString(), ...fields };
    const parsed = InstallReceiptSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    report(new Error(`install receipt for ${JSON.stringify(provider.id)} failed schema validation`));
    return {
      provider: provider.id,
      status: 'failed',
      startedAt,
      finishedAt: now().toISOString(),
      message: 'install receipt could not be assembled',
    };
  };

  const inspect = async (): Promise<InstalledAgent | undefined> => {
    const found = await options.inspect();
    return found === undefined ? undefined : toInstalledAgent(found);
  };

  let present: InstalledAgent | undefined;
  try {
    present = await inspect();
  } catch (error) {
    // Never run an installer over an install nobody could see.
    report(error);
    return receipt({ status: 'failed', message: `could not tell whether ${provider.label} is installed` });
  }
  if (present !== undefined) {
    return receipt({
      status: 'present',
      after: present,
      message: `${provider.label} is already installed at ${present.executable}`,
    });
  }

  const read = readInstallRecipe(options.service, report);
  if (!read.ok) return receipt({ status: 'failed', message: read.message });
  const { recipe } = read;
  if (recipe === undefined) {
    return receipt({ status: 'unsupported', message: `${provider.label} declares no install` });
  }
  if (recipe.kind === 'manual') {
    return receipt({ status: 'unsupported', recipe, message: recipe.instructions });
  }
  const unsupported = installUnsupportedHere(provider, recipe, options.platform);
  if (unsupported !== undefined) {
    return receipt({ status: 'unsupported', recipe, message: unsupported });
  }

  const plan = await planAgentInstall(recipe, {
    searchPath: options.searchPath,
    ...(options.executable === undefined ? {} : { executable: options.executable }),
  });
  if (plan.missing.length > 0) {
    return receipt({
      status: 'failed',
      recipe,
      missing: plan.missing,
      message: `needs ${plan.missing.join(' and ')}, which ${plan.missing.length === 1 ? 'is' : 'are'} not on the search path`,
    });
  }
  if (plan.argv === undefined || plan.argv.length === 0) {
    return receipt({ status: 'failed', recipe, message: 'install recipe produced no command' });
  }

  const { result, transcriptPath } = await runOperation({
    providerId: provider.id,
    argv: plan.argv,
    env: operationEnvironment({
      path: options.searchPath,
      scriptEnv: recipe.kind === 'installer-script' ? recipe.env : undefined,
      shell: options.shell ?? process.env.SHELL,
    }),
    timeoutMs: (recipe.kind === 'installer-script' ? recipe.timeoutMs : undefined) ?? OPERATION_TIMEOUT_MS,
    transcriptsDirectory: options.transcriptsDirectory ?? defaultUpdateTranscriptsDirectory(),
    run: options.run ?? runUpdateCommand,
    signal: options.signal,
    onOutput: options.onOutput,
    report,
  });

  let after: InstalledAgent | undefined;
  try {
    after = await inspect();
  } catch (error) {
    report(error);
  }
  const transcriptFields = transcriptPath === undefined ? {} : { transcriptPath };
  const exitFields = result.exitCode === null ? {} : { exitCode: result.exitCode };
  // A clean exit is one the runner did not end: a stop or a timeout is never success.
  const succeeded = result.exitCode === 0 && result.error === undefined;

  if (after !== undefined) {
    const ending =
      result.error !== undefined
        ? `; the installer was then ${result.error}`
        : result.exitCode !== 0 && result.exitCode !== null
          ? `; the installer then exited with ${result.exitCode}`
          : '';
    return receipt({
      status: 'installed',
      recipe,
      after,
      ...exitFields,
      ...transcriptFields,
      message: `installed ${provider.label}${after.version === undefined ? '' : ` ${after.version}`}${ending}`,
    });
  }
  if (succeeded) {
    return receipt({
      status: 'not-found',
      recipe,
      ...exitFields,
      ...transcriptFields,
      message: `the installer finished, but no ${provider.label} was found on the search path or in its install directories`,
    });
  }
  return receipt({
    status: 'failed',
    recipe,
    ...exitFields,
    ...transcriptFields,
    message:
      result.error !== undefined && result.exitCode !== 0
        ? `install command ${result.error}`
        : result.exitCode === null
          ? 'install command did not run to completion'
          : `install command exited with ${result.exitCode}`,
  });
}
