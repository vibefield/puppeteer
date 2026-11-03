#!/usr/bin/env node
/**
 * Kimi capture privacy gate: verbatim captures-raw -> committed captures.
 *
 * Native wire, hook, state, and index records keep their JSON shapes and
 * ordering while sensitive values are redacted in place. Harness process,
 * provider, stderr, and capture metadata are explicit semantic projections.
 * The workflow records those per-artifact distinctions in capture-fidelity.json.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REDACTED_EPOCH_MS,
  checkCaptureDirectory,
  defaultRules,
  extendRules,
  sanitizeRecord,
} from '@vibefield/puppeteer-surface/sanitize';
import { KIMI_CANDIDATE_VERSION } from './census/harness.mjs';
import { writeCaptureFidelity } from '../../scripts/capture-fidelity.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const REDACTED_ISO = new Date(REDACTED_EPOCH_MS).toISOString();

export const kimiRules = extendRules(
  {
    idKey: /^(?:hash|systemPromptHash|toolsHash|promptCacheKey)$/,
    timestampKey: /^(?:created|created_at)$/,
    pathKey: /^(?:agentsMdPaths|homedir|sessionDir|workDir)$/,
    // 2.4.1 moved the date disclosure into injection origins (`origin.disclosure`).
    sensitiveTextKey: /^(?:arguments|description|systemPrompt|think|localDate|timeZone)$/,
    sensitiveContainer: /^(?:args|environmentDisclosure|tool_output)$/,
    // Native structural identifiers, not host facts: `main`/`agent-<n>` name the
    // journal directory (`agents/<id>/wire.jsonl`, already disclosed by the
    // fixture path) and the parent/child join; `local` is the runtime binding.
    // A `wd_<slug>_a11a5ed0…` value is a workdir key whose hash was aliased below.
    structuralEnumValue: /^(?:main|agent-\d{1,4}|local|wd_[a-z0-9._-]{1,40}_a11a5ed0[0-9a-f]{4})$/,
    unsafeTextPatterns: [
      /\/private\/var\/folders\/[^\s"']+/,
      /\/private\/tmp\/puppeteer-kimi-census-[^\s"']+/,
      /\bsk-not-a-real-key\b/,
      // ISO wall-clock strings (`finishedAt`, `abortedAt`, engine `meta.createdAt`) are pinned below.
      new RegExp(`^(?!${REDACTED_ISO.replaceAll('.', '\\.')}$)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$`),
    ],
  },
  defaultRules,
);

/**
 * What the repository-wide capture gate applies to committed Kimi captures: the
 * shared defaults plus only the closed structural-identifier allowance above
 * (`main`, `agent-<n>`, `local`, and an aliased workdir key).
 */
export const kimiRepositoryGateRules = extendRules(
  { structuralEnumValue: kimiRules.structuralEnumValue },
  defaultRules,
);

function parseJsonLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${path}:${index + 1} is not valid JSON`);
      }
    });
}

const WORKDIR_KEY = /^wd_([a-z0-9._-]{1,40})_([0-9a-f]{12})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Pin ISO-8601 wall-clock strings to the shared redacted epoch, and keep Kimi's
 * `wd_<slug>_<sha256-12>` workdir-key shape. The hash covers the
 * harness temp path, so it is replaced with a marker-prefixed digest of itself;
 * the slug is the bounded basename slug Kimi derives (`workspace` here).
 */
function pinNativeShapes(value) {
  if (Array.isArray(value)) return value.map(pinNativeShapes);
  if (value === null || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    if (ISO_INSTANT.test(value)) return REDACTED_ISO;
    const match = WORKDIR_KEY.exec(value);
    if (!match || match[2].startsWith('a11a5ed0')) return value;
    return `wd_${match[1]}_a11a5ed0${createHash('sha256').update(match[2]).digest('hex').slice(0, 4)}`;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, pinNativeShapes(child)]));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeRecord(pinNativeShapes(value), kimiRules), null, 2)}\n`);
}

