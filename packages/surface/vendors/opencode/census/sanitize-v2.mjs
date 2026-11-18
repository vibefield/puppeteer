#!/usr/bin/env node
/**
 * OpenCode 2.x census privacy gate: the gitignored raw run -> committed,
 * shape-faithful evidence for one `opencode@<2.x.y>` tree.
 *
 * It promotes three things, all staged and checked before any destination is
 * replaced, so a partial or unsafe set never lands:
 *
 * - `captures/opencode@V/`: the JSONL carriers of every scenario whose raw
 *   manifest says it passed, sanitized with `opencodeV2Rules`, plus
 *   `census-run.json` (scenario -> capturedAt, terminal event, named checks),
 *   the capture fidelity contract and SANITIZATION.md. Failed scenarios are
 *   never promoted.
 * - `probes/opencode@V/`: an explicit allow-list, `version.txt`,
 *   `help/<command>.txt`, `help.json` and `artifact.json`, copied verbatim only
 *   when no unsafe pattern matches (text is never rewritten) and, for JSON,
 *   when `opencodeV2Rules` finds nothing. Any other file of the raw probes tree
 *   stays raw.
 * - `references/opencode@V/`: the runtime `/openapi.json` (byte for byte) and a
 *   SOURCE.json naming its digest, under the same text check.
 *
 * Every promoted JSON document and JSONL record also passes
 * `unpinnedEpochIssues`: a clock under a key no rule names fails the promotion.
 * Raw process logs, provider failure dumps, the per-scenario `manifest.json`
 * and the run's `run.json` stay raw.
 *
 * Each destination is replaced whole, so once it exists it must be the
 * vendor's own `<captures|probes|references>/opencode@<2.x.y>`.
 * `--check-only` runs the same checks on the committed trees.
 *
 * usage:
 *   node sanitize-v2.mjs --version 2.2.5
 *   node sanitize-v2.mjs --version 2.2.5 --check-only
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, checkCaptureFile, sanitizeCaptureDirectory } from '@vibefield/puppeteer-surface/sanitize';
import { writeCaptureFidelity } from '../../../scripts/capture-fidelity.mjs';
import { opencodeV2Rules, unpinnedEpochIssues } from '../privacy.mjs';
import { displayPath, replaceableDestination } from './harness-common.mjs';

export const VERSION_2 = /^2\.\d+\.\d+$/;

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));
const repoRoot = resolve(vendorRoot, '../../../..');

/** Every unsafe-pattern hit in a text document, as `<label>:<line>: unsafe text`. */
export function probeTextIssues(text, label, rules = opencodeV2Rules) {
  const issues = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (rules.unsafeTextPatterns.some((pattern) => pattern.test(line))) {
      issues.push(`${label}:${index + 1}: unsafe text`);
    }
  }
  return issues;
}

/** The raw probe files that are promoted; everything else in a probes tree stays raw. */
export function promotedProbeFile(file) {
  return (
    file === 'version.txt' ||
    file === 'help.json' ||
    file === 'artifact.json' ||
    /^help\/[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/.test(file)
  );
}

/**
 * The committed run summary, built from the raw per-scenario manifests: only
 * the fields the generator needs (capture clock, terminal event, transport)
 * and the named checks (label -> boolean, so a failed informational check is
 * visible in the evidence), never a session id, path or host fact. Throws when
 * a promoted scenario's manifest does not name the census version.
 */
export function censusRunDocument(version, manifests) {
  const scenarios = {};
  let platform;
  for (const [name, manifest] of Object.entries(manifests).sort(([left], [right]) => left.localeCompare(right))) {
    if (manifest?.outcome !== 'passed') continue;
    if (manifest.vendorVersion !== version) {
      throw new Error(`${name}: raw manifest is for ${String(manifest.vendorVersion)}, not ${version}`);
    }
    if (platform !== undefined && manifest.platform !== platform) {
      throw new Error(`${name}: raw manifest platform ${String(manifest.platform)} differs from ${platform}`);
    }
    platform = manifest.platform;
    const checks = Object.fromEntries(
      Object.entries(manifest.checks ?? {})
        .filter(([, value]) => typeof value === 'boolean')
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    scenarios[name] = {
      capturedAt: manifest.capturedAt,
      ...(manifest.terminalEvent ? { terminalEvent: manifest.terminalEvent } : {}),
      ...(manifest.interactive ? { interactive: true } : {}),
      ...(manifest.seedVersion ? { seedVersion: manifest.seedVersion } : {}),
      ...(Object.keys(checks).length > 0 ? { checks } : {}),
    };
  }
  if (Object.keys(scenarios).length === 0) throw new Error('no passed scenario to promote');
  return {
    format: 'opencode-census-run/1',
    vendor: 'opencode',
    vendorVersion: version,
    platform,
    harness: 'packages/surface/vendors/opencode/census/harness-v2.mjs',
    scenarios,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path).split('\\').join('/')];
  });
}

