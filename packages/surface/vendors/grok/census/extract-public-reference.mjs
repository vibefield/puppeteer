#!/usr/bin/env node
/**
 * Retain the public-source leads and binary-probe inventory relevant to one Grok release.
 *
 * Grok Build publishes source only as a periodic mirror (xai-org/grok-build,
 * HEAD/main, no tags). The installed binary's reported revision has never been
 * a mirror commit or a SOURCE_REV value, so everything this script extracts
 * from source is SUPPLEMENTAL: it names the nearest public lead and the exact
 * ACP schema dependency of that lead, never the binary's own source.
 *
 * The binary-probe section scans the exact artifact for its serde variant-name
 * run (a `strings`-style heuristic). Rust's string pooling means a name can be
 * absent from that run although the binary emits it, so its inventory is a
 * low-confidence lead for names the public enum lacks, never proof of absence.
 *
 * Every pin lives in RELEASES; the reference of an older release (1.0.0) was
 * produced by an earlier revision of this script and is retained unchanged.
 *
 * usage:
 *   node extract-public-reference.mjs [--version 1.0.70] \
 *     --grok-source /path/to/xai-org/grok-build \
 *     --acp-source /path/to/agentclientprotocol/agent-client-protocol \
 *     --artifact /path/to/exact/grok
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectJsonSchema } from '@vibefield/puppeteer-surface';

const RELEASES = {
  '1.0.70': {
    generatedAt: '2026-10-25',
    binaryReportedRevision: 'f50904eaee6c',
    artifactSha256: '5c8a688251bf61e35370b828b6a353b0a20fcc3f64000de8a91d426039f29cec',
    artifactPlatform: 'darwin-arm64',
    publicRevision: '2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8',
    publicSourceRevision: '559751fdcec02d413e4c57c8832ab275e4f44980',
    publicCrateVersion: '1.0.45',
    relationToBinary: 'nearest-public-mirror-older-than-binary',
    acpCrateVersion: '0.10.4',
    acpSchemaVersion: '0.11.4',
    acpTag: 'v0.11.4',
    acpRevision: 'e931357254ff44573294d5cee214a269e0cd6c54',
    xaiInventoryFloor: 61,
    // Names in the binary's serde run that the public enum lacks (variants, then fields).
    binaryOnlyVariants: ['login_refused', 'backend_responsive', 'session_ended'],
    binaryOnlyFields: ['remedy', 'responsive', 'links_left_out'],
    // xAI extension method literals (ACP prefixes `_` on the wire) whose presence the probe records.
    methodLiterals: [
      'x.ai/announcements/update',
      'x.ai/auth/info',
      'x.ai/mcp/init_progress',
      'x.ai/mcp/servers_updated',
      'x.ai/mcp_initialized',
      'x.ai/models/update',
      'x.ai/queue/changed',
      'x.ai/session/prompt_complete',
      'x.ai/session/setup',
      'x.ai/session/update',
      'x.ai/session_notification',
      'x.ai/sessions/changed',
      'x.ai/settings/update',
    ],
  },
};

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function snakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function braceBody(source, start) {
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error('unterminated Rust item');
}

function enumBody(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`missing ${declaration}`);
  return braceBody(source, start);
}

/** Split `A, B<C, D>` on top-level commas only. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if ('<([{'.includes(character)) depth += 1;
    if ('>)]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += character;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Parse struct-like fields with their serde attributes (rename, default, skip_serializing_if). */
