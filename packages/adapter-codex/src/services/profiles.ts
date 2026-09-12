/**
 * Codex account profiles (RFC 006): one persistent `CODEX_HOME` per account,
 * bound to a child process at launch.
 *
 * A profile is a launch selection, never a machine-wide switch. Onboarding runs
 * `codex login` in a host terminal whose output Puppeteer does not capture, and
 * identity comes back from the private app-server's `account/read`, never from
 * terminal text.
 *
 * Probed 2026-09-06 on Codex 0.153.4, `account/read` over the app-server:
 *   logged out → `{ account: null, requiresOpenaiAuth: true }`
 *   logged in  → `{ account: { type: 'chatgpt', email, planType }, requiresOpenaiAuth }`
 * `type` is the documented AuthMode (`chatgpt` | `apikey`); `planType` is the
 * documented PlanType enum. Neither carries a token.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AgentProfile,
  ProfileFailure,
  ProfileIdentity,
  ProfileProvider,
  ProfileService,
  TerminalSpec,
} from '@vibecook/puppeteer-core';
import { PUPPETEER_VERSION } from '@vibecook/puppeteer-core';
import { resolveCodexExecutable } from '../detection.js';
import { AppServerClient, spawnAppServerTransport, type Transport } from '../transport/app-server-client.js';

/** Root variable Codex reads for its data directory. */
export const CODEX_PROFILE_ROOT_VARIABLE = 'CODEX_HOME';

/**
 * Written into a freshly allocated managed root. `keyring` mode derives its
 * account name from the canonical `CODEX_HOME`, which isolates correctly but
 * leaves an OS keychain item behind when the root is removed; `file` keeps the
 * profile self-contained under the root Puppeteer allocated. Credential-free.
 */
const MANAGED_ROOT_CONFIG = 'cli_auth_credentials_store = "file"\n';

const CLIENT_INFO = { name: 'puppeteer-profiles', version: PUPPETEER_VERSION } as const;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

function unavailable(message: string): ProfileFailure {
  return { status: 'unavailable', provider: 'codex', message, retryable: true };
}

/**
 * Decode the app-server `account/read` result. `account: null` is the
 * documented logged-out answer; a response without the key at all is an
 * unrecognized shape, not a logged-out account.
 */
export function codexProfileIdentityFrom(result: unknown, verifiedAt: string): ProfileIdentity | ProfileFailure {
  const response = rec(result);
  if (!response || !('account' in response)) {
    return unavailable('`account/read` returned an unrecognized document');
  }
  const source = { kind: 'native-protocol', stability: 'documented' } as const;
  const account = rec(response.account);
  if (!account) return { loggedIn: false, verifiedAt, source };

  const method = text(account.type);
  const email = text(account.email);
  const plan = text(account.planType);
  return {
    loggedIn: true,
    ...(method ? { method } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    verifiedAt,
    source,
  };
}

export interface CodexProfileOptions {
  executable?: string;
  /** Home directory the native default root hangs off; defaults to the process home. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  requestTimeoutMs?: number;
  /** Injected transport factory; the default spawns `codex app-server` with the profile binding. */
  spawnTransport?: (options: { executable?: string; env?: Record<string, string> }) => Transport;
  /** Injected writer so unit tests never touch a real root. Receives mode 0600 content. */
  writeConfig?: (path: string, contents: string) => Promise<void>;
  /** Injected existence probe; resolves true when the managed root already has a config. */
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

/** Codex profile capability: root binding, native login, native protocol identity read. */
export function createCodexProfileService(options: CodexProfileOptions = {}): ProfileService {
  const ambient = options.env ?? process.env;
  const executable = resolveCodexExecutable(options.executable, ambient);
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const spawnTransport = options.spawnTransport ?? ((spawnOptions) => spawnAppServerTransport(spawnOptions));
  const writeConfig = options.writeConfig ?? defaultWriteConfig;
  const configExists = options.configExists ?? defaultConfigExists;

  const provider: ProfileProvider = {
    id: 'codex',
    label: 'Codex',
    support: {
      supported: true,
      identity: 'native-protocol',
      // Documented skill discovery is repository `.agents/skills`, user
      // `~/.agents/skills`, then `/etc/codex/skills`; none of them live under
      // CODEX_HOME, so every profile sees the same user skills.
      sharedSurfaces: ['~/.agents/skills'],
      nativeDefaultRoot: join(home, '.codex'),
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'managed' ? { [CODEX_PROFILE_ROOT_VARIABLE]: profile.dataRoot } : {};

  return {
    provider,
    bindingEnvironment,

    // CODEX_HOME names the layout root itself: unlike Pi and OpenCode, the
    // bound root is the directory an indexer applies Codex's layout to.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'managed' ? profile.dataRoot : (provider.support.nativeDefaultRoot ?? profile.dataRoot),

    async initializeRoot(profile: AgentProfile): Promise<void> {
      if (profile.kind !== 'managed') return;
      const path = join(profile.dataRoot, 'config.toml');
      // Never overwrite a root the user has already configured or logged into.
      if (await configExists(path)) return;
      await writeConfig(path, MANAGED_ROOT_CONFIG);
    },

    loginInvocation(profile: AgentProfile, loginOptions: { cwd: string }): TerminalSpec {
      // The interactive vendor login; it opens a browser and prints a code.
      return {
        command: executable,
        args: ['login'],
        cwd: loginOptions.cwd,
        env: bindingEnvironment(profile),
      };
    },

    async verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> {
      const binding = bindingEnvironment(profile);
      let transport: Transport | undefined;
      let client: AppServerClient | undefined;
      try {
        transport = spawnTransport({
          executable,
          ...(Object.keys(binding).length > 0 ? { env: binding } : {}),
        });
        client = new AppServerClient(transport, {
          ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        });
        await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
        client.notify('initialized');
        // `refreshToken` stays off: verification observes, it never rotates a
        // credential out from under a live Codex process.
        const result = await client.request('account/read', {});
        return codexProfileIdentityFrom(result, now().toISOString());
      } catch {
        return unavailable('`account/read` could not be completed against the Codex app-server');
      } finally {
        if (client) await client.close();
        else await transport?.close();
      }
    },
  };
}
