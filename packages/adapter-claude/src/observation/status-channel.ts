/** Claude Code root/child status telemetry and transparent delegate preservation. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ContextWindowInvalidatedEvent,
  ContextWindowUpdatedEvent,
  EffortEvent,
  EnvironmentEvent,
  ModelEvent,
} from '@vibefield/puppeteer-core';

export interface ClaudeStatusLineConfig {
  type: 'command';
  command: string;
  padding?: number | undefined;
  refreshInterval?: number | undefined;
  hideVimModeIndicator?: boolean | undefined;
}

export interface ClaudeStatusChannelSettings {
  statusLine?: ClaudeStatusLineConfig | undefined;
  subagentStatusLine?: ClaudeStatusLineConfig | undefined;
}

/** Native Claude settings layers accepted by `--setting-sources`. */
export type ClaudeSettingSource = 'user' | 'project' | 'local';

export interface ResolveClaudeStatusChannelsOptions {
  /** Testable override for Claude's user-settings home. */
  home?: string | undefined;
  /** Claude's relocated user configuration root (`CLAUDE_CONFIG_DIR`). */
  configDir?: string | undefined;
  /** Omitted means Claude's normal user + project + local source set. */
  settingSources?: readonly ClaudeSettingSource[] | undefined;
}

interface ClaudeStatusLinePayload {
  session_id?: unknown;
  prompt_id?: unknown;
  version?: unknown;
  model?: { id?: unknown; display_name?: unknown };
  effort?: { level?: unknown } | null;
  workspace?: { current_dir?: unknown };
  cwd?: unknown;
  context_window?: {
    total_input_tokens?: unknown;
    context_window_size?: unknown;
    used_percentage?: unknown;
    remaining_percentage?: unknown;
    current_usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    } | null;
  };
}

interface ClaudeSubagentStatusLinePayload extends ClaudeStatusLinePayload {
  columns?: unknown;
  tasks?: unknown;
}

export interface ClaudeSubagentStatusTask {
  id: string;
  name?: string | undefined;
  type?: string | undefined;
  status?: string | undefined;
  description?: string | undefined;
  label?: string | undefined;
  startTime?: number | undefined;
  model?: string | undefined;
  /** Claude reports either an effort level or a numeric token budget. */
  effort?: string | undefined;
  contextWindowSize?: number | undefined;
  tokenCount?: number | undefined;
  tokenSamples: number[];
  cwd?: string | undefined;
}

export interface ClaudeStatusChannelMetadata {
  nativeSessionId?: string | undefined;
  promptId?: string | undefined;
  providerVersion?: string | undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function openString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value);
  return nonEmptyString(value);
}

export function claudeStatusChannelMetadata(payload: unknown): ClaudeStatusChannelMetadata {
  if (!payload || typeof payload !== 'object') return {};
  const body = payload as ClaudeStatusLinePayload;
  return {
    ...(nonEmptyString(body.session_id) ? { nativeSessionId: nonEmptyString(body.session_id) } : {}),
    ...(nonEmptyString(body.prompt_id) ? { promptId: nonEmptyString(body.prompt_id) } : {}),
    ...(nonEmptyString(body.version) ? { providerVersion: nonEmptyString(body.version) } : {}),
  };
}

export type ClaudeStatusEnvironmentEvent = EnvironmentEvent | ModelEvent | EffortEvent;

/** Claude's root status channel is the authoritative live cwd/model-card/effort surface. */
export function claudeEnvironmentEvents(payload: unknown): ClaudeStatusEnvironmentEvent[] {
  if (!payload || typeof payload !== 'object') return [];
  const body = payload as ClaudeStatusLinePayload;
  const currentCwd = nonEmptyString(body.workspace?.current_dir) ?? nonEmptyString(body.cwd);
  const id = nonEmptyString(body.model?.id);
  const displayName = nonEmptyString(body.model?.display_name);
  const effort = openString(body.effort?.level);
  // The status-line contract omits `effort` when the active model does not
  // support it. A complete snapshot with a model and no effort therefore
  // retracts an older observed value instead of leaving it stale.
  const effortSnapshot = effort ?? (id ? null : undefined);
  const events: ClaudeStatusEnvironmentEvent[] = [];
  if (currentCwd) events.push({ type: 'environment:updated', currentCwd });
  if (id) {
    events.push({
      type: 'model:updated',
      intent: 'observed',
      model: { id, ...(displayName ? { displayName } : {}), provider: 'anthropic' },
    });
  }
  if (effortSnapshot !== undefined) {
    events.push({ type: 'effort:updated', intent: 'observed', effort: effortSnapshot });
  }
  return events;
}