function parseFields(body) {
  const fields = [];
  const cleaned = body.replace(/\/\/[^\n]*/g, '');
  let depth = 0;
  let item = '';
  const flush = () => {
    const text = item.trim();
    item = '';
    if (!text) return;
    const attributes = (text.match(/#\[[\s\S]*?\]\s*/g) ?? []).join(' ');
    const declaration = text.replace(/#\[[\s\S]*?\]\s*/g, '').trim();
    const field = /^(?:pub(?:\([^)]*\))?\s+)?([a-z_][a-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(declaration);
    if (!field) return;
    const rename = /rename\s*=\s*"([^"]+)"/.exec(attributes)?.[1];
    const rustType = field[2].replace(/\s+/g, ' ').trim();
    const optional =
      /^Option</.test(rustType) || /\bdefault\b/.test(attributes) || /skip_serializing_if/.test(attributes);
    fields.push({ name: field[1], wireName: rename ?? field[1], rustType, ...(optional ? { optional: true } : {}) });
  };
  for (const character of cleaned) {
    if ('<([{'.includes(character)) depth += 1;
    if ('>)]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) flush();
    else item += character;
  }
  flush();
  return fields;
}

/** Fields of a same-file `pub struct Name { … }`, when a newtype payload is declared locally. */
function localStructFields(source, typeName) {
  const name = typeName.replace(/^Box<(.+)>$/, '$1').replace(/^.*::/, '');
  const match = new RegExp(`pub struct ${name}\\s*\\{`).exec(source);
  return match ? parseFields(braceBody(source, match.index)) : undefined;
}

function closingIndex(text, start, opener, closer) {
  let depth = 0;
  for (let end = start; end < text.length; end += 1) {
    if (text[end] === opener) depth += 1;
    if (text[end] === closer) {
      depth -= 1;
      if (depth === 0) return end;
    }
  }
  throw new Error(`unterminated ${opener}`);
}

/**
 * Parse an internally tagged serde enum: unit, struct (multi-line or inline),
 * and newtype/tuple variants (including `Box<…>` payloads), honoring variant
 * `rename` attributes.
 */
export function parseRustEnum(source, declaration) {
  const body = enumBody(source, declaration).replace(/\/\/[^\n]*/g, '');
  const variants = [];
  let index = 0;
  let pendingAttributes = '';
  while (index < body.length) {
    const rest = body.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    if (rest.startsWith('#[')) {
      const end = closingIndex(body, index + 1, '[', ']');
      pendingAttributes += body.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const head = /^([A-Z][A-Za-z0-9_]*)\s*/.exec(rest);
    if (!head) {
      index += 1;
      continue;
    }
    const rustName = head[1];
    index += head[0].length;
    const rename = /rename\s*=\s*"([^"]+)"/.exec(pendingAttributes)?.[1];
    pendingAttributes = '';
    const variant = { rustName, wireName: rename ?? snakeCase(rustName) };
    const opener = body[index];
    if (opener === '{' || opener === '(') {
      const end = closingIndex(body, index, opener, opener === '{' ? '}' : ')');
      const inner = body.slice(index + 1, end);
      if (opener === '{') {
        const fields = parseFields(inner);
        if (fields.length) variant.fields = fields;
      } else {
        const payload = splitTopLevel(inner);
        variant.newtype = payload.join(', ');
        const fields = payload.length === 1 ? localStructFields(source, payload[0]) : undefined;
        if (fields?.length) variant.fields = fields;
        else variant.payloadUnresolved = true;
      }
      index = end + 1;
    }
    const comma = /^\s*,/.exec(body.slice(index));
    if (comma) index += comma[0].length;
    variants.push(variant);
  }
  return variants;
}

/** Printable ASCII runs of at least `minimum` bytes, like `strings -n <minimum>`. */
function* printableRuns(bytes, minimum = 6) {
  let start = -1;
  for (let index = 0; index <= bytes.length; index += 1) {
    const byte = index < bytes.length ? bytes[index] : 0;
    const printable = byte >= 0x20 && byte < 0x7f;
    if (printable && start < 0) start = index;
    if (!printable && start >= 0) {
      if (index - start >= minimum) yield bytes.toString('latin1', start, index);
      start = -1;
    }
  }
}

function binaryProbe(artifactPath, release, publicVariants) {
  const bytes = readFileSync(artifactPath);
  const digest = sha256(bytes);
  if (digest !== release.artifactSha256) {
    throw new Error(`artifact sha256 ${digest} is not the pinned ${release.artifactSha256}`);
  }
  let serdeRun;
  const embeddedCrates = new Set();
  const literals = new Set();
  for (const run of printableRuns(bytes)) {
    for (const literal of release.methodLiterals) if (run.includes(literal)) literals.add(literal);
    if (
      !serdeRun &&
      run.includes('diff_review') &&
      run.includes('turn_completed') &&
      run.includes('response_completed')
    ) {
      serdeRun = run;
    }
    for (const match of run.matchAll(/agent-client-protocol(?:-schema)?-\d+\.\d+\.\d+/g)) embeddedCrates.add(match[0]);
  }
  if (!serdeRun) throw new Error('could not locate the serde SessionUpdate variant-name run in the artifact');
  const publicNames = new Set(
    publicVariants.flatMap((entry) => [entry.wireName, ...(entry.fields ?? []).map((field) => field.wireName)]),
  );
  for (const token of [...release.binaryOnlyVariants, ...release.binaryOnlyFields]) {
    if (!serdeRun.includes(token)) throw new Error(`binary-only lead ${token} is absent from the serde run`);
    if (publicNames.has(token)) throw new Error(`binary-only lead ${token} is present in the public enum`);
  }
  if (!embeddedCrates.has(`agent-client-protocol-${release.acpCrateVersion}`)) {
    throw new Error(`artifact does not embed agent-client-protocol-${release.acpCrateVersion}`);
  }
  return {
    artifactSha256: digest,
    platform: release.artifactPlatform,
    // When this scan of the exact bytes ran: the evidence index's capturedAt for the lead.
    scannedAt: new Date().toISOString(),
    method:
      'printable-run scan (strings -n 6) for the run holding the serde SessionUpdate variant and field names; tokens compared with the public enum',
    confidence: 'low',
    serdeRunSha256: sha256(serdeRun),
    serdeRunLength: serdeRun.length,
    publicVariantNamesInRun: publicVariants.filter((entry) => serdeRun.includes(entry.wireName)).length,
    publicVariantNamesNotInRun: publicVariants
      .map((entry) => entry.wireName)
      .filter((name) => !serdeRun.includes(name))
      .sort(),
    binaryOnlyVariantLeads: release.binaryOnlyVariants,
    binaryOnlyFieldLeads: release.binaryOnlyFields,
    embeddedCratePaths: [...embeddedCrates].sort(),
    methodLiterals: Object.fromEntries(release.methodLiterals.map((literal) => [literal, literals.has(literal)])),
    limitations: [
      'The run is a strings heuristic: Rust pools identical literals, so a name the binary uses can be missing from this run (subagent_spawned and child_session_id are runtime-captured yet absent here). Absence is never evidence; presence is a low-confidence lead.',
      'A binary-only lead names a possible variant or field. It does not establish its payload shape, trigger, channel, or whether the variant is ever emitted.',
    ],
  };
}

const version = flag('--version', '1.0.70');
const release = RELEASES[version];
if (!release) throw new Error(`no pinned public-reference release for grok ${version}`);
const grokSourceFlag = flag('--grok-source', process.env.PUPPETEER_GROK_SOURCE);
const acpSourceFlag = flag('--acp-source', process.env.PUPPETEER_ACP_SOURCE);
const artifactFlag = flag('--artifact', process.env.PUPPETEER_GROK_BIN);
if (!grokSourceFlag || !acpSourceFlag || !artifactFlag) {
  throw new Error('--grok-source, --acp-source, and --artifact are required');
}
const grokSource = resolve(grokSourceFlag);
const acpSource = resolve(acpSourceFlag);
git(grokSource, 'cat-file', '-e', `${release.publicRevision}^{commit}`);
git(acpSource, 'cat-file', '-e', `${release.acpTag}^{commit}`);
if (git(grokSource, 'show', `${release.publicRevision}:SOURCE_REV`).trim() !== release.publicSourceRevision) {
  throw new Error(`Grok public mirror SOURCE_REV does not match ${release.publicSourceRevision}`);
}
if (git(acpSource, 'rev-parse', `${release.acpTag}^{}`) !== release.acpRevision) {
  throw new Error(`ACP ${release.acpTag} does not resolve to ${release.acpRevision}`);
}
// Re-derive the relation if the mirror ever publishes the binary's revision.
const mirrorCommits = git(grokSource, 'log', '--format=%H', release.publicRevision).split('\n');
if (mirrorCommits.some((commit) => commit.startsWith(release.binaryReportedRevision))) {
  throw new Error(`binary revision ${release.binaryReportedRevision} is now a mirror commit; re-derive the relation`);
}

const grokFiles = [
  'SOURCE_REV',
  'Cargo.lock',
  'crates/codegen/xai-grok-shell/Cargo.toml',
  'crates/codegen/xai-grok-shell/README.md',
  'crates/codegen/xai-grok-shell/src/extensions/notification.rs',
  'crates/codegen/xai-grok-shell/src/session/acp_session.rs',
  // The pager (native viewer) dispatch table names the ambient xAI notifications it consumes.
  'crates/codegen/xai-grok-pager/src/app/acp_handler/mod.rs',
];
const sourceContents = Object.fromEntries(
  grokFiles.map((path) => [path, git(grokSource, 'show', `${release.publicRevision}:${path}`)]),
);
const crateVersion = /^version = "([^"]+)"/m.exec(sourceContents['crates/codegen/xai-grok-shell/Cargo.toml'])?.[1];
if (crateVersion !== release.publicCrateVersion) {
  throw new Error(`public mirror crate is ${crateVersion}, expected ${release.publicCrateVersion}`);
}
const lock = sourceContents['Cargo.lock'];
const acpCrateVersion = /name = "agent-client-protocol"\nversion = "([^"]+)"/.exec(lock)?.[1];
const acpSchemaVersion = /name = "agent-client-protocol-schema"\nversion = "([^"]+)"/.exec(lock)?.[1];
if (acpCrateVersion !== release.acpCrateVersion || acpSchemaVersion !== release.acpSchemaVersion) {
  throw new Error(`unexpected public ACP dependencies: ${acpCrateVersion}/${acpSchemaVersion}`);
}

