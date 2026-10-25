import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ClaudeExec } from '../detection.js';

/** The artifact override every Claude live lane reads (the detection surface's `envVar`). */
export const CLAUDE_LIVE_EXECUTABLE_VARIABLE = 'PUPPETEER_CLAUDE_BIN';

const execFileAsync = promisify(execFile);
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/;

/**
 * The exact artifact a live lane proves. A live lane never falls back to `claude` on PATH: there it
 * is normally the owner's logged-in install, not the pinned candidate. A bare command name would
 * reach PATH the same way, so the variable must name a path.
 */
export function requireClaudeLiveExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment[CLAUDE_LIVE_EXECUTABLE_VARIABLE]?.trim();
  if (!configured) {
    throw new Error(
      `Claude live lanes require ${CLAUDE_LIVE_EXECUTABLE_VARIABLE}=/absolute/path/to/claude; ` +
        'they never fall back to `claude` on PATH',
    );
  }
  if (!isAbsolute(configured) && !/[\\/]/.test(configured)) {
    throw new Error(
      `${CLAUDE_LIVE_EXECUTABLE_VARIABLE} must name the artifact's path, not a command resolved through PATH`,
    );
  }
  return resolve(configured);
}

/**
 * Runs detection probes (`--version`, `--help`) in exactly the lane's isolated environment. The
 * default runner inherits the parent's environment, whose HOME and CLAUDE_CONFIG_DIR name the
 * owner's state; without HOME at all the binary would resolve the account's home directory itself.
 */
export function isolatedClaudeExec(environment: Readonly<Record<string, string>>): ClaudeExec {
  for (const name of ['HOME', 'CLAUDE_CONFIG_DIR'] as const) {
    if (!environment[name]) throw new Error(`isolated Claude detection requires an explicit ${name}`);
  }
  return async (file, args) => {
    const isScript = SCRIPT_EXECUTABLE.test(file);
    const { stdout } = await execFileAsync(isScript ? process.execPath : file, isScript ? [file, ...args] : args, {
      env: { ...environment },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout };
  };
}
