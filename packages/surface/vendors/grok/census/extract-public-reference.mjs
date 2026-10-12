#!/usr/bin/env node
/**
 * Retain the public-source leads relevant to Grok 1.0.0.
 *
 * The installed binary reports revision 3cd0d0cbcebe, which is absent from the
 * public mirror. This extractor therefore labels every source-derived value as
 * supplemental. It also retains the exact ACP schema dependency of the pinned
 * public mirror commit; that dependency is not asserted to be the binary's.
 *
 * usage:
 *   node extract-public-reference.mjs \
 *     --grok-source /path/to/xai-org/grok-build \
 *     --acp-source /path/to/agentclientprotocol/agent-client-protocol
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectJsonSchema } from '@vibefield/puppeteer-surface';

const VERSION = '1.0.0';
const PUBLIC_REVISION = '8a14c91d88875a831a38b3a066b1683116bcb31c';
const PUBLIC_SOURCE_REVISION = '27b3c66635e2c0bf213429a36ab916f25d59df20';
const ACP_TAG = 'v0.11.4';
const ACP_REVISION = 'e931357254ff44573294d5cee214a269e0cd6c54';
const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trimEnd();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function snakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function enumBody(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`missing ${declaration}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated ${declaration}`);
}

function parseRustEnum(source, declaration) {
  const body = enumBody(source, declaration);
  const lines = body.split('\n');
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {4}([A-Z][A-Za-z0-9_]*)(?:\s*\{|\s*\(|\s*,)/.exec(lines[index]);
    if (!match) continue;
    const rustName = match[1];
    const fields = [];
    if (lines[index].includes('{')) {
      let depth = (lines[index].match(/\{/g) ?? []).length - (lines[index].match(/\}/g) ?? []).length;
      while (depth > 0 && ++index < lines.length) {
        const line = lines[index];
        const field = /^ {8}(?:pub )?([a-z_][a-z0-9_]*):\s*(.+),$/.exec(line);
        if (field) fields.push({ name: field[1], rustType: field[2] });
        depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      }
    }
    variants.push({ rustName, wireName: snakeCase(rustName), ...(fields.length ? { fields } : {}) });
  }
  return variants;
}

const grokSource = resolve(flag('--grok-source', process.env.PUPPETEER_GROK_SOURCE ?? ''));
const acpSource = resolve(flag('--acp-source', process.env.PUPPETEER_ACP_SOURCE ?? ''));
if (
  !flag('--grok-source', process.env.PUPPETEER_GROK_SOURCE) ||
  !flag('--acp-source', process.env.PUPPETEER_ACP_SOURCE)
) {
  throw new Error('--grok-source and --acp-source are required');
}
git(grokSource, 'cat-file', '-e', `${PUBLIC_REVISION}^{commit}`);
git(acpSource, 'cat-file', '-e', `${ACP_TAG}^{commit}`);
if (git(grokSource, 'show', `${PUBLIC_REVISION}:SOURCE_REV`).trim() !== PUBLIC_SOURCE_REVISION) {
  throw new Error(`Grok public mirror SOURCE_REV does not match ${PUBLIC_SOURCE_REVISION}`);
}
if (git(acpSource, 'rev-parse', `${ACP_TAG}^{}`) !== ACP_REVISION) {
  throw new Error(`ACP ${ACP_TAG} does not resolve to ${ACP_REVISION}`);
}

const grokFiles = [
  'SOURCE_REV',
  'Cargo.lock',
  'crates/codegen/xai-grok-shell/Cargo.toml',
  'crates/codegen/xai-grok-shell/README.md',
  'crates/codegen/xai-grok-shell/src/extensions/notification.rs',
  'crates/codegen/xai-grok-shell/src/session/acp_session.rs',
];
const sourceContents = Object.fromEntries(
  grokFiles.map((path) => [path, git(grokSource, 'show', `${PUBLIC_REVISION}:${path}`)]),
);
const lock = sourceContents['Cargo.lock'];
const crateVersion = /name = "agent-client-protocol"\nversion = "([^"]+)"/.exec(lock)?.[1];
const schemaVersion = /name = "agent-client-protocol-schema"\nversion = "([^"]+)"/.exec(lock)?.[1];
if (crateVersion !== '0.10.4' || schemaVersion !== '0.11.4') {
  throw new Error(`unexpected public ACP dependencies: ${crateVersion}/${schemaVersion}`);
}

const acpSchemaText = git(acpSource, 'show', `${ACP_TAG}:schema/schema.unstable.json`);
const acpSchema = JSON.parse(acpSchemaText);
const acpDefinitions = [
  'InitializeRequest',
  'InitializeResponse',
  'NewSessionRequest',
  'NewSessionResponse',
  'LoadSessionRequest',
  'LoadSessionResponse',
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
if (extensionVariants.length < 40 || !extensionVariants.some((entry) => entry.wireName === 'diff_review')) {
  throw new Error(`unexpected supplemental xAI SessionUpdate inventory (${extensionVariants.length})`);
}

const output = {
  referenceVersion: 1,
  vendor: 'grok',
  vendorVersion: VERSION,
  kind: 'supplemental-public-source-lead',
  generatedAt: '2026-08-28',
  binaryReportedRevision: '3cd0d0cbcebe',
  publicMirror: {
    repository: 'https://github.com/xai-org/grok-build',
    revision: PUBLIC_REVISION,
    sourceRevision: PUBLIC_SOURCE_REVISION,
    relationToBinary: 'unverified-not-present-in-public-mirror',
    files: grokFiles.map((path) => ({ path, sha256: sha256(sourceContents[path]) })),
    xaiSessionUpdate: {
      serdeTag: 'sessionUpdate',
      renameAll: 'snake_case',
      variants: extensionVariants,
    },
  },
  acpDependencyOfPublicMirror: {
    repository: 'https://github.com/agentclientprotocol/agent-client-protocol',
    crateVersion,
    schemaVersion,
    tag: ACP_TAG,
    revision: ACP_REVISION,
    schemaFile: 'schema/schema.unstable.json',
    schemaSha256: sha256(acpSchemaText),
    sessionUpdateValues,
    schemas: projectedSchemas,
  },
  limitations: [
    'The installed Grok 1.0.0 binary reports revision 3cd0d0cbcebe, which is absent from the public mirror. No value in this reference proves binary behavior.',
    'The ACP 0.10.4 / schema 0.11.4 dependency is exact for the pinned public mirror commit only. Runtime captures remain the authority for the installed artifact.',
    'The xAI SessionUpdate enum inventory does not by itself establish which variants are live-only, durable-only, enabled, or present in the installed binary.',
  ],
};

const outputPath = join(vendorRoot, 'references', `grok@${VERSION}`, 'public-source-surface.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${outputPath} (${extensionVariants.length} supplemental xAI variants)`);