const acpSchemaText = git(acpSource, 'show', `${release.acpTag}:schema/schema.unstable.json`);
const acpSchema = JSON.parse(acpSchemaText);
const acpDefinitions = [
  'InitializeRequest',
  'InitializeResponse',
  'NewSessionRequest',
  'NewSessionResponse',
  'LoadSessionRequest',
  'LoadSessionResponse',
  'ListSessionsRequest',
  'ListSessionsResponse',
  'PromptRequest',
  'PromptResponse',
  'CancelNotification',
  'RequestPermissionRequest',
  'RequestPermissionResponse',
  'SessionNotification',
  'SessionUpdate',
  'ToolCall',
  'ToolCallUpdate',
  'ToolCallContent',
  'Diff',
];
const projectedSchemas = Object.fromEntries(
  acpDefinitions.map((name) => {
    const schema = acpSchema.$defs?.[name];
    if (!schema) throw new Error(`ACP schema is missing $defs.${name}`);
    return [name, projectJsonSchema(schema, acpSchema)];
  }),
);
const sessionUpdateValues = acpSchema.$defs.SessionUpdate.oneOf.map((branch) => branch.properties.sessionUpdate.const);

const notificationSource = sourceContents['crates/codegen/xai-grok-shell/src/extensions/notification.rs'];
const extensionVariants = parseRustEnum(notificationSource, 'pub enum SessionUpdate');
if (
  extensionVariants.length < release.xaiInventoryFloor ||
  !extensionVariants.some((entry) => entry.wireName === 'diff_review') ||
  !extensionVariants.some((entry) => entry.newtype !== undefined)
) {
  throw new Error(`unexpected supplemental xAI SessionUpdate inventory (${extensionVariants.length})`);
}
const binary = binaryProbe(resolve(artifactFlag), release, extensionVariants);

