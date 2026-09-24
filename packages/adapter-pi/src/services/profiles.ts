/**
 * Pi account profiles, bound through the native `PI_CODING_AGENT_DIR` variable
 * that already forms part of the provider's launch allow-list.
 *
 * Probed 2026-09-06 on Pi 0.84.3: the native root holds `auth.json`,
 * `settings.json`, `models-store.json`, and `sessions/`, so binding the one
 * variable isolates credentials and history together.
 *
 * The variable binds `<dataRoot>/agent`, one level inside the profile root, on
 * OpenCode's precedent: the binding never collides with the profile's own
 * metadata, and the profile root becomes the layout root — `~/.pi` for the
 * native default — that an external history indexer reads.
 *
 * Pi is a harness with no service of its own. A root holds one sign-in per
 * upstream provider (`auth.json`, keyed by provider id), and `settings.json`'s
 * `defaultProvider` names the one a new session uses. There is no login
 * subcommand: onboarding opens the agent bound to the profile and the user runs
 * `/login` in its own interface.
 *
 * Probed 2026-09-23 on Pi 0.87.1, no command lists a root's sign-ins, and
 * `pi auth check` reports `ready` for a provider the root does not store
 * whenever that provider's API key is in the environment. Verify therefore
 * projects `auth.json` the way Pi's own `CredentialStore.list()` does, then
 * confirms only the selected sign-in with `pi auth check --provider <id> --json
 * --no-refresh`, provider credentials removed from its environment. The check
 * emits a credential only with `--credentials`, which is never passed, and
 * `--no-refresh` opens the store read-only, so verifying never rotates a token.
 * `print-api-key` and `print-bearer-token` always emit one and are never run.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentProfile,
  ProfileFailure,
  ProfileIdentity,
  ProfileProvider,
  ProfileService,
  ProfileSignIn,
  SignInService,
  TerminalSpec,
} from '@vibecook/puppeteer-core';
import { resolvePiExecutable } from '../detection.js';

/** Pi's native root variable; also a provider launch allow-list entry. */
export const PI_PROFILE_ROOT_VARIABLE = 'PI_CODING_AGENT_DIR';

const execFileAsync = promisify(execFile);
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/;

/**
 * Pi's subscription logins, pinned from 0.87.1: the providers whose OAuth
 * method is marked `isSubscription`. OpenRouter's and Radius's OAuth are not,
 * and no API key is.
 */
const SUBSCRIPTION_PROVIDERS = new Set(['anthropic', 'openai-codex', 'github-copilot', 'xai', 'kimi-coding', 'meta']);

/**
 * The shared services (RFC 006) Pi's built-in providers bill through, by Pi
 * provider id. Any other provider passes through as a service of its own.
 */
const SERVICES = new Map<string, SignInService>([
  ['anthropic', { id: 'anthropic', label: 'Anthropic' }],
  ['openai', { id: 'openai', label: 'OpenAI' }],
  ['openai-codex', { id: 'openai', label: 'OpenAI' }],
  ['github-copilot', { id: 'github', label: 'GitHub' }],
  ['xai', { id: 'xai', label: 'xAI' }],
  ['kimi-coding', { id: 'kimi', label: 'Moonshot AI' }],
  ['google', { id: 'google', label: 'Google' }],
  ['google-vertex', { id: 'google', label: 'Google' }],
  ['meta', { id: 'meta', label: 'Meta' }],
  ['openrouter', { id: 'openrouter', label: 'OpenRouter' }],
  ['opencode', { id: 'opencode', label: 'OpenCode' }],
  ['opencode-go', { id: 'opencode', label: 'OpenCode' }],
]);

/**
 * Where Pi finds a provider credential the root does not store (pi-ai 0.87.1
 * `env-api-keys.ts` and its Bedrock and Vertex providers): every `*_API_KEY`
 * and `*_TOKEN` variable, and the AWS and Google credential sources. Matching
 * the suffixes, not the pinned names, also covers providers added since.
 */
const AMBIENT_CREDENTIAL_SUFFIX = /_(?:API_KEY|TOKEN)$/u;
const AMBIENT_CREDENTIAL_SOURCES = new Set([
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
]);

const isAmbientCredential = (name: string): boolean => {
  const upper = name.toUpperCase();
  return AMBIENT_CREDENTIAL_SUFFIX.test(upper) || AMBIENT_CREDENTIAL_SOURCES.has(upper);
};

/** A credential type as Pi writes one: `oauth` or `api_key` on 0.87.1. */
const CREDENTIAL_TYPE = /^[a-z][a-z0-9_]{0,31}$/u;

/** Injected process runner; `env` is the probe environment, ambient provider credentials removed. */
export type PiProfileExec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

