import { execFile } from 'node:child_process';

export const COPILOT_SURFACE_VERSION = '1.0.80';
export const COPILOT_EXECUTABLE_ENV = 'PUPPETEER_COPILOT_BIN';
export const COPILOT_DEFAULT_EXECUTABLE = 'copilot';

export function resolveCopilotExecutable(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? environment[COPILOT_EXECUTABLE_ENV] ?? COPILOT_DEFAULT_EXECUTABLE;
}
// Probed 2026-09-06 on Copilot 1.0.80: `copilot --version` prints
// `GitHub Copilot CLI 1.0.80.` — the sentence-ending period is part of the
// native output, so one optional trailing dot terminates the version token.
// A further digit after it (`1.0.80.5`) still fails, keeping the token strict.
export function parseCopilotVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.?(?:\s|$)/m)?.[1];
}
export function detectCopilotInstallation(
  explicit?: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ executable: string; version: string; targetVersion: string; exactTarget: boolean }> {
  const executable = resolveCopilotExecutable(explicit, options.env ?? process.env);
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      ['--version'],
      { timeout: options.timeoutMs ?? 5_000, env: options.env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error(`failed to execute ${executable} --version: ${error.message}`, { cause: error }));
        const version = parseCopilotVersion(`${stdout}\n${stderr}`);
        if (!version) return reject(new Error(`${executable} --version returned no semantic version`));
        resolve({
          executable,
          version,
          targetVersion: COPILOT_SURFACE_VERSION,
          exactTarget: version === COPILOT_SURFACE_VERSION,
        });
      },
    ),
  );
}
