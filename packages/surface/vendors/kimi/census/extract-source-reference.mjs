#!/usr/bin/env node
/** Build a digest-pinned Kimi source reference from the exact release checkout. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_COMMIT,
  SOURCE_TAG,
  VERSION,
  WIRE_PROTOCOL_VERSION,
  cliOptions,
  hookEvents,
  hookSchemas,
  persistedSchemas,
  sourceFiles,
  transientTypes,
} from './source-contract.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutput = join(vendorRoot, 'references', `kimi@${VERSION}`, 'source-contract.json');

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  throw new Error(`Kimi source reference: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(sourceRoot, ...args) {
  return execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim();
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameInventory(label, actual, expected) {
  const left = sorted(actual);
  const right = sorted(expected);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    const missing = right.filter((value) => !left.includes(value));
    const extra = left.filter((value) => !right.includes(value));
    fail(`${label} drift (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
}

function extractManifestInventory(source) {
  const entries = [];
  for (const line of source.split('\n')) {
    const match = /^\/\/\s{3}(\S+)\s+.*?\s{2,}(persisted|transient)\s+(src\/\S+\.ts)$/.exec(line);
    if (match) entries.push({ type: match[1], persistence: match[2], owner: match[3] });
  }
  if (entries.length !== 48) fail(`wire manifest has ${entries.length} indexed records, expected 48`);
  return entries;
}

function matchingBrace(source, opening) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  fail(`unterminated declaration at byte ${opening}`);
}

function braceDelta(line) {
  return [...line].reduce((depth, character) => depth + (character === '{' ? 1 : character === '}' ? -1 : 0), 0);
}

function extractInterfacePayloadShapes(source) {
  const payloads = new Map();
  for (const match of source.matchAll(/interface\s+\w+Payload\s*\{/g)) {
    const opening = source.indexOf('{', match.index);
    const body = source.slice(opening + 1, matchingBrace(source, opening));
    let depth = 0;
    let name;
    const fields = [];
    const required = [];
    for (const line of body.split('\n')) {
      if (depth === 0) {
        const property = /^\s*(?:readonly\s+)?(?:"([^"]+)"|([A-Za-z_$][\w$]*))(\?)?:/.exec(line);
        if (property) {
          const field = property[1] ?? property[2];
          const operation = field === '_name' ? /_name:\s*['"]([^'"]+)['"]/.exec(line)?.[1] : undefined;
          if (operation) name = operation;
          else if (field !== '_name') {
            fields.push(field);
            if (!property[3]) required.push(field);
          }
        }
      }
      depth += braceDelta(line);
    }
    if (name) payloads.set(name, { fields, required });
  }
  return payloads;
}

function validateProjectionAgainstManifest(manifest, schemas) {
  const declarations = extractInterfacePayloadShapes(manifest);
  for (const [operation, schema] of Object.entries(schemas)) {
    // The generated declaration preserves this Zod union as an intersection
    // type rather than an interface. Its three required-field branches are
    // checked directly below and the contributing Zod source is digest-pinned.
    if (operation === 'context.apply_compaction') continue;
    const declaration = declarations.get(operation);
    if (!declaration) fail(`generated manifest has no payload declaration for ${operation}`);
    sameInventory(`${operation} top-level fields`, Object.keys(schema.properties ?? {}), declaration.fields);
    sameInventory(`${operation} required fields`, schema.required ?? [], declaration.required);
  }

  const compaction = schemas['context.apply_compaction'];
  const branches = (compaction.anyOf ?? []).map((branch) => sorted(branch.required ?? []).join(','));
  sameInventory('context.apply_compaction required branches', branches, [
    'compactedCount,summary',
    'compactedCount,contextSummary',
    'count,summary',
  ]);
  for (const declaration of [
    '{ summary: string, compactedCount: number, contextSummary?: string }',
    '{ contextSummary: string, compactedCount: number, summary?: string }',
    '{ summary: ContextMessage, count: number, compactedCount?: number }',
  ]) {
    if (!manifest.includes(declaration)) fail(`context.apply_compaction declaration is missing ${declaration}`);
  }
}

function extractStringArray(source, constantName) {
  const match = new RegExp(`export const ${constantName} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  if (!match) fail(`cannot locate ${constantName}`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

export function buildSourceReference({ sourceRoot, retrievedAt }) {
  if (!sourceRoot) fail('--source is required');
  if (!retrievedAt || Number.isNaN(Date.parse(retrievedAt))) fail('--retrieved-at must be an ISO timestamp');

  const revision = git(sourceRoot, 'rev-parse', 'HEAD');
  if (revision !== SOURCE_COMMIT) fail(`expected revision ${SOURCE_COMMIT}, got ${revision}`);
  const dirty = git(sourceRoot, 'status', '--porcelain');
  if (dirty) fail('checkout is dirty');
  const tags = git(sourceRoot, 'tag', '--points-at', 'HEAD').split('\n').filter(Boolean);
  if (!tags.includes(SOURCE_TAG)) fail(`revision is not tagged ${SOURCE_TAG}`);

  const manifestPath = 'packages/agent-core-v2/docs/wire-manifest.d.ts';
  const manifest = readFileSync(join(sourceRoot, manifestPath), 'utf8');
  const entries = extractManifestInventory(manifest);
  const persisted = entries.filter((entry) => entry.persistence === 'persisted');
  const transient = entries.filter((entry) => entry.persistence === 'transient');
  sameInventory(
    'persisted operation inventory',
    persisted.map((entry) => entry.type),
    Object.keys(persistedSchemas),
  );
  sameInventory(
    'transient operation inventory',
    transient.map((entry) => entry.type),
    transientTypes,
  );
  validateProjectionAgainstManifest(manifest, persistedSchemas);

  const contributingFiles = sorted(
    new Set([...sourceFiles, ...entries.map((entry) => `packages/agent-core-v2/${entry.owner}`)]),
  );
  const fileRecords = contributingFiles.map((path) => {
    const bytes = readFileSync(join(sourceRoot, path));
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });

  const protocolSource = readFileSync(
    join(sourceRoot, 'packages/agent-core-v2/src/wire/migration/migration.ts'),
    'utf8',
  );
  const protocol = /WIRE_PROTOCOL_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(protocolSource)?.[1];
  if (protocol !== WIRE_PROTOCOL_VERSION) fail(`expected wire protocol ${WIRE_PROTOCOL_VERSION}, got ${protocol}`);

  const hookSource = readFileSync(join(sourceRoot, 'packages/agent-core-v2/src/agent/externalHooks/types.ts'), 'utf8');
  const sourceHookEvents = extractStringArray(hookSource, 'HOOK_EVENT_TYPES');
  sameInventory('hook inventory', sourceHookEvents, hookEvents);
  sameInventory('hook schema inventory', Object.keys(hookSchemas), hookEvents);

  const cliSource = readFileSync(join(sourceRoot, 'apps/kimi-code/src/cli/commands.ts'), 'utf8');
  for (const [purpose, options] of Object.entries(cliOptions)) {
    for (const option of options) {
      if (!cliSource.includes(option)) fail(`CLI ${purpose} declaration is missing ${option}`);
    }
  }

  return {
    referenceVersion: 1,
    vendor: 'kimi',
    vendorVersion: VERSION,
    repository: 'https://github.com/moonshotai/kimi-code',
    revision: SOURCE_COMMIT,
    tag: SOURCE_TAG,
    retrievedAt,
    projection: {
      format: 'Agent Surface Model recursive schema subset',
      method:
        'Curated recursive projection with top-level fields and requiredness checked against the release-generated wire manifest; every operation owner and expanded declaration source is digest-pinned.',
      limitations:
        'Unknown/custom TypeScript values remain unconstrained; source-only declarations do not establish runtime behavior.',
    },
    sourceFiles: fileRecords,
    wire: {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      manifest: manifestPath,
      totalOperationTypes: entries.length,
      persistedOperationTypes: persisted.length,
      transientOperationTypes: transient.length,
      persisted: persisted.map((entry) => ({ type: entry.type, owner: entry.owner })),
      transient: transient.map((entry) => ({ type: entry.type, owner: entry.owner })),
      payloadSchemas: persistedSchemas,
    },
    hooks: {
      events: hookEvents,
      payloadSchemas: hookSchemas,
    },
    cli: { options: cliOptions },
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const sourceFlag = flag('--source');
  const sourceRoot = sourceFlag && (isAbsolute(sourceFlag) ? sourceFlag : resolve(sourceFlag));
  const output = resolve(flag('--output', defaultOutput));
  const reference = buildSourceReference({ sourceRoot, retrievedAt: flag('--retrieved-at') });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(
    `wrote Kimi ${VERSION} source reference: ${reference.wire.persistedOperationTypes} persisted + ${reference.wire.transientOperationTypes} transient operations, ${reference.hooks.events.length} hooks`,
  );
}
