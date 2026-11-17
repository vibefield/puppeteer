#!/usr/bin/env node
/**
 * Build the OpenCode 2.x exact-source event contract the model generator reads
 * (`references/opencode@V/source/event-contract.json`, the `ExactSourceEventContract`
 * shape in @vibefield/puppeteer-surface) from the 2.x event draft
 * (draft/opencode-2/event-contract.json, plan §4 A6) and a checkout of the
 * upstream source at the same tag.
 *
 * The 2.x OpenAPI document declares the event stream's payload only as an
 * encoded `V2EventEncoded` string, so the event inventory comes from source:
 * every public `Event.durable`/`Event.ephemeral` definition. The draft was read
 * from source as text at one tag; this script refuses a draft from another tag
 * (re-derive the draft first), digests every source file the draft cites, and
 * projects each field's Effect Schema expression into JSON Schema where the
 * expression is a known primitive. Anything else stays an open schema that
 * carries the expression as its description, and the event says so in notes.
 *
 * usage:
 *   node event-contract-v2.mjs --version 2.2.5 --source-root <opencode checkout at v2.2.5>
 *     [--draft draft/opencode-2/event-contract.json] [--out references/opencode@2.2.5/source/event-contract.json]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_SOURCE_ROOT = 'packages/schema/src';

/** Ids whose prefix the 2.x probes observed (plan §2.3: `evt_ ses_ per_ frm_ msg_ psv_`). */
const OBSERVED_ID_PREFIXES = new Map([
  ['SessionID', 'ses_'],
  ['Session.ID', 'ses_'],
  ['SessionMessage.ID', 'msg_'],
]);

const PRIMITIVES = new Map([
  ['Schema.String', { type: 'string' }],
  ['Schema.Boolean', { type: 'boolean' }],
  ['Schema.Number', { type: 'number' }],
  ['Schema.Finite', { type: 'number' }],
  ['Schema.Int', { type: 'integer' }],
  ['NonNegativeInt', { type: 'integer', minimum: 0 }],
  ['PositiveInt', { type: 'integer', minimum: 1 }],
  ['Schema.Unknown', {}],
  ['Schema.Json', {}],
  ['AbsolutePath', { type: 'string' }],
  ['RelativePath', { type: 'string' }],
]);

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/** `Name(inner)` → inner, when the whole expression is exactly one such call. */
function callArgument(expression, name) {
  if (!expression.startsWith(`${name}(`) || !expression.endsWith(')')) return undefined;
  const inner = expression.slice(name.length + 1, -1);
  let depth = 0;
  for (const character of inner) {
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    if (depth < 0) return undefined;
  }
  return depth === 0 ? inner : undefined;
}

/** `head.name(args)` → head, when `.name(args)` closes the whole expression. */
function stripTrailingCall(expression, name) {
  for (let index = expression.indexOf(`.${name}(`); index > 0; index = expression.indexOf(`.${name}(`, index + 1)) {
    if (callArgument(expression.slice(index + 1), name) !== undefined) return expression.slice(0, index).trim();
  }
  return undefined;
}

/**
 * Project one Effect Schema source expression into JSON Schema.
 * `exact` is false when any part of it was not a known primitive; the
 * unresolved part is then `{description: "source: <expression>"}`.
 */
