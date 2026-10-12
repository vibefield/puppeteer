/**
 * OpenCode account profiles.
 *
 * OpenCode has no root variable of its own. Verified 2026-09-06 on 1.18.23, it
 * keys credentials, history, and logs off the XDG data root:
 * `$XDG_DATA_HOME/opencode/{auth.json,opencode.db,log,snapshot}`, defaulting to
 * `~/.local/share/opencode`. Binding `XDG_DATA_HOME` to `<dataRoot>/data`
 * therefore isolates an account while config, plugins, and cache — which live
 * under the XDG config and cache roots — stay shared, exactly as RFC 006
 * decided.
 *
 * The variable is generic, so two consequences are documented rather than
 * hidden: tools the agent spawns inherit it, and the profile root gains one
 * `data` level so the binding never collides with the profile's own metadata.
 *
 * OpenCode is a harness: one root holds sign-ins of two kinds, each with its
 * own login (read from the 1.18.32 source, probed 2026-09-23 on 1.18.32).
 *
 * - The OpenCode Console account, OpenCode's own service. `opencode console
 *   login`, a device-code flow in a command group `--help` hides, keeps it in
 *   `opencode.db`: `account(id, email, url, access_token, refresh_token, …)`
 *   and `account_state(active_account_id, active_org_id)`. Several accounts
 *   can be signed in at once; one is active.
 * - Provider credentials. `opencode auth login` keeps one per provider id in
 *   `auth.json`, typed `oauth`, `api`, or `wellknown`, each beside its secret.
 *
 * verify() lists both, and no token leaves either store: the account tables
 * are read through a read-only connection that never names a token column,
 * `auth.json` is reduced to provider id and type as it is parsed, and the org
 * names come from a short-lived `opencode serve` bound to the same root,
 * started only when a Console account exists. OpenCode reports no plan for
 * either kind, and marks no sign-in as the one in use: a new session's model
 * is chosen in the shared config or the recent-model list under the XDG state
 * root, and neither is in this root.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentProfile,
  ProfileFailure,
  ProfileIdentity,
  ProfileProvider,
  ProfileService,
  ProfileSignIn,
  SignInService,
  TerminalSpec,
} from '@vibefield/puppeteer-core';
import { resolveOpenCodeExecutable } from '../detection.js';
import { startOpenCodeBackend, type OpenCodeBackend } from '../launch/backend.js';
import { OpenCodeClient } from '../transport/client.js';

/** The XDG variable OpenCode reads its data root from. */
export const OPENCODE_PROFILE_ROOT_VARIABLE = 'XDG_DATA_HOME';

/** The release channels' database (`Database.path()`); a build from another channel names its own. */
const OPENCODE_DATABASE = 'opencode.db';

const OPENCODE_SERVICE: SignInService = { id: 'opencode', label: 'OpenCode' };

/** `auth login` stores a provider credential and stays the default; `console login` adds a Console account. */
const LOGIN_ARGUMENTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['provider', ['auth', 'login']],
  ['console', ['console', 'login']],
]);

/** RFC 006's shared service ids, with the name each is known by. */
const SERVICE_LABELS: ReadonlyMap<string, string> = new Map([
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['xai', 'xAI'],
  ['kimi', 'Moonshot AI'],
  ['google', 'Google'],
  ['github', 'GitHub'],
  ['nous', 'Nous Research'],
  ['opencode', 'OpenCode'],
  ['openrouter', 'OpenRouter'],
  ['meta', 'Meta'],
]);

/**
 * Provider ids OpenCode stores (models.dev's, 2026-09-23) whose service has a
 * shared id of another name. Any other id passes through as its own service.
 */
const SERVICE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['github-copilot', 'github'],
  ['google-vertex', 'google'],
  ['google-vertex-anthropic', 'google'],
  ['moonshotai', 'kimi'],
  ['moonshotai-cn', 'kimi'],
  ['kimi-for-coding', 'kimi'],
  ['kimi-code-plan-global', 'kimi'],
  ['kimi-code-plan-cn', 'kimi'],
  ['opencode-go', 'opencode'],
  ['llama', 'meta'],
]);

/**
 * OAuth logins whose method in OpenCode's own catalog is a plan's: the
 * built-in auth plugins on 1.18.32 label them "ChatGPT Pro/Plus", "SuperGrok
 * Subscription", and "Login with GitHub Copilot". An API key is not marked,
 * nor is an OAuth login a third-party plugin wrote: the catalog never named it.
 */
const SUBSCRIPTION_OAUTH = new Set(['openai', 'xai', 'github-copilot']);

