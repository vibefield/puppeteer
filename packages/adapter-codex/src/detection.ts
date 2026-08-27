/** Adapter-owned Codex executable resolution. */

export const CODEX_EXECUTABLE_ENV = 'PUPPETEER_CODEX_BIN';
export const CODEX_DEFAULT_EXECUTABLE = 'codex';

export function resolveCodexExecutable(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? environment[CODEX_EXECUTABLE_ENV] ?? CODEX_DEFAULT_EXECUTABLE;
}
