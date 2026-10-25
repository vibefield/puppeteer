#!/usr/bin/env node
/**
 * Controlled Claude Code hook census.
 *
 * The harness runs the exact caller-supplied binary in a disposable
 * environment (census/isolation.mjs: throwaway HOME, CLAUDE_CONFIG_DIR, TMPDIR,
 * a minimal PATH with a keychain stub, and nothing inherited from the caller),
 * records hook stdin before normalization, and never writes raw payloads
 * outside the gitignored captures-raw tree. Its lanes are:
 *
 * - `init`: --init-only, which produces Setup plus startup lifecycle hooks;
 * - `headless`: a minimal print-mode turn with no credentials at all, which
 *   reaches prompt and session teardown without any API request;
 * - `api-error`: print-mode turns against a loopback Messages API that answers
 *   one HTTP error per case (placeholder token, CLAUDE_CODE_MAX_RETRIES=0), so
 *   Claude's API-error path (StopFailure) runs without an account;
 * - `interactive`: the native TUI in a harness-owned PTY against a scripted
 *   loopback model (census/interactive-lane.mjs), followed by a resume.
 *
 * No lane borrows the owner's settings, plugins, hooks, transcripts, keychain,
 * or tokens, and no lane makes a credentialed or billed model call.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_TOKEN_VAR, hookSettings, projectOrder, startHookSink, writeForwarder } from './hook-sink.mjs';
import { createIsolatedRoot, isolatedEnvironment, removeIsolatedRoot } from './isolation.mjs';
import { LOOPBACK_AUTH_TOKEN, LOOPBACK_MODEL, startLoopbackModel } from './loopback-model.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The 33 hook events of Claude Code 2.1.308: the binary's own event array and
// the official hook reference retrieved 2026-10-24 agree on this set (the
// model generator re-checks the array in the pinned artifact). Unknown names are
// harmless in Claude settings, but keeping the census list explicit makes an
// upstream addition a reviewed Surface change rather than a silent wildcard.
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'Setup',
  'InstructionsLoaded',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'MessageDisplay',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'SessionEnd',
  'Elicitation',
  'ElicitationResult',
];

/** Lanes in run order. */
export const CLAUDE_CENSUS_LANES = ['init', 'headless', 'api-error', 'interactive'];

/**
 * HTTP errors the loopback model returns, one print turn each. Mode names keep
 * the HTTP status beside the native `error` value the hook reports.
 */
export const CLAUDE_API_ERROR_CASES = [
  { status: 400, type: 'invalid_request_error', message: 'bad request' },
  { status: 401, type: 'authentication_error', message: 'invalid x-api-key' },
  { status: 429, type: 'rate_limit_error', message: 'rate limited' },
  { status: 500, type: 'api_error', message: 'internal' },
  { status: 529, type: 'overloaded_error', message: 'overloaded' },
];

