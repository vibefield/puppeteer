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
 * On macOS the credential is NOT in the root: it is a login-Keychain item
 * whose service name is derived from the root's path. Deleting a managed root
 * would leave it behind, so sign-out runs the vendor's own `claude auth
 * logout` under the binding first (the subcommand confirmed on this machine
 * 2026-09-23: "Log out from your Anthropic account").
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentProfile,
  ProfileFailure,
  ProfileIdentity,
  ProfileProvider,
  ProfileService,
  TerminalSpec,
} from '@vibecook/puppeteer-core';
import { resolveClaudeExecutable } from '../detection.js';

/** Root variable Claude Code reads for its config directory. */
export const CLAUDE_PROFILE_ROOT_VARIABLE = 'CLAUDE_CONFIG_DIR';

/**
 * Undocumented override that re-points the directory the Keychain service name
 * hashes from. Forwarding it would let one profile read another profile's
 * credentials, so it is stripped from every probe environment.
 */
const SECURE_STORAGE_OVERRIDE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

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
  const isScript = SCRIPT_EXECUTABLE.test(file);
  const command = isScript ? (process.versions.electron ? 'node' : process.execPath) : file;
  const commandArgs = isScript ? [file, ...args] : args;
  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: options.env,
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
  const plan = text(status.subscriptionType);
  return {
    loggedIn: status.loggedIn,
    ...(method ? { method } : {}),
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
    ...(plan ? { plan } : {}),
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