/** `unpinnedEpochIssues` over one JSON document or every record of one JSONL file; an unparsable one is an issue. */
export function documentEpochIssues(text, label, { lines = false } = {}) {
  const documents = lines
    ? text
        .split('\n')
        .map((line, index) => [`${label}:${index + 1}`, line])
        .filter(([, line]) => line.trim())
    : [[label, text]];
  const issues = [];
  for (const [location, source] of documents) {
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      issues.push(`${location}: not JSON`);
      continue;
    }
    issues.push(...unpinnedEpochIssues(value, location));
  }
  return issues;
}

/** `documentEpochIssues` over every `.json` and `.jsonl` file under `root`. */
export function epochIssuesUnder(root, label) {
  return filesUnder(root)
    .sort()
    .filter((file) => file.endsWith('.json') || file.endsWith('.jsonl'))
    .flatMap((file) =>
      documentEpochIssues(readFileSync(join(root, file), 'utf8'), `${label}/${file}`, {
        lines: file.endsWith('.jsonl'),
      }),
    );
}

/**
 * Privacy issues of the promotable files under a probes tree (the raw one or a
 * committed one), copying each to `copyTo` when given. The same checks run on
 * promotion and on `--check-only`.
 */
function probeIssues(root, copyTo) {
  if (!existsSync(root)) return ['probes: the probes tree is missing'];
  const files = filesUnder(root).filter(promotedProbeFile).sort();
  const issues = [];
  for (const file of files) {
    const source = join(root, file);
    const text = readFileSync(source, 'utf8');
    if (file.endsWith('.json')) {
      issues.push(...checkCaptureFile(source, `probes/${file}`, opencodeV2Rules));
      issues.push(...documentEpochIssues(text, `probes/${file}`));
    } else {
      issues.push(...probeTextIssues(text, `probes/${file}`));
    }
    if (copyTo) {
      mkdirSync(dirname(join(copyTo, file)), { recursive: true });
      cpSync(source, join(copyTo, file));
    }
  }
  if (!files.includes('artifact.json')) issues.push('probes/artifact.json: missing artifact identity');
  if (!files.includes('version.txt')) issues.push('probes/version.txt: missing version probe');
  return issues;
}

/** The checks a runtime OpenAPI document must pass to be committed. */
export function openapiIssues(bytes, label) {
  const text = bytes.toString('utf8');
  const issues = probeTextIssues(text, label);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return [...issues, `${label}: not JSON`];
  }
  if (document?.openapi !== '3.1.0') issues.push(`${label}: expected OpenAPI 3.1.0, got ${String(document?.openapi)}`);
  return issues;
}

function stageReferences(input, staging, version, platform) {
  const source = join(input, 'openapi.json');
  if (!existsSync(source)) return ['probes/openapi.json: the run captured no /openapi.json'];
  const bytes = readFileSync(source);
  const issues = openapiIssues(bytes, 'references/openapi.json');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'openapi.json'), bytes);
  writeFileSync(
    join(staging, 'SOURCE.json'),
    `${JSON.stringify(
      {
        vendor: 'opencode',
        vendorVersion: version,
        kind: 'runtime-openapi',
        file: 'openapi.json',
        route: 'GET /openapi.json',
        platform,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        notes:
          'Served by the pinned private `opencode serve` backend during the 2.x census and kept byte for byte. It declares HTTP operations only: the event stream payload is `V2EventEncoded`, so events come from the exact-source event contract and the census samples.',
      },
      null,
      2,
    )}\n`,
  );
  return issues;
}

/** The committed references tree: the OpenAPI checks, plus a SOURCE.json that is clean and names its digest. */
function referenceIssues(root) {
  const openapi = join(root, 'openapi.json');
  const source = join(root, 'SOURCE.json');
  if (!existsSync(openapi)) return ['references/openapi.json: missing'];
  const bytes = readFileSync(openapi);
  const issues = openapiIssues(bytes, 'references/openapi.json');
  if (!existsSync(source)) return [...issues, 'references/SOURCE.json: missing'];
  issues.push(...checkCaptureFile(source, 'references/SOURCE.json', opencodeV2Rules));
  if (readJson(source).sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    issues.push('references/SOURCE.json: sha256 does not match openapi.json');
  }
  return issues;
}

