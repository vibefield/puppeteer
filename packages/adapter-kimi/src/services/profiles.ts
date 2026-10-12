/**
 * Kimi Code account profiles (RFC 006), bound through the native
 * `KIMI_CODE_HOME` variable that already forms the provider's launch
 * allow-list.
 *
 * A profile is a launch selection, never a machine-wide switch. Onboarding runs
 * `kimi login` (a device code) in a host terminal whose output Puppeteer does
 * not capture. Identity comes back from the managed platform's `GET {base}/me`,
 * the profile document the official CLI parses (`managed-userinfo.ts` in
 * kimi-code), read with the access token Kimi Code already stored in the root.
 * Kimi Code has no `auth status`, and its access token carries no email or plan.
 *
 * `GET {base}/me` as the CLI's parser reads it (the same parser is embedded in
 * the 2.0.2 binary installed 2026-09-23; that day's probe met an expired grant
 * and saw only 401s):
 *   { user_id, nickname, status, region, user_level, user_level_name, domain,
 *     domain_name, email?, username?, phone?, avatar?, bio?, global_id?, … }
 * Only `email` and `user_level_name` are kept. The local server's
 * `/api/v1/oauth/userinfo` serves the same document but refreshes the grant
 * first and rewrites the credential file when that fails, so it is never used.
 *
 * Kimi Code's only token store is a file inside the root
 * (`credentials/kimi-code.json`): deleting a managed root is its sign-out, and
 * this service has no `signOut`.
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
import { resolveKimiExecutable } from '../detection.js';
import {
  getKimiCodeDocument,
  kimiCodeCredentialPath,
  readKimiCodeCredential,
  resolveKimiCodeBaseUrl,
  type KimiCodeResponse,
} from '../transport/managed-platform.js';

/** Kimi's native root variable; also the provider's launch allow-list entry. */
export const KIMI_PROFILE_ROOT_VARIABLE = 'KIMI_CODE_HOME';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SOURCE = { kind: 'native-status', stability: 'documented' } as const;

export interface KimiProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
  /** Ambient environment: `KIMI_CODE_HOME` for the native default, `KIMI_CODE_BASE_URL` for every profile. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Injected so unit tests never reach Kimi's platform. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/**
 * The root whose credential, config and region marker describe a profile's
 * account. A managed profile is its bound root; the native default is the root
 * Kimi Code resolves with nothing bound: `KIMI_CODE_HOME`, else `~/.kimi-code`.
 * Identity and usage both read it, so one row never pairs one account's name
 * with another account's usage.
 */
export function kimiCredentialRoot(
  profile: AgentProfile | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (profile?.kind === 'managed') return profile.dataRoot;
  const configured = env[KIMI_PROFILE_ROOT_VARIABLE]?.trim();
  if (!configured) return join(home, '.kimi-code');
  if (configured === '~') return home;
  return configured.startsWith('~/') ? join(home, configured.slice(2)) : configured;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

function unavailable(message: string): ProfileFailure {
  return { status: 'unavailable', provider: 'kimi', message, retryable: true };
}

/**
 * Decode the `/me` document. A string `user_id` is what makes it a profile, as
 * it is for the CLI's own parser; without one the document is malformed, not a
 * signed-out account. The document also carries a phone number, avatar, bio
 * and ids, none of which leave this function.
 */
export function kimiProfileIdentityFrom(document: unknown, verifiedAt: string): ProfileIdentity | ProfileFailure {
  const me = rec(document);
  if (!me || !text(me.user_id)) return unavailable('`GET /me` returned a document without a user_id');
  const email = text(me.email);
  const plan = text(me.user_level_name);
  return {
    loggedIn: true,
    // The OAuth scope every managed Kimi Code sign-in holds.
    method: 'kimi-code',
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    verifiedAt,
    source: SOURCE,
  };
}

/** Every answer but a document is a failure: a rejected token is not a signed-out root. */
function failedRead(response: Exclude<KimiCodeResponse, { status: 'ok' }>): ProfileFailure {
  if (response.status === 'http-error') return unavailable(`\`GET /me\` failed with HTTP ${response.httpStatus}`);
  if (response.status === 'invalid-json') return unavailable('`GET /me` did not return JSON');
  return unavailable('`GET /me` could not be completed');
}

/** Kimi Code profile capability: root binding, native login, managed-platform identity read. */
export function createKimiProfileService(options: KimiProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const ambient = options.env ?? process.env;
  const executable = resolveKimiExecutable(options.executable, ambient);
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const provider: ProfileProvider = {
    id: 'kimi',
    label: 'Kimi',
    support: {
      supported: true,
      identity: 'native-status',
      sharedSurfaces: [],
      nativeDefaultRoot: join(home, '.kimi-code'),
      // Kimi Code's only token store is file-backed, under the root's
      // credentials directory.
      credential: 'root',
      service: { id: 'kimi', label: 'Moonshot AI' },
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [KIMI_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  return {
    provider,
    bindingEnvironment,
    // KIMI_CODE_HOME names the layout root itself: unlike Pi and OpenCode, the
    // bound root is the directory an indexer applies Kimi's layout to.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'native-default' ? (provider.support.nativeDefaultRoot ?? profile.dataRoot) : profile.dataRoot,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // `kimi login` runs the native device-code flow; it must own a real
      // terminal so the host never observes the credential exchange.
      return {
        command: executable,
        args: ['login'],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> {
      const root = kimiCredentialRoot(profile, ambient, home);
      const readAt = now();
      const credential = await readKimiCodeCredential(kimiCodeCredentialPath(root), readAt.valueOf());
      if (credential.state === 'signed-out') {
        return { loggedIn: false, verifiedAt: readAt.toISOString(), source: SOURCE };
      }
      // The access token lives fifteen minutes. Renewing it would spend the
      // refresh token Kimi Code owns, so a lapsed one waits for Kimi Code to run.
      if (credential.state === 'expired') {
        return unavailable("Kimi Code's access token has expired; Kimi Code renews it while it runs");
      }
      if (credential.state === 'unreadable') return unavailable("Kimi Code's credential file could not be read");
      const baseUrl = await resolveKimiCodeBaseUrl(root, ambient);
      const response = await getKimiCodeDocument(`${baseUrl}/me`, credential.accessToken, {
        timeoutMs,
        fetchImpl: options.fetchImpl,
      });
      if (response.status !== 'ok') return failedRead(response);
      return kimiProfileIdentityFrom(response.body, now().toISOString());
    },
  };
}
