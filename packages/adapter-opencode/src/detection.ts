/**
 * Checked runtime projection of
 * Surface `vendors/opencode/model/opencode@1.18.16/detection.json`.
 * Production code consumes this projection; it never imports the ASM.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const OPENCODE_EXECUTABLE_ENV = 'PUPPETEER_OPENCODE_BIN';
export const OPENCODE_DEFAULT_EXECUTABLE = 'opencode';
export const OPENCODE_VERSION_FLAG = '--version';
export const OPENCODE_VERSION_PATTERN = /^(\d+\.\d+\.\d+)$/;

export const OPENCODE_LAUNCH_FLAGS = {
  serve: 'serve',
  hostname: '--hostname',
  port: '--port',
  attach: 'attach',
  directory: '--dir',
  session: '--session',
  pure: '--pure',
} as const;

export function resolveOpenCodeExecutable(explicit?: string): string {
  return explicit ?? process.env[OPENCODE_EXECUTABLE_ENV] ?? OPENCODE_DEFAULT_EXECUTABLE;
}

export function parseOpenCodeVersion(output: string): string | undefined {
  const candidate = output.trim();
  return OPENCODE_VERSION_PATTERN.test(candidate) ? candidate : undefined;
}

export async function probeOpenCodeVersion(executable = resolveOpenCodeExecutable()): Promise<string> {
  const { stdout } = await execFileAsync(executable, [OPENCODE_VERSION_FLAG], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const version = parseOpenCodeVersion(stdout);
  if (!version) throw new Error(`OpenCode returned an unrecognized version string: ${JSON.stringify(stdout.trim())}`);
  return version;
}
