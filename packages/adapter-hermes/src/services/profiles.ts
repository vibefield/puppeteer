/**
 * Hermes account profiles (RFC 006), bound through the native `HERMES_HOME`
 * variable that already forms the provider's launch allow-list.
 *
 * Probed 2026-09-06 on Hermes 0.20.5: the native root holds `auth.json`,
 * `config.yaml`, `cache/`, and `cron/`, so binding the one variable isolates
 * credentials and state together. The adapter already runs the gateway with
 * `HOME` set to the same directory, so a bound profile also owns whatever the
 * agent reads from its home. The Python checkout and virtual environment the
 * wrapper script execs are addressed absolutely and stay shared.
 *
 * Hermes is a harness: its own service is Nous Portal, and its root also holds
 * a pool of sign-ins to other services, so identity lists every sign-in the
 * root holds. Hermes prints no structured status document. Verification runs a
 * short script in the interpreter the `hermes` wrapper execs, under the same
 * binding, that asks Hermes's own helpers (read in the 0.21.4 source on
 * 2026-09-23):
 *   `get_nous_auth_status_local()`, the refresh-free snapshot `hermes status`
 *     reads. Never `get_nous_auth_status()`, which redeems the single-use
 *     refresh token on every call.
 *   `get_nous_portal_account_info(force_fresh=True)`, only when the snapshot
 *     holds a Portal login: `/api/oauth/account` normalized to email,
 *     organisation and plan, the call Hermes's own `/usage` credits view
 *     makes. It refreshes an access token only inside Hermes's skew window,
 *     and persists the rotation itself.
 *   `read_credential_pool()`, the pool as stored. Not `load_pool()`, which
 *     seeds (running `gh auth token`) and writes back.
 *   `model.provider` from `read_raw_config()`, the provider a new session
 *     uses. Not `load_config()`, which creates directories and backs the file
 *     up on every read.
 * The script prints one allowlisted JSON object; tokens, claims and account
 * bodies never leave it, and the decoder here allowlists again.
 */

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
import { SignInServiceIdSchema } from '@vibecook/puppeteer-core';
import { resolveHermesExecutable } from '../detection.js';
import { HERMES_HOME_ENV, HERMES_PYTHON_ENV } from '../generated/detection.js';
import { hermesPythonFromWrapper, readHermesWrapperHead } from './distribution.js';

/** Hermes's native root variable; also the provider's launch allow-list entry. */
export const HERMES_PROFILE_ROOT_VARIABLE = HERMES_HOME_ENV;

/** A provider credential a host may carry: `*_API_KEY`, `*_TOKEN`, `*_SECRET`, and the like. */
const CREDENTIAL_VARIABLE = /(?:API_KEY|TOKEN|SECRET|ACCESS_KEY|PASSWORD)$/iu;

const execFileAsync = promisify(execFile);

/**
 * Hermes bounds a refresh at 15 s and the account call at 8 s. A read cut off
 * between redeeming the single-use refresh token and persisting its successor
 * would sign the root out, so this budget stays well clear of both.
 */
const VERIFY_TIMEOUT_MS = 60_000;

/**
 * Printed to stdout as one JSON line; Hermes's own output is sent to stderr.
 * Exit 3: Hermes's modules would not import. Exit 4: a read failed, which is
 * never taken for a sign-out (an unreadable auth.json raises here).
 */
