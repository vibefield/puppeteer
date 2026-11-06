import { AgentLaunchRefusedError } from '@vibefield/puppeteer-core';
import { ownScriptRunnerFacts, resolveScriptRunner } from '@vibefield/puppeteer-native-observation';
/**
 * Claude executable detection and capability probe (DESIGN §10, §16.2 steps
 * 1–3). Capability-probe, don't assume: we read `claude --version` and
 * `claude --help` and report which launch flags the native driver depends on.
 *
 * Raw detection never throws for missing flags: it reports warnings + false in
 * `flags`. Launch preflight is stricter and throws a typed capability error only
 * when the concrete recipe needs one of those missing flags. The exec function
 * is injected so unit tests run against fakes; the real binary is exercised
 * only by the opt-in integration test gated on CLAUDE_NATIVE_TUI_LIVE.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CLAUDE_BRIEFING_FLAGS } from './launch/briefing.js';
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
  ...CLAUDE_BRIEFING_FLAGS,
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

/** Native version flag from the generated detection surface; reused by the distribution service. */
export const CLAUDE_VERSION_FLAG = surface.versionFlag;

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
  mcpServers?: boolean;
  allowTools?: boolean;
  appendSystemPromptFile?: boolean;
  systemPromptSnapshot?: boolean;
}

export interface ClaudeDetection {
  /** The resolved command (an absolute path, or a bare name left to PATH). */
  executable: string;
  /** Parsed `x.y.z` from `--version`; undefined when it could not be read. */
  version?: string | undefined;
  flags: ClaudeFlagSupport;
  /** Non-fatal capability gaps (missing flags, unreadable version). */
  warnings: string[];
}

export interface DetectClaudeOptions {
  executable?: string | undefined;
  exec?: ClaudeExec | undefined;
}

