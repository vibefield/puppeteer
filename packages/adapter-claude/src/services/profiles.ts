/**
 * Claude Code account profiles (RFC 006): one persistent config root per
 * account, bound to a child process through `CLAUDE_CONFIG_DIR`.
 *
 * A profile is a launch selection, never a machine-wide switch. Onboarding runs
 * the vendor's own `claude auth login` in a host terminal whose output Puppeteer
 * does not capture, and identity comes back from `claude auth status --json`
 * run under the same binding, never from terminal text.
 *
 * Probed 2026-09-06 on Claude Code 2.1.263, `claude auth status --json`:
 *   { loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory,
 *     email, orgId, orgName, subscriptionType }
 * The document carries no token, and this service never reads a credential store.
 *
 * Seen 2026-11-17 on a signed-in Max account at the 20x tier (the Claude Code
 * version was not recorded): the document also holds `planTier`, the family
 * and its tier in one token (`subscriptionType: "max"`, `planTier: "max_20x"`).
 * No other tier's token has been read, nor whether an older Claude Code
 * reports the field at all.
 *
 * Seen 2026-11-17: a managed root signed in through `claude auth login` alone
 * opens the interactive app's first run (the theme picker) at its first
 * session, because the login subcommand does not complete it. `initializeRoot`
 * marks it done for a new root; the key's effect on the current Claude Code is
 * not yet measured.
 *
 * On macOS the credential is NOT in the root: it is a login-Keychain item
 * whose service name is derived from the root's path. Deleting a managed root
 * would leave it behind, so sign-out runs the vendor's own `claude auth
 * logout` under the binding first (the subcommand confirmed on this machine
 * 2026-09-23: "Log out from your Anthropic account").
 */

import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  PlanTierSchema,
  type AgentProfile,
  type PlanTier,
  type ProfileFailure,
  type ProfileIdentity,
  type ProfileProvider,
  type ProfileService,
  type TerminalSpec,
} from '@vibefield/puppeteer-core';
import { ownScriptRunnerFacts, resolveScriptRunner } from '@vibefield/puppeteer-native-observation';
import { resolveClaudeExecutable } from '../detection.js';

/** Root variable Claude Code reads for its config directory. */
export const CLAUDE_PROFILE_ROOT_VARIABLE = 'CLAUDE_CONFIG_DIR';

/**
 * Undocumented override that re-points the directory the Keychain service name
 * hashes from. Forwarding it would let one profile read another profile's
 * credentials, so it is stripped from every probe environment.
 */
const SECURE_STORAGE_OVERRIDE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

/**
 * Written as `.claude.json` into a freshly allocated managed root. The sign-in
 * pane runs the vendor's `claude auth login`, which is not the interactive app,
 * so without this a managed root's first session opens Claude Code's own first
 * run. `hasCompletedOnboarding` is the vendor's app-state key that marks first
 * run done. Credential-free.
 */
const MANAGED_ROOT_STATE = `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`;

const execFileAsync = promisify(execFile);
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/;

/** Injected process runner; `env` carries the profile binding merged over the ambient environment. */
export type ClaudeProfileExec = (
  file: string,
  args: string[],
  /** `strict`: a non-zero exit is a failure whatever it printed (an act, not a read). */
  options: { env: NodeJS.ProcessEnv; strict?: boolean },
) => Promise<{ stdout: string }>;

/**
 * Default runner. A non-zero exit that still printed a document is decoded
 * rather than discarded: `auth status` reports "not logged in" that way. An
 * act runs strict — a logout that failed may well have printed something.
 */
const defaultProfileExec: ClaudeProfileExec = async (file, args, options) => {
  // A script runs under this process's script runner; where there is none (a single executable) the act fails,
  // never runs the script as that executable.
  const script = SCRIPT_EXECUTABLE.test(file);
  const runner = script ? resolveScriptRunner(ownScriptRunnerFacts()) : undefined;
  if (script && runner === undefined) throw new Error(`no program in this process can run the script ${file}`);
  const command = runner ? runner.command : file;
  const commandArgs = runner ? [...runner.args, file, ...args] : args;
  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: { ...options.env, ...runner?.env },
    });
    return { stdout };
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (options.strict !== true && typeof stdout === 'string' && stdout.trim()) return { stdout };
    throw error;
  }
};

export interface ClaudeProfileOptions {
  executable?: string;
  exec?: ClaudeProfileExec;
  /** Home directory the native default root hangs off; defaults to the process home. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Injected writer so unit tests never touch a real root. Receives mode 0600 content. */
  writeConfig?: (path: string, contents: string) => Promise<void>;
  /** Injected existence probe; resolves true when the managed root already has its app-state file. */
  configExists?: (path: string) => Promise<boolean>;
}

