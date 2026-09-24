/**
 * Copilot CLI account profiles (RFC 006): one persistent `COPILOT_HOME` per
 * account, bound through the native root variable that already forms the
 * provider's launch allow-list.
 *
 * A profile is a launch selection, never a machine-wide switch. Onboarding runs
 * the vendor's own interactive `copilot login` in a host terminal whose output
 * Puppeteer does not capture, and identity comes back from the JSON-RPC server
 * the official SDK drives (`copilot --server --stdio`), never from terminal
 * text. That flag is not in `copilot --help` and the SDK marks its types
 * experimental, so the identity source is marked experimental too.
 *
 * Probed 2026-09-23 on Copilot 1.0.88: `ping` answers `protocolVersion: 3`, and
 * `auth.getStatus` answers { isAuthenticated, authType, host, login,
 * statusMessage } — no email, organization, plan, or token. `authType` names the
 * credential that won: `user` for Copilot's own login, `gh-cli`, or an env/token
 * variant. Only a `user` status is followed by `account.getCurrentAuth`, whose
 * `copilotUser` snapshot names the plan family; that method's other variants are
 * specified to carry the secret itself, so they are never asked for.
 *
 * The credential is NOT in the root. The OAuth token is one OS keychain item
 * per GitHub login (service `copilot-cli`, account `https://<host>:<login>`),
 * shared by every root signed in as that login, and a root with no login of its
 * own runs as GitHub CLI's user. `account.logout` would remove the shared item
 * from under every such root and has not been probed, so there is no sign-out.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentProfile,
  ProfileFailure,
  ProfileIdentity,
  ProfileProvider,
  ProfileService,
  TerminalSpec,
} from '@vibecook/puppeteer-core';
import { resolveCopilotExecutable } from '../detection.js';
import {
  CopilotServerClient,
  spawnCopilotServerTransport,
  type CopilotServerTransport,
} from '../transport/server-client.js';

/** Copilot's native root variable; also the provider's launch allow-list entry. */
export const COPILOT_PROFILE_ROOT_VARIABLE = 'COPILOT_HOME';

/** The server protocol the identity read was written against; any other version is not read. */
const SERVER_PROTOCOL_VERSION = 3;

/**
 * All the identity server takes from the ambient environment: enough to find
 * the executable, the user's home and login keychain, a locale and a temp
 * directory, plus what a Windows process needs to start. Never a token
 * variable — `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` outrank the
 * root's own login and would answer for their account — and never an inherited
 * `COPILOT_HOME`, which would re-point the native default at another root.
 */
const PROBE_ENVIRONMENT = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
] as const;

/**
 * Keys that hold a secret in the published `AuthInfo` variants (`token` in
 * gh-cli, env and token; `hmac`; `apiKey`) and any other key a later build
 * might name for one. `token_based_billing`, which the live `user` document
 * carries, is a flag and does not match.
 */
const SECRET_FIELD = /(?:token|hmac|api_?key|secret|password)$/iu;

export interface CopilotProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
  /** Ambient environment the executable and the probe environment are drawn from; defaults to the process's own. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  requestTimeoutMs?: number;
  /** Injected transport factory; the default spawns `copilot --server --stdio` with exactly `env`. */
  spawnTransport?: (options: { executable: string; env: Record<string, string> }) => CopilotServerTransport;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

function unavailable(message: string): ProfileFailure {
  return { status: 'unavailable', provider: 'copilot', message, retryable: true };
}

