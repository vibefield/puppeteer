import { execFile } from 'node:child_process';
export const ANTIGRAVITY_SURFACE_VERSION = '1.1.20';
export const ANTIGRAVITY_EXECUTABLE_ENV = 'PUPPETEER_ANTIGRAVITY_BIN';
export function resolveAntigravityExecutable(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? environment[ANTIGRAVITY_EXECUTABLE_ENV] ?? 'agy';
}
export function parseAntigravityVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m)?.[1];
}
export function detectAntigravityInstallation(
  explicit?: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ executable: string; version: string; targetVersion: string; exactTarget: boolean }> {
  const executable = resolveAntigravityExecutable(explicit, options.env ?? process.env);
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      ['--version'],
      { timeout: options.timeoutMs ?? 5_000, env: options.env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error(`failed to execute ${executable} --version: ${error.message}`, { cause: error }));
        const version = parseAntigravityVersion(`${stdout}\n${stderr}`);
        if (!version) return reject(new Error(`${executable} --version returned no semantic version`));
        resolve({
          executable,
          version,
          targetVersion: ANTIGRAVITY_SURFACE_VERSION,
          exactTarget: version === ANTIGRAVITY_SURFACE_VERSION,
        });
      },
    ),
  );
}
