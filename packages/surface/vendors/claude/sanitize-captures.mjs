#!/usr/bin/env node
/**
 * Claude capture sanitiser — a thin CLI over the shared engine in
 * `@vibefield/puppeteer-surface/sanitize`.
 *
 * The engine moved out of this file on 2026-08-07 (docs/archive/IMPOSTER.md §9.6).
 * The rules are vendor-specific, but the MECHANISM is not, and keeping one copy
 * means a hole closed for one vendor is closed for every vendor. The move was
 * prompted by finding that this file's own predecessor passed a real codex
 * capture as clean while leaving the prompt text, hostname, userAgent and 19
 * verbatim UUIDs intact — and, once the rules were widened, that it had also
 * been missing a raw `delta` in claude's own committed fixtures.
 *
 * Claude's own rules (privacy.mjs) extend the shared defaults: scratchpad and
 * directory paths, MCP server names, compaction summaries and other
 * user-authored text, plus the closed StopFailure/SessionEnd enums that must
 * survive as protocol constants. Redaction and detection use the same rules.
 *
 * Beside the hook carriers, the census writes value-free projections (arrival
 * order, transcript record shapes, status-line key paths, the sandbox proof,
 * and the turn-failure lane's verdicts). They are copied only after the
 * detector passes them, and declared as semantic projections in
 * capture-fidelity.json.
 *
 * Usage: node surface/sanitize-captures.mjs [--check] <input-dir> [output-dir]
 *        node surface/sanitize-captures.mjs --merge <input-dir> <output-dir>
 * Name the directories explicitly: the no-argument form resolves the support
 * ledger's active version, which is not necessarily the one being captured.
 * `--merge` adds the lanes of a later census run (for example one lane re-run
 * on another host) to an existing sanitized set: it refuses a mode the set
 * already holds, and merges the per-mode projections (arrival order, sandbox
 * proof) in census lane order instead of replacing them.
 * Requires node >= 22.18 (type stripping).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCaptureDirectory as checkWithRules,
  checkCaptureFile,
  sanitizeCaptureDirectory as sanitizeWithRules,
} from '@vibefield/puppeteer-surface/sanitize';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { writeCaptureFidelity } from '../../scripts/capture-fidelity.mjs';
import { CLAUDE_CAPTURE_MODES } from './census/harness.mjs';
import { claudeCaptureRules } from './privacy.mjs';

/** Value-free census projections that may accompany the hook carriers. */
export const CLAUDE_CAPTURE_PROJECTIONS = [
  'ordering.json',
  'transcript-shape.json',
  'statusline-shape.json',
  'sandbox.json',
  'turn-failure.json',
];

/** Projections whose entries are per capture mode, so two disjoint runs merge by concatenation. */
const MERGEABLE_PROJECTIONS = new Set(['ordering.json', 'sandbox.json', 'turn-failure.json']);
const LANE_ORDER = Object.values(CLAUDE_CAPTURE_MODES).flat();

export function sanitizeCaptureDirectory(input, output = input) {
  return sanitizeWithRules(input, output, claudeCaptureRules);
}

export function checkCaptureDirectory(directory) {
  return checkWithRules(directory, claudeCaptureRules);
}

