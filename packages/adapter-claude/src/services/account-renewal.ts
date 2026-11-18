/**
 * Asking Claude Code to renew an aged access token.
 *
 * A Claude Code sign-in is two tokens: an access token that lives eight hours and the refresh token it is renewed
 * from. Nothing here refreshes a token or writes a credential: Claude Code owns both, and a second writer would race
 * its refresh-token rotation. This only starts Claude Code once under the account's root; its own start renews an
 * aged token and stores it.
 *
 * Measured 2026-11-17 on Claude Code 2.1.326, macOS: under two managed roots whose access tokens had been aged for
 * about three hours, `claude --safe-mode --strict-mcp-config --print /cost --no-session-persistence` exited 0 in five
 * to six seconds and each root's stored expiry then read eight hours ahead. It sends no message (no turn, no session
 * file), so it spends none of the account's quota. `claude auth status --json` did not renew. Unmeasured: other
 * systems, where the credential is the root's own file.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile } from '@vibefield/puppeteer-core';
import { ownScriptRunnerFacts, resolveScriptRunner } from '@vibefield/puppeteer-native-observation';
import { resolveClaudeExecutable } from '../detection.js';
import { CLAUDE_PROFILE_ROOT_VARIABLE } from './profiles.js';

/** One print-mode start that runs a local command and ends: no model is asked anything. */
export const CLAUDE_RENEWAL_ARGS: readonly string[] = [
  '--safe-mode',
  '--strict-mcp-config',
  '--print',
  '/cost',
  '--no-session-persistence',
];

const RENEWAL_TIMEOUT_MS = 30_000;
/** A renewal that did not work is not tried again for its root before this has passed. */
const RENEWAL_RETRY_WAIT_MS = 30 * 60_000;
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/;

/**
 * The only variables of the host's environment a renewal sees. The host may hold an API key, a token override or
 * its own secrets; any of them would change which account Claude Code acts as, or leak into its process.
 */
const PASSED_VARIABLES = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'LANG',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERNAME',
] as const;

/** What one renewal starts. */
export interface ClaudeRenewalInvocation {
  command: string;
  args: string[];
  /** An empty folder that is no project: no project settings are read and no folder is trusted. */
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** Runs one invocation to its end; rejects when it cannot be started, is ended by the limit, or exits non-zero. */
export type ClaudeRenewalRun = (invocation: ClaudeRenewalInvocation) => Promise<void>;

export interface ClaudeTokenRenewerOptions {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to a folder of this module's own under the system's temporary directory. */
  workingDirectory?: string;
  /** Injected runner so unit tests start no process. */
  run?: ClaudeRenewalRun;
  now?: () => Date;
}

export interface ClaudeTokenRenewer {
  /**
   * Ask Claude Code to renew the access token of the native default account, or of one profile's root. Resolves
   * true once the start has ended and `confirm` reads the token fresh; false otherwise. Never rejects. Calls for
   * one root share one start, and a renewal that did not work is not tried again for that root for thirty minutes.
   */
  renew(profile: AgentProfile | undefined, confirm: () => Promise<boolean>): Promise<boolean>;
}

/** Input closed and output discarded: what Claude Code prints could name the account, and nothing here reads it. */
const defaultRun: ClaudeRenewalRun = async (invocation) => {
  await mkdir(invocation.cwd, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), invocation.timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Claude Code did not end its renewal start cleanly'));
    });
  });
};

function renewalEnvironment(ambient: NodeJS.ProcessEnv, profile: AgentProfile | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_VARIABLES) {
    const value = ambient[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  env.TERM = 'dumb';
  // The native default is the vendor's own root: a root variable the host inherited never re-points it.
  if (profile?.kind === 'managed') env[CLAUDE_PROFILE_ROOT_VARIABLE] = profile.dataRoot;
  return env;
}

/** A renewer for one composition: its starts in flight and its waits are its own, never process-global. */
export function createClaudeTokenRenewer(options: ClaudeTokenRenewerOptions = {}): ClaudeTokenRenewer {
  const ambient = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const now = options.now ?? (() => new Date());
  const cwd = options.workingDirectory ?? join(tmpdir(), 'puppeteer-claude-renewal');
  const inFlight = new Map<string, Promise<boolean>>();
  const failedAtMs = new Map<string, number>();

  const invocationFor = (profile: AgentProfile | undefined): ClaudeRenewalInvocation => {
    const executable = resolveClaudeExecutable(options.executable, ambient);
    const env = renewalEnvironment(ambient, profile);
    const args = [...CLAUDE_RENEWAL_ARGS];
    const timeoutMs = RENEWAL_TIMEOUT_MS;
    if (!SCRIPT_EXECUTABLE.test(executable)) return { command: executable, args, cwd, env, timeoutMs };
    // A script runs under this process's script runner; where there is none, nothing is started.
    const runner = resolveScriptRunner(ownScriptRunnerFacts());
    if (runner === undefined) throw new Error(`no program in this process can run the script ${executable}`);
    return {
      command: runner.command,
      args: [...runner.args, executable, ...args],
      cwd,
      env: { ...env, ...runner.env },
      timeoutMs,
    };
  };

  return {
    renew(profile, confirm) {
      const key = profile?.kind === 'managed' ? profile.dataRoot : '';
      const running = inFlight.get(key);
      if (running) return running;
      const failed = failedAtMs.get(key);
      if (failed !== undefined && now().valueOf() - failed < RENEWAL_RETRY_WAIT_MS) return Promise.resolve(false);

      const attempt = (async (): Promise<boolean> => {
        let renewed = false;
        try {
          await run(invocationFor(profile));
          renewed = await confirm();
        } catch {
          renewed = false;
        }
        if (renewed) failedAtMs.delete(key);
        else failedAtMs.set(key, now().valueOf());
        return renewed;
      })();
      inFlight.set(key, attempt);
      void attempt.then(() => {
        if (inFlight.get(key) === attempt) inFlight.delete(key);
      });
      return attempt;
    },
  };
}