/** Convert Claude's provider-defined input-only usage into the shared used/size event. */
export function claudeContextWindowEvent(
  payload: unknown,
): ContextWindowUpdatedEvent | ContextWindowInvalidatedEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as ClaudeStatusLinePayload;
  const context = body.context_window;
  if (!context) return null;
  const capacityTokens = nonNegativeNumber(context.context_window_size);
  if (context.current_usage === null) {
    // Before the first API response Claude reports a known empty window:
    // total_input_tokens=0, a concrete capacity, and null usage/percentages.
    // Preserve invalidation for compaction/reset payloads that do not make
    // that explicit, but give new sessions a useful CTX:00% state.
    if (capacityTokens !== undefined && capacityTokens > 0 && nonNegativeNumber(context.total_input_tokens) === 0) {
      const modelId = nonEmptyString(body.model?.id);
      return { type: 'context-window:updated', usedTokens: 0, capacityTokens, modelId };
    }
    return { type: 'context-window:invalidated', reason: 'provider-reset' };
  }

  if (capacityTokens === undefined || capacityTokens <= 0) return null;

  const usage = context.current_usage;
  let usedTokens: number | undefined;
  if (usage) {
    const input = nonNegativeNumber(usage.input_tokens);
    const cacheCreation = nonNegativeNumber(usage.cache_creation_input_tokens);
    const cacheRead = nonNegativeNumber(usage.cache_read_input_tokens);
    if (input !== undefined && cacheCreation !== undefined && cacheRead !== undefined) {
      usedTokens = input + cacheCreation + cacheRead;
    }
  }
  // Current Claude versions expose this as the same input-only sum. It is a
  // useful compatibility fallback if an older payload omits the components.
  usedTokens ??= nonNegativeNumber(context.total_input_tokens);

  const providerUsedPercentage = finiteNumber(context.used_percentage);
  const providerRemainingPercentage = finiteNumber(context.remaining_percentage);
  const validProviderPercentage =
    providerUsedPercentage !== undefined && providerUsedPercentage >= 0 && providerUsedPercentage <= 100
      ? providerUsedPercentage
      : providerRemainingPercentage !== undefined &&
          providerRemainingPercentage >= 0 &&
          providerRemainingPercentage <= 100
        ? 100 - providerRemainingPercentage
        : undefined;
  if (usedTokens === undefined && validProviderPercentage !== undefined) {
    usedTokens = (capacityTokens * validProviderPercentage) / 100;
  }
  if (usedTokens === undefined) return null;

  const modelId = nonEmptyString(body.model?.id);
  return {
    type: 'context-window:updated',
    usedTokens,
    capacityTokens,
    ...(validProviderPercentage !== undefined
      ? { usedPercentage: validProviderPercentage, percentageSource: 'provider' as const }
      : { percentageSource: 'derived' as const }),
    modelId,
  };
}

/** Parse the documented full snapshot passed to `subagentStatusLine`. */
export function claudeSubagentStatusTasks(payload: unknown): ClaudeSubagentStatusTask[] {
  if (!payload || typeof payload !== 'object') return [];
  const tasks = (payload as ClaudeSubagentStatusLinePayload).tasks;
  if (!Array.isArray(tasks)) return [];
  const parsed: ClaudeSubagentStatusTask[] = [];
  for (const value of tasks) {
    if (!value || typeof value !== 'object') continue;
    const task = value as Record<string, unknown>;
    const id = nonEmptyString(task.id);
    if (!id) continue;
    const rawSamples = Array.isArray(task.tokenSamples) ? task.tokenSamples : [];
    parsed.push({
      id,
      ...(nonEmptyString(task.name) ? { name: nonEmptyString(task.name) } : {}),
      ...(nonEmptyString(task.type) ? { type: nonEmptyString(task.type) } : {}),
      ...(nonEmptyString(task.status) ? { status: nonEmptyString(task.status) } : {}),
      ...(nonEmptyString(task.description) ? { description: nonEmptyString(task.description) } : {}),
      ...(nonEmptyString(task.label) ? { label: nonEmptyString(task.label) } : {}),
      ...(nonNegativeNumber(task.startTime) !== undefined ? { startTime: nonNegativeNumber(task.startTime) } : {}),
      ...(nonEmptyString(task.model) ? { model: nonEmptyString(task.model) } : {}),
      ...(openString(task.effort) ? { effort: openString(task.effort) } : {}),
      ...(nonNegativeNumber(task.contextWindowSize) !== undefined
        ? { contextWindowSize: nonNegativeNumber(task.contextWindowSize) }
        : {}),
      ...(nonNegativeNumber(task.tokenCount) !== undefined ? { tokenCount: nonNegativeNumber(task.tokenCount) } : {}),
      tokenSamples: rawSamples
        .map(nonNegativeNumber)
        .filter((sample): sample is number => sample !== undefined)
        .slice(-16),
      ...(nonEmptyString(task.cwd) ? { cwd: nonEmptyString(task.cwd) } : {}),
    });
  }
  return parsed;
}