export function sourceExpressionSchema(raw) {
  let expression = raw.trim();
  // Annotations, pipes (`optional`, decoding defaults) and `optional(...)` do
  // not change the wire type a value has when present: strip them.
  for (;;) {
    const stripped = stripTrailingCall(expression, 'annotate') ?? stripTrailingCall(expression, 'pipe');
    if (stripped !== undefined) {
      expression = stripped;
      continue;
    }
    const optional = callArgument(expression, 'optional');
    if (optional !== undefined) {
      expression = optional.trim();
      continue;
    }
    break;
  }
  const primitive = PRIMITIVES.get(expression);
  if (primitive) return { schema: structuredClone(primitive), exact: true };
  const prefix = OBSERVED_ID_PREFIXES.get(expression);
  if (prefix) return { schema: { type: 'string', pattern: `^${prefix}` }, exact: true };

  const literals = callArgument(expression, 'Schema.Literals');
  if (literals !== undefined) {
    try {
      const values = JSON.parse(literals);
      if (Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === 'string')) {
        return { schema: { type: 'string', enum: values }, exact: true };
      }
    } catch {
      // Not a JSON literal list; fall through to an open schema.
    }
  }
  const nullable = callArgument(expression, 'Schema.NullOr');
  if (nullable !== undefined) {
    const inner = sourceExpressionSchema(nullable);
    return { schema: { anyOf: [inner.schema, { type: 'null' }] }, exact: inner.exact };
  }
  for (const [name, minItems] of [
    ['Schema.Array', undefined],
    ['Schema.NonEmptyArray', 1],
  ]) {
    const items = callArgument(expression, name);
    if (items !== undefined) {
      const inner = sourceExpressionSchema(items);
      return {
        schema: { type: 'array', items: inner.schema, ...(minItems ? { minItems } : {}) },
        exact: inner.exact,
      };
    }
  }
  const record = callArgument(expression, 'Schema.Record');
  if (record !== undefined) {
    const [key, value] = splitTopLevel(record);
    if (key === 'Schema.String' && value) {
      const inner = sourceExpressionSchema(value);
      return { schema: { type: 'object', additionalProperties: inner.schema }, exact: inner.exact };
    }
  }
  if (/ID$/.test(expression)) {
    return { schema: { type: 'string', description: `source: ${raw.trim()}` }, exact: false };
  }
  return { schema: { description: `source: ${raw.trim()}` }, exact: false };
}

/** One draft event's payload schema, with the expressions it could not resolve. */
export function draftPayloadSchema(fields) {
  const properties = {};
  const required = [];
  const unresolved = [];
  for (const field of fields ?? []) {
    if (field?.spread) {
      unresolved.push(`spread ${field.spread}`);
      continue;
    }
    const projected = sourceExpressionSchema(field.schema);
    properties[field.name] = projected.schema;
    if (!projected.exact) unresolved.push(`${field.name}: ${field.schema}`);
    if (field.optional !== true) required.push(field.name);
  }
  return {
    schema: {
      type: 'object',
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      ...(required.length > 0 ? { required } : {}),
    },
    unresolved,
  };
}

/** The shared 2.x record envelope (plan §2.3): `{id, created, type, location?, metadata?, data, durable?}`. */
export function envelopeSchema() {
  return {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^evt_' },
      created: { type: 'integer' },
      type: { type: 'string' },
      location: { type: 'object', properties: { directory: { type: 'string' } } },
      metadata: { type: 'object' },
      data: {},
      durable: {
        type: 'object',
        properties: {
          aggregateID: { type: 'string' },
          seq: { type: 'integer', minimum: 0 },
          version: { type: 'integer', minimum: 1 },
        },
        required: ['aggregateID', 'seq', 'version'],
      },
    },
    required: ['id', 'type', 'data'],
  };
}

/**
 * The exact-source contract for `vendorVersion` from the draft and the digests
 * of the source files it cites (`sourceFiles[name] = {path, sha256, bytes}`,
 * keyed by the draft's file name). Only public-stream definitions become
 * events; the rest are counted in the limitations.
 */
