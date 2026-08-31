#!/usr/bin/env node
/**
 * Antigravity capture privacy gate: captures-raw -> committed captures.
 *
 * SchemaVersion 2 preserves every native JSON key, container, and value type.
 * Sensitive values are redacted in place; they are never replaced with shape
 * summaries such as `hasOutput`, `parameterKeys`, or `workspacePathCount`.
 * The retained 1.1.12 schemaVersion 1 fixtures predate this rule and are
 * explicitly marked as legacy projections by their capture metadata.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeRecord } from '@vibecook/puppeteer-surface/sanitize';
import { AUTHORIZED_SCENARIOS } from './census/authorized-census.mjs';
import { VERSION } from './census/harness.mjs';
import { antigravityRules } from './privacy.mjs';
import { writeCaptureFidelity } from '../../scripts/capture-fidelity.mjs';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));

function parseMaybeJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { unparsed: true, bytes: Buffer.byteLength(trimmed) };
  }
}

function parseJsonLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`jsonl line ${index + 1} is not valid JSON`);
      }
    });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeRecord(value, antigravityRules), null, 2)}\n`);
}

function writeJsonLines(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${records.map((record) => JSON.stringify(sanitizeRecord(record, antigravityRules))).join('\n')}${records.length ? '\n' : ''}`,
  );
}

/**
 * Keep process metadata separate from the native stdout document. Stream JSON
 * is retained as an array of otherwise unchanged records; ordinary JSON mode
 * is retained as `body`. This changes framing only, and records that fact in
 * capture.json, while preserving the complete native JSON shape.
 */
function preservePrintRecord(record) {
  const stdout = String(record.stdout ?? '');
  const trimmed = stdout.trim();
  let native;
  if (trimmed) {
    try {
      native = { body: JSON.parse(trimmed) };
    } catch {
      const lines = parseJsonLines(stdout);
      native =
        lines.length > 0 && lines.every((entry) => entry && typeof entry === 'object' && entry.event)
          ? { events: lines }
          : { body: parseMaybeJson(stdout) };
    }
  } else {
    native = { body: null };
  }
  return {
    status: record.status,
    signal: record.signal ?? null,
    error: record.error ?? null,
    stdoutBytes: record.stdoutBytes ?? Buffer.byteLength(stdout),
    stderrBytes: record.stderrBytes ?? Buffer.byteLength(String(record.stderr ?? '')),
    ...native,
  };
}

function firstTranscript(root) {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'transcript.jsonl' && !path.includes(`${sep}chunks${sep}`)) files.push(path);
    }
  };
  walk(join(root, 'durable'));
  return files.sort()[0];
}

const sep = '/';

export function sanitizeAntigravityCaptureSet(
  input = join(vendorRoot, 'captures-raw', `antigravity@${VERSION}`),
  output = join(vendorRoot, 'captures', `antigravity@${VERSION}`),
) {
  if (!existsSync(input)) throw new Error(`raw captures missing: ${input}`);
  const scenarios = readdirSync(input, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && AUTHORIZED_SCENARIOS.includes(entry.name),
  );
  if (scenarios.length === 0) throw new Error(`no Antigravity scenarios in ${input}`);
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  for (const scenario of scenarios) {
    const source = join(input, scenario.name);
    const destination = join(staging, scenario.name);
    mkdirSync(destination, { recursive: true });
    const capture = existsSync(join(source, 'capture.json'))
      ? JSON.parse(readFileSync(join(source, 'capture.json'), 'utf8'))
      : { scenario: scenario.name };
    writeJson(join(destination, 'capture.json'), {
      schemaVersion: 2,
      representation: 'type-preserving-redaction',
      framing: 'process stdout JSON/JSONL parsed into body/events; native JSON records otherwise unchanged',
      vendor: 'antigravity',
      vendorVersion: VERSION,
      scenario: scenario.name,
      mode: 'authorized-print-oracle',
      artifactSha256: capture.artifactSha256,
      settingsMutated: capture.settingsMutated === true,
      hookEvents: capture.hookFiles?.filter((name) => name.endsWith('.stdin.json')).map((name) => name.split('.')[0]),
      durableKinds: (capture.copiedDurable ?? []).map((file) => {
        if (file.includes('transcript_full')) return 'transcript_full';
        if (file.endsWith('transcript.jsonl')) return 'transcript';
        if (file.endsWith('.db')) return 'sqlite';
        if (file.includes('last_conversations')) return 'last_conversations';
        if (file.includes('messages/')) return 'message';
        return 'other';
      }),
    });

    for (const name of readdirSync(source)) {
      if (!name.endsWith('.json') || name === 'capture.json') continue;
      const record = JSON.parse(readFileSync(join(source, name), 'utf8'));
      writeJson(join(destination, name), preservePrintRecord(record));
    }

    const hooksPath = join(source, 'hooks', 'hooks.jsonl');
    if (existsSync(hooksPath)) {
      writeJsonLines(join(destination, 'hooks.jsonl'), parseJsonLines(readFileSync(hooksPath, 'utf8')));
    }
    const transcript = firstTranscript(source);
    if (transcript) {
      writeJsonLines(join(destination, 'transcript.jsonl'), parseJsonLines(readFileSync(transcript, 'utf8')));
    }
  }

  writeCaptureFidelity(staging, {
    vendor: 'antigravity',
    vendorVersion: VERSION,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*/capture.json', '*/hooks.jsonl', '*/transcript.jsonl', '*/print.*.json'],
    limitations: [
      'Process stdout JSON or JSONL framing is made explicit, but every parsed native JSON record otherwise retains all keys, containers, and primitive types.',
      'Non-JSON durable files and databases remain outside the committed capture set.',
    ],
  });

  const leaks = checkCaptureDirectory(staging, antigravityRules);
  if (leaks.length > 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`sanitized Antigravity captures leaked:\n${leaks.join('\n')}`);
  }
  rmSync(output, { recursive: true, force: true });
  renameSync(staging, output);
  writeFileSync(
    join(output, 'SANITIZATION.md'),
    `# Antigravity capture sanitization

These fixtures were captured from the exact Antigravity CLI 1.1.12
darwin-arm64 executable through authorized print-mode survey oracles and
launch-scoped \`.agents/hooks.json\` observers.

SQLite databases and non-JSON durable files stay in gitignored
\`captures-raw/\`. Every native JSON key, container, and JSON value type is
preserved; prompts, model text, tool output, account fields, and paths are
redacted in place. Process stdout framing is represented explicitly by
\`capture.json#framing\`.
`,
  );
  return output;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  if (process.argv.includes('--check')) {
    const selected = resolveAgentModel({ vendor: 'antigravity' });
    const captures = selected.capturesRoot;
    const leaks = existsSync(captures)
      ? checkCaptureDirectory(captures, antigravityRules)
      : ['captures directory missing'];
    if (leaks.length > 0) {
      console.error(leaks.join('\n'));
      process.exit(1);
    }
    console.log(`antigravity@${selected.version} sanitized captures: clean`);
  } else {
    const output = sanitizeAntigravityCaptureSet();
    console.log(`wrote sanitized Antigravity captures to ${output}`);
  }
}
