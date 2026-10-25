/**
 * Disposable process environment for every execution of a pinned Claude Code
 * artifact by the Surface census and model generator.
 *
 * Nothing is inherited from the caller's environment: a developer shell can
 * hold ANTHROPIC_* credentials, CLAUDE_CODE_* session variables (including
 * messaging tokens of a running Claude session), proxies, or a PATH whose
 * `claude` is a different release. The artifact instead sees a throwaway HOME,
 * CLAUDE_CONFIG_DIR, TMPDIR and XDG tree, a minimal PATH, and nonessential
 * traffic disabled.
 *
 * On macOS Claude looks credentials up through `security(1)` found on PATH. The
 * disposable PATH starts with a stub that answers every lookup "not found", so
 * a census never reads, writes, or prompts for the owner's login keychain.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const SECURITY_STUB = `#!/bin/sh
# Census keychain stub: never touches a real keychain.
case "$1" in find-*|delete-*) exit 44 ;; *) exit 0 ;; esac
`;

/**
 * Create a disposable root. The short prefix keeps Unix socket paths that
 * Claude derives from TMPDIR below the platform limit.
 */
export function createIsolatedRoot(prefix = 'pcc-') {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  const layout = {
    root,
    home: join(root, 'home'),
    configDir: join(root, 'config'),
    temporary: join(root, 'tmp'),
    workspace: join(root, 'workspace'),
    bin: join(root, 'bin'),
  };
  for (const directory of [layout.home, layout.temporary, layout.workspace, layout.bin]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  mkdirSync(layout.configDir, { recursive: true, mode: 0o700 });
  const security = join(layout.bin, 'security');
  writeFileSync(security, SECURITY_STUB, { mode: 0o700 });
  chmodSync(security, 0o700);
  return layout;
}

/** A complete environment for one artifact process; `extra` may add census-owned variables only. */
export function isolatedEnvironment(layout, extra = {}) {
  return {
    PATH: [layout.bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    HOME: layout.home,
    USERPROFILE: layout.home,
    XDG_CONFIG_HOME: join(layout.home, '.config'),
    XDG_CACHE_HOME: join(layout.home, '.cache'),
    XDG_DATA_HOME: join(layout.home, '.local', 'share'),
    XDG_STATE_HOME: join(layout.home, '.local', 'state'),
    TMPDIR: layout.temporary,
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    CLAUDE_CONFIG_DIR: layout.configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_UPDATES: '1',
    ...extra,
  };
}

export function removeIsolatedRoot(layout) {
  rmSync(layout.root, { recursive: true, force: true });
}