export function draftEventContract(draft, { vendorVersion, sourceFiles }) {
  const tag = `v${vendorVersion}`;
  if (draft?.upstream?.tag !== tag) {
    throw new Error(`the event draft was read at ${String(draft?.upstream?.tag)}, not ${tag}: re-derive it first`);
  }
  const events = {};
  const used = new Set();
  let hidden = 0;
  let unresolvedEvents = 0;
  for (const definition of draft.events ?? []) {
    if (definition.publicStream !== true) {
      hidden += 1;
      continue;
    }
    const file = definition.source?.[0];
    const source = file ? sourceFiles[file] : undefined;
    if (file && !source) throw new Error(`${definition.type}: no digest for its source file ${file}`);
    if (source) used.add(file);
    const payload = draftPayloadSchema(definition.data);
    if (payload.unresolved.length > 0) unresolvedEvents += 1;
    const durable = definition.durability === 'durable';
    const connected = definition.type === 'server.connected';
    const notes = [
      durable
        ? `durable v${definition.durable?.version} (aggregate ${definition.durable?.aggregate})`
        : 'ephemeral (no durable record)',
      ...(payload.unresolved.length > 0 ? [`unresolved: ${payload.unresolved.join('; ')}`] : []),
    ];
    events[definition.type] = {
      payloadSchema: payload.schema,
      ...(source ? { source: { path: source.path } } : {}),
      envelopeRequired: connected ? [] : durable ? ['created', 'durable'] : ['created'],
      envelopeOmitted: connected ? ['created', 'location', 'durable'] : durable ? [] : ['durable'],
      notes: notes.join('; '),
    };
  }
  const repository = String(draft.upstream.repository ?? '');
  return {
    kind: 'exact-source-event-contract',
    contractVersion: 1,
    vendor: 'opencode',
    vendorVersion,
    sourceRepository: repository.startsWith('https://') ? repository : `https://github.com/${repository}`,
    sourceTag: tag,
    sourceRevision: draft.upstream.commit,
    sourceFiles: [...used].sort().map((file) => {
      const { path, sha256, bytes } = sourceFiles[file];
      return { path, sha256, bytes };
    }),
    envelope: {
      discriminator: 'type',
      payload: 'data',
      payloadEncodings: ['object', 'json-string'],
      schema: envelopeSchema(),
    },
    events,
    limitations: [
      'Read from the exact tag source as text (draft/opencode-2/event-contract.json); field schemas project Effect Schema source expressions, and an expression that is not a known primitive stays an open schema carrying the expression as its description.',
      `${unresolvedEvents} event(s) keep at least one unresolved field expression; their notes name each one.`,
      `${hidden} definition(s) not on the public GET /api/event stream are omitted.`,
      'The envelope declares `data` as either an object (what the server sends) or a JSON-encoded string (what the OpenAPI V2EventEncoded declares).',
    ],
  };
}

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path).split(sep).join('/')];
  });
}

/** Digests of every file the draft cites, found by name under `<sourceRoot>/packages/schema/src`; a name must be unique. */
export function sourceFileDigests(draft, sourceRoot) {
  const schemaRoot = join(sourceRoot, SCHEMA_SOURCE_ROOT);
  const files = filesUnder(schemaRoot);
  const digests = {};
  for (const name of new Set((draft.events ?? []).flatMap((definition) => definition.source ?? []))) {
    const matches = files.filter((file) => file === name || file.endsWith(`/${name}`));
    if (matches.length !== 1) throw new Error(`${name}: ${matches.length} files under ${SCHEMA_SOURCE_ROOT}`);
    const bytes = readFileSync(join(schemaRoot, matches[0]));
    digests[name] = {
      path: `${SCHEMA_SOURCE_ROOT}/${matches[0]}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
  }
  return digests;
}

const scriptPath = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const vendorRoot = dirname(dirname(scriptPath));
  const repoRoot = resolve(vendorRoot, '../../../..');
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const version = flag('--version');
  if (!version || !/^2\.\d+\.\d+$/.test(version)) throw new Error('--version <2.x.y> is required');
  const sourceRoot = flag('--source-root');
  if (!sourceRoot) throw new Error('--source-root <opencode checkout at the tag> is required');
  const draftPath = resolve(flag('--draft') ?? join(repoRoot, 'draft', 'opencode-2', 'event-contract.json'));
  const out = resolve(
    flag('--out') ?? join(vendorRoot, 'references', `opencode@${version}`, 'source', 'event-contract.json'),
  );
  const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  const contract = draftEventContract(draft, {
    vendorVersion: version,
    sourceFiles: sourceFileDigests(draft, resolve(sourceRoot)),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(contract, null, 2)}\n`);
  console.log(`${Object.keys(contract.events).length} public event type(s) -> ${out}`);
}