/** Default runner. Only a zero exit is `ready`, so any other exit is a failure whatever it printed. */
const defaultProfileExec: PiProfileExec = async (file, args, options) => {
  const isScript = SCRIPT_EXECUTABLE.test(file);
  const command = isScript ? (process.versions.electron ? 'node' : process.execPath) : file;
  const { stdout } = await execFileAsync(command, isScript ? [file, ...args] : args, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
    env: options.env,
  });
  return { stdout };
};

export interface PiProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
  exec?: PiProfileExec;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * One credential a Pi root stores, as Pi's own `CredentialStore.list()`
 * projects it, plus the two non-secret fields Pi's logins keep. Never a
 * secret: `access`, `refresh`, `key` and `env` are not copied out of the file.
 */
export interface PiStoredCredential {
  providerId: string;
  type: string;
  /** ChatGPT's account id, kept by the `openai-codex` login: an identifier, not a handle a person knows. */
  accountId?: string;
  /** The GitHub Enterprise domain, kept by the `github-copilot` login. */
  enterpriseUrl?: string;
}

/** The agent directory a managed profile binds: one `agent` level inside the profile root. */
export function piAgentDir(profile: AgentProfile): string {
  return join(profile.dataRoot, 'agent');
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};

function unavailable(message: string): ProfileFailure {
  return { status: 'unavailable', provider: 'pi', message, retryable: true };
}

/**
 * Project a parsed `auth.json`. A document Pi would not have written is
 * undefined, never an empty store.
 */
export function piStoredCredentialsFrom(document: unknown): PiStoredCredential[] | undefined {
  const store = rec(document);
  if (!store) return undefined;
  const stored: PiStoredCredential[] = [];
  for (const [providerId, value] of Object.entries(store)) {
    const credential = rec(value);
    if (!credential || typeof credential.type !== 'string' || !CREDENTIAL_TYPE.test(credential.type)) return undefined;
    const accountId = text(credential.accountId);
    const enterpriseUrl = text(credential.enterpriseUrl);
    stored.push({
      providerId,
      type: credential.type,
      ...(accountId ? { accountId } : {}),
      ...(enterpriseUrl ? { enterpriseUrl } : {}),
    });
  }
  return stored;
}

const isSubscription = (credential: PiStoredCredential): boolean =>
  credential.type === 'oauth' && SUBSCRIPTION_PROVIDERS.has(credential.providerId);

/**
 * The credential a new session in the root uses: the saved default
 * provider's, else the only subscription login, else the first stored.
 */
export function piSelectedCredential(
  stored: readonly PiStoredCredential[],
  defaultProvider: string | undefined,
): PiStoredCredential | undefined {
  const saved = stored.find((credential) => credential.providerId === defaultProvider);
  if (saved) return saved;
  const subscriptions = stored.filter(isSubscription);
  return subscriptions.length === 1 ? subscriptions[0] : stored[0];
}

/** The service a Pi provider bills through; an unlisted provider passes through as its own. */
export function piSignInService(providerId: string): SignInService {
  const known = SERVICES.get(providerId);
  if (known) return known;
  // A custom provider is named by whoever wrote its models.json entry or
  // extension, so its id is folded into the shared alphabet, not trusted to fit.
  const folded = providerId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .slice(0, 64)
    .replace(/^[._-]+|[._-]+$/gu, '');
  // A name with nothing in that alphabet (one in another script) keeps a stable id of its own.
  const id = folded || createHash('sha256').update(providerId).digest('hex').slice(0, 16);
  return { id, label: providerId.trim().slice(0, 64) || id };
}

/**
 * Map a root's stored credentials onto a profile identity. `inUse` is the
 * provider the native check confirmed. Pi keeps no email, organization or plan
 * for a sign-in, and `accountId` is no handle, so none is filled in.
 */
export function piProfileIdentityFrom(
  stored: readonly PiStoredCredential[],
  inUse: string | undefined,
  verifiedAt: string,
): ProfileIdentity {
  const signIns = stored.map((credential): ProfileSignIn => ({
    service: piSignInService(credential.providerId),
    method: credential.type.replaceAll('_', '-'),
    ...(isSubscription(credential) ? { subscription: true } : {}),
    ...(credential.providerId === inUse ? { inUse: true } : {}),
  }));
  const current = signIns.find((signIn) => signIn.inUse === true);
  return {
    loggedIn: signIns.length > 0,
    ...(current ? { method: current.method } : {}),
    signIns,
    verifiedAt,
    // Pi documents neither auth.json's rows nor the check's JSON.
    source: { kind: 'native-status', stability: 'experimental' },
  };
}

