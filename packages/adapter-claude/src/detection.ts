/**
 * Claude executable detection and capability probe (DESIGN §10, §16.2 steps
 * 1–3). Capability-probe, don't assume: we read `claude --version` and
 * `claude --help` and report which launch flags the native driver depends on.
 *
 * Raw detection never throws for missing flags: it reports warnings + false in
 * `flags`. Launch preflight is stricter and throws a typed capability error only
 * when the concrete recipe needs one of those missing flags. The exec function
 * is injected so unit tests run against fakes; the real binary is exercised
 * only by the opt-in integration test gated on PUPPETEER_REAL_CLAUDE.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLAUDE_DETECTION_SURFACE } from './generated/detection-surface.js';

interface DetectionSurface {
  executables: string[];
  envVar: string;
  versionFlag: string;
  versionPattern: string;
  helpFlag: string;
  probedFlags: Pick<
    Record<keyof ClaudeFlagSupport, string>,
    'sessionId' | 'settings' | 'settingSources' | 'name' | 'permissionMode'
  >;
  launchFlags: Pick<Record<keyof ClaudeFlagSupport, string>, 'resume' | 'model' | 'effort'>;
}

const surface = CLAUDE_DETECTION_SURFACE as unknown as DetectionSurface;
const versionPattern = new RegExp(surface.versionPattern);
const advertisedFlags: Record<keyof ClaudeFlagSupport, string> = {
  sessionId: surface.probedFlags.sessionId,
  settings: surface.probedFlags.settings,
  settingSources: surface.probedFlags.settingSources,
  name: surface.probedFlags.name,
  permissionMode: surface.probedFlags.permissionMode,
  resume: surface.launchFlags.resume,
  model: surface.launchFlags.model,
  effort: surface.launchFlags.effort,
};
const flags = Object.fromEntries(
  Object.entries(advertisedFlags).map(([key, value]) => [
    key,
    value
      .split(',')
      .map((flag) => flag.trim())
      .filter(Boolean),
  ]),
) as Record<keyof ClaudeFlagSupport, string[]>;

/** Injected process runner; the default wraps node:child_process execFile. */
export type ClaudeExec = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface ClaudeFlagSupport {
  sessionId: boolean;
  settings: boolean;
  settingSources: boolean;
  name: boolean;
  permissionMode: boolean;
  resume: boolean;
  model: boolean;
  effort: boolean;
}

export interface ClaudeDetection {
  /** The resolved command (an absolute path, or a bare name left to PATH). */
  executable: string;
  /** Parsed `x.y.z` from `--version`; undefined when it could not be read. */
  version?: string;
  flags: ClaudeFlagSupport;
  /** Non-fatal capability gaps (missing flags, unreadable version). */
  warnings: string[];
}

export interface DetectClaudeOptions {
  executable?: string;
  exec?: ClaudeExec;
}

export interface ClaudeLaunchRequirements {
  /** Fresh sessions need the native UUID join contract. */
  freshSession: boolean;
  /** The adapter will add `--resume`; caller-owned resume picker argv stays caller-owned. */
  resume?: boolean;
  title?: boolean;
  model?: boolean;
  effort?: boolean;
  settingSources?: boolean;
}

export interface PreflightClaudeLaunchOptions extends ClaudeLaunchRequirements {
  executable?: string;
}

export type ClaudeLaunchCapability = keyof ClaudeFlagSupport;

/** A launch recipe cannot work against the detected executable's advertised surface. */
export class ClaudeCapabilityError extends Error {
  readonly code = 'CLAUDE_CAPABILITY_MISSING' as const;

  constructor(
    readonly detection: ClaudeDetection,
    readonly missingFlags: readonly ClaudeLaunchCapability[],
  ) {
    const labels = missingFlags.map((flag) => flags[flag].join('/')).join(', ');
    super(`Claude executable ${detection.executable} does not advertise required launch flags: ${labels}`);
    this.name = 'ClaudeCapabilityError';
  }
}

const execFileAsync = promisify(execFile);
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/;

