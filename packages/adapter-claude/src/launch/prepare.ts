/**
 * Native Claude session preparation (DESIGN §16.2 steps 4–5, 8; §11
 * PreparedNativeSession). Allocates the runtime session UUID used by hooks,
 * OTLP records, transcripts, and workflow journals, writes the generated hook
 * settings to a per-session file, and builds the interactive spawn command.
 *
 * The command is native-interactive ONLY (§16.3): never -p/--print/
 * --output-format/--input-format — those select structured print mode, a
 * different process class. The token VALUE rides `env` (injected into the
 * process, resolved by Claude's env interpolation), never the on-disk settings.
 */

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants, accessSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { CLAUDE_HOOK_FORWARDER_SOURCE, generateHookSettings } from './settings.js';
import {
  CLAUDE_STATUS_CHANNEL_FORWARDER_SOURCE,
  resolveClaudeStatusChannels,
  type ClaudeSettingSource,
  type ClaudeStatusLineConfig,
} from '../observation/status-channel.js';

export interface PrepareClaudeSessionOptions {
  cwd: string;
  title?: string;
  /** Reuse a caller-chosen session UUID; otherwise one is generated. */
  sessionId?: string;
  endpoint: string;
  /** Optional authenticated endpoint enabling exact context-window telemetry. */
  statusLineEndpoint?: string;
  /** Optional authenticated endpoint enabling visible child/task telemetry. */
  subagentStatusLineEndpoint?: string;
  /** Optional authenticated OTLP/HTTP JSON log endpoint for settled request usage. */
  otelLogsEndpoint?: string;
  tokenEnvVar: string;
  /** The bearer token VALUE — placed in `env`, never written to disk. */
  token: string;
  executable?: string;
  permissionMode?: string;
  /** Model alias or full model id passed to Claude Code's `--model`. */
  model?: string;
  /** Open-ended Claude effort value passed to `--effort`. */
  effort?: string;
  /** Native settings layers passed to `--setting-sources` and used for delegate discovery. */
  settingSources?: readonly ClaudeSettingSource[];
  /** Override Claude's user configuration root; defaults to `CLAUDE_CONFIG_DIR` when set. */
  configDir?: string;
  /** Override auto-resolution of the user/project status line; null means no delegate. */
  existingStatusLine?: ClaudeStatusLineConfig | null;
  /** Override auto-resolution of the user/project child line; null means no delegate. */
  existingSubagentStatusLine?: ClaudeStatusLineConfig | null;
  /** Claude FileChanged matcher (for example `.envrc|.env`); omitted means no file watcher is installed. */
  fileChangeMatcher?: string;
  /**
   * Resume an existing session by its id instead of starting fresh. Probed
   * (packages/surface/vendors/claude/findings.md §6): `--resume <id>` continues the SAME session and
   * transcript in place, so the id/join-contract is preserved automatically —
   * `--session-id` is NOT passed alongside it. When set, `sessionId` is
   * ignored in favor of this id.
   */
  resume?: string;
  /** Native resume/continue argv when Claude must choose the session after launch. */
  resumeInvocation?: string[];
  /** Override the settings-file directory (tests); default is an mkdtemp dir. */
  settingsDir?: string;
}

/** DESIGN §11 PreparedNativeSession, narrowed to what this adapter fills. */
export interface PreparedClaudeSession {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  settingsPath: string;
  hookForwarderPath: string;
  statusLineForwarderPath?: string;
  filesToCleanup: string[];
}

const CLAUDE_OTEL_CONFLICT_KEYS = [
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  'OTEL_EXPORTER_OTLP_LOGS_COMPRESSION',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_LOGS_EXPORT_INTERVAL',
] as const;

/** Do not hijack a caller's exporter. The driver falls back to the transcript when any route is already configured. */
export function hasClaudeOtelExporterConflict(environment: NodeJS.ProcessEnv = process.env): boolean {
  return CLAUDE_OTEL_CONFLICT_KEYS.some((key) => Boolean(environment[key]?.trim()));
}

// A script executable (the emulator bin, PATH shims) is not directly
// exec-able: POSIX needs an exec bit the repo can't guarantee, Windows has
// no shebang handling. Run it under node so the recipe is a real binary on
// every platform and through every spawn path (PTY spawn, spawn-through
// execve, test harnesses). Under Electron `process.execPath` is the electron
// binary, so resolve a real node from PATH instead (electron-as-node has
// stdin/event-loop quirks that break the bin's control channel — probed
// 2026-08-07); ELECTRON_RUN_AS_NODE is the documented fallback.
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/;