const CREDENTIAL_METHODS = { oauth: 'oauth', api: 'api-key', wellknown: 'wellknown' } as const;

/** The contract's bound on one identity's list. */
const MAX_SIGN_INS = 64;

/** One `auth.json` entry as OpenCode's own `auth list` names it. */
export interface OpenCodeStoredCredential {
  /** The entry's key; for a URL-keyed `wellknown` entry, the URL's host. */
  providerId: string;
  type: keyof typeof CREDENTIAL_METHODS;
}

/** The fields an identity keeps from one `GET /experimental/console/orgs` row. */
export interface OpenCodeConsoleOrgName {
  accountId: string;
  name: string;
  active: boolean;
}

/** A Console account as `opencode.db` holds it, less its token columns. */
interface ConsoleAccount {
  id?: string;
  email?: string;
  active: boolean;
}

export interface OpenCodeConsoleOrgsRequest {
  executable: string;
  /** XDG_DATA_HOME pinned to the root the stores were read from; the rest is inherited, as the backend's is. */
  env: Record<string, string>;
  timeoutMs: number;
}

/** Asks a short-lived `opencode serve` for `GET /experimental/console/orgs`; resolves the body undecoded. */
export type OpenCodeConsoleOrgsReader = (request: OpenCodeConsoleOrgsRequest) => Promise<unknown>;

export interface OpenCodeProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
  now?: () => Date;
  /** Budget for the org request once the server is up; running out costs the org names only. */
  requestTimeoutMs?: number;
  /** Injected so unit tests never start a real `opencode serve`. */
  readConsoleOrgs?: OpenCodeConsoleOrgsReader;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

const URL_KEY = /^https?:\/\//iu;

/** A `wellknown` credential is keyed by its organization's URL; the host alone names it. */
function urlHost(key: string): string | undefined {
  try {
    return text(new URL(key).hostname);
  } catch {
    return undefined;
  }
}

/** ENOENT or ENOTDIR: the root never held the file, which reads as holding nothing. */
const absent = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

function unavailable(message: string): ProfileFailure {
  return { status: 'unavailable', provider: 'opencode', message, retryable: true };
}

/** The same shapes OpenCode's own decoder (`Auth.Info`) keeps; it silently drops any other entry. */
function credentialType(value: unknown): OpenCodeStoredCredential['type'] | undefined {
  const entry = rec(value);
  switch (entry?.type) {
    case 'oauth':
      return typeof entry.refresh === 'string' &&
        typeof entry.access === 'string' &&
        typeof entry.expires === 'number' &&
        Number.isInteger(entry.expires) &&
        entry.expires >= 0 &&
        optionalString(entry.accountId) &&
        optionalString(entry.enterpriseUrl)
        ? 'oauth'
        : undefined;
    case 'api': {
      const metadata = entry.metadata === undefined ? {} : rec(entry.metadata);
      return typeof entry.key === 'string' &&
        metadata &&
        Object.values(metadata).every((item) => typeof item === 'string')
        ? 'api'
        : undefined;
    }
    case 'wellknown':
      return typeof entry.key === 'string' && typeof entry.token === 'string' ? 'wellknown' : undefined;
    default:
      return undefined;
  }
}

/**
 * Reduce `auth.json` to what OpenCode's own `auth list` prints — provider id
 * and type — the way Pi's `CredentialStore.list()` does. The file, not
 * `GET /provider`, is the source: it is what the root itself stores, where
 * that route's `connected` also counts keys in the environment and providers
 * a Console org injects, and the rest of its document carries API keys.
 *
 * Nothing beside `type` leaves this function, so neither a secret nor a field
 * that travels with one (`accountId`, `enterpriseUrl`, login-form `metadata`)
 * reaches a result, and a URL key leaves as its host, without userinfo, path,
 * or query. Undefined: not a store it can read, which a torn write also looks
 * like.
 */
export function openCodeStoredCredentials(document: string): OpenCodeStoredCredential[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    // The parser's message can quote the text around the fault, secrets and all.
    return undefined;
  }
  const store = rec(parsed);
  if (!store) return undefined;
  const credentials: OpenCodeStoredCredential[] = [];
  for (const [key, entry] of Object.entries(store)) {
    const type = credentialType(entry);
    const providerId = URL_KEY.test(key) ? urlHost(key) : key;
    if (type && providerId) credentials.push({ providerId, type });
  }
  return credentials;
}

/**
 * Decode `GET /experimental/console/orgs` down to account, org name, and the
 * active mark. Any other document is no org names: they only label accounts
 * the database already proves, so a drifted route costs the labels alone.
 */
