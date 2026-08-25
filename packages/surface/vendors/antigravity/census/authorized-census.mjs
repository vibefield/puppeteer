#!/usr/bin/env node
/**
 * Authorized Antigravity census. Uses the operator's already-authenticated
 * keyring; never isolates HOME. Writes raw evidence under captures-raw/.
 *
 * usage:
 *   node authorized-census.mjs --scenario readonly-print
 *   node authorized-census.mjs --scenario hook-discovery
 *   node authorized-census.mjs --scenario basic-turn
 *   node authorized-census.mjs --scenario add-dir-turn
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './harness.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));
const forwarderPath = join(dirname(scriptPath), 'hook-forwarder.mjs');
const REVIEWED_SHA256 = 'c8fd3c0016e101689f923f82da1c068b0e6dce3abcb0089e282742693ad4d344';
const cliHome = join(homedir(), '.gemini', 'antigravity-cli');
const settingsPath = join(cliHome, 'settings.json');

export const AUTHORIZED_SCENARIOS = [
  'readonly-print',
  'hook-discovery',
  'basic-turn',
  'add-dir-turn',
  'resume-turn',
  'tool-success',
];

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function filesUnder(root, current = root) {
  if (!existsSync(current)) return [];
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path).split(sep).join('/')];
    })
    .sort();
}

function hooksConfig() {
  const command = (event) => `${process.execPath} ${forwarderPath} ${event}`;
  return {
    'puppeteer-census': {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: command('PreToolUse'), timeout: 10 }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: command('PostToolUse'), timeout: 10 }] }],
      PreInvocation: [{ type: 'command', command: command('PreInvocation'), timeout: 10 }],
      PostInvocation: [{ type: 'command', command: command('PostInvocation'), timeout: 10 }],
      Stop: [{ type: 'command', command: command('Stop'), timeout: 10 }],
    },
  };
}

function installHooks(workspace, hookDir) {
  mkdirSync(join(workspace, '.agents'), { recursive: true, mode: 0o755 });
  mkdirSync(hookDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, '.agents', 'hooks.json'), `${JSON.stringify(hooksConfig(), null, 2)}\n`);
}

function runAgy(bin, args, { cwd, env, timeout = 90_000 }) {
  const result = spawnSync(bin, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function censusEnv(hookDir) {
  return {
    ...process.env,
    PUPPETEER_AGY_HOOK_DIR: hookDir,
    AGY_CLI_HIDE_ACCOUNT_INFO: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    NO_COLOR: '1',
  };
}

function snapshotCli() {
  return {
    settings: existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null,
    files: existsSync(cliHome) ? filesUnder(cliHome) : [],
  };
}

function newCliFiles(before, after) {
  const prior = new Set(before.files);
  return after.files.filter((file) => !prior.has(file));
}

function copyNewDurable(before, after, dest) {
  const copied = [];
  for (const file of newCliFiles(before, after)) {
    if (
      !file.startsWith('brain/') &&
      !file.startsWith('conversations/') &&
      file !== 'conversation_summaries.db' &&
      !file.startsWith('cache/last_conversations') &&
      !file.startsWith('cache/conversation_metadata')
    ) {
      continue;
    }
    const from = join(cliHome, file);
    const to = join(dest, 'durable', file);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    cpSync(from, to);
    copied.push(file);
  }
  return copied;
}

function restoreSettings(original) {
  if (!original) return;
  writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
}

function writeProcess(outputRoot, name, result) {
  writeJson(join(outputRoot, name), {
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

export function runAuthorizedCensus({ scenario, bin = process.env.PUPPETEER_ANTIGRAVITY_BIN, output }) {
  if (!AUTHORIZED_SCENARIOS.includes(scenario)) throw new Error(`unsupported scenario ${scenario}`);
  const artifact = resolve(bin);
  if (!existsSync(artifact)) throw new Error(`agy executable missing: ${artifact}`);
  const digest = sha256(readFileSync(artifact));
  if (digest !== REVIEWED_SHA256) throw new Error(`agy SHA-256 ${digest} is not the reviewed 1.1.12 artifact`);

  const outputRoot = resolve(output ?? join(vendorRoot, 'captures-raw', `antigravity@${VERSION}`, scenario));
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const isolation = mkdtempSync(join(tmpdir(), `puppeteer-agy-${scenario}-`));
  const project = join(isolation, 'project');
  const extra = join(isolation, 'extra');
  const hookDir = join(isolation, 'hooks');
  mkdirSync(project, { recursive: true, mode: 0o755 });
  mkdirSync(extra, { recursive: true, mode: 0o755 });
  writeFileSync(join(project, 'README.md'), 'Puppeteer Antigravity census workspace.\n');
  writeFileSync(join(project, 'note.txt'), 'SURFACE_AGY_NOTE\n');

  const before = snapshotCli();
  const env = censusEnv(hookDir);
  const probedAt = new Date().toISOString();
  const runs = [];

  try {
    if (scenario === 'readonly-print') {
      for (const command of ['/help', '/hooks', '/config', '/changelog', '/permissions']) {
        const result = runAgy(artifact, ['-p', command, '--output-format', 'json', '--print-timeout', '60s'], {
          cwd: project,
          env,
        });
        writeProcess(outputRoot, `${command.slice(1)}.json`, result);
        runs.push({ command, status: result.status });
      }
      const stream = runAgy(artifact, ['-p', '/hooks', '--output-format', 'stream-json', '--print-timeout', '30s'], {
        cwd: project,
        env,
      });
      writeProcess(outputRoot, 'hooks.stream-json.json', stream);
      runs.push({ command: '/hooks-stream-json', status: stream.status });
    }

    if (scenario === 'hook-discovery') {
      installHooks(project, hookDir);
      const cwdHooks = runAgy(artifact, ['-p', '/hooks', '--output-format', 'json', '--print-timeout', '30s'], {
        cwd: project,
        env,
      });
      writeProcess(outputRoot, 'cwd-hooks.json', cwdHooks);
      rmSync(join(project, '.agents'), { recursive: true, force: true });
      installHooks(extra, hookDir);
      const addDir = runAgy(
        artifact,
        ['--add-dir', extra, '-p', '/hooks', '--output-format', 'json', '--print-timeout', '30s'],
        { cwd: project, env },
      );
      writeProcess(outputRoot, 'add-dir-hooks.json', addDir);
      runs.push({ command: 'cwd-hooks', status: cwdHooks.status }, { command: 'add-dir-hooks', status: addDir.status });
    }

    if (
      scenario === 'basic-turn' ||
      scenario === 'add-dir-turn' ||
      scenario === 'resume-turn' ||
      scenario === 'tool-success'
    ) {
      const hookWorkspace = scenario === 'basic-turn' ? project : extra;
      installHooks(hookWorkspace, hookDir);
      const args = ['--output-format', 'stream-json', '--print-timeout', '3m'];
      if (scenario !== 'basic-turn') args.unshift('--add-dir', extra);
      if (scenario === 'resume-turn') {
        const conversation = flag('--conversation');
        if (!conversation) throw new Error('resume-turn requires --conversation <uuid>');
        args.unshift('--conversation', conversation);
        args.push('-p', 'Reply with exactly SURFACE_AGY_RESUME and do not use tools.');
      } else if (scenario === 'tool-success') {
        args.push(
          '--dangerously-skip-permissions',
          '-p',
          'Read note.txt with a file tool, then reply with exactly SURFACE_AGY_TOOL.',
        );
      } else {
        args.push('-p', 'Reply with exactly SURFACE_AGY_OK and do not use tools.');
      }
      const result = runAgy(artifact, args, { cwd: project, env, timeout: 200_000 });
      writeProcess(outputRoot, 'print.stream-json.json', result);
      runs.push({ command: 'print-turn', status: result.status });
    }

    const after = snapshotCli();
    const copied = copyNewDurable(before, after, outputRoot);
    if (existsSync(hookDir)) cpSync(hookDir, join(outputRoot, 'hooks'), { recursive: true });
    writeJson(join(outputRoot, 'capture.json'), {
      vendor: 'antigravity',
      vendorVersion: VERSION,
      scenario,
      probedAt,
      artifactSha256: digest,
      platform: 'darwin-arm64',
      isolationRoot: '$CENSUS_TMP',
      settingsMutated: JSON.stringify(before.settings) !== JSON.stringify(after.settings),
      newCliFiles: newCliFiles(before, after),
      copiedDurable: copied,
      hookFiles: existsSync(join(outputRoot, 'hooks')) ? filesUnder(join(outputRoot, 'hooks')) : [],
      runs,
    });
    restoreSettings(before.settings);
    return { outputRoot, scenario, runs };
  } catch (error) {
    restoreSettings(before.settings);
    throw error;
  } finally {
    rmSync(isolation, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = runAuthorizedCensus({
    scenario: flag('--scenario', 'readonly-print'),
    bin: flag('--bin', process.env.PUPPETEER_ANTIGRAVITY_BIN),
    output: flag('--output'),
  });
  console.log(`wrote ${result.scenario} raw capture to ${result.outputRoot}`);
}
