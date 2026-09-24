/**
 * Antigravity account profiles (RFC 006): one persistent home per account,
 * bound to a child process through the adapter-owned
 * `PUPPETEER_ANTIGRAVITY_HOME`, which the driver turns into `HOME`. The CLI
 * keeps its store at `<home>/.gemini/antigravity-cli`.
 *
 * A profile is a launch selection, never a machine-wide switch. There is no
 * login subcommand (1.1.21 answered `agy help login` with "unknown subcommand:
 * login", and 1.2.9's `agy --help` still lists none), so onboarding runs `agy`
 * itself in a host terminal whose output Puppeteer does not capture: an empty
 * home opens the browser sign-in, or prints a URL where there is no local
 * browser.
 *
 * Identity is read back from the credential file that sign-in leaves in the
 * store, probed 2026-09-23 on 1.2.9:
 *   <home>/.gemini/antigravity-cli/antigravity-oauth-token
 *   { token: { access_token, token_type, refresh_token, expiry }, auth_method, id_token }
 * `token` is never read. The ID token's payload is decoded locally, with no
 * signature check and no network, for `email` and `hd` only; nothing
 * non-interactive names the plan. A home holding only this file signed in, so
 * the file is the session, but its name and shape are undocumented: the
 * identity is `experimental`.
 *
 * There is no `signOut`. The only native one is in-prompt `/logout`, which
 * purges the OS keyring every home shares and could end a session another
 * profile owns; deleting a managed home is the sign-out.
 */

import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
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
import { resolveAntigravityExecutable } from '../detection.js';

/** The adapter-owned HOME redirection; also a provider launch allow-list entry. */
export const ANTIGRAVITY_PROFILE_ROOT_VARIABLE = 'PUPPETEER_ANTIGRAVITY_HOME';

/** The CLI's store, relative to the home it runs under. */
const STORE = ['.gemini', 'antigravity-cli'] as const;
const CREDENTIAL_FILE = 'antigravity-oauth-token';
const SETTINGS_FILE = 'settings.json';
/** Documented switch to Google Cloud Application Default Credentials; unsetting it is the way off. */
const ADC_SWITCH = 'AGY_ADC_AUTH';