function stageCaptures(input, staging, version) {
  const manifests = {};
  for (const entry of readdirSync(input, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(input, entry.name, 'manifest.json');
    if (existsSync(manifestPath)) manifests[entry.name] = readJson(manifestPath);
  }
  const run = censusRunDocument(version, manifests);
  let lines = 0;
  for (const scenario of Object.keys(run.scenarios)) {
    const result = sanitizeCaptureDirectory(join(input, scenario), join(staging, scenario), opencodeV2Rules);
    lines += result.lines;
  }
  writeFileSync(join(staging, 'census-run.json'), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o644 });
  writeCaptureFidelity(staging, {
    vendor: 'opencode',
    vendorVersion: version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*/*.jsonl'],
    limitations: [
      'Only JSONL protocol carriers of passed scenarios are promoted; raw process logs, failure dumps and per-scenario manifests remain raw.',
      'Sensitive scalar values are replaced in place while native keys, containers, primitive types, record order, durable sequence numbers and stable joins are retained.',
      'An event `data` carried as an encoded JSON string is sanitized as its decoded document and re-encoded, so either wire form keeps its type.',
    ],
  });
  writeFileSync(
    join(staging, 'SANITIZATION.md'),
    [
      '# OpenCode capture sanitization',
      '',
      `These fixtures were captured from OpenCode ${version} with the hermetic fake-provider census`,
      '(`census/harness-v2.mjs`) and sanitized with `opencodeV2Rules` (`privacy.mjs`).',
      'Native identifiers (including durable aggregate, inbox, assistant message, form, saved-permission and',
      'credential ids) are stable pseudonyms; paths, clocks, prompts, model output, tool input and output,',
      'permission resources, provider request headers and provider settings are redacted. Event types, envelope',
      'keys, durable sequence numbers and versions, tool names, ordering and cross-record identity joins are kept.',
      'A number in the epoch-millisecond range under any key other than a pinned clock fails the promotion.',
      '',
      'Only JSONL protocol carriers of passed scenarios are promoted. Raw logs and failure dumps remain',
      'gitignored; the runtime OpenAPI document is committed separately under references/.',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  return { scenarios: Object.keys(run.scenarios).length, lines };
}

function promote(staging, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(staging, destination);
}

const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const shown = (path) => displayPath(path, repoRoot);
  const version = flag('--version') ?? process.env.PUPPETEER_OPENCODE_VERSION;
  if (!version || !VERSION_2.test(version)) throw new Error('--version <2.x.y> is required');
  const rawRoot = resolve(flag('--in') ?? join(vendorRoot, 'captures-raw', `opencode@${version}`));
  const rawProbes = resolve(flag('--probes-in') ?? `${rawRoot}.probes`);
  const captures = resolve(flag('--out') ?? join(vendorRoot, 'captures', `opencode@${version}`));
  const probes = resolve(flag('--probes-out') ?? join(vendorRoot, 'probes', `opencode@${version}`));
  const references = resolve(flag('--references-out') ?? join(vendorRoot, 'references', `opencode@${version}`));

  if (argv.includes('--check-only')) {
    const issues = [
      ...(existsSync(captures)
        ? [...checkCaptureDirectory(captures, opencodeV2Rules), ...epochIssuesUnder(captures, 'captures')]
        : [`captures: ${shown(captures)} is missing`]),
      ...probeIssues(probes),
      ...referenceIssues(references),
    ];
    for (const issue of issues.slice(0, 40)) console.error(issue);
    console.log(
      issues.length === 0 ? `clean: ${[captures, probes, references].map(shown).join(', ')}` : `${issues.length} issue(s)`,
    );
    process.exit(issues.length === 0 ? 0 : 1);
  }

  const destinations = [
    [captures, 'captures'],
    [probes, 'probes'],
    [references, 'references'],
  ].map(([path, kind]) => replaceableDestination(path, join(vendorRoot, kind)));
  const stagings = destinations.map((path) => `${path}.staging`);
  for (const staging of stagings) {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
  }
  const [capturesStaging, probesStaging, referencesStaging] = stagings;
  const result = stageCaptures(rawRoot, capturesStaging, version);
  const platform = readJson(join(capturesStaging, 'census-run.json')).platform;
  const issues = [
    ...checkCaptureDirectory(capturesStaging, opencodeV2Rules),
    ...epochIssuesUnder(capturesStaging, 'captures'),
    ...probeIssues(rawProbes, probesStaging),
    ...stageReferences(rawProbes, referencesStaging, version, platform),
  ];
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 40)) console.error(issue);
    for (const staging of stagings) rmSync(staging, { recursive: true, force: true });
    throw new Error(`${issues.length} privacy issue(s); nothing was promoted`);
  }
  promote(capturesStaging, captures);
  promote(probesStaging, probes);
  promote(referencesStaging, references);
  console.log(`sanitized ${result.scenarios} scenario(s), ${result.lines} line(s) -> ${shown(captures)}`);
  console.log(`probes -> ${shown(probes)}`);
  console.log(`references -> ${shown(references)}`);
  console.log('privacy check: clean');
}
