/**
 * Grok-specific capture privacy rules layered on the shared conservative gate.
 *
 * The shared engine (`@vibefield/puppeteer-surface/sanitize`) stays the single
 * redactor/detector for every vendor; this module only adds what Grok's native
 * JSON needs, always as a redaction step paired with a detector:
 *
 * - Disposable roots (workspace, HOME, GROK_HOME, the leader socket directory,
 *   the executable) are rewritten to fixed synthetic paths in every string,
 *   including their percent-encoded session-bucket form, BEFORE the shared
 *   pass. Paired with a detector that rejects any surviving multi-segment
 *   absolute path outside the synthetic roots, so a partially redacted path
 *   (the 1.0.70 survey leak) fails instead of passing.
 * - Grok clocks: the durable record `timestamp` is Unix SECONDS, while
 *   `_meta.agentTimestampMs`, `streamStartMs`, `turnStartMs` and
 *   `lastChangeUnixMs` are milliseconds. Pinning seconds to the shared
 *   millisecond epoch would forge the unit (the 1.0.0 capture defect), so
 *   seconds pin to exactly 1_000_000_000 and milliseconds to the shared epoch.
 *   ISO-8601 strings keep their precision and offset but pin to 2026-01-01.
 * - The initialize `_meta.agentId` is a stable machine-derived UUIDv5. A
 *   value-keyed alias would stay linkable across every capture from one
 *   machine, so it becomes one constant.
 * - xAI prefixed identifiers (`ag1.`, `at1.`, `aa1.`) are aliased wherever
 *   they occur, including keys the shared id rule does not recognize.
 * - Raw tool arguments and results (`rawInput`, `rawOutput`, `x.ai/tool.input`)
 *   are redacted leaf by leaf, keeping only their discriminator fields.
 * - Prompt- and model-derived text in Grok-only keys (`runningText`,
 *   `session_summary`, `generated_title`, `last_turn_summary`,
 *   `arguments_delta`, `output_for_prompt`, …) is sensitive text.
 * - The viewer's `memtrace/<unix seconds>-<pid>.jsonl` file name embeds its
 *   start clock and pid, which no key rule sees; both pin in place
 *   (`memtrace/1000000000-0.jsonl`), and the detector rejects any other value.
 *
 * Values under the SHARED path keys (`grok_home`, `cwd`, `*_path`, `*_home`,
 * `path`, …) are not Grok's to keep: the repository-wide default gate accepts
 * only its own placeholders there, so they become `/workspace` (cwd) or
 * `/workspace/redacted-file`, whatever the synthetic root. The capture
 * fidelity record lists that loss.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  REDACTED_EPOCH_MS,
  alias,
  checkCaptureDirectory,
  checkRecord,
  extendRules,
  sanitizeRecord,
} from '@vibefield/puppeteer-surface/sanitize';

export const grokRules = extendRules({
  sensitiveTextKey: new RegExp(
    [
      '^(?:signature|prompt_text|summary_preview|description|runningText|session_summary|generated_title',
      '|last_turn_summary|arguments_delta|output_for_prompt|agentResult|agent_result)$',
    ].join(''),
  ),
  // Millisecond clocks the shared suffix rule does not recognize.
  timestampKey: /(?:Timestamp|Start|Unix|Change)Ms$|^ts$/,
});

/** Unix-seconds clocks pin here: inside the seconds range, and not above the shared detector's floor. */
export const REDACTED_EPOCH_SECONDS = 1_000_000_000;
/** One constant for the machine-derived UUIDv5 `agentId`, shaped like every other alias. */
export const REDACTED_MACHINE_AGENT_ID = 'a11a5ed0-0000-4000-8000-00000000a9e7';
export const REDACTED_ISO_DATE = '2026-01-01T00:00:00';

