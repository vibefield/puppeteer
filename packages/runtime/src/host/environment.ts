import { userInfo } from 'node:os';

/**
 * Construct the explicit environment granted to an agent TUI. The runtime
 * owns this policy; terminal transports must not leak the full parent process
 * environment as an accidental capability.
 *
 * Windows essentials are passed through on win32: a clean env without
 * SystemRoot makes spawned processes abort under ConPTY (probed: node exits
 * 134 before running any JS), and USERPROFILE is what os.homedir() reads
 * there. POSIX callers get HOME plus the login identity required to select
 * user-scoped native credentials.
 */
export interface AgentEnvironmentRequest {
  path?: string | undefined;
  home?: string | undefined;
  locale?: string | undefined;
  /** POSIX login identity used by native credential stores such as macOS Keychain. */
  username?: string | undefined;
  allowed?: Record<string, string> | undefined;
  /** Defaults to process.platform; injectable for tests. */
  platform?: NodeJS.Platform | undefined;
}

export function buildAgentEnvironment(request: AgentEnvironmentRequest = {}): Record<string, string> {
  const platform = request.platform ?? process.platform;
  const environment: Record<string, string> = {
    PATH: request.path ?? process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    TERM_PROGRAM: 'ghostty',
    TERM_PROGRAM_VERSION: '1.2.0',
    CLAUDE_CODE_NO_FLICKER: '1',
    LANG: request.locale ?? process.env.LANG ?? 'en_US.UTF-8',
  };
  if (platform === 'win32') {
    environment.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    if (process.env.TEMP) environment.TEMP = process.env.TEMP;
    if (process.env.TMP) environment.TMP = process.env.TMP;
    if (process.env.USERPROFILE) environment.USERPROFILE = process.env.USERPROFILE;
  } else {
    let operatingSystemUsername: string | undefined;
    try {
      operatingSystemUsername = userInfo().username;
    } catch {
      // A minimal container can lack passwd metadata; environment fallbacks
      // below still preserve an identity when the parent has one.
    }
    const requestedUsername = request.username?.trim() || undefined;
    const username = [requestedUsername, process.env.USER, process.env.LOGNAME, operatingSystemUsername]
      .map((value) => value?.trim())
      .find(Boolean);
    if (username) {
      environment.USER = username;
      environment.LOGNAME = requestedUsername ?? (process.env.LOGNAME?.trim() || username);
    }
  }
  const home = request.home ?? process.env.HOME ?? (platform === 'win32' ? process.env.USERPROFILE : undefined);
  if (home) environment.HOME = home;
  return { ...environment, ...request.allowed };
}

/**
 * Names a host's launch value never takes: the environment's own (a path, the
 * home, the terminal, the locale, the login), what changes how a process loads
 * (`NODE_OPTIONS`, `LD_*`, `DYLD_*`, a Python path), and anything that points an
 * agent at a folder (`XDG_*`, `*_HOME`, `*_DIR`) — an agent's root is its
 * profile's binding, never a server's value.
 */
const RESERVED_LAUNCH_NAME =
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|COLORTERM|FORCE_COLOR|NO_COLOR|LANG|LC_[A-Z_]+|TZ|TMPDIR|TEMP|TMP|SYSTEMROOT|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_[A-Z_]+|DYLD_[A-Z_]+|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUNBUFFERED|BUN_[A-Z_]+|XDG_[A-Z_]+|PUPPETEER_[A-Z0-9_]+|[A-Z0-9_]*_(?:HOME|DIR))$/iu;
const LAUNCH_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
/** A value larger than this is not a key. */
const LAUNCH_VALUE_MAX = 32_768;

/** Whether a host's launch value may take this name. */
export function isLaunchValueName(name: string): boolean {
  return LAUNCH_NAME.test(name) && !RESERVED_LAUNCH_NAME.test(name);
}

/**
 * A host's launch values as a run may take them: well-formed names that are
 * not reserved, and string values of a key's size with no NUL. Nothing, when
 * nothing is left.
 */
export function launchValues(values: unknown): Readonly<Record<string, string>> | undefined {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return undefined;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    if (!isLaunchValueName(name)) continue;
    if (typeof value !== 'string' || value.length > LAUNCH_VALUE_MAX || value.includes('\0')) continue;
    kept[name] = value;
  }
  return Object.keys(kept).length === 0 ? undefined : Object.freeze(kept);
}