export function openCodeConsoleOrgsFrom(document: unknown): OpenCodeConsoleOrgName[] {
  const orgs = rec(document)?.orgs;
  if (!Array.isArray(orgs)) return [];
  return orgs.flatMap((value) => {
    const org = rec(value);
    const accountId = text(org?.accountID);
    const name = text(org?.orgName);
    return accountId && name ? [{ accountId, name, active: org?.active === true }] : [];
  });
}

/** The shape a shared id takes: `[a-z0-9._-]`, alphanumeric at both ends, at most 64 long. */
function serviceId(value: string): string | undefined {
  const id = value
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '')
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/u, '');
  return id.length > 0 ? id : undefined;
}

/** The service a stored credential is billed through; undefined for an id no service id can be made from. */
function signInService(providerId: string): SignInService | undefined {
  const native = providerId.trim().toLowerCase();
  const shared = SERVICE_ALIASES.get(native) ?? native;
  const label = SERVICE_LABELS.get(shared);
  if (label) return { id: shared, label };
  const id = serviceId(shared);
  return id ? { id, label: providerId.trim().slice(0, 64) } : undefined;
}

function credentialSignIns(credential: OpenCodeStoredCredential): ProfileSignIn[] {
  const service = signInService(credential.providerId);
  if (!service) return [];
  const subscription = credential.type === 'oauth' && SUBSCRIPTION_OAUTH.has(credential.providerId);
  return [{ service, method: CREDENTIAL_METHODS[credential.type], ...(subscription ? { subscription } : {}) }];
}

function consoleSignIns(accounts: readonly ConsoleAccount[], orgs: readonly OpenCodeConsoleOrgName[]): ProfileSignIn[] {
  const ordered = [...accounts.filter((account) => account.active), ...accounts.filter((account) => !account.active)];
  return ordered.map((account) => {
    const own = orgs.filter((org) => org.accountId === account.id);
    // The org OpenCode has active for the account, else the only one it belongs to.
    const organization = (own.find((org) => org.active) ?? (own.length === 1 ? own[0] : undefined))?.name;
    return {
      service: OPENCODE_SERVICE,
      method: 'console',
      ...(account.email ? { email: account.email } : {}),
      ...(organization ? { organization } : {}),
    };
  });
}

async function readStoredCredentials(path: string): Promise<OpenCodeStoredCredential[] | ProfileFailure> {
  let document: string;
  try {
    document = await readFile(path, 'utf8');
  } catch (error) {
    return absent(error) ? [] : unavailable('auth.json could not be read');
  }
  return openCodeStoredCredentials(document) ?? unavailable('auth.json is not a credential store OpenCode would read');
}

async function readConsoleAccounts(path: string): Promise<ConsoleAccount[] | ProfileFailure> {
  try {
    await stat(path);
  } catch (error) {
    return absent(error) ? [] : unavailable(`${OPENCODE_DATABASE} could not be read`);
  }
  let database: DatabaseSync | undefined;
  try {
    // Loaded on first use: the module is experimental on the oldest supported
    // Node, and its absence costs this read, not the adapter.
    const { DatabaseSync } = await import('node:sqlite');
    // Read-only. Like any reader of a WAL database it may create the `-shm`
    // and `-wal` side files; it never writes the database.
    database = new DatabaseSync(path, { readOnly: true, timeout: 250 });
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('account', 'account_state')")
      .all();
    // A store without them predates Console accounts: an unrecognized shape, not a signed-out root.
    if (tables.length !== 2) return unavailable(`${OPENCODE_DATABASE} has no Console account tables`);
    // Named columns only; the token columns beside them are never selected.
    const active = text(
      database.prepare('SELECT active_account_id FROM account_state WHERE id = 1').get()?.active_account_id,
    );
    return database
      .prepare('SELECT id, email FROM account')
      .all()
      .map((row) => {
        const id = text(row.id);
        const email = text(row.email);
        return { ...(id ? { id } : {}), ...(email ? { email } : {}), active: id !== undefined && id === active };
      });
  } catch {
    return unavailable(`the Console accounts in ${OPENCODE_DATABASE} could not be read`);
  } finally {
    database?.close();
  }
}

/**
 * The adapter's own private backend, answering one request under the binding
 * and disposed. The request loads a fresh empty directory: outside any
 * repository that is OpenCode's global project, so the read records no project
 * directory in the root. Like any OpenCode start in the root, it lets OpenCode
 * refresh a Console token within five minutes of expiry and save the new one;
 * this service never handles a token itself.
 */
