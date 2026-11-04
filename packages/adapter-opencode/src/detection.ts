/**
 * Checked runtime projection of
 * Surface `vendors/opencode/model/opencode@1.19.5/detection.json`.
 * Production code consumes this projection; it never imports the ASM.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withoutOpenCodeServerPasswords } from './launch/credentials.js';

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

/**
 * The 2.x release line's `--version` output (`opencode v2.2.5`, probe 2026-11-04; the plan's
 * draft/OPENCODE-2-MIGRATION-PLAN.md §2.1). It is a different integration family — routes, envelopes, flags and
 * readiness all differ — so this 1.x projection names it in order to refuse it, never to run it. Both lines install
 * the same `opencode` command, so the version string is the only evidence that tells them apart.
 */
export const OPENCODE_UNSUPPORTED_LINE_VERSION_PATTERN = /^opencode v(2\.\d+\.\d+\S*)$/u;

/** What one `--version` output says about the release line, as a typed result. */
export type OpenCodeVersionReading =
  | { status: 'supported'; version: string }
  | { status: 'unsupported-release-line'; line: '2.x'; version: string; message: string }
  | { status: 'unrecognized'; message: string };

/** {@link OpenCodeVersionReading}, or the version command itself could not run. */
export type OpenCodeVersionInspection = OpenCodeVersionReading | { status: 'failed'; message: string };

export function parseOpenCodeVersion(output: string): string | undefined {
  const candidate = output.trim();
  return OPENCODE_VERSION_PATTERN.test(candidate) ? candidate : undefined;
}

/** The words every 2.x refusal carries, so a record that holds only the message (an install's warnings) names it. */
export const OPENCODE_UNSUPPORTED_LINE_MARK = 'is the 2.x release line, which this adapter does not support';

export function unsupportedOpenCodeLineMessage(version: string): string {
  return `OpenCode ${version} ${OPENCODE_UNSUPPORTED_LINE_MARK}; it supports OpenCode 1.x`;
}

export function readOpenCodeVersion(output: string): OpenCodeVersionReading {
  const version = parseOpenCodeVersion(output);
  if (version) return { status: 'supported', version };
  const foreign = OPENCODE_UNSUPPORTED_LINE_VERSION_PATTERN.exec(output.trim())?.[1];
  if (foreign) {
    return {
      status: 'unsupported-release-line',
      line: '2.x',
      version: foreign,
      message: unsupportedOpenCodeLineMessage(foreign),
    };
  }
  return {
    status: 'unrecognized',
    message: `OpenCode ${OPENCODE_VERSION_FLAG} returned an unrecognized version string`,
  };
}

export interface InspectOpenCodeVersionOptions {
  /** The environment the version command runs in; server passwords are removed from it. Default: this process's. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  timeoutMs?: number | undefined;
  /** Stops the version command; an aborted read is `failed`, and the caller decides what the abort means. */
  signal?: AbortSignal | undefined;
}

/**
 * Run `--version` and read it as a typed result; never throws for an expected failure. A Node script (the
 * conformance fixture) runs through this process's Node, as the private backend runs it.
 */
export async function inspectOpenCodeVersion(
  executable = resolveOpenCodeExecutable(),
  options: InspectOpenCodeVersionOptions = {},
): Promise<OpenCodeVersionInspection> {
  const nodeScript = /\.(?:mjs|cjs|js)$/iu.test(executable);
  try {
    const { stdout } = await execFileAsync(
      nodeScript ? process.execPath : executable,
      [...(nodeScript ? [executable] : []), OPENCODE_VERSION_FLAG],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 10_000,
        ...(options.signal ? { signal: options.signal } : {}),
        env: {
          ...withoutOpenCodeServerPasswords(options.env ?? process.env),
          ...(nodeScript && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
      },
    );
    return readOpenCodeVersion(stdout);
  } catch (error) {
    return {
      status: 'failed',
      message: `OpenCode ${OPENCODE_VERSION_FLAG} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function probeOpenCodeVersion(executable = resolveOpenCodeExecutable()): Promise<string> {
  const { stdout } = await execFileAsync(executable, [OPENCODE_VERSION_FLAG], {
    encoding: 'utf8',
    timeout: 10_000,
    env: withoutOpenCodeServerPasswords(process.env),
  });
  const reading = readOpenCodeVersion(stdout);
  if (reading.status === 'supported') return reading.version;
  if (reading.status === 'unsupported-release-line') throw new Error(reading.message);
  throw new Error(`OpenCode returned an unrecognized version string: ${JSON.stringify(stdout.trim())}`);
}