const IDENTITY_SCRIPT = `
import json
import sys

out, sys.stdout = sys.stdout, sys.stderr
BORROWED = ("gh_cli", "claude_code", "qwen-cli")


def text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def nous(auth, account_info):
    local = auth.get_nous_auth_status_local() or {}
    if local.get("free_tier"):
        return {"state": "free-tier"}
    if not local.get("logged_in"):
        return {"state": "none"}
    info = account_info(force_fresh=True)
    source = getattr(info, "source", None)
    if getattr(info, "logged_in", False) and source == "account_api":
        found = {
            "email": text(getattr(info, "email", None)),
            "organization": text(getattr(info, "org_name", None)),
            "plan": text(getattr(getattr(info, "subscription", None), "plan", None)),
        }
        return dict(state="account", **{key: value for key, value in found.items() if value})
    if source in ("none", "inference_key"):
        return {"state": "none"}
    refused = str(getattr(info, "error", "") or "").startswith("HTTP Error 401:")
    after = auth.get_nous_auth_status_local() or {}
    return {"state": "rejected" if refused or not after.get("logged_in") else "unreachable"}


def credential(credentials, provider, entry):
    try:
        return credentials.PooledCredential.from_dict(provider, entry)
    except Exception:
        return None


def pool(auth, credentials):
    stored = auth.read_credential_pool() or {}
    display = getattr(auth, "get_auth_provider_display_name", None)
    dead = getattr(credentials, "STATUS_DEAD", "dead")
    rows = []
    for provider in sorted(key for key in stored if isinstance(key, str)):
        entries = stored[provider] if isinstance(stored[provider], list) else []
        held = [credential(credentials, provider, entry) for entry in entries if isinstance(entry, dict)]
        name = text(display(provider)) if display else None
        for entry in sorted((held_entry for held_entry in held if held_entry is not None),
                            key=lambda held_entry: held_entry.priority if isinstance(held_entry.priority, int) else 0):
            auth_type = text(entry.auth_type)
            portal = provider == "nous" and (
                str(auth_type).startswith("oauth") or bool(entry.refresh_token)
                or (entry.extra or {}).get("auth_method") == "anonymous")
            if entry.last_status == dead or portal or not auth_type:
                continue
            row = {"provider": provider, "authType": auth_type}
            if entry.source in BORROWED:
                row["borrowed"] = entry.source
            if name:
                row["name"] = name
            rows.append(row)
    return rows


def selected(auth, settings):
    try:
        read = getattr(settings, "read_raw_config", None) or settings.load_config
        model = (read() or {}).get("model")
        provider = text(model.get("provider")) if isinstance(model, dict) else None
        if not provider or provider.lower() == "auto":
            return None
        try:
            return auth.resolve_provider(provider.lower())
        except Exception:
            return provider.lower()
    except Exception:
        return None


try:
    import agent.credential_pool as credentials
    import hermes_cli.auth as auth
    import hermes_cli.config as settings
    from hermes_cli.nous_account import get_nous_portal_account_info
except Exception:
    sys.exit(3)
try:
    document = {"v": 1, "nous": nous(auth, get_nous_portal_account_info), "pool": pool(auth, credentials)}
except Exception:
    sys.exit(4)
document["selected"] = selected(auth, settings)
out.write(json.dumps(document) + "\\n")
out.flush()
`;

/**
 * `-I` keeps the working directory and any PYTHON* variable off the import
 * path, so nothing beside the install can stand in for Hermes's modules while
 * they hold tokens. `-B` leaves the shared checkout's bytecode untouched.
 */
const IDENTITY_PROBE_ARGS = ['-I', '-B', '-c', IDENTITY_SCRIPT] as const;

/** Injected process runner so unit tests never start an interpreter; rejects on a non-zero exit. */
export type HermesProfileExec = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

/** Injected wrapper read so unit tests never touch a real install: the head of the file `executable` names. */
export type HermesWrapperRead = (executable: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;

const defaultProfileExec: HermesProfileExec = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: VERIFY_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
    env: options.env,
  });
  return { stdout };
};

/** The first `executable` on PATH, which is the one the launch runs; a path is read as given. */
const defaultReadWrapper: HermesWrapperRead = async (executable, env) => {
  const candidates = /[/\\]/u.test(executable)
    ? [executable]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter((directory) => directory.length > 0)
        .map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await readHermesWrapperHead(candidate);
    } catch {
      // Not an executable file here; the next PATH entry decides.
    }
  }
  return undefined;
};

const NOUS_PORTAL: SignInService = { id: 'nous', label: 'Nous Research' };
const OPENAI: SignInService = { id: 'openai', label: 'OpenAI' };
const XAI: SignInService = { id: 'xai', label: 'xAI' };
const GITHUB: SignInService = { id: 'github', label: 'GitHub' };
const GOOGLE: SignInService = { id: 'google', label: 'Google' };
const KIMI: SignInService = { id: 'kimi', label: 'Moonshot AI' };
const OPENCODE: SignInService = { id: 'opencode', label: 'OpenCode' };