export interface ClaudeLaunchRequirements {
  /** Fresh sessions need the native UUID join contract. */
  freshSession: boolean;
  /** The adapter will add `--resume`; caller-owned resume picker argv stays caller-owned. */
  resume?: boolean | undefined;
  title?: boolean | undefined;
  model?: boolean | undefined;
  effort?: boolean | undefined;
  settingSources?: boolean | undefined;
  mcpServers?: boolean | undefined;
  allowTools?: boolean | undefined;
  instructions?: boolean | undefined;
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

export const defaultClaudeExec: ClaudeExec = async (file, args) => {
  // Adapter/Imposter development commonly supplies a JavaScript entry point. It runs under this process's script
  // runner, as launch preparation runs it; where there is none (a single executable) the probe fails, never runs
  // the script as that executable.
  const script = SCRIPT_EXECUTABLE.test(file);
  const runner = script ? resolveScriptRunner(ownScriptRunnerFacts()) : undefined;
  if (script && runner === undefined) throw new Error(`no program in this process can run the script ${file}`);
  const command = runner ? runner.command : file;
  const commandArgs = runner ? [...runner.args, file, ...args] : args;
  const { stdout } = await execFileAsync(command, commandArgs, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
    ...(runner?.env ? { env: { ...process.env, ...runner.env } } : {}),
  });
  return { stdout };
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `<semver> (Claude Code)` → `<semver>`; undefined when no semver is present. */
export function parseClaudeVersion(stdout: string): string | undefined {
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

/** Resolution order: explicit option → `PUPPETEER_CLAUDE_BIN` → PATH lookup of `claude`. */
export function resolveClaudeExecutable(explicit?: string, environment: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? environment[surface.envVar] ?? surface.executables[0] ?? 'claude';
}

/**
 * What the launch preflight keys a detection by: the file that runs for `executable` (the one `execFile` finds, or a
 * script's own file), as it is now. undefined when no such file can be read, and then nothing is kept for it.
 */
export type ClaudeExecutableIdentify = (executable: string) => Promise<string | undefined>;

/**
 * The files `execFile` tries for `executable`, in order, with no shell: libuv's lookup over the PATH of the child's
 * environment (the default exec passes this process's).
 * - POSIX (execvp): a name with a slash is that file; otherwise each PATH entry, an empty one being the working
 *   directory. With no PATH libuv falls back to a built-in default, which no identity guesses at.
 * - Windows (src/win/process.c search_path): PATHEXT is NOT read. A name with an extension is tried as given, then
 *   `.com` and `.exe` are appended. A bare name is looked for in the working directory first (unless
 *   NoDefaultCurrentDirectoryInExePath is set), then in each PATH entry, unquoted, empty entries skipped.
 */
function executableCandidates(executable: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') {
    if (executable.includes('/')) return [resolve(executable)];
    return (environment.PATH?.split(delimiter) ?? []).map((directory) => resolve(directory, executable));
  }
  const names = [...(extname(executable).length > 1 ? [executable] : []), `${executable}.com`, `${executable}.exe`];
  if (/[\\/:]/.test(executable)) return names.map((name) => resolve(name));
  const directories = (environment.PATH ?? '')
    .split(delimiter)
    .map((directory) => directory.replace(/^["']|["']$/g, ''))
    .filter((directory) => directory.length > 0);
  if (environment.NoDefaultCurrentDirectoryInExePath === undefined) directories.unshift('');
  return directories.flatMap((directory) => names.map((name) => resolve(directory, name)));
}

/**
 * The default identity: the real path of the file the lookup runs, with the stat fields an in-place update moves (the
 * native installer re-points its launcher symlink at a new version; npm rewrites the package's entry). The first
 * candidate that is a file this process may execute is the one run: execvp passes over the rest, and on Windows `X_OK`
 * reads as existence, which is libuv's own test. A script is never exec'd: the default exec runs it as
 * `<runner> <script>`, and the runner opens the name as a path from the working directory, so it is that one file,
 * executable or not.
 */
export async function identifyClaudeExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const script = SCRIPT_EXECUTABLE.test(executable);
  for (const candidate of script ? [resolve(executable)] : executableCandidates(executable, environment)) {
    try {
      const real = await realpath(candidate);
      const file = await stat(real);
      if (!file.isFile()) continue;
      if (!script) await access(real, constants.X_OK);
      return [real, file.mtimeMs, file.size, file.ino].join('\0');
    } catch {
      // Not a file the lookup would run; the next candidate decides.
    }
  }
  return undefined;
}

interface ClaudeProbe {
  detection: ClaudeDetection;
  /** A version was parsed and help was read: only such a detection is a fact about the file. */
  complete: boolean;
}

export async function detectClaude(options: DetectClaudeOptions = {}): Promise<ClaudeDetection> {
  const executable = resolveClaudeExecutable(options.executable);
  return (await probeClaude(executable, options.exec ?? defaultClaudeExec)).detection;
}

async function probeClaude(executable: string, exec: ClaudeExec): Promise<ClaudeProbe> {
  const warnings: string[] = [];

  let version: string | undefined;
  try {
    const { stdout } = await exec(executable, [surface.versionFlag]);
    version = parseClaudeVersion(stdout);
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
    mcpServers: flags.mcpServers.some((flag) => helpHasFlag(help, flag)),
    allowTools: flags.allowTools.some((flag) => helpHasFlag(help, flag)),
    // Claude documents this hidden flag in the restricted-mode help as --append-system-prompt[-file].
    appendSystemPromptFile:
      help.includes('--append-system-prompt[-file]') ||
      flags.appendSystemPromptFile.some((flag) => helpHasFlag(help, flag)),
    systemPromptSnapshot: flags.systemPromptSnapshot.some((flag) => helpHasFlag(help, flag)),
  };

  for (const key of Object.keys(supported) as Array<keyof ClaudeFlagSupport>) {
    if (!supported[key]) {
      const label = flags[key].join('/');
      warnings.push(
        `\`${executable} ${surface.helpFlag}\` does not advertise ${label}; native driver capability degraded`,
      );
    }
  }

  return {
    detection: { executable, version, flags: supported, warnings },
    complete: version !== undefined && help.trim() !== '',
  };
}

export function requiredClaudeLaunchCapabilities(requirements: ClaudeLaunchRequirements): ClaudeLaunchCapability[] {
  const required: ClaudeLaunchCapability[] = ['settings', 'permissionMode'];
  if (requirements.freshSession) required.push('sessionId');
  if (requirements.resume) required.push('resume');
  if (requirements.title) required.push('name');
  if (requirements.model) required.push('model');
  if (requirements.effort) required.push('effort');
  if (requirements.settingSources) required.push('settingSources');
  if (requirements.mcpServers) required.push('mcpServers');
  if (requirements.allowTools) required.push('allowTools');
  if (requirements.instructions) required.push('appendSystemPromptFile', 'systemPromptSnapshot');
  return required;
}

export function assertClaudeLaunchCapabilities(
  detection: ClaudeDetection,
  requirements: ClaudeLaunchRequirements,
): void {
  const missing = requiredClaudeLaunchCapabilities(requirements).filter((flag) => !detection.flags[flag]);
  const field = missing.includes('mcpServers')
    ? 'mcpServers'
    : missing.includes('allowTools')
      ? 'allowTools'
      : missing.some((flag) => flag === 'appendSystemPromptFile' || flag === 'systemPromptSnapshot')
        ? 'instructions'
        : undefined;
  if (field)
    throw new AgentLaunchRefusedError(
      'UNSUPPORTED_LAUNCH_FIELD',
      `This Claude executable does not support launch field: ${field}.`,
    );
  if (missing.length > 0) throw new ClaudeCapabilityError(detection, missing);
}

export type ClaudeLaunchPreflight = (options: PreflightClaudeLaunchOptions) => Promise<ClaudeDetection>;

export interface ClaudeLaunchPreflightOptions {
  /** The executable's identity, the one key a detection is kept by; default {@link identifyClaudeExecutable}. */
  identify?: ClaudeExecutableIdentify | undefined;
}

/**
 * Build a process-lifetime preflight. Each launch checks only the flags its concrete recipe will use, against a probe
 * kept only while it stands for the file that will run:
 * - Keyed by the executable's identity, so an in-place update (agents.update, the vendor's own updater) probes again.
 *   There is no invalidate verb: the identity is the one invalidation authority. An executable with no identity is
 *   probed at every launch.
 * - Only a complete probe is kept. One that failed (a timeout, Gatekeeper, a reinstall half done) is an observation,
 *   not a fact about the file: launches already waiting share it, it is dropped once it settles, and the next launch
 *   probes again.
 * - One entry per executable name: a new identity replaces the old, so what is held is what is installed now.
 */
export function createClaudeLaunchPreflight(
  exec: ClaudeExec = defaultClaudeExec,
  { identify = identifyClaudeExecutable }: ClaudeLaunchPreflightOptions = {},
): ClaudeLaunchPreflight {
  const probes = new Map<string, { key: string; probe: Promise<ClaudeProbe> }>();
  const probeFor = (executable: string, key: string | undefined): Promise<ClaudeProbe> => {
    if (key === undefined) {
      probes.delete(executable);
      return probeClaude(executable, exec);
    }
    const held = probes.get(executable);
    if (held !== undefined && held.key === key) return held.probe;
    const entry = { key, probe: probeClaude(executable, exec) };
    probes.set(executable, entry);
    const forget = (): void => {
      if (probes.get(executable) === entry) probes.delete(executable);
    };
    void entry.probe.then(({ complete }) => {
      if (!complete) forget();
    }, forget);
    return entry.probe;
  };
  return async (options) => {
    const executable = resolveClaudeExecutable(options.executable);
    const { detection } = await probeFor(executable, await identify(executable));
    assertClaudeLaunchCapabilities(detection, options);
    return detection;
  };
}

/** Shared cached preflight for built-in runtime providers. */
export const preflightClaudeLaunch = createClaudeLaunchPreflight();
