#!/usr/bin/env node
/**
 * Invocation-grammar probes for an exact Claude Code artifact, each in its own
 * disposable environment (census/isolation.mjs) with no credential.
 *
 * - Parse probes are session-free: `claude <flags under test> mcp --help`.
 *   "mcp help" means the flags parsed and left `mcp` the first operand; "root
 *   help" means a flag took `mcp` as its value or an unknown option sent the rest
 *   to commander's unknown list; an `error:` line is commander's own refusal.
 * - Runtime probes run argv shapes whose dispatch changed, but only ones that
 *   cannot act outside the disposable root: background verbs with an id that
 *   matches no job, purge in an empty project, the VS Code helper without its
 *   stdin request, and the gh shim entry. `--desktop`, `--bg`, Remote Control,
 *   and cloud paths are never executed; they stay parse-only.
 *
 * Output is classified text only (first meaningful line, disposable root
 * elided); the reviewed probe record cites it.
 *
 * Usage: node census/invocation-probes.mjs --artifact <claude> --previous <invocation-grammar.json> --output <file>
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedRoot, isolatedEnvironment, removeIsolatedRoot } from './isolation.mjs';

/** Parse probes added for 2.1.308 on top of the previous record's list. */
export const ADDED_PARSE_PROBES = [
  ['--desktop', 'mcp', '--help'],
  ['--client-data-url', 'x', 'mcp', '--help'],
  ['--fast-mode', 'on', 'mcp', '--help'],
  ['--fast-mode', 'bogus', 'mcp', '--help'],
  ['--allow-other-models', 'mcp', '--help'],
  ['--include-unsupported-models', 'mcp', '--help'],
  ['--host-auth-is-org-sign-in', 'mcp', '--help'],
  ['--proactivity', 'ask', 'mcp', '--help'],
  ['--proactivity', 'bogus', 'mcp', '--help'],
  ['--runner-declares', 'x', 'mcp', '--help'],
  ['project', '--help'],
  ['purge', '--help'],
  ['project', 'purge', '--help'],
  ['drop-worktree-registrations', '--help'],
  ['--permission-mode', 'manual', 'mcp', '--help'],
  ['--effort', 'max', 'mcp', '--help'],
  ['--effort', 'bogus', 'mcp', '--help'],
  ['--resume', 'some-name', 'mcp', '--help'],
];

/** Runtime probes whose dispatch the grammar must mirror; all are inert in an empty disposable root. */
export const RUNTIME_PROBES = [
  { id: 'R01', argv: ['--verbose', 'attach', '1a2b3c4d'], question: 'a background verb behind a safe root option' },
  { id: 'R02', argv: ['--', 'attach', '1a2b3c4d'], question: 'a background verb after `--`' },
  { id: 'R03', argv: ['attach', '1a2b3c4d'], question: 'a background verb as argv[0]' },
  { id: 'R04', argv: ['purge', '--dry-run'], question: 'purge with an option' },
  { id: 'R05', argv: ['--', 'purge'], question: 'purge after `--`' },
  { id: 'R06', argv: ['--verbose', '--', 'purge', '--dry-run'], question: 'tokens after `--` purge' },
  { id: 'R07', argv: ['drop-worktree-registrations'], question: 'the hidden VS Code worktree helper without --json' },
  { id: 'R08', argv: ['--gh-standin'], question: 'the gh shim entry used directly' },
];

function classify(stdout, stderr, root) {
  const text = `${stdout}\n${stderr}`.replaceAll(root, '<root>');
  if (/^Usage: claude mcp/m.test(stdout)) return 'mcp help';
  if (/^Usage: claude project purge/m.test(stdout)) return 'project purge help';
  if (/^Usage: claude project/m.test(stdout)) return 'project help';
  if (/^Usage: claude purge/m.test(stdout)) return 'purge help';
  if (/^Usage: claude drop-worktree-registrations/m.test(stdout)) return 'drop-worktree-registrations help';
  if (/^Usage: claude \[options\] \[command\] \[prompt\]/m.test(stdout)) return 'root help';
  if (/^Usage: claude \[options\] \[prompt\]/m.test(stdout)) return 'root help without commands';
  if (/^\d+\.\d+\.\d+ \(Claude Code\)/m.test(stdout)) return 'version';
  if (/Not logged in/.test(text)) return 'session (no credential: Not logged in)';
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ? line.slice(0, 200) : '(no output)';
}

function run(artifact, argv, timeout) {
  const layout = createIsolatedRoot();
  try {
    const result = spawnSync(resolve(artifact), argv, {
      cwd: layout.workspace,
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: isolatedEnvironment(layout, { COLUMNS: '80' }),
    });
    const timedOut = result.error?.code === 'ETIMEDOUT';
    return {
      exit: timedOut ? null : result.status,
      reads: timedOut
        ? `no exit within ${timeout / 1000} s (non-TTY)${result.stdout ? `; first output: ${classify(result.stdout, result.stderr, layout.root)}` : ''}`
        : classify(result.stdout ?? '', result.stderr ?? '', layout.root),
    };
  } finally {
    removeIsolatedRoot(layout);
  }
}

export function runInvocationProbes({ artifact, previous }) {
  const parse = [...previous.parseProbes.results.map((result) => result.argv), ...ADDED_PARSE_PROBES];
  const seen = new Set();
  const parseResults = [];
  for (const argv of parse) {
    const key = JSON.stringify(argv);
    if (seen.has(key)) continue;
    seen.add(key);
    parseResults.push({ argv, ...run(artifact, argv, 20_000) });
  }
  const runtimeResults = RUNTIME_PROBES.map((probe) => ({ ...probe, ...run(artifact, probe.argv, 15_000) }));
  return { parse: parseResults, runtime: runtimeResults };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const artifact = flag('--artifact');
  const previousPath = flag('--previous');
  const output = flag('--output');
  if (!artifact || !previousPath || !output) {
    throw new Error(
      'usage: invocation-probes.mjs --artifact <claude> --previous <invocation-grammar.json> --output <file>',
    );
  }
  const result = runInvocationProbes({
    artifact: resolve(artifact),
    previous: JSON.parse(readFileSync(previousPath, 'utf8')),
  });
  writeFileSync(resolve(output), `${JSON.stringify(result, null, 1)}\n`);
  console.log(`parse probes: ${result.parse.length}; runtime probes: ${result.runtime.length}`);
}