function captureModes(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Copy reviewed projections, refusing any the detector does not pass. */
export function copyCaptureProjections(input, output) {
  const copied = [];
  for (const name of CLAUDE_CAPTURE_PROJECTIONS) {
    const source = join(input, name);
    if (!existsSync(source)) continue;
    const issues = checkCaptureFile(source, name, claudeCaptureRules);
    if (issues.length > 0) throw new Error(`refusing to copy ${name}:\n${issues.join('\n')}`);
    mkdirSync(output, { recursive: true });
    copyFileSync(source, join(output, name));
    copied.push(name);
  }
  return copied;
}

function laneIndex(mode) {
  const index = LANE_ORDER.indexOf(mode);
  return index < 0 ? LANE_ORDER.length : index;
}

/** One per-mode projection holding both runs' entries, in census lane order (stable within a mode). */
export function mergeProjection(name, existing, added) {
  if (existing.projection !== added.projection) throw new Error(`${name}: the two runs describe different projections`);
  const entries = [...existing.entries, ...added.entries];
  const key = (entry) => laneIndex(entry.mode ?? entry.modes?.[0]);
  return {
    ...existing,
    entries: entries
      .map((entry, position) => ({ entry, position }))
      .sort((left, right) => key(left.entry) - key(right.entry) || left.position - right.position)
      .map(({ entry }) => entry),
  };
}

/**
 * Add a later run's lanes to an existing sanitized set. Every refusal happens
 * before anything is written, so a refused merge leaves the set unchanged.
 */
export function mergeCaptureDirectory(input, output) {
  const added = captureModes(input);
  const present = new Set(captureModes(output));
  const overlap = added.filter((mode) => present.has(mode));
  if (overlap.length > 0) throw new Error(`refusing to merge: ${output} already holds ${overlap.join(', ')}`);
  const projections = [];
  for (const name of CLAUDE_CAPTURE_PROJECTIONS) {
    if (!existsSync(join(input, name))) continue;
    const exists = existsSync(join(output, name));
    if (exists && !MERGEABLE_PROJECTIONS.has(name)) {
      throw new Error(`refusing to merge: both runs hold ${name}, which is not a per-mode projection`);
    }
    const issues = checkCaptureFile(join(input, name), name, claudeCaptureRules);
    if (issues.length > 0) throw new Error(`refusing to merge ${name}:\n${issues.join('\n')}`);
    projections.push({ name, exists });
  }
  const result = sanitizeCaptureDirectory(input, output);
  for (const { name, exists } of projections) {
    const addedProjection = JSON.parse(readFileSync(join(input, name), 'utf8'));
    const merged = exists
      ? mergeProjection(name, JSON.parse(readFileSync(join(output, name), 'utf8')), addedProjection)
      : addedProjection;
    writeFileSync(join(output, name), `${JSON.stringify(merged, null, 2)}\n`);
  }
  return { ...result, modes: added, projections: projections.map(({ name }) => name) };
}

export function claudeCaptureFidelity(output, version, projections) {
  const modes = captureModes(output);
  const limitations = [
    'Hook stdin JSON carriers are type-preserving: sensitive scalar values are replaced in place while JSON keys, containers, primitive types, and record ordering within each event file are retained.',
    'Raw transcripts, status-line payloads, and process diagnostics stay in the gitignored captures-raw tree; only value-free projections of them are committed.',
  ];
  if (modes.includes('headless')) {
    limitations.push(
      'headless is a print turn with no credential at all; its model endpoint was a loopback tripwire that received no request, so the authentication failure is native and no model was involved.',
    );
  }
  if (modes.some((mode) => mode.startsWith('api-error-'))) {
    limitations.push(
      'api-error-<status> modes are print turns against a loopback Messages API that returned that HTTP status to a placeholder token; the native error mapping is real, the failures are synthetic.',
    );
  }
  if (modes.includes('turn-failure')) {
    limitations.push(
      'turn-failure is one session of three print turns against a scripted loopback Messages API with a placeholder token: a turn that completes with scripted words, a turn whose model streams scripted words and a Read call and whose follow-up request is answered HTTP 529, and a turn whose first request is answered HTTP 529; hook payloads, ordering and the native error mapping are real, while the words and failures are synthetic.',
    );
  }
  if (modes.includes('interactive') || modes.includes('resume')) {
    limitations.push(
      'interactive and resume modes ran the native TUI in a harness-owned PTY against a scripted loopback model: hook payload shapes, transports, and ordering are native, while assistant text, tool choices, and compaction summaries are synthetic.',
    );
  }
  return {
    vendor: 'claude',
    vendorVersion: version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*/*.jsonl', ...projections],
    limitations,
    ...(projections.length > 0
      ? {
          overrides: [
            {
              paths: projections,
              representation: 'semantic-projection',
              limitations: [
                'Projections keep only event names, enum discriminators, record types, key names, and counts; they prove occurrence, ordering, and record shape, never a value.',
                'Arrival order is the order the census sink received each rail: a command-forwarded hook (SessionStart, Setup) can arrive after an HTTP hook Claude emitted later.',
                ...(projections.includes('sandbox.json')
                  ? [
                      'sandbox.json is the network-deny sandbox observed from inside its namespace before any artifact ran, for the modes each entry names; modes no entry names ran without that sandbox.',
                    ]
                  : []),
                ...(projections.includes('turn-failure.json')
                  ? [
                      "turn-failure.json compares each closing hook's last_assistant_message with the lane's own scripted sentinels and with Claude's displayed and printed text for that turn, by equality and containment only; it keeps the verdicts, the loopback request kinds and the print result's enums, never a value.",
                    ]
                  : []),
              ],
            },
          ],
        }
      : {}),
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const check = process.argv.includes('--check');
  const merge = process.argv.includes('--merge');
  let directories = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  if (directories.length === 0) {
    const selected = resolveAgentModel({ vendor: 'claude' });
    directories = check
      ? [selected.capturesRoot]
      : [
          join(selected.surfaceRoot, 'vendors', 'claude', 'captures-raw', `claude@${selected.version}`),
          selected.capturesRoot,
        ];
  }
  if ((check && directories.length !== 1) || (!check && ![1, 2].includes(directories.length))) {
    console.error('usage: node surface/sanitize-captures.mjs [--check] [input-directory] [output-directory]');
    process.exit(2);
  }
  if (merge) {
    if (check || directories.length !== 2) {
      console.error('usage: node surface/sanitize-captures.mjs --merge <input-directory> <output-directory>');
      process.exit(2);
    }
    const [input, output] = directories;
    const version = /claude@([^/]+)\/?$/.exec(output)?.[1];
    if (!version) throw new Error(`cannot infer Claude version from capture path: ${output}`);
    const result = mergeCaptureDirectory(input, output);
    const projections = CLAUDE_CAPTURE_PROJECTIONS.filter((name) => existsSync(join(output, name)));
    writeCaptureFidelity(output, claudeCaptureFidelity(output, version, projections));
    console.log(
      `merged ${result.modes.join(', ')}: ${result.lines} capture lines in ${result.files} files; projections: ${result.projections.join(', ') || 'none'}`,
    );
  } else if (check) {
    const issues = checkCaptureDirectory(directories[0]);
    for (const issue of issues) console.error(issue);
    if (issues.length > 0) process.exit(1);
    console.log('capture privacy check clean');
  } else {
    const result = sanitizeCaptureDirectory(directories[0], directories[1]);
    const output = directories[1] ?? directories[0];
    const version = /claude@([^/]+)\/?$/.exec(output)?.[1];
    if (!version) throw new Error(`cannot infer Claude version from capture path: ${output}`);
    const projections = directories[1] ? copyCaptureProjections(directories[0], directories[1]) : [];
    writeCaptureFidelity(output, claudeCaptureFidelity(output, version, projections));
    console.log(
      `sanitized ${result.lines} capture lines in ${result.files} files; projections: ${projections.join(', ') || 'none'}`,
    );
  }
}