/** Hermes pool provider ids onto the shared service ids; an unlisted one passes through. */
const SERVICES = new Map<string, SignInService>([
  ['nous', NOUS_PORTAL],
  ['openai-codex', OPENAI],
  ['openai-api', OPENAI],
  ['anthropic', { id: 'anthropic', label: 'Anthropic' }],
  ['xai-oauth', XAI],
  ['xai', XAI],
  ['openrouter', { id: 'openrouter', label: 'OpenRouter' }],
  ['copilot', GITHUB],
  ['copilot-acp', GITHUB],
  ['gemini', GOOGLE],
  ['vertex', GOOGLE],
  ['kimi-coding', KIMI],
  ['kimi-coding-cn', KIMI],
  ['opencode-zen', OPENCODE],
  ['opencode-go', OPENCODE],
]);

/**
 * OAuth logins Hermes's own catalog sells as a subscription: "ChatGPT or Codex
 * Subscription", "Claude Pro/Max subscription", "SuperGrok / Premium+".
 */
const SUBSCRIPTION_LOGINS = new Set(['openai-codex', 'anthropic', 'xai-oauth']);

/**
 * Pool rows Hermes borrows from another program's login on this machine
 * instead of holding one in the root. Every root that seeds one shows the same
 * account, so the method names whose login it is, and `borrowedFrom` names the
 * program as a person knows it.
 */
const BORROWED_METHODS = new Map([
  ['gh_cli', { method: 'gh-cli', from: 'GitHub CLI' }],
  ['claude_code', { method: 'claude-code', from: 'Claude Code' }],
  ['qwen-cli', { method: 'qwen-cli', from: 'Qwen Code' }],
]);

const NOUS_STATES = new Set(['none', 'free-tier', 'account', 'unreachable', 'rejected']);
const MAX_SIGN_INS = 64;
const MAX_TEXT = 8_192;
const MAX_LABEL = 64;

/**
 * `hermes portal` is the Nous sign-in (`hermes auth add nous --type oauth`,
 * then the model and provider choice); 0.21.4 keeps `hermes login` only to
 * print that it was removed, and exits 0 signed out. Bare `hermes auth` is the
 * credential-pool manager, whose first action adds a credential for any
 * provider.
 */
const LOGIN_ARGS = new Map<string, readonly string[]>([
  ['portal', ['portal']],
  ['provider', ['auth']],
]);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 && trimmed.length <= MAX_TEXT ? trimmed : undefined;
};

function unavailable(message: string): ProfileFailure {
  return { status: 'unavailable', provider: 'hermes', message, retryable: true };
}

interface HeldSignIn {
  /** Hermes's own provider id, which `model.provider` names. */
  provider: string;
  signIn: ProfileSignIn;
}

function portalSignIn(state: string, nous: Record<string, unknown>): ProfileSignIn | undefined {
  if (state === 'free-tier') return { service: NOUS_PORTAL, method: 'free-tier' };
  // `unreachable`: the credential is there and was not refused; only who it is stayed unknown.
  if (state === 'unreachable') return { service: NOUS_PORTAL, method: 'oauth', subscription: true };
  if (state !== 'account') return undefined;
  const email = text(nous.email);
  const organization = text(nous.organization);
  const plan = text(nous.plan);
  return {
    service: NOUS_PORTAL,
    method: 'oauth',
    subscription: true,
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
    ...(plan ? { plan } : {}),
  };
}

function serviceFor(provider: string, name: string | undefined): SignInService | undefined {
  const known = SERVICES.get(provider);
  if (known) return known;
  // A custom endpoint's pool key is `custom:<name>`, which is not a service id.
  const id = provider
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/u, '');
  if (!SignInServiceIdSchema.safeParse(id).success) return undefined;
  const label = (name && name !== provider ? name : provider.replace(/^custom:/u, '')).slice(0, MAX_LABEL).trim();
  return { id, label: label || id };
}

