/** Adapter-owned Codex executable resolution and version grammar. */

export const CODEX_EXECUTABLE_ENV = 'PUPPETEER_CODEX_BIN';
export const CODEX_DEFAULT_EXECUTABLE = 'codex';
/** Native version flag; probed 2026-09-06 on Codex 0.153.4 → `codex-cli 0.153.4`. */
export const CODEX_VERSION_FLAG = '--version';
/** Vendor marker in the version banner; distinguishes Codex from any other `codex` on PATH. */
export const CODEX_VERSION_BANNER_MARKER = 'codex-cli';

const CODEX_VERSION_PATTERN = /codex-cli\s+(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/;

export function resolveCodexExecutable(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? environment[CODEX_EXECUTABLE_ENV] ?? CODEX_DEFAULT_EXECUTABLE;
}

/** `codex-cli <semver>` → `<semver>`; undefined when the banner does not carry one. */
export function parseCodexVersion(stdout: string): string | undefined {
  return stdout.match(CODEX_VERSION_PATTERN)?.[1];
}
