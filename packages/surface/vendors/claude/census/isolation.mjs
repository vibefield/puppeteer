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
 *
 * An empty environment still does not prove the artifact holds no credential
 * (findings.md, 2.1.311), so network reach is closed too: the model endpoint
 * and every HTTP(S) proxy variable default to a refusing loopback port, and
 * only loopback bypasses the proxy. Lanes that run a census-owned server
 * replace those defaults with their loopback model and the egress recorder
 * (census/egress-guard.mjs). The environment cannot hide a credential the
 * artifact reads from a fixed path (2.1.311 reads one under
 * /home/claude/.claude/remote); the Linux network-deny sandbox
 * (census/sandbox.mjs) hides that directory and takes the network away.
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

/**
 * Fail-closed model endpoint for every execution that does not name the
 * census's own loopback model. An empty environment does not prove the
 * artifact holds no credential: in a hosted Linux container the 2.1.311
 * artifact still sent an Authorization header (findings.md, 2.1.311), so the
 * only safe default is an endpoint nothing can listen on. Port 0 refuses every
 * connection, so a request fails with ECONNREFUSED and its headers reach no
 * listener. Lanes with a loopback model override it. It redirects only the
 * model endpoint, not the hard-coded account and OAuth endpoints; those are
 * the proxy's job (below).
 */
export const FAIL_CLOSED_BASE_URL = 'http://127.0.0.1:0';

/**
 * Fail-closed proxy for traffic no base URL controls, such as the artifact's
 * hard-coded account and OAuth endpoints. Like the base URL it refuses every
 * connection; asynchronous lanes replace it with the egress recorder.
 */
export const FAIL_CLOSED_PROXY_URL = 'http://127.0.0.1:0';

/** Hosts that bypass the proxy: the census's own loopback model and hook sink. */
export const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1';

/** Proxy variables (both spellings) that route every non-loopback request to `proxyUrl`. */
export function egressEnvironment(proxyUrl = FAIL_CLOSED_PROXY_URL) {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: LOOPBACK_NO_PROXY,
    no_proxy: LOOPBACK_NO_PROXY,
  };
}

/** A complete environment for one artifact process; `extra` may add census-owned variables only. */
export function isolatedEnvironment(layout, extra = {}) {
  return {
    ANTHROPIC_BASE_URL: FAIL_CLOSED_BASE_URL,
    ...egressEnvironment(),
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
    // The pinned TUI bootstraps its official marketplace even with nonessential
    // traffic disabled. A census must never install plugins from the network.
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
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
