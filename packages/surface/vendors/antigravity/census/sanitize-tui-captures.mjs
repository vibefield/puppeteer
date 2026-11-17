#!/usr/bin/env node
/**
 * Antigravity native-TUI capture privacy gate: a raw ANTIGRAVITY_TUI_CAPTURE_DIR (written by
 * packages/adapter-antigravity/src/tui-capture.live.test.ts) -> captures/antigravity@<version>-tui/.
 *
 * Only native journals (`*.jsonl` from `brain/<id>/.system_generated/logs/`) are committed as native artifacts,
 * each record sanitized in place with every key, container and primitive type kept. Beside them each scenario keeps
 * its manifest, a store inventory (names, sizes, digests), the provider's request summary and the first-run screen
 * pattern verdicts. Screen text, terminal output, adapter events and binary files stay in the raw capture.
 *
 * usage:
 *   node sanitize-tui-captures.mjs --summary --input <raw>
 *   node sanitize-tui-captures.mjs --input <raw> [--version 1.4.12] [--output <dir>] [--replace]
 *                                  [--accept-operator-name-hits]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { writeCaptureFidelity } from '../../../scripts/capture-fidelity.mjs';
import { antigravityRules } from '../privacy.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const TUI_CAPTURE_FORMAT = 'puppeteer-antigravity-tui-capture/1';
export const TUI_SCENARIOS = ['screens', 'basic-chat', 'resume', 'tool-success', 'tool-failure'];
export const TUI_CAPTURE_VERSION = '1.4.12';
const JOURNAL_SCENARIOS = new Set(TUI_SCENARIOS.filter((scenario) => scenario !== 'screens'));
const PLACEHOLDER_LEAKS = ['$OPERATOR_HOME'];

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeRecord(value, antigravityRules), null, 2)}\n`);
}

function filesUnder(root, current = root) {
  if (!existsSync(current)) return [];
  return readdirSync(current)
    .sort()
    .flatMap((name) => {
      const path = join(current, name);
      return statSync(path).isDirectory() ? filesUnder(root, path) : [relative(root, path).split('\\').join('/')];
    });
}

function rawScenarios(input) {
  return TUI_SCENARIOS.filter((scenario) => existsSync(join(input, scenario, 'capture.json')));
}

/** What a runner may report: verdicts and counts, never screen text, paths or journal contents. */
export function summarizeTuiCapture(input) {
  const root = resolve(input);
  if (!existsSync(root)) throw new Error('raw TUI capture directory is missing');
  return rawScenarios(root).map((scenario) => {
    const capture = json(join(root, scenario, 'capture.json'));
    const screensPath = join(root, scenario, 'screens.json');
    const screens = existsSync(screensPath) ? json(screensPath) : { stages: [] };
    return {
      scenario,
      outcome: capture.outcome,
      version: capture.version?.parsed ?? null,
      executableUnchanged: capture.executable?.unchanged === true,
      artifactSha256: capture.executable?.sha256Before ?? null,
      confinement: capture.network?.confinement ?? null,
      providerRequests: capture.provider?.requests ?? 0,
      functionCallsIssued: capture.provider?.functionCallsIssued ?? 0,
      functionResponsesSeen: capture.provider?.functionResponsesSeen ?? 0,
      conversations: capture.journals?.conversations?.length ?? 0,
      journalFiles: capture.journals?.copied?.length ?? 0,
      withheldBinary: capture.journals?.withheldBinary?.length ?? 0,
      stages: (screens.stages ?? []).map(({ stage, matches }) => ({ stage, matches })),
      screensOnly: screens.screensOnly
        ? {
            keysSent: screens.screensOnly.keysSent,
            loginScreen: screens.screensOnly.loginScreen,
            exitedBeforeCapture: screens.screensOnly.exitedBeforeCapture,
            patterns: screens.screensOnly.patterns.map(({ id, matchedFinal, matchedAny }) => ({
              id,
              matchedFinal,
              matchedAny,
            })),
          }
        : null,
      privacy: capture.privacy ?? null,
    };
  });
}