const output = {
  referenceVersion: 2,
  vendor: 'grok',
  vendorVersion: version,
  kind: 'supplemental-public-source-lead',
  generatedAt: release.generatedAt,
  binaryReportedRevision: release.binaryReportedRevision,
  publicMirror: {
    repository: 'https://github.com/xai-org/grok-build',
    revision: release.publicRevision,
    sourceRevision: release.publicSourceRevision,
    crateVersion,
    relationToBinary: release.relationToBinary,
    files: grokFiles.map((path) => ({ path, sha256: sha256(sourceContents[path]) })),
    xaiSessionUpdate: {
      serdeTag: 'sessionUpdate',
      renameAll: 'snake_case',
      variants: extensionVariants,
    },
  },
  acpDependencyOfPublicMirror: {
    repository: 'https://github.com/agentclientprotocol/agent-client-protocol',
    crateVersion: acpCrateVersion,
    schemaVersion: acpSchemaVersion,
    tag: release.acpTag,
    revision: release.acpRevision,
    schemaFile: 'schema/schema.unstable.json',
    schemaSha256: sha256(acpSchemaText),
    sessionUpdateValues,
    schemas: projectedSchemas,
  },
  binaryProbe: binary,
  limitations: [
    `The installed Grok ${version} binary reports revision ${release.binaryReportedRevision}, which is absent from the public mirror. The mirror's newest commit (${release.publicRevision.slice(0, 8)}, crate ${crateVersion}) is the nearest public lead and is older than the binary; no source value here proves binary behavior.`,
    `The ACP ${acpCrateVersion} / schema ${acpSchemaVersion} dependency is exact for the mirror commit. The binary embeds agent-client-protocol-${release.acpCrateVersion} crate paths (binary probe); runtime captures remain the authority for the installed artifact.`,
    'The xAI SessionUpdate enum inventory does not by itself establish which variants are live-only, durable-only, enabled, or present in the installed binary.',
  ],
};

const outputPath = join(vendorRoot, 'references', `grok@${version}`, 'public-source-surface.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `wrote ${outputPath} (${extensionVariants.length} supplemental xAI variants; ${release.binaryOnlyVariants.length} binary-only variant leads)`,
);