const SOURCE = { kind: 'native-status', stability: 'experimental' } as const;
/** `consumer` on 1.2.9; another short native label passes through as is. */
const METHOD_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const EMAIL = /^(?=.{3,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$/u;
/** A Google Workspace hosted domain, such as `example.com`. */
const HOSTED_DOMAIN = /^(?=.{1,253}$)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/iu;

export interface AntigravityProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
  /** Where the ADC switch, and the executable when none is given, are read from; defaults to the process environment. */
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
  return { status: 'unavailable', provider: 'antigravity', message, retryable: true };
}

/** The file's contents, or undefined when there is no such file; any other failure throws. */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The payload of a compact JWS. The signature is not checked: this names an account, it authorizes nothing. */
function tokenClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string') return undefined;
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1]) return undefined;
  try {
    return rec(JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Decode the credential file. Only `auth_method` and `id_token` are taken from
 * it, and of the ID token only `email` and `hd`; `name` is not a plan and `sub`
 * does not belong on a profile. A parse failure is reported without the
 * parser's error, which quotes the input.
 */
function identityFromCredentialFile(contents: string, verifiedAt: string): ProfileIdentity | ProfileFailure {
  let document: Record<string, unknown> | undefined;
  try {
    document = rec(JSON.parse(contents));
  } catch {
    return unavailable('the Antigravity credential file is not JSON');
  }
  const claims = tokenClaims(document?.id_token);
  const email = typeof claims?.email === 'string' && EMAIL.test(claims.email) ? claims.email : undefined;
  if (!email) return unavailable('the Antigravity credential file names no account');
  const authMethod = document?.auth_method;
  const method = typeof authMethod === 'string' && METHOD_LABEL.test(authMethod) ? authMethod : undefined;
  const organization = typeof claims?.hd === 'string' && HOSTED_DOMAIN.test(claims.hd) ? claims.hd : undefined;
  return {
    loggedIn: true,
    ...(method ? { method } : {}),
    email,
    ...(organization ? { organization } : {}),
    verifiedAt,
    source: SOURCE,
  };
}

/**
 * Only `true` is documented. Any value but `0` or `false` reads as on: naming
 * the consumer account where the CLI may be on ADC is the worse mistake.
 */
function adcSwitchedOn(env: NodeJS.ProcessEnv): boolean {
  const value = text(env[ADC_SWITCH]);
  return value !== undefined && !/^(?:0|false)$/iu.test(value);
}

/** Antigravity profile capability: HOME binding, the agent itself as login, the CLI's credential file as identity. */
export function createAntigravityProfileService(options: AntigravityProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const ambient = options.env ?? process.env;
  const executable = resolveAntigravityExecutable(options.executable, ambient);
  const now = options.now ?? (() => new Date());
  const nativeDefaultRoot = join(home, ...STORE);

  const provider: ProfileProvider = {
    id: 'antigravity',
    label: 'Antigravity',
    support: {
      supported: true,
      identity: 'native-status',
      sharedSurfaces: [],
      nativeDefaultRoot,
      // A home holding only the credential file signed in, and the login
      // keychain's items did not sign in an empty home, so deleting a managed
      // home is its sign-out. The CLI saves a login to the OS keyring first and
      // has fallen back to this file on the probed machine; where the keyring
      // save succeeds the login would sit outside the home, so re-probe before
      // claiming more.
      credential: 'root',
      service: { id: 'google', label: 'Google' },
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'managed' ? { [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: profile.dataRoot } : {};

  // A managed root is the home the child runs under; the native default is the
  // process home's store, whatever root variable the host happens to inherit.
  const storeOf = (profile: AgentProfile): string =>
    profile.kind === 'managed' ? join(profile.dataRoot, ...STORE) : nativeDefaultRoot;

  return {
    provider,
    bindingEnvironment,

    // History, settings.json and the credential file all live in the store,
    // two levels inside a managed home: the bound root is not the layout root.
    observationRoot: storeOf,

    loginInvocation(profile: AgentProfile, loginOptions: { cwd: string }): TerminalSpec {
      // The agent signs in on its first launch. A host spawns this terminal
      // directly rather than through the driver, so the HOME the binding stands
      // for is set here too; without it the login lands in the user's own home.
      return {
        command: executable,
        args: [],
        cwd: loginOptions.cwd,
        env: profile.kind === 'managed' ? { HOME: profile.dataRoot, ...bindingEnvironment(profile) } : {},
      };
    },

    async verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> {
      const store = storeOf(profile);
      const verifiedAt = now().toISOString();

      // Only `modelProvider` is read: the settings can carry custom model
      // configuration this service has no business with.
      let modelProvider: string | undefined;
      try {
        const contents = await readIfPresent(join(store, SETTINGS_FILE));
        const settings: Record<string, unknown> | undefined = contents === undefined ? {} : rec(JSON.parse(contents));
        if (!settings) return unavailable('Antigravity settings.json is not a settings object');
        modelProvider = text(settings.modelProvider);
      } catch {
        return unavailable('Antigravity settings.json could not be read');
      }

      // Two other sign-ins are not this subscription: a Gemini API key
      // (`modelProvider: "gemini"` here, the key in GEMINI_API_KEY, which is
      // never read) and Google Cloud ADC (switched on by AGY_ADC_AUTH, signed in
      // through gcloud's store). Neither variable is on the launch allow-list,
      // and the runtime launches into a clean environment, so no session it
      // starts is signed in by either: the root reads signed out, with the mode
      // as its method. The credential file's account is not named instead: the
      // CLI skips it under a key, and where the host's environment turns ADC on,
      // a pane that inherits the switch and the usage read sign in through gcloud.
      if (modelProvider === 'gemini') return { loggedIn: false, method: 'gemini-api-key', verifiedAt, source: SOURCE };
      if (modelProvider !== undefined) return unavailable('Antigravity settings.json names an unknown model provider');
      if (adcSwitchedOn(ambient)) return { loggedIn: false, method: 'adc', verifiedAt, source: SOURCE };

      let contents: string | undefined;
      try {
        contents = await readIfPresent(join(store, CREDENTIAL_FILE));
      } catch {
        return unavailable('the Antigravity credential file could not be read');
      }
      if (contents === undefined) return { loggedIn: false, verifiedAt, source: SOURCE };
      return identityFromCredentialFile(contents, verifiedAt);
    },
  };
}
