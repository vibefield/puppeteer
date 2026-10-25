/**
 * What an opt-in Codex live test runs, and where. The `codex` on a developer's PATH is usually their own
 * signed-in install, with a real `~/.codex` under a real HOME. So a live test never takes the production
 * resolver's PATH fallback (`resolveCodexExecutable`, which real users keep): it runs only the artifact
 * PUPPETEER_CODEX_BIN names, and only inside a throwaway HOME and CODEX_HOME.
 */

import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { removeLiveRoot } from '@vibefield/puppeteer-testing/live-cleanup';
import { CODEX_EXECUTABLE_ENV } from '../detection.js';
import {
  CODEX_LIVE_PINNED_VARIABLES,
  isolatedCodexLiveEnvironment,
  startCodexLoopbackProvider,
  writeCodexLiveConfiguration,
  type CodexLiveModelProvider,
} from './live-model.js';

/** The live tests' own switches: they share Codex's prefix, but codex reads none of them. */
const LIVE_HARNESS_VARIABLES = new Set([
  'CODEX_LIVE',
  'CODEX_NATIVE_TUI_LIVE',
  'CODEX_NATIVE_TUI_TRANSPORT',
  'CODEX_ACCOUNT_USAGE_LIVE',
  'CODEX_INVOCATION_LIVE',
  'CODEX_INVOCATION_CASES',
  'CODEX_INVOCATION_ROOT',
  'CODEX_INVOCATION_OUT',
]);

const PINNED = new Set(CODEX_LIVE_PINNED_VARIABLES);

/**
 * The Codex and OpenAI variables in `environment` that a throwaway profile does not pin. The live tests'
 * app-servers are spawned with this process's environment beneath the profile's (`spawnAppServer`), so
 * these would reach codex unchanged, and 0.164.0 reads credentials (`CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`,
 * `CODEX_AUTH`, `OPENAI_IDENTITY_TOKEN_FILE`, …) and roots it writes under (`CODEX_ROLLOUT_TRACE_ROOT`,
 * `CODEX_TUI_SESSION_LOG_PATH`, …) from them. Matched without regard to case, as Windows reads them.
 */
export function inheritedCodexVariables(environment: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(environment)
    .filter((name) => {
      const upper = name.toUpperCase();
      return /^(?:CODEX|OPENAI)_/u.test(upper) && !PINNED.has(upper) && !LIVE_HARNESS_VARIABLES.has(upper);
    })
    .sort();
}

/**
 * The absolute path PUPPETEER_CODEX_BIN names, for the live test `flag` enables. Throws when it is unset,
 * not absolute (spawn would look a bare name up on PATH) or not a file, and when the environment exports
 * a Codex variable the profile does not pin ({@link inheritedCodexVariables}); the message names
 * variables, never their values.
 */
export function requireCodexLiveExecutable(flag: string, environment: NodeJS.ProcessEnv = process.env): string {
  const executable = environment[CODEX_EXECUTABLE_ENV];
  const usage = `${flag}=1 runs only the Codex named by ${CODEX_EXECUTABLE_ENV}=/absolute/path/to/codex, never one from PATH`;
  if (executable === undefined || executable === '') throw new Error(`${usage}: ${CODEX_EXECUTABLE_ENV} is not set`);
  if (!isAbsolute(executable)) throw new Error(`${usage}: ${CODEX_EXECUTABLE_ENV} is not an absolute path`);
  let file = false;
  try {
    file = statSync(executable).isFile();
  } catch {
    // Missing: reported below.
  }
  if (!file) throw new Error(`${usage}: ${CODEX_EXECUTABLE_ENV} names no file`);
  const inherited = inheritedCodexVariables(environment);
  if (inherited.length > 0) {
    throw new Error(
      `${flag}=1 runs codex only in a throwaway profile, but this environment exports ${inherited.join(', ')}, ` +
        `which the profile does not pin: unset ${inherited.length === 1 ? 'it' : 'them'}`,
    );
  }
  return executable;
}

/**
 * Remove a Codex live root. At startup the app-server syncs its curated plugins with `git` into
 * `CODEX_HOME/.tmp/plugins-clone-*` (findings C8); those helpers name the directory on their command line,
 * share the app-server's process group and outlive it, so the shared cleanup stops them before removing.
 */
export function removeCodexLiveRoot(root: string): Promise<void> {
  return removeLiveRoot(root, 'codex live');
}

export interface CodexLiveProfile {
  /** The directory holding everything below; `dispose` removes it. */
  readonly root: string;
  readonly codexHome: string;
  /** An empty workspace, trusted by a loopback profile's configuration. */
  readonly cwd: string;
  /** HOME, CODEX_HOME, XDG and temp directories under `root`, to merge over the spawning environment. */
  readonly environment: Record<string, string>;
  /** The loopback Responses endpoint a `loopback` profile is configured for. */
  readonly provider: CodexLiveModelProvider | undefined;
  /** Close the endpoint, stop what still works under `root`, and remove it. Call after the codex processes are disposed. */
  dispose(): Promise<void>;
}

/**
 * A throwaway HOME and CODEX_HOME under the temp directory. `loopback` (the default) configures the
 * deterministic loopback Responses endpoint with a placeholder API key, so a turn needs no account and
 * reaches no model; `none` leaves CODEX_HOME empty: no credentials and no provider.
 */
export async function createCodexLiveProfile(
  prefix: string,
  model: 'loopback' | 'none' = 'loopback',
): Promise<CodexLiveProfile> {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  const codexHome = join(root, 'codex-home');
  const cwd = join(root, 'workspace');
  let provider: CodexLiveModelProvider | undefined;
  try {
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    if (model === 'loopback') {
      provider = await startCodexLoopbackProvider();
      writeCodexLiveConfiguration(codexHome, cwd, provider.baseUrl);
    }
    const environment = isolatedCodexLiveEnvironment(root, codexHome);
    return {
      root,
      codexHome,
      cwd,
      environment,
      provider,
      async dispose() {
        await provider?.close();
        await removeCodexLiveRoot(root);
      },
    };
  } catch (error) {
    await provider?.close();
    await removeCodexLiveRoot(root);
    throw error;
  }
}