function poolSignIn(row: unknown): HeldSignIn | undefined {
  const entry = rec(row);
  const provider = text(entry?.provider)?.toLowerCase();
  const authType = text(entry?.authType);
  if (!entry || !provider || !authType) return undefined;
  const service = serviceFor(provider, text(entry.name));
  if (!service) return undefined;
  const oauth = authType.startsWith('oauth');
  const borrowed = typeof entry.borrowed === 'string' ? BORROWED_METHODS.get(entry.borrowed) : undefined;
  const method = borrowed?.method ?? (oauth ? 'oauth' : authType === 'api_key' ? 'api-key' : authType);
  return {
    provider,
    signIn: {
      service,
      method,
      ...(oauth && SUBSCRIPTION_LOGINS.has(provider) ? { subscription: true } : {}),
      ...(borrowed ? { borrowedFrom: borrowed.from } : {}),
    },
  };
}

/**
 * Decode the identity script's document. A document that is not the script's
 * is a failure, never a fabricated sign-out: only the Nous snapshot's own
 * answer and the stored pool say what the root holds.
 */
export function hermesProfileIdentityFrom(document: unknown, verifiedAt: string): ProfileIdentity | ProfileFailure {
  const read = rec(document);
  const nous = rec(read?.nous);
  const state = typeof nous?.state === 'string' ? nous.state : undefined;
  if (!read || read.v !== 1 || !nous || !state || !NOUS_STATES.has(state) || !Array.isArray(read.pool)) {
    return unavailable('the Hermes identity script returned an unrecognized document');
  }

  const held: HeldSignIn[] = [];
  const portal = portalSignIn(state, nous);
  if (portal) held.push({ provider: 'nous', signIn: portal });
  for (const row of read.pool) {
    const signIn = poolSignIn(row);
    if (signIn) held.push(signIn);
  }
  const kept = held.slice(0, MAX_SIGN_INS);

  // A new session uses the configured provider: the Portal login for `nous`,
  // else that provider's first pool row, which is the one Hermes fills first.
  const selected = text(read.selected)?.toLowerCase();
  const current = selected === undefined ? undefined : kept.find(({ provider }) => provider === selected)?.signIn;
  const signIns = kept.map(({ signIn }) => (signIn === current ? { ...signIn, inUse: true } : signIn));
  return {
    loggedIn: signIns.length > 0,
    ...(current
      ? {
          method: current.method,
          ...(current.email ? { email: current.email } : {}),
          ...(current.account ? { account: current.account } : {}),
          ...(current.organization ? { organization: current.organization } : {}),
          ...(current.plan ? { plan: current.plan } : {}),
          ...(current.borrowedFrom ? { borrowedFrom: current.borrowedFrom } : {}),
        }
      : {}),
    signIns,
    verifiedAt,
    source: { kind: 'native-protocol', stability: 'experimental' },
  };
}

export interface HermesProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
  /** The interpreter verification runs; by default the one the wrapper execs, then `HERMES_PYTHON`. */
  python?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  exec?: HermesProfileExec;
  readWrapper?: HermesWrapperRead;
}