/** Read and project a root's `auth.json`; the file is Pi's credential store, so only fixed messages leave here. */
async function readStoredCredentials(agentDir: string): Promise<PiStoredCredential[] | ProfileFailure> {
  let content: string;
  try {
    content = await readFile(join(agentDir, 'auth.json'), 'utf8');
  } catch (error) {
    // No store yet: nobody has signed in to this root.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return unavailable("Pi's `auth.json` could not be read");
  }
  content = content.replace(/^\uFEFF/u, '');
  // Pi's own store reads an empty file as an empty store.
  if (!content) return [];
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    // The parser's message can quote the file, and the file holds tokens.
    return unavailable("Pi's `auth.json` is not valid JSON");
  }
  return piStoredCredentialsFrom(document) ?? unavailable("Pi's `auth.json` holds an entry this adapter cannot read");
}

/**
 * The root's saved `defaultProvider`. A missing or unreadable settings file
 * names none, as Pi itself reads it. A repository's `.pi/settings.json` can
 * override it for sessions there; verification has no repository.
 */
async function readDefaultProvider(agentDir: string): Promise<string | undefined> {
  try {
    const content = await readFile(join(agentDir, 'settings.json'), 'utf8');
    const settings = rec(JSON.parse(content.replace(/^\uFEFF/u, '')));
    return typeof settings?.defaultProvider === 'string' ? settings.defaultProvider : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `pi auth check --json` confirms the stored credential: `ready`, for
 * that provider, with the stored type. Pi answers a stored OAuth row as
 * `oauth` and resolves anything else as an API key, so any other answer is not
 * this sign-in.
 */
function checkConfirms(stdout: string, credential: PiStoredCredential): boolean {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    return false;
  }
  const result = rec(document);
  return result?.status === 'ready' && result.provider === credential.providerId && result.authType === credential.type;
}

export function createPiProfileService(options: PiProfileServiceOptions = {}): ProfileService {
  const exec = options.exec ?? defaultProfileExec;
  const home = options.home ?? homedir();
  const ambient = options.env ?? process.env;
  const executable = resolvePiExecutable(options.executable, ambient);
  const now = options.now ?? (() => new Date());
  const nativeDefaultRoot = join(home, '.pi', 'agent');
  const provider: ProfileProvider = {
    id: 'pi',
    label: 'Pi',
    support: {
      supported: true,
      identity: 'native-status',
      // Provider API keys read from the ambient environment reach every
      // profile, and a repository's settings merge over the root's.
      sharedSurfaces: ['provider API keys supplied through environment variables', 'project .pi/settings.json'],
      nativeDefaultRoot,
      // auth.json sits in the bound agent directory (probed on 0.84.3).
      credential: 'root',
      // No `service`: Pi signs in only to other companies' services. No
      // `signInRoutes`: every sign-in is `/login` inside the one login.
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [PI_PROFILE_ROOT_VARIABLE]: piAgentDir(profile) };

  const agentDirectory = (profile: AgentProfile): string =>
    profile.kind === 'native-default' ? nativeDefaultRoot : piAgentDir(profile);

  const probeEnvironment = (agentDir: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(ambient)) {
      if (!isAmbientCredential(name)) env[name] = value;
    }
    // Set for the native default too: a root variable the host happened to
    // inherit must not re-point the check at another root.
    env[PI_PROFILE_ROOT_VARIABLE] = agentDir;
    return env;
  };

  const confirms = async (agentDir: string, credential: PiStoredCredential): Promise<boolean> => {
    // Pi's auth parser lifts `--credentials` out of any argument position, so
    // an id that reads as a flag is never passed.
    if (!credential.providerId || credential.providerId.startsWith('-')) return false;
    try {
      const { stdout } = await exec(
        executable,
        ['auth', 'check', '--provider', credential.providerId, '--json', '--no-refresh'],
        { env: probeEnvironment(agentDir) },
      );
      return checkConfirms(stdout, credential);
    } catch {
      return false;
    }
  };

  return {
    provider,
    bindingEnvironment,
    // The bound agent directory sits one level inside the layout root, so the
    // profile root itself is what an indexer applies Pi's layout to.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'native-default' ? dirname(nativeDefaultRoot) : profile.dataRoot,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // No native login command exists, so the agent itself runs bound to the
      // profile: whatever it writes on first authentication lands in that root.
      return {
        command: executable,
        args: [],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> {
      const agentDir = agentDirectory(profile);
      const stored = await readStoredCredentials(agentDir);
      if ('status' in stored) return stored;
      const selected = piSelectedCredential(stored, await readDefaultProvider(agentDir));
      // A check that fails or disagrees leaves the sign-in listed, only not in
      // use: the root still holds it, and a sign-out is Pi's `/logout`.
      const inUse = selected && (await confirms(agentDir, selected)) ? selected.providerId : undefined;
      return piProfileIdentityFrom(stored, inUse, now().toISOString());
    },
  };
}