const defaultExec: ClaudeExec = async (file, args) => {
  // Adapter/Imposter development commonly supplies a JavaScript entry point.
  // Match launch preparation by running scripts under Node; Electron resolves
  // `node` from PATH rather than accidentally entering Electron-as-Node.
  const isScript = SCRIPT_EXECUTABLE.test(file);
  const command = isScript ? (process.versions.electron ? 'node' : process.execPath) : file;
  const commandArgs = isScript ? [file, ...args] : args;
  const { stdout } = await execFileAsync(command, commandArgs, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  return { stdout };
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `<semver> (Claude Code)` → `<semver>`; undefined when no semver is present. */
function parseVersion(stdout: string): string | undefined {
  return stdout.match(versionPattern)?.[1];
}

/**
 * Match a flag as a standalone token. Help text lists flags whitespace- or
 * comma-delimited (`-n, --name`), so a bare `includes` would false-positive
 * (`-n` inside `--session-id` need not, but `--settings` inside `--settings-x`
 * would). Bound the match on both sides.
 */
function helpHasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,('"\`])${escaped}([\\s,)='"\`]|$)`, 'm').test(help);
}

function resolveExecutable(executable?: string): string {
  return executable ?? process.env[surface.envVar] ?? surface.executables[0] ?? 'claude';
}

export async function detectClaude(options: DetectClaudeOptions = {}): Promise<ClaudeDetection> {
  const exec = options.exec ?? defaultExec;
  // Resolution order: explicit option → env override → PATH lookup of `claude`.
  const executable = resolveExecutable(options.executable);
  const warnings: string[] = [];

  let version: string | undefined;
  try {
    const { stdout } = await exec(executable, [surface.versionFlag]);
    version = parseVersion(stdout);
    if (!version) {
      warnings.push(`could not parse version from \`${executable} ${surface.versionFlag}\`: ${stdout.trim()}`);
    }
  } catch (err) {
    warnings.push(`\`${executable} ${surface.versionFlag}\` failed: ${errMessage(err)}`);
  }

  let help = '';
  try {
    help = (await exec(executable, [surface.helpFlag])).stdout;
  } catch (err) {
    warnings.push(`\`${executable} ${surface.helpFlag}\` failed: ${errMessage(err)}`);
  }

  const supported: ClaudeFlagSupport = {
    sessionId: flags.sessionId.some((flag) => helpHasFlag(help, flag)),
    settings: flags.settings.some((flag) => helpHasFlag(help, flag)),
    settingSources: flags.settingSources.some((flag) => helpHasFlag(help, flag)),
    name: flags.name.some((flag) => helpHasFlag(help, flag)),
    permissionMode: flags.permissionMode.some((flag) => helpHasFlag(help, flag)),
    resume: flags.resume.some((flag) => helpHasFlag(help, flag)),
    model: flags.model.some((flag) => helpHasFlag(help, flag)),
    effort: flags.effort.some((flag) => helpHasFlag(help, flag)),
  };

  for (const key of Object.keys(supported) as Array<keyof ClaudeFlagSupport>) {
    if (!supported[key]) {
      const label = flags[key].join('/');
      warnings.push(
        `\`${executable} ${surface.helpFlag}\` does not advertise ${label}; native driver capability degraded`,
      );
    }
  }

  return { executable, version, flags: supported, warnings };
}

export function requiredClaudeLaunchCapabilities(requirements: ClaudeLaunchRequirements): ClaudeLaunchCapability[] {
  const required: ClaudeLaunchCapability[] = ['settings', 'permissionMode'];
  if (requirements.freshSession) required.push('sessionId');
  if (requirements.resume) required.push('resume');
  if (requirements.title) required.push('name');
  if (requirements.model) required.push('model');
  if (requirements.effort) required.push('effort');
  if (requirements.settingSources) required.push('settingSources');
  return required;
}

export function assertClaudeLaunchCapabilities(
  detection: ClaudeDetection,
  requirements: ClaudeLaunchRequirements,
): void {
  const missing = requiredClaudeLaunchCapabilities(requirements).filter((flag) => !detection.flags[flag]);
  if (missing.length > 0) throw new ClaudeCapabilityError(detection, missing);
}

export type ClaudeLaunchPreflight = (options: PreflightClaudeLaunchOptions) => Promise<ClaudeDetection>;

/**
 * Build a process-lifetime preflight. Detection is cached per resolved executable,
 * while each launch still checks only the flags its concrete recipe will use.
 */
export function createClaudeLaunchPreflight(exec: ClaudeExec = defaultExec): ClaudeLaunchPreflight {
  const detections = new Map<string, Promise<ClaudeDetection>>();
  return async (options) => {
    const executable = resolveExecutable(options.executable);
    let detection = detections.get(executable);
    if (!detection) {
      detection = detectClaude({ executable, exec });
      detections.set(executable, detection);
    }
    const resolved = await detection;
    assertClaudeLaunchCapabilities(resolved, options);
    return resolved;
  };
}

/** Shared cached preflight for built-in runtime providers. */
export const preflightClaudeLaunch = createClaudeLaunchPreflight();