/** Hermes profile capability: root binding, native sign-ins, and a read of what the root holds. */
export function createHermesProfileService(options: HermesProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const ambient = options.env ?? process.env;
  const executable = resolveHermesExecutable(options.executable);
  const exec = options.exec ?? defaultProfileExec;
  const readWrapper = options.readWrapper ?? defaultReadWrapper;
  const now = options.now ?? (() => new Date());

  const provider: ProfileProvider = {
    id: 'hermes',
    label: 'Hermes',
    support: {
      supported: true,
      identity: 'native-protocol',
      sharedSurfaces: [
        'the Hermes source checkout and virtual environment the wrapper script execs',
        "the machine's `gh` login, which Hermes seeds into a root's Copilot sign-in",
        "Claude Code's and the Codex CLI's logins, which Hermes adopts unless `auth.adopt_external_logins` is off",
      ],
      nativeDefaultRoot: join(home, '.hermes'),
      // auth.json sits in the bound root (probed on 0.20.5); initializeRoot
      // refuses a root Hermes would fold into another one.
      credential: 'root',
      service: NOUS_PORTAL,
      signInRoutes: [
        { id: 'portal', label: 'Nous Portal', service: NOUS_PORTAL },
        { id: 'provider', label: 'Another provider…' },
      ],
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [HERMES_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  /**
   * Hermes's `get_default_hermes_root()` makes `~/.hermes` the root of any home
   * inside it, and the grandparent the root of a home whose parent directory is
   * named `profiles`. Such a home falls back to that root's auth.json and keeps
   * the Nous login's shared copy in its `shared/`, outside the profile, so it
   * would neither be isolated nor signed out by deleting it.
   */
  const joinsAnotherRoot = (dataRoot: string): boolean => {
    const inside = relative(join(home, '.hermes'), dataRoot);
    return basename(dirname(dataRoot)) === 'profiles' || (!isAbsolute(inside) && inside.split(sep)[0] !== '..');
  };

  const probeEnvironment = (profile: AgentProfile): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...ambient, ...bindingEnvironment(profile) };
    // The wrapper unsets both before it execs the interpreter.
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    // The native default is Hermes's own root: a HERMES_HOME the host happened
    // to inherit must not re-point the read at another account.
    if (profile.kind === 'native-default') delete env[HERMES_PROFILE_ROOT_VARIABLE];
    // A session is launched from a clean environment, so a provider key in the
    // host's never reaches it. Hermes's pool loader seeds rows from such keys
    // and saves them to auth.json, which would make this read a write and list
    // a sign-in no session has: every one is dropped.
    for (const name of Object.keys(env)) if (CREDENTIAL_VARIABLE.test(name)) delete env[name];
    return env;
  };

  // The interpreter of the install the host chose: its wrapper names it.
  // HERMES_PYTHON is Hermes's own override, for an install without that wrapper.
  const interpreter = async (): Promise<string | undefined> => {
    if (options.python) return options.python;
    try {
      const wrapper = await readWrapper(executable, ambient);
      const python = wrapper === undefined ? undefined : hermesPythonFromWrapper(wrapper);
      if (python) return python;
    } catch {
      // An unreadable wrapper names nothing.
    }
    return text(ambient[HERMES_PYTHON_ENV]);
  };

  return {
    provider,
    bindingEnvironment,
    // HERMES_HOME names the layout root itself: unlike Pi and OpenCode, the
    // bound root is the directory an indexer applies Hermes's layout to.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'native-default' ? (provider.support.nativeDefaultRoot ?? profile.dataRoot) : profile.dataRoot,
    async initializeRoot(profile: AgentProfile): Promise<void> {
      // Onboarding reports this as unavailable and registers nothing.
      if (profile.kind === 'managed' && joinsAnotherRoot(profile.dataRoot)) {
        throw new Error(`Hermes would read ${profile.dataRoot} as a profile of another root and share its sign-in`);
      }
    },
    loginInvocation(profile: AgentProfile, loginOptions: { cwd: string; route?: string }): TerminalSpec {
      const args = LOGIN_ARGS.get(loginOptions.route ?? 'portal');
      if (!args) throw new Error(`unknown Hermes sign-in route: ${loginOptions.route}`);
      // Hermes's own interactive flows; they must own a real terminal so the
      // host never observes the credential exchange.
      return {
        command: executable,
        args: [...args],
        cwd: loginOptions.cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure> {
      const python = await interpreter();
      if (!python) return unavailable('the interpreter the `hermes` wrapper execs could not be found');
      let stdout: string;
      try {
        stdout = (await exec(python, IDENTITY_PROBE_ARGS, { env: probeEnvironment(profile) })).stdout;
      } catch {
        return unavailable("Hermes's account helpers could not be run");
      }
      let document: unknown;
      try {
        document = JSON.parse(stdout.trim().split('\n').pop() ?? '');
      } catch {
        return unavailable('the Hermes identity script did not return JSON');
      }
      return hermesProfileIdentityFrom(document, now().toISOString());
    },
  };
}