function statusLineConfig(value: unknown): ClaudeStatusLineConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'command' || typeof candidate.command !== 'string') return undefined;
  return {
    type: 'command',
    command: candidate.command,
    padding: finiteNumber(candidate.padding),
    refreshInterval: finiteNumber(candidate.refreshInterval),
    hideVimModeIndicator:
      typeof candidate.hideVimModeIndicator === 'boolean' ? candidate.hideVimModeIndicator : undefined,
  };
}

async function statusChannelsFromFile(path: string): Promise<ClaudeStatusChannelSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      statusLine?: unknown;
      subagentStatusLine?: unknown;
    };
    return {
      ...(statusLineConfig(parsed.statusLine) ? { statusLine: statusLineConfig(parsed.statusLine) } : {}),
      ...(statusLineConfig(parsed.subagentStatusLine)
        ? { subagentStatusLine: statusLineConfig(parsed.subagentStatusLine) }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The person's settings files a launch reads, low to high precedence (user < shared project <
 * local project) whatever order the caller listed the sources in. Claude's own flag and policy
 * layers rank above all three.
 */
export function claudeSettingsLayers(
  cwd: string,
  options: ResolveClaudeStatusChannelsOptions = {},
): Array<{ source: ClaudeSettingSource; path: string }> {
  const sources = new Set<ClaudeSettingSource>(options.settingSources ?? ['user', 'project', 'local']);
  const absolute = resolve(cwd);
  const userConfigRoot = options.configDir ? resolve(options.configDir) : join(options.home ?? homedir(), '.claude');
  const layers: Array<{ source: ClaudeSettingSource; path: string }> = [];
  if (sources.has('user')) layers.push({ source: 'user', path: join(userConfigRoot, 'settings.json') });
  if (sources.has('project')) layers.push({ source: 'project', path: join(absolute, '.claude', 'settings.json') });
  if (sources.has('local')) layers.push({ source: 'local', path: join(absolute, '.claude', 'settings.local.json') });
  return layers;
}

/** Resolve normal user/project/local layers without modifying provider settings. */
export async function resolveClaudeStatusChannels(
  cwd: string,
  options: ResolveClaudeStatusChannelsOptions = {},
): Promise<ClaudeStatusChannelSettings> {
  let resolved: ClaudeStatusChannelSettings = {};
  for (const { path } of claudeSettingsLayers(cwd, options)) {
    resolved = { ...resolved, ...(await statusChannelsFromFile(path)) };
  }
  return resolved;
}

/**
 * Tiny standalone Node program written beside the generated settings file.
 * It reports telemetry and runs the matching original command concurrently,
 * relaying the delegate's stdout/stderr and exit status without interpreting it.
 */
export const CLAUDE_STATUS_CHANNEL_FORWARDER_SOURCE = `
import { spawn } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

const childChannel = process.argv[2] === 'subagent';
const endpoint = process.env[childChannel
  ? 'PUPPETEER_SUBAGENT_STATUSLINE_ENDPOINT'
  : 'PUPPETEER_STATUSLINE_ENDPOINT'];
const delegateCommand = process.env[childChannel
  ? 'PUPPETEER_SUBAGENT_STATUSLINE_DELEGATE'
  : 'PUPPETEER_STATUSLINE_DELEGATE'];
const tokenEnvVar = process.env.PUPPETEER_STATUSLINE_TOKEN_ENV_VAR;
const token = tokenEnvVar ? process.env[tokenEnvVar] : undefined;
const configuredTimeout = Number(process.env.PUPPETEER_STATUSLINE_TIMEOUT_MS);
const telemetryTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 50 && configuredTimeout <= 5000
  ? configuredTimeout
  : 250;
const telemetry = endpoint && token
  ? fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: \`Bearer \${token}\`,
      },
      body: input,
      signal: AbortSignal.timeout(telemetryTimeoutMs),
    }).catch(() => undefined)
  : Promise.resolve();

let delegate = Promise.resolve(0);
if (delegateCommand) {
  delegate = new Promise((resolve) => {
    const childProcess = spawn(delegateCommand, {
      shell: true,
      cwd: globalThis.process.cwd(),
      env: globalThis.process.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    childProcess.once('error', () => resolve(1));
    childProcess.once('close', (code) => resolve(code ?? 1));
    childProcess.stdin.end(input);
  });
}

const [, code] = await Promise.all([telemetry, delegate]);
process.exitCode = code;
`.trimStart();
