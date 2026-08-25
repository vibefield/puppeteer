#!/usr/bin/env node
/**
 * Controlled Claude Code hook census.
 *
 * The harness runs the exact caller-supplied binary with an isolated
 * CLAUDE_CONFIG_DIR, records hook stdin before normalization, and never writes
 * raw payloads outside the gitignored captures-raw tree. It intentionally
 * exercises two authentication-independent paths:
 *
 * - --init-only, which produces Setup plus startup lifecycle hooks;
 * - a minimal print-mode turn, which reaches prompt/failure/session teardown
 *   even when the disposable config has no credentials.
 *
 * A credentialed live lane can add tool/permission captures with the same
 * collector, but this baseline does not borrow the user's normal settings,
 * plugins, hooks, transcripts, or tokens.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));

// Current official hook reference, captured 2026-08-09. Unknown names are
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
  'SessionEnd',
  'Elicitation',
  'ElicitationResult',
];

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function safeEventName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
    throw new Error('hook payload has no safe hook_event_name');
  }
  return value;
}

async function collect(outputRoot, mode) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  const event = safeEventName(payload?.hook_event_name);
  const directory = resolve(outputRoot, mode);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(join(directory, `${event}.jsonl`), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

function versionOf(artifact) {
  const result = spawnSync(artifact, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(`Claude version probe failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const match = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(result.stdout);
  if (!match) throw new Error(`Claude version output is not understood: ${result.stdout.trim()}`);
  return { version: match[1], output: result.stdout.trim() };
}

function settingsFor(outputRoot, mode) {
  const command = [
    shellQuote(process.execPath),
    shellQuote(scriptPath),
    '--collect',
    shellQuote(outputRoot),
    '--mode',
    shellQuote(mode),
  ].join(' ');
  return {
    hooks: Object.fromEntries(
      CLAUDE_HOOK_EVENTS.map((event) => [
        event,
        [
          {
            hooks: [{ type: 'command', command, timeout: 10 }],
          },
        ],
      ]),
    ),
  };
}

function runClaude({ artifact, args, cwd, configDir, logPath }) {
  const result = spawnSync(artifact, args, {
    cwd,
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },
  });
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
  if (result.error && result.error.name === 'Error' && result.error.message.includes('ETIMEDOUT')) {
    throw new Error(`Claude census invocation timed out; see ${logPath}`);
  }
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

export function runClaudeCensus({ artifact, expectedVersion, outputRoot }) {
  const identity = versionOf(artifact);
  if (identity.version !== expectedVersion) {
    throw new Error(`expected Claude ${expectedVersion}, got ${identity.output}`);
  }
  if (existsSync(outputRoot) && capturedEvents(outputRoot).size > 0) {
    throw new Error(`refusing to append to existing raw census: ${outputRoot}`);
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

  const temporary = mkdtempSync(join(tmpdir(), 'puppeteer-claude-census-'));
  const workspace = join(temporary, 'workspace');
  const configDir = join(temporary, 'config');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, 'CLAUDE.md'), 'Surface census fixture. Do not modify files.\n', 'utf8');

  try {
    for (const mode of ['init', 'headless']) {
      const settingsPath = join(temporary, `${mode}.settings.json`);
      writeFileSync(settingsPath, `${JSON.stringify(settingsFor(outputRoot, mode), null, 2)}\n`, { mode: 0o600 });
      const common = [
        '--settings',
        settingsPath,
        '--setting-sources',
        'project',
        '--session-id',
        randomUUID(),
        '--name',
        `puppeteer-surface-${mode}`,
      ];
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
      runClaude({
        artifact,
        args,
        cwd: workspace,
        configDir,
        logPath: join(outputRoot, `${mode}.log`),
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const counts = capturedEvents(outputRoot);
  if (!counts.has('SessionStart') || !counts.has('SessionEnd')) {
    throw new Error(`census did not capture the required session lifecycle; see ${outputRoot}`);
  }
  return { identity, counts };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly && process.argv.includes('--collect')) {
  await collect(flag('--collect'), flag('--mode', 'headless'));
} else if (invokedDirectly) {
  const artifactFlag = flag('--artifact', process.env.PUPPETEER_CLAUDE_BIN ?? 'claude');
  const artifact = isAbsolute(artifactFlag) || artifactFlag.includes('/') ? resolve(artifactFlag) : artifactFlag;
  const expectedVersion = flag('--version');
  if (!expectedVersion) throw new Error('--version is required');
  const outputRoot = resolve(
    flag('--output', join(vendorRoot, 'captures-raw', `claude@${expectedVersion}`)),
  );
  const result = runClaudeCensus({ artifact, expectedVersion, outputRoot });
  console.log(`captured ${result.identity.output} at ${outputRoot}`);
  for (const [event, count] of [...result.counts].sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${event}: ${count}`);
  }
}