function resolveNodeBinary(): string | undefined {
  const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // next PATH entry
      }
    }
  }
  return undefined;
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Status lines are shell commands, so render one platform-specific, injection-safe invocation. */
export function statusLineForwarderCommand(
  executable: string,
  scriptPath: string,
  targetPlatform: NodeJS.Platform = process.platform,
  channel: 'root' | 'subagent' = 'root',
): string {
  const args = channel === 'subagent' ? [scriptPath, 'subagent'] : [scriptPath];
  if (targetPlatform === 'win32') {
    const encoded = Buffer.from(
      `& ${powershellLiteral(executable)} ${args.map(powershellLiteral).join(' ')}`,
      'utf16le',
    ).toString('base64');
    // Explicit PowerShell works whether Claude selected Git Bash or PowerShell
    // as its outer Windows shell; encoded input keeps path metacharacters inert.
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }
  return [posixQuote(executable), ...args.map(posixQuote)].join(' ');
}

export async function prepareClaudeSession(options: PrepareClaudeSessionOptions): Promise<PreparedClaudeSession> {
  if (options.resume && options.resumeInvocation) {
    throw new Error('Claude preparation accepts resume or resumeInvocation, not both');
  }
  if (options.settingSources !== undefined && options.settingSources.length === 0) {
    throw new Error('Claude settingSources must contain at least one source');
  }
  // On resume the session keeps its own id + transcript, so that id IS the
  // session id; otherwise reuse a caller-chosen id or mint one.
  const sessionId = options.resume ?? options.sessionId ?? randomUUID();
  // Own the temp dir only when we create it; a caller-supplied settingsDir is
  // the caller's to clean, so it stays out of filesToCleanup (§23: no
  // destroying state we didn't create).
  const ownsDir = options.settingsDir === undefined;
  const dir = options.settingsDir ?? (await mkdtemp(join(tmpdir(), 'puppeteer-claude-')));
  const settingsPath = join(dir, `${sessionId}.settings.json`);
  const hookForwarderPath = join(dir, `${sessionId}.hooks.mjs`);
  const statusLineForwarderPath =
    options.statusLineEndpoint || options.subagentStatusLineEndpoint
      ? join(dir, `${sessionId}.statusline.mjs`)
      : undefined;
  const runningUnderElectron = process.versions.electron !== undefined;
  const resolvedNode = runningUnderElectron ? resolveNodeBinary() : undefined;
  const electronAsNodeFallback = runningUnderElectron && resolvedNode === undefined;
  const nodeRunner = resolvedNode ?? process.execPath;
  const rawClaudeConfigDir = (options.configDir ?? process.env.CLAUDE_CONFIG_DIR)?.trim() || undefined;
  // Claude interprets a relative CLAUDE_CONFIG_DIR from the launched process's
  // cwd. Resolve it at that same boundary before both discovery and spawn so
  // an Electron/main-process cwd cannot select a different delegate.
  const claudeConfigDir = rawClaudeConfigDir ? resolve(options.cwd, rawClaudeConfigDir) : undefined;
  const discoveredStatusChannels = statusLineForwarderPath
    ? await resolveClaudeStatusChannels(options.cwd, {
        settingSources: options.settingSources,
        configDir: claudeConfigDir,
      })
    : {};
  const existingStatusLine = options.statusLineEndpoint
    ? options.existingStatusLine === undefined
      ? discoveredStatusChannels.statusLine
      : (options.existingStatusLine ?? undefined)
    : undefined;
  const existingSubagentStatusLine = options.subagentStatusLineEndpoint
    ? options.existingSubagentStatusLine === undefined
      ? discoveredStatusChannels.subagentStatusLine
      : (options.existingSubagentStatusLine ?? undefined)
    : undefined;
  const statusLine =
    statusLineForwarderPath && options.statusLineEndpoint
      ? {
          type: 'command' as const,
          command: statusLineForwarderCommand(nodeRunner, statusLineForwarderPath),
          padding: existingStatusLine?.padding,
          refreshInterval: existingStatusLine?.refreshInterval,
          hideVimModeIndicator: existingStatusLine?.hideVimModeIndicator,
        }
      : undefined;
  const subagentStatusLine =
    statusLineForwarderPath && options.subagentStatusLineEndpoint
      ? {
          type: 'command' as const,
          command: statusLineForwarderCommand(nodeRunner, statusLineForwarderPath, process.platform, 'subagent'),
          padding: existingSubagentStatusLine?.padding,
          refreshInterval: existingSubagentStatusLine?.refreshInterval,
          hideVimModeIndicator: existingSubagentStatusLine?.hideVimModeIndicator,
        }
      : undefined;
  const settings = generateHookSettings({
    endpoint: options.endpoint,
    tokenEnvVar: options.tokenEnvVar,
    commandForwarderPath: hookForwarderPath,
    commandExecutable: nodeRunner,
    ...(options.fileChangeMatcher !== undefined ? { matchers: { FileChanged: options.fileChangeMatcher } } : {}),
    statusLine,
    subagentStatusLine,
  });
  await writeFile(hookForwarderPath, CLAUDE_HOOK_FORWARDER_SOURCE, 'utf8');
  if (statusLineForwarderPath) {
    await writeFile(statusLineForwarderPath, CLAUDE_STATUS_CHANNEL_FORWARDER_SOURCE, 'utf8');
  }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  // --resume and --session-id are mutually exclusive: resume continues an
  // existing id, so passing --session-id would fight it. --settings composes
  // with both (the hook bridge attaches to resumed sessions too — probed §6).
  const args = options.resumeInvocation
    ? [...options.resumeInvocation]
    : options.resume
      ? ['--resume', sessionId]
      : ['--session-id', sessionId];
  if (options.title !== undefined) args.push('--name', options.title);
  if (options.model !== undefined) args.push('--model', options.model);
  if (options.effort !== undefined) args.push('--effort', options.effort);
  if (options.settingSources !== undefined) {
    args.push('--setting-sources', options.settingSources.join(','));
  }
  args.push('--settings', settingsPath, '--permission-mode', options.permissionMode ?? 'default');

  const executable = options.executable ?? 'claude';
  const isScript = SCRIPT_EXECUTABLE.test(executable);
  const command = isScript ? nodeRunner : executable;

  return {
    sessionId,
    command,
    args: isScript ? [executable, ...args] : args,
    cwd: options.cwd,
    env: {
      [options.tokenEnvVar]: options.token,
      ...(options.otelLogsEndpoint
        ? {
            CLAUDE_CODE_ENABLE_TELEMETRY: '1',
            OTEL_LOGS_EXPORTER: 'otlp',
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
            OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: options.otelLogsEndpoint,
            OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer%20${encodeURIComponent(options.token)}`,
            OTEL_LOGS_EXPORT_INTERVAL: '1000',
          }
        : {}),
      ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
      ...(electronAsNodeFallback ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(options.statusLineEndpoint
        ? {
            PUPPETEER_STATUSLINE_ENDPOINT: options.statusLineEndpoint,
            PUPPETEER_STATUSLINE_DELEGATE: existingStatusLine?.command ?? '',
          }
        : {}),
      ...(options.subagentStatusLineEndpoint
        ? {
            PUPPETEER_SUBAGENT_STATUSLINE_ENDPOINT: options.subagentStatusLineEndpoint,
            PUPPETEER_SUBAGENT_STATUSLINE_DELEGATE: existingSubagentStatusLine?.command ?? '',
          }
        : {}),
      ...(statusLineForwarderPath ? { PUPPETEER_STATUSLINE_TOKEN_ENV_VAR: options.tokenEnvVar } : {}),
    },
    settingsPath,
    hookForwarderPath,
    statusLineForwarderPath,
    filesToCleanup: ownsDir
      ? [settingsPath, hookForwarderPath, ...(statusLineForwarderPath ? [statusLineForwarderPath] : []), dir]
      : [settingsPath, hookForwarderPath, ...(statusLineForwarderPath ? [statusLineForwarderPath] : [])],
  };
}

/** Remove the session's generated files; tolerant of already-gone paths. */
export async function cleanupClaudeSession(prepared: PreparedClaudeSession): Promise<void> {
  for (const path of prepared.filesToCleanup) {
    await rm(path, { recursive: true, force: true });
  }
}
