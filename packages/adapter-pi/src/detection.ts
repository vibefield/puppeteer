import { execFile } from 'node:child_process';

export const PI_SURFACE_VERSION = '0.84.3';
export const PI_EXECUTABLE_ENV = 'PUPPETEER_PI_BIN';
export const PI_DEFAULT_EXECUTABLE = 'pi';

export function resolvePiExecutable(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? environment[PI_EXECUTABLE_ENV] ?? PI_DEFAULT_EXECUTABLE;
}

export function parsePiVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m)?.[1];
}

export function detectPiInstallation(
  explicitExecutable?: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ executable: string; version: string; targetVersion: string; exactTarget: boolean }> {
  const executable = resolvePiExecutable(explicitExecutable, options.env ?? process.env);
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--version'],
      { timeout: options.timeoutMs ?? 5_000, env: options.env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error(`failed to execute ${executable} --version: ${error.message}`, { cause: error }));
        const version = parsePiVersion(`${stdout}\n${stderr}`);
        if (!version) return reject(new Error(`${executable} --version returned no semantic version`));
        resolve({
          executable,
          version,
          targetVersion: PI_SURFACE_VERSION,
          exactTarget: version === PI_SURFACE_VERSION,
        });
      },
    );
  });
}