/**
 * Synthetic roots that disposable census paths are rewritten to.
 *
 * The census base (and its short leader-socket directory) is deliberately not
 * a temp root: the shared gate treats every `/tmp/…` path as private, since a
 * relocated TMPDIR names the uid and the checkout, and its redaction would
 * flatten a temp-rooted placeholder to `/workspace/redacted-path`, erasing the
 * leader-socket topology. It also stays outside GROK_HOME so it never reads as
 * the auto-discovered default `~/.grok/leader*.sock`.
 */
export const SYNTHETIC_ROOTS = Object.freeze({
  workspace: '/workspace',
  home: '/home/user',
  grokHome: '/home/user/.grok',
  socketDir: '/home/user/grok-census',
  base: '/home/user/grok-census',
  tmp: '/home/user/grok-census/tmp',
  artifact: '/usr/local/bin/grok',
});
const ALLOWED_PATH_PREFIXES = ['/workspace', '/home/user', '/usr/local/bin/grok'];

/** Census prompt, response, and tool-argument canaries. Any survivor means text leaked. */
export const GROK_CENSUS_CANARIES = Object.freeze([
  'SURFACE_',
  'Pinned Grok census',
  'surface census',
  'census workspace',
  'Thinking about the reply',
  'Planning a tool call',
]);

const RAW_TOOL_CONTAINERS = new Set(['rawInput', 'rawOutput']);
/** Discriminators kept inside raw tool containers: they select the native branch, not user content. */
const RAW_TOOL_DISCRIMINATORS = new Set(['variant', 'type', 'kind', 'status']);
const SAFE_DISCRIMINATOR = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const REDACTED_PLACEHOLDER = /^<redacted(?::[^>\r\n]+)?>$/;
const XAI_PREFIXED_ID = /\b(?:ag1|at1|aa1)\.[0-9a-f]{32}\b/g;
/** The shared engine's embedded-UUID rule, applied before id keys so `<sessionId>-<n>` event ids keep their shape. */
const EMBEDDED_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** The viewer's memory-trace file: `memtrace/<unix seconds>-<pid>.jsonl`. */
const MEMTRACE_NAME = /(^|\/)memtrace\/(\d+)-(\d+)\.jsonl/g;
export const REDACTED_MEMTRACE_NAME = `memtrace/${REDACTED_EPOCH_SECONDS}-0.jsonl`;
const CLOCK_KEY = /(?:time|Time|timestamp|Timestamp|_at$|At$|At[A-Z]|Ms$|_ms$|Unix|^ts$|^created$|^updated$)/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the ordered root rewrite list for one disposable census root.
 * Longest raw paths are replaced first so nested roots win over their parent.
 */
export function grokRootReplacements(roots = {}) {
  const pairs = [];
  const add = (raw, replacement) => {
    if (typeof raw !== 'string' || raw.length < 2 || !raw.startsWith('/')) return;
    const variants = new Set([raw]);
    if (raw.startsWith('/private/')) variants.add(raw.slice('/private'.length));
    else if (raw.startsWith('/tmp/') || raw.startsWith('/var/')) variants.add(`/private${raw}`);
    for (const variant of variants) {
      pairs.push([variant, replacement]);
      pairs.push([encodeURIComponent(variant), encodeURIComponent(replacement)]);
    }
  };
  if (roots.socket) add(roots.socket, `${SYNTHETIC_ROOTS.socketDir}/leader.sock`);
  for (const key of ['artifact', 'workspace', 'grokHome', 'tmp', 'socketDir', 'home', 'base']) {
    add(roots[key], SYNTHETIC_ROOTS[key]);
  }
  return pairs.sort((left, right) => right[0].length - left[0].length);
}

function rewriteRoots(value, replacements) {
  let result = value;
  for (const [raw, replacement] of replacements) {
    if (result.includes(raw)) result = result.replace(new RegExp(escapeRegExp(raw), 'g'), replacement);
  }
  return result;
}

function pinIsoDatetime(value) {
  const match = ISO_DATETIME.exec(value);
  if (!match) return value;
  const fraction = match[3] ? `.${'0'.repeat(match[3].length - 1)}` : '';
  return `${REDACTED_ISO_DATE}${fraction}${match[4]}`;
}