/** Capture modes each lane writes; the model generator binds each lane to its own claim. */
export const CLAUDE_CAPTURE_MODES = {
  init: ['init'],
  headless: ['headless'],
  'api-error': CLAUDE_API_ERROR_CASES.map(({ status }) => `api-error-${status}`),
  interactive: ['interactive', 'resume'],
};

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** Run one short, session-free probe (`--version`, `--help`) in its own disposable environment. */
export function probeClaude(artifact, args) {
  const layout = createIsolatedRoot();
  try {
    // The probe runs with the disposable workspace as cwd, so a relative path must be resolved first.
    const result = spawnSync(resolve(artifact), args, {
      cwd: layout.workspace,
      encoding: 'utf8',
      timeout: 15_000,
      env: isolatedEnvironment(layout),
    });
    if (result.status !== 0) {
      throw new Error(`${artifact} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
    }
    return result.stdout.trimEnd();
  } finally {
    removeIsolatedRoot(layout);
  }
}

export function claudeVersionOf(artifact) {
  const output = probeClaude(artifact, ['--version']).trim();
  const match = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(output);
  if (!match) throw new Error(`Claude version output is not understood: ${output}`);
  return { version: match[1], output };
}

function settingsFor(sink, layout) {
  return {
    hooks: hookSettings({ events: CLAUDE_HOOK_EVENTS, sinkUrl: sink.url, forwarder: writeForwarder(layout.root) }),
  };
}

function writeLog(logPath, result) {
  writeFileSync(
    logPath,
    [
      `status=${String(result.status)}`,
      `signal=${String(result.signal)}`,
      '--- stdout ---',
      result.stdout ?? '',
      '--- stderr ---',
      result.stderr ?? result.error?.message ?? '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

/** Print turns run asynchronously so the in-process hook sink and loopback model keep serving. */
function runClaudeAsync({ artifact, args, layout, logPath, extraEnvironment }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(artifact, args, {
      cwd: layout.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: isolatedEnvironment(layout, extraEnvironment),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('exit', (status, signal) => {
      clearTimeout(timer);
      writeLog(logPath, { status, signal, stdout, stderr });
      if (signal === 'SIGKILL') rejectRun(new Error(`Claude census invocation timed out; see ${logPath}`));
      else resolveRun({ status, stdout });
    });
  });
}

function capturedEvents(outputRoot) {
  const counts = new Map();
  if (!existsSync(outputRoot)) return counts;
  for (const mode of readdirSync(outputRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const directory = join(outputRoot, mode.name);
    for (const file of readdirSync(directory).filter((entry) => entry.endsWith('.jsonl'))) {
      const event = file.replace(/\.jsonl$/, '');
      const lines = readFileSync(join(directory, file), 'utf8').split('\n').filter(Boolean).length;
      counts.set(event, (counts.get(event) ?? 0) + lines);
    }
  }
  return counts;
}

function commonArgs(settingsPath, mode) {
  return [
    '--settings',
    settingsPath,
    '--setting-sources',
    'project',
    '--session-id',
    randomUUID(),
    '--name',
    `puppeteer-surface-${mode}`,
  ];
}

function prepareWorkspace(layout) {
  writeFileSync(join(layout.workspace, 'CLAUDE.md'), 'Surface census fixture. Do not modify files.\n', 'utf8');
}

async function runOfflineLanes({ artifact, sink, outputRoot, lanes }) {
  const layout = createIsolatedRoot();
  prepareWorkspace(layout);
  try {
    for (const mode of ['init', 'headless'].filter((lane) => lanes.includes(lane))) {
      sink.mode = mode;
      const settingsPath = join(layout.root, `${mode}.settings.json`);
      writeFileSync(settingsPath, `${JSON.stringify(settingsFor(sink, layout), null, 2)}\n`, { mode: 0o600 });
      const common = commonArgs(settingsPath, mode);
      const args =
        mode === 'init'
          ? ['--init-only', ...common]
          : [
              '-p',
              '--output-format',
              'json',
              '--no-session-persistence',
              '--tools',
              '',
              '--model',
              'haiku',
              '--max-budget-usd',
              '0.01',
              ...common,
              'Reply with exactly SURFACE_CENSUS_OK and do not use tools.',
            ];
      await runClaudeAsync({
        artifact,
        args,
        layout,
        logPath: join(outputRoot, `${mode}.log`),
        extraEnvironment: { [HOOK_TOKEN_VAR]: sink.token },
      });
    }
  } finally {
    removeIsolatedRoot(layout);
  }
}

async function runApiErrorLane({ artifact, sink, outputRoot }) {
  const summary = [];
  for (const errorReply of CLAUDE_API_ERROR_CASES) {
    const mode = `api-error-${errorReply.status}`;
    sink.mode = mode;
    const layout = createIsolatedRoot();
    prepareWorkspace(layout);
    const model = await startLoopbackModel({ errorReply });
    try {
      const settingsPath = join(layout.root, `${mode}.settings.json`);
      writeFileSync(settingsPath, `${JSON.stringify(settingsFor(sink, layout), null, 2)}\n`, { mode: 0o600 });
      const { status, stdout } = await runClaudeAsync({
        artifact,
        layout,
        logPath: join(outputRoot, `${mode}.log`),
        extraEnvironment: {
          ANTHROPIC_BASE_URL: model.baseUrl,
          ANTHROPIC_AUTH_TOKEN: LOOPBACK_AUTH_TOKEN,
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_MAX_RETRIES: '0',
          [HOOK_TOKEN_VAR]: sink.token,
        },
        args: [
          '-p',
          '--output-format',
          'json',
          '--tools',
          '',
          '--model',
          LOOPBACK_MODEL,
          ...commonArgs(settingsPath, mode),
          'Reply with exactly SURFACE_CENSUS_OK and do not use tools.',
        ],
      });
      let result;
      try {
        const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
        result = {
          terminal_reason: parsed.terminal_reason,
          api_error_status: parsed.api_error_status,
          is_error: parsed.is_error,
        };
      } catch {
        result = { unparsed: true };
      }
      summary.push({ mode, httpStatus: errorReply.status, exit: status, requests: model.requests.length, ...result });
    } finally {
      await model.close();
      removeIsolatedRoot(layout);
    }
  }
  writeFileSync(join(outputRoot, 'api-error.summary.log'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

export async function runClaudeCensus({ artifact, expectedVersion, outputRoot, auxRoot, lanes = CLAUDE_CENSUS_LANES }) {
  for (const lane of lanes) {
    if (!CLAUDE_CENSUS_LANES.includes(lane)) throw new Error(`unknown Claude census lane ${lane}`);
  }
  const identity = claudeVersionOf(artifact);
  if (identity.version !== expectedVersion) {
    throw new Error(`expected Claude ${expectedVersion}, got ${identity.output}`);
  }
  if (existsSync(outputRoot) && capturedEvents(outputRoot).size > 0) {
    throw new Error(`refusing to append to existing raw census: ${outputRoot}`);
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

  const sink = await startHookSink({ outputRoot, auxRoot });
  let apiErrors = [];
  try {
    await runOfflineLanes({ artifact, sink, outputRoot, lanes });
    if (lanes.includes('api-error')) apiErrors = await runApiErrorLane({ artifact, sink, outputRoot });
  } finally {
    await sink.close();
  }
  let interactive;
  if (lanes.includes('interactive')) {
    const { runInteractiveLanes } = await import('./interactive-lane.mjs');
    interactive = await runInteractiveLanes({ artifact, outputRoot, auxRoot, events: CLAUDE_HOOK_EVENTS });
  }
  writeFileSync(
    join(outputRoot, 'ordering.json'),
    `${JSON.stringify(
      {
        projection:
          'native hook and status-line arrival order per capture mode; event names and enum discriminators only',
        entries: projectOrder([...sink.order, ...(interactive?.order ?? [])]),
      },
      null,
      2,
    )}\n`,
  );

  const counts = capturedEvents(outputRoot);
  if (!counts.has('SessionStart') || !counts.has('SessionEnd')) {
    throw new Error(`census did not capture the required session lifecycle; see ${outputRoot}`);
  }
  return { identity, counts, apiErrors, interactive };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  // Always name the exact artifact: a bare `claude` is whatever release PATH happens to hold.
  const artifactFlag = flag('--artifact', process.env.PUPPETEER_CLAUDE_BIN);
  if (!artifactFlag || (!isAbsolute(artifactFlag) && !artifactFlag.includes('/'))) {
    throw new Error('--artifact <path to the exact pinned Claude Code executable> is required');
  }
  const artifact = resolve(artifactFlag);
  const expectedVersion = flag('--version');
  if (!expectedVersion) throw new Error('--version is required');
  const outputRoot = resolve(flag('--output', join(vendorRoot, 'captures-raw', `claude@${expectedVersion}`)));
  const auxRoot = resolve(flag('--aux', `${outputRoot}-aux`));
  const lanes = (flag('--lanes') ?? CLAUDE_CENSUS_LANES.join(',')).split(',').filter(Boolean);
  const result = await runClaudeCensus({ artifact, expectedVersion, outputRoot, auxRoot, lanes });
  console.log(`captured ${result.identity.output} at ${outputRoot}`);
  for (const [event, count] of [...result.counts].sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${event}: ${count}`);
  }
  for (const entry of result.apiErrors) console.log(`  ${JSON.stringify(entry)}`);
  if (result.interactive) {
    const { order, ...interactive } = result.interactive;
    console.log(`  interactive: ${JSON.stringify(interactive)}`);
  }
}