/** True when a key named for a secret appears anywhere in `value`. */
function carriesSecret(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === null || typeof next !== 'object') continue;
    for (const [key, child] of Object.entries(next)) {
      if (SECRET_FIELD.test(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

/**
 * `authType`s that are another program's sign-in: with no login of its own in
 * the root, Copilot acts as the GitHub CLI's user — the same account in every
 * root that has none, so the identity says whose it is.
 */
const BORROWED_AUTH = new Map([['gh-cli', 'GitHub CLI']]);

/**
 * Decode `auth.getStatus`. Only the documented boolean says whether anyone is
 * signed in; a document without it, or one that carries a secret, is not the
 * credential-free status this reader was built for. The account is `login`,
 * never `statusMessage`, which only happened to echo it.
 */
export function copilotProfileIdentityFrom(result: unknown, verifiedAt: string): ProfileIdentity | ProfileFailure {
  const status = rec(result);
  if (!status || typeof status.isAuthenticated !== 'boolean' || carriesSecret(status)) {
    return unavailable('`auth.getStatus` returned an unrecognized document');
  }
  const source = { kind: 'native-protocol', stability: 'experimental' } as const;
  // Nobody is signed in. A login beside `false` is at most config.json's
  // record of who once signed in there, not who the next process will be.
  if (!status.isAuthenticated) return { loggedIn: false, verifiedAt, source };

  const method = text(status.authType);
  const account = text(status.login);
  const borrowedFrom = method === undefined ? undefined : BORROWED_AUTH.get(method);
  return {
    loggedIn: true,
    ...(method ? { method } : {}),
    ...(account ? { account } : {}),
    ...(borrowedFrom ? { borrowedFrom } : {}),
    verifiedAt,
    source,
  };
}

/**
 * The plan and organization from `account.getCurrentAuth`, allowlisted from
 * its `copilotUser` snapshot. Nothing is taken from a document that carries a
 * secret anywhere, or whose credential is not Copilot's own login for the
 * account the status reported: the plan would then travel beside a token, or
 * describe someone else.
 *
 * `organization_login_list` names every organization the login's Copilot
 * access comes through and does not say which one bills it. An organization
 * is one name, so only a list of exactly one yields it; an individual plan's
 * empty list yields none.
 */
export function copilotPlanFrom(
  result: unknown,
  account: string | undefined,
): Pick<ProfileIdentity, 'plan' | 'organization'> {
  const document = rec(result);
  if (!document || carriesSecret(document)) return {};
  const auth = rec(document.authInfo);
  // GitHub logins are case-insensitive, so `Octo-Dev` and `octo-dev` are one account.
  const login = text(auth?.login)?.toLowerCase();
  if (!auth || auth.type !== 'user' || login === undefined || login !== account?.toLowerCase()) return {};

  const user = rec(auth.copilotUser);
  const plan = text(user?.copilot_plan);
  const organizations = user?.organization_login_list;
  const organization = Array.isArray(organizations) && organizations.length === 1 ? text(organizations[0]) : undefined;
  return { ...(plan ? { plan } : {}), ...(organization ? { organization } : {}) };
}

/** Copilot CLI profile capability: root binding, native login, native protocol identity read. */
export function createCopilotProfileService(options: CopilotProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const ambient = options.env ?? process.env;
  const executable = resolveCopilotExecutable(options.executable, ambient);
  const now = options.now ?? (() => new Date());
  const spawnTransport = options.spawnTransport ?? spawnCopilotServerTransport;

  const provider: ProfileProvider = {
    id: 'copilot',
    label: 'GitHub Copilot',
    support: {
      supported: true,
      identity: 'native-protocol',
      // Copilot reads the cross-agent personal skills directory (`copilot skill
      // list --json` labels it `personal-agents`, verified 2026-09-06 on 1.0.80),
      // which no root variable redirects. The sign-in is not per root either: it
      // is kept per GitHub login, with GitHub CLI's as the fallback.
      sharedSurfaces: [
        join(home, '.agents', 'skills'),
        'one copilot-cli keychain item per GitHub login',
        "GitHub CLI's login in any root without a Copilot login",
      ],
      nativeDefaultRoot: join(home, '.copilot'),
      // The OAuth token is a keychain item keyed on the GitHub login, not the
      // root: deleting a managed root leaves it behind.
      credential: 'external',
      service: { id: 'github', label: 'GitHub' },
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [COPILOT_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  const probeEnvironment = (profile: AgentProfile): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const name of PROBE_ENVIRONMENT) {
      const value = ambient[name];
      if (value !== undefined) env[name] = value;
    }
    return { ...env, ...bindingEnvironment(profile) };
  };

  return {
    provider,
    bindingEnvironment,
    // COPILOT_HOME names the layout root itself: unlike Pi and OpenCode, the
    // bound root is the directory an indexer applies Copilot's layout to.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'native-default' ? (provider.support.nativeDefaultRoot ?? profile.dataRoot) : profile.dataRoot,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // `copilot login` is the native interactive device flow; it must run in a
      // real terminal so the host never observes the credential exchange.
      return {
        command: executable,
        args: ['login'],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> {
      let transport: CopilotServerTransport | undefined;
      let client: CopilotServerClient | undefined;
      try {
        transport = spawnTransport({ executable, env: probeEnvironment(profile) });
        client = new CopilotServerClient(transport, {
          ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        });
        const ping = rec(await client.request('ping'));
        if (ping?.protocolVersion !== SERVER_PROTOCOL_VERSION) {
          return unavailable(`the Copilot server does not speak protocol version ${SERVER_PROTOCOL_VERSION}`);
        }
        const identity = copilotProfileIdentityFrom(await client.request('auth.getStatus'), now().toISOString());
        // Only Copilot's own login is asked for its plan. A `gh-cli` status is
        // the truth about a root with no login of its own: the process will
        // act as the GitHub CLI's user, and the row says so without a plan.
        if ('status' in identity || identity.method !== 'user') return identity;
        let current: unknown;
        try {
          current = await client.request('account.getCurrentAuth');
        } catch {
          return identity;
        }
        return { ...identity, ...copilotPlanFrom(current, identity.account) };
      } catch {
        return unavailable('`auth.getStatus` could not be completed against the Copilot server');
      } finally {
        if (client) await client.close();
        else await transport?.close();
      }
    },
  };
}
