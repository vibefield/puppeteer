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
  path?: string;
  home?: string;
  locale?: string;
  /** POSIX login identity used by native credential stores such as macOS Keychain. */
  username?: string;
  allowed?: Record<string, string>;
  /** Defaults to process.platform; injectable for tests. */
  platform?: NodeJS.Platform;
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