function pinClock(value, key) {
  if (!Number.isInteger(value) || !CLOCK_KEY.test(key)) return value;
  if (value > REDACTED_EPOCH_SECONDS && value < 100_000_000_000) return REDACTED_EPOCH_SECONDS;
  if (value >= 1_000_000_000_000 && value < 100_000_000_000_000) return REDACTED_EPOCH_MS;
  return value;
}

function redactRawToolLeaf(value, key) {
  if (typeof value !== 'string') return value;
  if (value.length === 0 || REDACTED_PLACEHOLDER.test(value)) return value;
  if (RAW_TOOL_DISCRIMINATORS.has(key) && SAFE_DISCRIMINATOR.test(value)) return value;
  return `<redacted:${key || 'value'}>`;
}

function prepare(value, key, context, inRawTool, underXaiTool) {
  if (typeof value === 'number') return pinClock(value, key);
  if (typeof value === 'string') {
    if (key === 'agentId') return REDACTED_MACHINE_AGENT_ID;
    let next = rewriteRoots(value, context.replacements);
    next = next.replace(XAI_PREFIXED_ID, (match) => alias(match));
    next = next.replace(EMBEDDED_UUID, (match) => alias(match));
    next = next.replace(MEMTRACE_NAME, (_match, lead) => `${lead}${REDACTED_MEMTRACE_NAME}`);
    next = pinIsoDatetime(next);
    return inRawTool ? redactRawToolLeaf(next, key) : next;
  }
  if (Array.isArray(value)) {
    // Tool output can arrive as a byte array (rawOutput.output); keep its
    // length and integer type, never its bytes.
    if (inRawTool && value.length > 0 && value.every((entry) => Number.isInteger(entry))) return value.map(() => 0);
    return value.map((entry) => prepare(entry, key, context, inRawTool, underXaiTool));
  }
  if (value !== null && typeof value === 'object') {
    const nextInRawTool = inRawTool || RAW_TOOL_CONTAINERS.has(key) || (key === 'input' && underXaiTool);
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        prepare(child, childKey, context, nextInRawTool, underXaiTool || childKey === 'x.ai/tool'),
      ]),
    );
  }
  return value;
}

/** Sanitize one parsed Grok record: the Grok pre-pass, then the shared type-preserving pass. */
export function sanitizeGrokRecord(record, { roots } = {}) {
  const context = { replacements: grokRootReplacements(roots) };
  return sanitizeRecord(prepare(record, '', context, false, false), grokRules);
}

