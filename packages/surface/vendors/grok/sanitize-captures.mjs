#!/usr/bin/env node
/**
 * Grok capture privacy gate: raw census output -> tracked, type-preserving capture set.
 *
 * Input is one `census/harness.mjs` output directory (`captures-raw/grok@<v>/`).
 * Only native carriers the model consumes are promoted, each sanitized in place
 * with every key, container, primitive type, record order, and cross-record
 * join preserved:
 *
 *   <scenario>/acp-<connection>.jsonl  directional ACP frames {direction, message}
 *   <scenario>/updates.jsonl           the root session's durable updates.jsonl
 *   <scenario>/updates-child-<n>.jsonl subagent child sessions' updates.jsonl
 *   <scenario>/state.jsonl             final signals/summary/usage.json as {method, params}
 *
 * Census observations, process topology, and the store layout are written as
 * declared semantic projections. Everything else stays raw: provider bodies,
 * stderr, terminal bytes, prompt/chat history, system prompts, tool
 * definitions, events.jsonl, rewind points, and persisted permission rules
 * (`permission__*.toml`, which the harness never copies at all).
 *
 * usage:
 *   node sanitize-captures.mjs [--version 1.0.70] [--input <raw>] [--output <captures>]
 *   node sanitize-captures.mjs [--version 1.0.70] --check [--output <captures>]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCaptureFidelity } from '../../scripts/capture-fidelity.mjs';
import { checkGrokCaptureDirectory, sanitizeGrokRecord } from './privacy.mjs';

const DEFAULT_VERSION = '1.0.70';
const vendorRoot = dirname(fileURLToPath(import.meta.url));

/** Native session files promoted from the store; every other store file stays raw. */
const STATE_FILES = ['signals.json', 'summary.json', 'usage.json'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseJsonLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${path}:${index + 1} is not valid JSON`);
      }
    });
}

function writeJsonLines(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sessionDirectories(storeSessions) {
  if (!existsSync(storeSessions)) return [];
  const sessions = [];
  for (const bucket of readdirSync(storeSessions).sort()) {
    const bucketPath = join(storeSessions, bucket);
    if (!statSync(bucketPath).isDirectory()) continue;
    for (const id of readdirSync(bucketPath).sort()) {
      const path = join(bucketPath, id);
      if (statSync(path).isDirectory() && existsSync(join(path, 'updates.jsonl'))) sessions.push({ id, path });
    }
  }
  return sessions;
}

function createdSessionIds(frames) {
  const ids = [];
  for (const frame of frames) {
    const sessionId = frame.message?.result?.sessionId;
    if (typeof sessionId === 'string' && !ids.includes(sessionId)) ids.push(sessionId);
  }
  return ids;
}

/** Sanitize one scenario directory; returns the promoted record count. */
function sanitizeScenario(input, output, scenario) {
  const roots = readJson(join(input, 'roots.json'));
  const sanitize = (record) => sanitizeGrokRecord(record, { roots });
  let records = 0;

  const wireFiles = readdirSync(input)
    .filter((name) => /^acp-[a-z0-9-]+\.jsonl$/.test(name))
    .sort();
  if (wireFiles.length === 0) throw new Error(`${scenario}: no ACP wire captures`);
  const controllerFrames = [];
  for (const name of wireFiles) {
    const frames = parseJsonLines(join(input, name));
    if (name === 'acp-controller.jsonl') controllerFrames.push(...frames);
    const carriers = frames.map((frame) => {
      if (frame.direction !== 'agent-to-client' && frame.direction !== 'client-to-agent') {
        throw new Error(`${scenario}/${name}: frame without a direction`);
      }
      return { direction: frame.direction, message: sanitize(frame.message) };
    });
    writeJsonLines(join(output, scenario, name), carriers);
    records += carriers.length;
  }

  const rootIds = createdSessionIds(controllerFrames);
  const sessions = sessionDirectories(join(input, 'store', 'sessions'));
  const primary = sessions.filter((session) => rootIds.includes(session.id));
  const children = sessions.filter((session) => !rootIds.includes(session.id));
  if (primary.length !== 1) throw new Error(`${scenario}: expected one root durable session, found ${primary.length}`);
  const state = [];
  const promote = (session, name) => {
    const updates = parseJsonLines(join(session.path, 'updates.jsonl')).map(sanitize);
    writeJsonLines(join(output, scenario, name), updates);
    records += updates.length;
    for (const file of STATE_FILES) {
      const path = join(session.path, file);
      if (existsSync(path)) state.push(sanitize({ method: file, params: readJson(path) }));
    }
  };
  promote(primary[0], 'updates.jsonl');
  children.forEach((session, index) => promote(session, `updates-child-${index + 1}.jsonl`));
  writeJsonLines(join(output, scenario, 'state.jsonl'), state);
  records += state.length;

  // Semantic projections: occurrence, timing, and topology evidence, never native schemas.
  const observations = readJson(join(input, 'observations.json'));
  const tools = existsSync(join(input, 'provider-tools.json')) ? readJson(join(input, 'provider-tools.json')) : [];
  writeJson(
    join(output, scenario, 'observations.json'),
    sanitize({
      ...observations,
      offeredTools: tools.map((entry) => ({ kind: entry.kind, chosen: entry.chosen, offered: entry.toolNames })),
    }),
  );
  const processes = parseJsonLines(join(input, 'processes.jsonl'));
  writeJson(
    join(output, scenario, 'topology.json'),
    sanitize({
      processes: processes
        .filter((entry) => Array.isArray(entry.args))
        // `argv` is shared free text; these are harness-chosen flags whose paths were rewritten.
        .map((entry) => ({ role: entry.role, arguments: entry.args })),
      exits: processes
        .filter((entry) => entry.exit !== undefined)
        .map((entry) => ({ role: entry.label, exit: entry.exit, signal: entry.signal })),
    }),
  );
  const listing = readJson(join(input, 'store-listing.json'));
  writeJson(
    join(output, scenario, 'store-layout.json'),
    sanitize({
      grokHomeFiles: listing.filter((path) => !/^docs\//.test(path) && !/(?:^|\/)permission__[^/]*\.toml$/.test(path)),
      bundledDocs: listing.filter((path) => /^docs\//.test(path)).length,
      permissionRuleFiles: observations.permissionRuleFiles ?? 0,
    }),
  );
  return records;
}

/** Fail if the operator's own host identity reaches the tracked output in any form. */
function assertNoHostIdentity(output) {
  const secrets = [hostname(), hostname().replace(/\.local$/, ''), userInfo().username].filter(
    (value) => typeof value === 'string' && value.length >= 4,
  );
  const leaks = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else {
        const text = readFileSync(path, 'utf8');
        for (const secret of secrets) if (text.includes(secret)) leaks.push(`${path}: host identity survived`);
      }
    }
  };
  visit(output);
  return leaks;
}

export function sanitizeGrokCaptureSet(input, output, { version = DEFAULT_VERSION } = {}) {
  const harness = readJson(join(input, 'harness.json'));
  if (harness.version !== version) throw new Error(`raw capture is grok ${harness.version}, expected ${version}`);
  const failed = Object.entries(harness.scenarios ?? {}).flatMap(([name, expectations]) =>
    expectations.filter((entry) => !entry.ok).map((entry) => `${name}:${entry.id}`),
  );
  if (failed.length > 0) throw new Error(`raw census has failed expectations: ${failed.join(', ')}`);
  mkdirSync(output, { recursive: true });
  const scenarios = Object.keys(harness.scenarios ?? {}).sort();
  if (scenarios.length === 0) throw new Error('raw census has no scenarios');
  let records = 0;
  for (const scenario of scenarios) records += sanitizeScenario(join(input, scenario), output, scenario);
  writeJson(join(output, 'capture.json'), {
    schemaVersion: 2,
    representation: 'type-preserving-redaction',
    vendor: 'grok',
    vendorVersion: version,
    mode: 'controlled-leader-acp-viewer-census',
    harness: 'packages/surface/vendors/grok/census/harness.mjs',
    platform: harness.platform,
    artifactSha256: harness.artifactSha256,
    versionOutput: harness.versionOutput,
    capturedOn: String(harness.capturedAt).slice(0, 10),
    scenarios,
  });
  writeCaptureFidelity(output, {
    vendor: 'grok',
    vendorVersion: version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*/acp-*.jsonl', '*/updates.jsonl', '*/updates-child-*.jsonl', '*/state.jsonl', 'capture.json'],
    limitations: [
      'Directional ACP frames, durable updates.jsonl records, and signals/summary/usage.json state retain every native key, container, primitive type, record order, and request/result correlation; sensitive scalars are replaced in place.',
      'Durable Unix-seconds clocks pin to 1000000000, millisecond clocks to 1767225600000, and ISO-8601 strings to 2026-01-01T00:00:00 with their native precision and offset retained.',
      'Values under id-shaped keys are value-keyed aliases, so joins survive but native literals do not: permission optionId values, model ids, config option ids, auth method ids, and xAI ag1./at1./aa1. identifiers are aliased. The census observations retain the literal permission option inventory.',
      'The machine-derived initialize _meta.agentId is one fixed constant. Raw tool arguments and results (rawInput, rawOutput, x.ai/tool.input) keep only their variant/type/kind/status discriminators.',
      'Disposable workspace, HOME, GROK_HOME, leader socket, and executable paths are rewritten to /workspace, /home/user, /home/user/.grok, /tmp/grok-census, and /usr/local/bin/grok, including percent-encoded session buckets.',
    ],
    overrides: [
      {
        paths: ['*/observations.json', '*/topology.json', '*/store-layout.json'],
        representation: 'semantic-projection',
        limitations: [
          'Harness-computed timings, counts, permission option inventories, process argv, and store file listings. They are occurrence, ordering, timing, and topology evidence only and cannot define a native payload schema.',
        ],
      },
    ],
  });
  return { scenarios: scenarios.length, records };
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const version = flag('--version', DEFAULT_VERSION);
  const input = resolve(flag('--input', join(vendorRoot, 'captures-raw', `grok@${version}`)));
  const output = resolve(flag('--output', join(vendorRoot, 'captures', `grok@${version}`)));
  if (process.argv.includes('--check')) {
    const issues = existsSync(output) ? checkGrokCaptureDirectory(output) : ['captures directory missing'];
    for (const issue of issues.slice(0, 40)) console.error(issue);
    console.log(issues.length === 0 ? `clean: ${output}` : `${issues.length} issue(s) in ${output}`);
    process.exit(issues.length === 0 ? 0 : 1);
  }
  if (!existsSync(input) || !statSync(input).isDirectory()) throw new Error(`raw capture directory missing: ${input}`);
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const result = sanitizeGrokCaptureSet(input, staging, { version });
  const issues = [...checkGrokCaptureDirectory(staging), ...assertNoHostIdentity(staging)];
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 40)) console.error(issue);
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${issues.length} privacy issue(s); committed captures were not replaced`);
  }
  const note = existsSync(join(output, 'SANITIZATION.md')) ? readFileSync(join(output, 'SANITIZATION.md'), 'utf8') : '';
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);
  if (note) writeFileSync(join(output, 'SANITIZATION.md'), note);
  console.log(`sanitized ${result.records} Grok records across ${result.scenarios} scenarios -> ${output}`);
}