function validate(scenario, capture, version, options) {
  const problems = [];
  if (capture.format !== TUI_CAPTURE_FORMAT) problems.push(`${scenario}: not a ${TUI_CAPTURE_FORMAT} capture`);
  if (capture.outcome !== 'passed') problems.push(`${scenario}: outcome ${capture.outcome}; re-run it or set it aside`);
  if (capture.version?.parsed !== version) {
    problems.push(`${scenario}: the binary reported ${capture.version?.parsed ?? 'no version'}, expected ${version}`);
  }
  const executable = capture.executable ?? {};
  if (executable.unchanged !== true || executable.sha256Before !== executable.expectedSha256) {
    problems.push(`${scenario}: the executable digest was not the pinned one before and after`);
  }
  if (capture.network?.confinement !== 'sandbox-exec') problems.push(`${scenario}: not run under sandbox-exec`);
  if ((capture.privacy?.operatorHomeHits ?? 0) > 0) {
    problems.push(`${scenario}: the binary named the runner's home ${capture.privacy.operatorHomeHits} time(s)`);
  }
  if ((capture.privacy?.operatorNameHits ?? 0) > 0 && !options.acceptOperatorNameHits) {
    problems.push(
      `${scenario}: the raw capture names the runner's account ${capture.privacy.operatorNameHits} time(s); ` +
        'a person reviews it, then --accept-operator-name-hits',
    );
  }
  if (JOURNAL_SCENARIOS.has(scenario) && !(capture.journals?.conversations?.length > 0)) {
    problems.push(`${scenario}: no conversation journal was captured`);
  }
  return problems;
}

/** Copy one scenario's sanitized journals; a scenario with several conversations keeps them apart. */
function sanitizeJournals(source, destination) {
  const logs = join(source, 'logs');
  const conversations = existsSync(logs) ? readdirSync(logs).sort() : [];
  const written = [];
  const withheld = [];
  let records = 0;
  conversations.forEach((conversation, index) => {
    const base = conversations.length === 1 ? destination : join(destination, `conversation-${index + 1}`);
    const prefix = conversations.length === 1 ? '' : `conversation-${index + 1}/`;
    for (const file of filesUnder(join(logs, conversation))) {
      if (!file.endsWith('.jsonl')) {
        withheld.push(`${prefix}${file}`);
        continue;
      }
      const lines = readFileSync(join(logs, conversation, file), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line, lineIndex) => {
          try {
            return JSON.stringify(sanitizeRecord(JSON.parse(line), antigravityRules));
          } catch {
            throw new Error(`${prefix}${file}:${lineIndex + 1} is not valid JSON`);
          }
        });
      mkdirSync(dirname(join(base, file)), { recursive: true });
      writeFileSync(join(base, file), lines.length ? `${lines.join('\n')}\n` : '');
      written.push(`${prefix}${file}`);
      records += lines.length;
    }
  });
  return { written, withheld, records, conversations: conversations.length };
}

function screenVerdicts(path) {
  if (!existsSync(path)) return { stages: [] };
  const screens = json(path);
  return {
    stages: (screens.stages ?? []).map(({ stage, matches }) => ({ stage, matches })),
    ...(screens.screensOnly
      ? {
          screensOnly: {
            keysSent: screens.screensOnly.keysSent,
            loginScreen: screens.screensOnly.loginScreen,
            patterns: screens.screensOnly.patterns.map(({ id, matchedFinal, matchedAny }) => ({
              id,
              matchedFinal,
              matchedAny,
            })),
          },
        }
      : {}),
  };
}