function writeJsonLines(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${records.map((record) => JSON.stringify(sanitizeRecord(pinNativeShapes(record), kimiRules))).join('\n')}\n`,
  );
}

function filesNamed(directory, name) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesNamed(path, name));
    else if (entry.isFile() && entry.name === name) files.push(path);
  }
  return files.sort();
}

function exactlyOne(paths, label) {
  if (paths.length !== 1) throw new Error(`expected exactly one ${label}, found ${paths.length}`);
  return paths[0];
}

export function sanitizeKimiCaptureSet(input, output, version = KIMI_CANDIDATE_VERSION) {
  const scenarios = readdirSync(input, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (scenarios.length === 0) throw new Error(`no Kimi scenarios in ${input}`);
  mkdirSync(output, { recursive: true });

  for (const scenario of scenarios) {
    const source = join(input, scenario.name);
    const destination = join(output, scenario.name);
    const wires = filesNamed(source, 'wire.jsonl');
    const mainWires = wires.filter((path) => /(?:^|[\\/])agents[\\/]main[\\/]wire\.jsonl$/.test(path));
    const agentWires = wires.filter((path) => !mainWires.includes(path));
    const wire = exactlyOne(mainWires, 'main wire journal');
    // 2.4.1 also writes `<session>/notify/state.json`; the session state sits beside `agents/`.
    const state = exactlyOne(
      filesNamed(source, 'state.json').filter((path) => existsSync(join(dirname(path), 'agents'))),
      'session state',
    );
    const index = exactlyOne(filesNamed(source, 'session_index.jsonl'), 'session index');

    writeJsonLines(join(destination, 'wire.jsonl'), parseJsonLines(wire));
    const agentIds = [];
    for (const agentWire of agentWires) {
      const match = /(?:^|[\\/])agents[\\/]([^/\\]+)[\\/]wire\.jsonl$/.exec(agentWire);
      if (!match) throw new Error(`cannot determine agent id for ${agentWire}`);
      agentIds.push(match[1]);
      writeJsonLines(join(destination, 'agents', `${match[1]}.jsonl`), parseJsonLines(agentWire));
    }
    writeJson(join(destination, 'state.json'), JSON.parse(readFileSync(state, 'utf8')));
    writeJsonLines(join(destination, 'session-index.jsonl'), parseJsonLines(index));
    const processRecord = JSON.parse(readFileSync(join(source, 'process.json'), 'utf8'));
    writeJson(join(destination, 'process.json'), {
      ...processRecord,
      args: {
        promptMode: processRecord.args?.includes('--prompt') === true,
        outputFormat: 'stream-json',
        isolatedSkillsDirectory: processRecord.args?.includes('--skills-dir') === true,
      },
    });

    const providerRequests = parseJsonLines(join(source, 'provider-requests.jsonl')).map((request) => ({
      method: request.method,
      url: request.url,
      body: request.body,
    }));
    writeJsonLines(join(destination, 'provider-requests.jsonl'), providerRequests);

    const stdout = parseJsonLines(join(source, 'stdout.log'));
    writeJsonLines(join(destination, 'stdout.jsonl'), stdout);
    const stderr = readFileSync(join(source, 'stderr.log'), 'utf8');
    writeJson(join(destination, 'stderr.json'), { present: stderr.length > 0, bytes: stderr.length });

    const hooksDirectory = join(source, 'hooks');
    if (existsSync(hooksDirectory)) {
      for (const entry of readdirSync(hooksDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        writeJsonLines(join(destination, 'hooks', entry.name), parseJsonLines(join(hooksDirectory, entry.name)));
      }
    }

    writeJson(join(destination, 'capture.json'), {
      schemaVersion: 1,
      representation: 'semantic-projection',
      vendor: 'kimi',
      version,
      scenario: scenario.name,
      mode: processRecord.mode ?? 'native-print-hermetic',
      wireProtocolVersion: '1.5',
      ...(agentIds.length > 0 ? { agentJournals: agentIds.sort() } : {}),
    });
  }
  writeCaptureFidelity(output, {
    vendor: 'kimi',
    vendorVersion: version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*/wire.jsonl', '*/agents/*.jsonl', '*/hooks/*.jsonl', '*/state.json', '*/session-index.jsonl'],
    limitations: [
      'The native wire, hook, state, and index carriers retain every key, container, primitive type, and record order while redacting sensitive scalar values.',
    ],
    overrides: [
      {
        paths: ['*/process.json', '*/provider-requests.jsonl', '*/stderr.json', '*/capture.json'],
        representation: 'semantic-projection',
        limitations: [
          'Process arguments, HTTP headers, raw stderr, and harness metadata are deliberately summarized; they are occurrence and control evidence, not native payload schemas.',
        ],
      },
    ],
  });
  return { scenarios: scenarios.length };
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const version = flag('--version', KIMI_CANDIDATE_VERSION);
  const input = resolve(flag('--input', join(vendorRoot, 'captures-raw', `kimi@${version}`)));
  const output = resolve(flag('--output', join(vendorRoot, 'captures', `kimi@${version}`)));

  if (process.argv.includes('--check')) {
    const issues = checkCaptureDirectory(output, kimiRules);
    for (const issue of issues.slice(0, 20)) console.error(issue);
    console.log(issues.length === 0 ? `clean: ${output}` : `${issues.length} issue(s) in ${output}`);
    process.exit(issues.length === 0 ? 0 : 1);
  }

  if (!existsSync(input) || !statSync(input).isDirectory()) throw new Error(`raw capture directory missing: ${input}`);
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const result = sanitizeKimiCaptureSet(input, staging, version);
  const issues = checkCaptureDirectory(staging, kimiRules);
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 20)) console.error(issue);
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${issues.length} privacy issue(s); committed captures were not replaced`);
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);
  console.log(`sanitized ${result.scenarios} Kimi scenario(s) -> ${output}`);
  console.log('privacy check: clean');
}
