/**
 * Grok account profiles (RFC 006): one persistent `GROK_HOME` per account,
 * bound to a child process through Grok's own root variable, which is also the
 * provider's launch allow-list.
 *
 * A profile is a launch selection, never a machine-wide switch. Onboarding runs
 * `grok login` in a host terminal whose output Puppeteer does not capture. The
 * CLI publishes no structured status (no `--json` auth status on 1.0.13,
 * probed 2026-09-06, and still none on 1.0.41), so identity comes back over the
 * agent protocol account usage already speaks, never from terminal text.
 *
 * Probed 2026-09-23 on Grok 1.0.41, `grok agent --no-leader stdio` after
 * `initialize` and without `authenticate`:
 *   `_x.ai/auth/info` → `{ methodId, email, organizationName, teamName, … }`,
 *     `methodId: null` for a root that holds no credential
 *   `_x.ai/billing`   → `{ config, subscription_tier }` once signed in
 *     (`subscriptionTier` on grok-build main); -32000 when signed out
 * Neither carries a token. Both are source-level xAI extensions, not documented
 * ones, so the identity source stays experimental until a Surface claim.
 *
 * Login writes the session to `$GROK_HOME/auth.json`, inside the root: deleting
 * a managed root is its sign-out, and `grok logout` stays the person's own
 * command.
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
} from '@vibefield/puppeteer-core';
import { PUPPETEER_VERSION } from '@vibefield/puppeteer-core';
import { resolveGrokExecutable } from '../detection.js';
import {
  GROK_AUTH_INFO_ACP_METHOD,
  GROK_BILLING_ACP_METHOD,
  GrokAcpClient,
  GrokAcpError,
  JSONRPC_METHOD_NOT_FOUND,
  spawnGrokAgentTransport,
  type GrokAgentTransport,
} from '../transport/agent-client.js';

/** Grok's native root variable; also the provider's launch allow-list entry. */
export const GROK_PROFILE_ROOT_VARIABLE = 'GROK_HOME';

const CLIENT_INFO = { name: 'puppeteer-profiles', version: PUPPETEER_VERSION } as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * All a probe inherits: what the runtime grants a launch (PATH, HOME, login
 * identity, locale, the Windows essentials). Grok also signs in from
 * `XAI_API_KEY`, its legacy `GROK_CODE_XAI_API_KEY`, a raw `GROK_AUTH` document
 * or a `GROK_AUTH_PATH` file, and a probe that inherited one could describe an
 * account the root does not hold. An inherited `GROK_HOME` stays out the same
 * way: only the binding names a root.
 */
const PROBE_INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'];

/** `methodId`s of a credential the root holds: its cached session, or an API key. */
const SIGNED_IN_METHODS: ReadonlySet<string> = new Set(['cached_token', 'xai.api_key']);
/** The interactive logins the agent offers a root that holds neither. */
const SIGNED_OUT_METHODS: ReadonlySet<string> = new Set(['grok.com', 'oidc']);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

function unavailable(message: string): ProfileFailure {
  return { status: 'unavailable', provider: 'grok', message, retryable: true };
}

/**
 * Decode `_x.ai/auth/info`. Only `methodId` says whether the root is signed in:
 * a document without it, or naming a method this adapter does not know, is a
 * failure rather than a guessed sign-out. The fields below are the whole
 * identity; the document's ids, personal names, and avatar URL (which embeds an
 * account id) stay off the profile.
 */
export function grokProfileIdentityFrom(info: unknown, verifiedAt: string): ProfileIdentity | ProfileFailure {
  const document = rec(info);
  const method = document?.methodId;
  const source = { kind: 'native-protocol', stability: 'experimental' } as const;
  if (method === null || (typeof method === 'string' && SIGNED_OUT_METHODS.has(method))) {
    return { loggedIn: false, verifiedAt, source };
  }
  if (!document || typeof method !== 'string') {
    return unavailable('`_x.ai/auth/info` returned an unrecognized document');
  }
  if (!SIGNED_IN_METHODS.has(method)) {
    return unavailable('`_x.ai/auth/info` named an unrecognized sign-in method');
  }
  const email = text(document.email);
  const organization = text(document.organizationName) ?? text(document.teamName);
  return {
    loggedIn: true,
    method,
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
    verifiedAt,
    source,
  };
}

/** The plan is extra: a billing read that fails leaves a signed-in identity without one. */
async function readPlan(client: GrokAcpClient): Promise<string | undefined> {
  try {
    const billing = rec(await client.request(GROK_BILLING_ACP_METHOD, {}));
    return text(billing?.subscription_tier) ?? text(billing?.subscriptionTier);
  } catch {
    return undefined;
  }
}

export interface GrokProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
  /** The environment a probe's own is drawn from; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  requestTimeoutMs?: number;
  /** Injected transport factory; the default spawns `grok agent --no-leader stdio` with exactly `env`. */
  spawnTransport?: (options: { executable: string; env: NodeJS.ProcessEnv }) => GrokAgentTransport;
}

/** Grok profile capability: root binding, native login, native protocol identity read. */
export function createGrokProfileService(options: GrokProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const ambient = options.env ?? process.env;
  const executable = resolveGrokExecutable(options.executable, ambient);
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const spawnTransport = options.spawnTransport ?? spawnGrokAgentTransport;

  const provider: ProfileProvider = {
    id: 'grok',
    label: 'Grok',
    support: {
      supported: true,
      identity: 'native-protocol',
      sharedSurfaces: [],
      nativeDefaultRoot: join(home, '.grok'),
      // The session is `auth.json` inside the root, so deleting a managed root
      // is its sign-out.
      credential: 'root',
      service: { id: 'xai', label: 'xAI' },
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [GROK_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  const probeEnvironment = (profile: AgentProfile): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of PROBE_INHERITED) {
      const value = ambient[name];
      if (value !== undefined) env[name] = value;
    }
    return { ...env, ...bindingEnvironment(profile) };
  };

  return {
    provider,
    bindingEnvironment,
    // GROK_HOME names the layout root itself: unlike Pi and OpenCode, the
    // bound root is the directory an indexer applies Grok's layout to.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'native-default' ? (provider.support.nativeDefaultRoot ?? profile.dataRoot) : profile.dataRoot,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // `grok login` is the native interactive flow; it must run in a real
      // terminal so the host never sees the credential exchange.
      return {
        command: executable,
        args: ['login'],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> {
      let transport: GrokAgentTransport | undefined;
      let client: GrokAcpClient | undefined;
      try {
        transport = spawnTransport({ executable, env: probeEnvironment(profile) });
        client = new GrokAcpClient(transport, requestTimeoutMs);
        await client.request('initialize', {
          protocolVersion: 1,
          clientInfo: CLIENT_INFO,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
        // No `authenticate`: `initialize` has already loaded the root's
        // session, and verification observes a credential, never exercises it.
        const info = await client.request(GROK_AUTH_INFO_ACP_METHOD, {});
        const identity = grokProfileIdentityFrom(info, now().toISOString());
        if ('status' in identity || !identity.loggedIn) return identity;
        const plan = await readPlan(client);
        return plan ? { ...identity, plan } : identity;
      } catch (error) {
        if (error instanceof GrokAcpError && error.body.code === JSONRPC_METHOD_NOT_FOUND) {
          return {
            status: 'unsupported',
            provider: 'grok',
            message: 'this Grok build does not answer `_x.ai/auth/info`',
            retryable: false,
          };
        }
        return unavailable('`_x.ai/auth/info` could not be completed against the Grok agent');
      } finally {
        if (client) await client.close();
        else await transport?.close();
      }
    },
  };
}