export function sanitizeAntigravityTuiCaptureSet({
  input,
  version = TUI_CAPTURE_VERSION,
  output = join(vendorRoot, 'captures', `antigravity@${version}-tui`),
  replace = false,
  acceptOperatorNameHits = false,
}) {
  const root = resolve(input);
  if (!existsSync(root)) throw new Error('raw TUI capture directory is missing');
  const scenarios = rawScenarios(root);
  if (scenarios.length === 0) throw new Error('no TUI capture scenarios in the raw directory');
  const captures = new Map(scenarios.map((scenario) => [scenario, json(join(root, scenario, 'capture.json'))]));
  const problems = scenarios.flatMap((scenario) =>
    validate(scenario, captures.get(scenario), version, { acceptOperatorNameHits }),
  );
  const digests = new Set([...captures.values()].map((capture) => capture.executable?.sha256Before));
  if (digests.size > 1) problems.push('scenarios were captured from different executables');
  if (problems.length > 0) throw new Error(`raw TUI capture refused:\n${problems.join('\n')}`);
  if (existsSync(output) && !replace) throw new Error(`refusing to replace ${output} without --replace`);

  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  let records = 0;
  try {
    for (const scenario of scenarios) {
      const source = join(root, scenario);
      const destination = join(staging, scenario);
      const capture = captures.get(scenario);
      const journals = sanitizeJournals(source, destination);
      records += journals.records;
      writeJson(join(destination, 'screens.json'), screenVerdicts(join(source, 'screens.json')));
      if (existsSync(join(source, 'store-inventory.json'))) {
        writeJson(join(destination, 'store-inventory.json'), json(join(source, 'store-inventory.json')));
      }
      if (existsSync(join(source, 'provider-requests.json'))) {
        writeJson(join(destination, 'provider-requests.json'), json(join(source, 'provider-requests.json')));
      }
      writeJson(join(destination, 'capture.json'), {
        schemaVersion: 2,
        representation: 'type-preserving-redaction',
        vendor: 'antigravity',
        vendorVersion: version,
        scenario,
        mode: 'native-tui-loopback-capture',
        artifactSha256: capture.executable.sha256Before,
        platform: capture.host?.platform ?? null,
        network: 'loopback-only (macOS sandbox-exec)',
        provider: 'loopback Gemini with a dummy key; no account, no sign-in',
        settings: capture.settings ?? null,
        termsAnswered: capture.firstRun?.keysSent === true,
        collectionCheckboxUnchecked: capture.firstRun?.collectionCheckboxUnchecked === true,
        toolVariant: capture.provider?.toolVariant ?? null,
        toolCommand: capture.provider?.command ?? null,
        functionCallsIssued: capture.provider?.functionCallsIssued ?? 0,
        functionResponsesSeen: capture.provider?.functionResponsesSeen ?? 0,
        conversations: journals.conversations,
        journals: journals.written,
        withheld: journals.withheld,
        withheldBinaryLogFiles: capture.journals?.withheldBinary?.length ?? 0,
      });
    }
    if (!filesUnder(staging).some((file) => file.endsWith('.jsonl'))) {
      throw new Error('no native journal to commit; a screens-only capture is reported with --summary');
    }
    writeJson(join(staging, 'capture.json'), {
      schemaVersion: 2,
      representation: 'type-preserving-redaction',
      vendor: 'antigravity',
      vendorVersion: version,
      mode: 'native-tui-loopback-capture',
      scenarios,
      records,
    });
    writeCaptureFidelity(staging, {
      vendor: 'antigravity',
      vendorVersion: version,
      defaultRepresentation: 'type-preserving-redaction',
      nativeArtifacts: ['**/*.jsonl'],
      limitations: [
        `Native-TUI journals from the exact ${version} executable under a loopback-only sandbox and a loopback Gemini provider; every native key, container, primitive type and record order is kept while sensitive scalar values are redacted in place.`,
        'Screen text, terminal output, SQLite stores and binary files stay in the raw capture; screens are kept as first-run pattern verdicts only.',
      ],
    });
    const leaks = checkCaptureDirectory(staging, antigravityRules);
    for (const file of filesUnder(staging)) {
      const text = readFileSync(join(staging, file), 'utf8');
      for (const placeholder of PLACEHOLDER_LEAKS) {
        if (text.includes(placeholder)) leaks.push(`${file}: names the runner's home`);
      }
    }
    if (leaks.length > 0) throw new Error(`sanitized TUI captures leaked:\n${leaks.join('\n')}`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);
  return { output, scenarios, records };
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const input = flag(argv, '--input');
  if (!input) throw new Error('--input <raw ANTIGRAVITY_TUI_CAPTURE_DIR> is required');
  if (argv.includes('--summary')) {
    console.log(JSON.stringify(summarizeTuiCapture(input), null, 2));
  } else {
    const result = sanitizeAntigravityTuiCaptureSet({
      input,
      version: flag(argv, '--version') ?? TUI_CAPTURE_VERSION,
      ...(flag(argv, '--output') ? { output: resolve(flag(argv, '--output')) } : {}),
      replace: argv.includes('--replace'),
      acceptOperatorNameHits: argv.includes('--accept-operator-name-hits'),
    });
    console.log(
      `sanitized ${result.records} journal records across ${result.scenarios.join(', ')} -> ${relative(process.cwd(), result.output)}`,
    );
  }
}