async function defaultConfigExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultWriteConfig(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

function unavailable(message: string): ProfileFailure {
  return { status: 'unavailable', provider: 'claude', message, retryable: true };
}

/**
 * Plans shown under another name than the family Claude Code reports. The
 * tool's document never says this name: each row is a naming choice, matched
 * on the family and the tier token exactly (after trimming), and kept by hand
 * when the vendor renames a plan. A plan named here is shown by its name
 * alone, with no tier beside it (`planTier: {}`), though the tool did tell a
 * tier. It is the one place a plan or tier word is compared with a literal;
 * every other tier follows `claudePlanTierFrom`.
 */
const CLAUDE_PLAN_NAMES: readonly { family: string; tier: string; plan: string }[] = [
  { family: 'max', tier: 'max_20x', plan: 'ultra' },
];

/**
 * The tier rule, for a family and tier no row of `CLAUDE_PLAN_NAMES` names:
 * the label a view draws beside the family is the tier token with the family
 * and `_` taken off (`max` + `max_5x` is "5x"), or a one-word token given
 * whole; `{}` when the token is the family itself, which says the plan has no
 * tier beyond its name. Undefined, meaning not read, when the document tells
 * no family or no tier, or a tier in a shape not seen or that core's label
 * rule refuses: a raw token is never shown as a label, and a label never sits
 * beside no name. Both tokens come trimmed and are compared exactly.
 */
function claudePlanTierFrom(family: string | undefined, tier: string | undefined): PlanTier | undefined {
  if (family === undefined || tier === undefined) return undefined;
  if (tier === family) return {};
  const label = tier.startsWith(`${family}_`) ? tier.slice(family.length + 1) : tier;
  return PlanTierSchema.safeParse({ label }).success ? { label } : undefined;
}

/**
 * Decode `claude auth status --json`. Unknown shapes are a failure, not a
 * fabricated "logged out": only the documented boolean answers that question.
 */
export function claudeProfileIdentityFrom(document: unknown, verifiedAt: string): ProfileIdentity | ProfileFailure {
  const status = rec(document);
  if (!status || typeof status.loggedIn !== 'boolean') {
    return unavailable('`claude auth status --json` returned an unrecognized document');
  }
  const method = text(status.authMethod);
  const email = text(status.email);
  const organization = text(status.orgName);
  const family = text(status.subscriptionType);
  const tier = text(status.planTier);
  const named = CLAUDE_PLAN_NAMES.find((row) => row.family === family && row.tier === tier);
  const plan = named?.plan ?? family;
  const planTier: PlanTier | undefined = named !== undefined ? {} : claudePlanTierFrom(family, tier);
  return {
    loggedIn: status.loggedIn,
    ...(method ? { method } : {}),
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
    ...(plan ? { plan } : {}),
    ...(planTier ? { planTier } : {}),
    verifiedAt,
    source: { kind: 'native-status', stability: 'documented' },
  };
}

/** Claude Code profile capability: root binding, native login, native identity read. */
export function createClaudeProfileService(options: ClaudeProfileOptions = {}): ProfileService {
  const exec = options.exec ?? defaultProfileExec;
  const home = options.home ?? homedir();
  const ambient = options.env ?? process.env;
  const executable = resolveClaudeExecutable(options.executable, ambient);
  const now = options.now ?? (() => new Date());
  const writeConfig = options.writeConfig ?? defaultWriteConfig;
  const configExists = options.configExists ?? defaultConfigExists;

  const provider: ProfileProvider = {
    id: 'claude',
    label: 'Claude',
    support: {
      supported: true,
      identity: 'native-status',
      // Project-scoped settings are read from the working tree, not the config
      // root, so every profile in one repository sees the same ones.
      sharedSurfaces: ['project .claude/ settings and .mcp.json'],
      nativeDefaultRoot: join(home, '.claude'),
      // macOS keeps the OAuth credential in a login-Keychain item named after
      // the root's path, outside the root: only `auth logout` removes it.
      credential: 'external',
      service: { id: 'anthropic', label: 'Anthropic' },
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'managed' ? { [CLAUDE_PROFILE_ROOT_VARIABLE]: profile.dataRoot } : {};

  const probeEnvironment = (profile: AgentProfile): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...ambient, ...bindingEnvironment(profile) };
    delete env[SECURE_STORAGE_OVERRIDE];
    // The native default is the vendor's own root: a root variable the host
    // happened to inherit must not re-point a probe — or a sign-out — at
    // another account.
    if (profile.kind !== 'managed') delete env[CLAUDE_PROFILE_ROOT_VARIABLE];
    return env;
  };

  const readIdentity = async (profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> => {
    let stdout: string;
    try {
      stdout = (await exec(executable, ['auth', 'status', '--json'], { env: probeEnvironment(profile) })).stdout;
    } catch {
      return unavailable('`claude auth status --json` could not be run');
    }
    let document: unknown;
    try {
      document = JSON.parse(stdout);
    } catch {
      return unavailable('`claude auth status --json` did not return JSON');
    }
    return claudeProfileIdentityFrom(document, now().toISOString());
  };

  return {
    provider,
    bindingEnvironment,

    // Claude Code writes its transcripts under the config root it was bound
    // to, so the profile root is itself the layout root an indexer reads.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'managed' ? profile.dataRoot : (provider.support.nativeDefaultRoot ?? profile.dataRoot),

    async initializeRoot(profile: AgentProfile): Promise<void> {
      if (profile.kind !== 'managed') return;
      const path = join(profile.dataRoot, '.claude.json');
      // Never overwrite app state that is already there: the vendor's tool rewrites this file itself.
      if (await configExists(path)) return;
      await writeConfig(path, MANAGED_ROOT_STATE);
    },

    loginInvocation(profile: AgentProfile, loginOptions: { cwd: string }): TerminalSpec {
      // The interactive vendor login. It must run in a real terminal; there is
      // no print mode whose output Puppeteer would be allowed to interpret.
      return {
        command: executable,
        args: ['auth', 'login'],
        cwd: loginOptions.cwd,
        env: bindingEnvironment(profile),
      };
    },

    verify: readIdentity,

    async signOut(profile: AgentProfile): Promise<ProfileFailure | undefined> {
      try {
        await exec(executable, ['auth', 'logout'], { env: probeEnvironment(profile), strict: true });
      } catch {
        return unavailable('`claude auth logout` did not complete');
      }
      // The output is the vendor's and is not read; the status afterwards
      // says whether it took, and only a root that reads signed out is one.
      const after = await readIdentity(profile);
      if ('status' in after) return after;
      return after.loggedIn ? unavailable('`claude auth logout` ran, but the root still reads signed in') : undefined;
    },
  };
}
