import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  HERMES_DEFAULT_EXECUTABLE,
  HERMES_EXECUTABLE_ENV,
  HERMES_LAUNCH_FLAGS,
  HERMES_SURFACE_VERSION,
  HERMES_VERSION_FLAG,
  HERMES_VERSION_PATTERN,
} from './generated/detection.js';

const execFileAsync = promisify(execFile);

export const HERMES_ADAPTER_CAPABILITIES = Object.freeze({
  executionMode: 'native-tui' as const,
  observationLevel: 'structured' as const,
  promptConfirmation: 'session-message-start' as const,
  structuredApprovalControl: false,
  isolatedHome: true,
});

export function resolveHermesExecutable(explicit?: string): string {
  return explicit ?? process.env[HERMES_EXECUTABLE_ENV] ?? HERMES_DEFAULT_EXECUTABLE;
}

export function parseHermesVersion(output: string): { version: string; releaseTag: string } | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(HERMES_VERSION_PATTERN);
    if (match?.[1] && match[2]) return { version: match[1], releaseTag: match[2] };
  }
  return undefined;
}

export async function probeHermesVersion(executable = resolveHermesExecutable()): Promise<{
  version: string;
  releaseTag: string;
}> {
  const { stdout, stderr } = await execFileAsync(executable, [HERMES_VERSION_FLAG], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const parsed = parseHermesVersion(`${stdout}\n${stderr}`);
  if (!parsed) {
    throw new Error(`Hermes returned an unrecognized version string: ${JSON.stringify(stdout.trim())}`);
  }
  return parsed;
}

export function buildHermesTuiArgs(options: { resume?: string; yolo?: boolean } = {}): string[] {
  const args: string[] = [HERMES_LAUNCH_FLAGS.tui];
  if (options.yolo) args.push(HERMES_LAUNCH_FLAGS.yolo);
  if (options.resume) args.push(HERMES_LAUNCH_FLAGS.resume, options.resume);
  return args;
}

export { HERMES_SURFACE_VERSION, HERMES_LAUNCH_FLAGS, HERMES_EXECUTABLE_ENV, HERMES_DEFAULT_EXECUTABLE };