const readConsoleOrgsFromServe: OpenCodeConsoleOrgsReader = async ({ executable, env, timeoutMs }) => {
  const directory = await mkdtemp(join(tmpdir(), 'puppeteer-opencode-verify-'));
  let backend: OpenCodeBackend | undefined;
  try {
    backend = await startOpenCodeBackend({ executable, env });
    const client = new OpenCodeClient({
      origin: backend.origin,
      directory,
      username: backend.username,
      password: backend.password,
      fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    });
    return await client.listConsoleOrgs();
  } finally {
    await backend?.dispose();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** The XDG data root a managed profile binds: one `data` level inside the profile root. */
export function openCodeDataHome(profile: AgentProfile): string {
  return join(profile.dataRoot, 'data');
}

/** OpenCode profile capability: root binding, two native logins, and the sign-ins the root holds. */
export function createOpenCodeProfileService(options: OpenCodeProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const executable = resolveOpenCodeExecutable(options.executable);
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const readConsoleOrgs = options.readConsoleOrgs ?? readConsoleOrgsFromServe;

  const provider: ProfileProvider = {
    id: 'opencode',
    label: 'OpenCode',
    support: {
      supported: true,
      identity: 'native-protocol',
      sharedSurfaces: [
        'the OpenCode config directory under the XDG config root',
        'plugins and the model cache under the XDG cache root',
        'the recent-model list under the XDG state root',
        'tools the agent spawns inherit XDG_DATA_HOME',
        'provider API keys supplied through environment variables, and OPENCODE_AUTH_CONTENT, which replaces auth.json',
      ],
      nativeDefaultRoot: join(home, '.local', 'share', 'opencode'),
      // auth.json and opencode.db, the Console account's tokens included, live
      // under the bound data root (verified on 1.18.23 and 1.18.32).
      credential: 'root',
      service: OPENCODE_SERVICE,
      signInRoutes: [
        { id: 'provider', label: 'Another provider…' },
        { id: 'console', label: 'OpenCode Console', service: OPENCODE_SERVICE },
      ],
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [OPENCODE_PROFILE_ROOT_VARIABLE]: openCodeDataHome(profile) };

  // The native default is OpenCode's own root: an XDG_DATA_HOME the host
  // happened to inherit must not re-point a read at another account's store.
  const dataHome = (profile: AgentProfile): string =>
    profile.kind === 'native-default' ? join(home, '.local', 'share') : openCodeDataHome(profile);

  // History, auth.json, and opencode.db live at $XDG_DATA_HOME/opencode, so a
  // profile's layout root is one `opencode` level below the data home it binds.
  const dataDirectory = (profile: AgentProfile): string => join(dataHome(profile), 'opencode');

  return {
    provider,
    bindingEnvironment,
    observationRoot: dataDirectory,

    loginInvocation(profile: AgentProfile, loginOptions: { cwd: string; route?: string }): TerminalSpec {
      const args = LOGIN_ARGUMENTS.get(loginOptions.route ?? 'provider');
      // The runtime refuses a route the provider does not declare before asking.
      if (!args) throw new Error(`unknown OpenCode sign-in route: ${loginOptions.route}`);
      // Both are the native interactive flows and must own a real terminal: the
      // host never observes the device code or the credential exchange.
      return { command: executable, args: [...args], cwd: loginOptions.cwd, env: bindingEnvironment(profile) };
    },

    async verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> {
      const directory = dataDirectory(profile);
      const credentials = await readStoredCredentials(join(directory, 'auth.json'));
      if ('status' in credentials) return credentials;
      const accounts = await readConsoleAccounts(join(directory, OPENCODE_DATABASE));
      if ('status' in accounts) return accounts;

      let orgs: OpenCodeConsoleOrgName[] = [];
      if (accounts.length > 0) {
        try {
          // The native default's server is pinned to the root the projection
          // read, whatever XDG_DATA_HOME the host carries.
          const env = { [OPENCODE_PROFILE_ROOT_VARIABLE]: dataHome(profile) };
          orgs = openCodeConsoleOrgsFrom(await readConsoleOrgs({ executable, env, timeoutMs: requestTimeoutMs }));
        } catch {
          // A console out of reach, a server that would not start, or a timeout
          // costs the org names, not the accounts the store holds.
        }
      }

      const signIns = [...consoleSignIns(accounts, orgs), ...credentials.flatMap(credentialSignIns)].slice(
        0,
        MAX_SIGN_INS,
      );
      return {
        loggedIn: signIns.length > 0,
        signIns,
        verifiedAt: now().toISOString(),
        source: { kind: 'native-protocol', stability: 'experimental' },
      };
    },
  };
}