function absolutePathTokens(value) {
  const tokens = [];
  // Two or more segments: single-segment tokens are slash commands such as /compact.
  for (const match of value.matchAll(/(?:^|[\s"'=(:,[{`])(\/[A-Za-z0-9._~+@-]+(?:\/[^\s"'`<>|)\]}]*)+)/g)) {
    tokens.push(match[1].replace(/[.,;:!?]+$/, ''));
  }
  for (const match of value.matchAll(/%2F[^%\s"'/]+(?:%2F[^%\s"'/]*)+/gi)) {
    try {
      tokens.push(decodeURIComponent(match[0]));
    } catch {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

function allowedPath(path) {
  return ALLOWED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function inspectGrok(value, issues, location, key, inRawTool, underXaiTool) {
  if (typeof value === 'number') {
    if (
      Number.isInteger(value) &&
      value > REDACTED_EPOCH_SECONDS &&
      value !== REDACTED_EPOCH_MS &&
      !/Bytes$|_bytes$/.test(key)
    ) {
      issues.push(`${location}: unpinned epoch-sized integer at ${key} (seconds or milliseconds clock)`);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const path of absolutePathTokens(value)) {
      if (!allowedPath(path)) issues.push(`${location}: absolute path outside synthetic roots at ${key}`);
    }
    if (/-(?:Users|home)-<redacted>-/.test(value)) issues.push(`${location}: partially redacted path at ${key}`);
    if (ISO_DATETIME.test(value) && !value.startsWith(REDACTED_ISO_DATE)) {
      issues.push(`${location}: unpinned ISO timestamp at ${key}`);
    }
    if (value.match(XAI_PREFIXED_ID)) issues.push(`${location}: raw xAI prefixed id at ${key}`);
    for (const [, , seconds, pid] of value.matchAll(MEMTRACE_NAME)) {
      if (seconds !== String(REDACTED_EPOCH_SECONDS) || pid !== '0') {
        issues.push(`${location}: unpinned memtrace start clock or pid at ${key}`);
      }
    }
    if (key === 'agentId' && value !== REDACTED_MACHINE_AGENT_ID) {
      issues.push(`${location}: machine agentId is not the fixed redaction`);
    }
    for (const canary of GROK_CENSUS_CANARIES) {
      if (value.includes(canary)) issues.push(`${location}: census prompt/response text survived at ${key}`);
    }
    if (inRawTool && value.length > 0 && !REDACTED_PLACEHOLDER.test(value)) {
      if (!RAW_TOOL_DISCRIMINATORS.has(key) || !SAFE_DISCRIMINATOR.test(value)) {
        issues.push(`${location}: raw tool argument/result survived at ${key}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((entry) => Number.isInteger(entry))) {
      if (inRawTool && value.some((entry) => entry !== 0)) {
        issues.push(`${location}: raw tool byte output survived at ${key}`);
      }
      if (value.length >= 4 && value.every((entry) => entry >= 9 && entry <= 126)) {
        const decoded = String.fromCharCode(...value);
        if (GROK_CENSUS_CANARIES.some((canary) => decoded.includes(canary)) || absolutePathTokens(decoded).length > 0) {
          issues.push(`${location}: text encoded as a byte array survived at ${key}`);
        }
      }
      return;
    }
    value.forEach((entry, index) => inspectGrok(entry, issues, `${location}[${index}]`, key, inRawTool, underXaiTool));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const nextInRawTool = inRawTool || RAW_TOOL_CONTAINERS.has(key) || (key === 'input' && underXaiTool);
    for (const [childKey, child] of Object.entries(value)) {
      inspectGrok(
        child,
        issues,
        `${location}.${childKey}`,
        childKey,
        nextInRawTool,
        underXaiTool || childKey === 'x.ai/tool',
      );
    }
  }
}

/** Grok-only detectors for one parsed record; the inverse of the Grok pre-pass. */
export function checkGrokOnlyRecord(record, label = '<record>') {
  const issues = [];
  inspectGrok(record, issues, label, '', false, false);
  return issues;
}

/** Shared detector (with Grok rules) plus the Grok-only detectors. */
export function checkGrokRecord(record) {
  return [...checkRecord(record, grokRules), ...checkGrokOnlyRecord(record)];
}

function captureFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...captureFiles(path));
    else if (entry.endsWith('.jsonl') || entry.endsWith('.json')) files.push(path);
  }
  return files.sort();
}

/**
 * Every issue a committed Grok capture directory can carry: the shared engine
 * with Grok rules, the shared engine with its DEFAULT rules (exactly what the
 * repository-wide capture gate runs), and the Grok-only detectors.
 */
export function checkGrokCaptureDirectory(directory) {
  const issues = [...checkCaptureDirectory(directory, grokRules)];
  issues.push(...checkCaptureDirectory(directory).map((issue) => `default rules: ${issue}`));
  for (const file of captureFiles(directory)) {
    const label = relative(directory, file);
    const text = readFileSync(file, 'utf8');
    const documents = file.endsWith('.jsonl')
      ? text
          .split('\n')
          .map((line, index) => [line, `${label}:${index + 1}`])
          .filter(([line]) => line.trim())
      : [[text, label]];
    for (const [source, location] of documents) {
      try {
        issues.push(...checkGrokOnlyRecord(JSON.parse(source), location));
      } catch {
        // Parse failures are reported by the audit.
      }
    }
  }
  return issues;
}
