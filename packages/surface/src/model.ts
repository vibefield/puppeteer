/**
 * Agent Surface Model (ASM) runtime — validate, load, report, diff
 * (docs/archive/EMULATOR.md §2, §7).
 *
 * This module is SELF-CONTAINED by design: no relative imports, erasable
 * syntax only. Surface-owned audit scripts and adapter projection generators
 * import it as `@vibecook/chopsticks-surface`, which node (≥22.18, type
 * stripping) can execute — node does not remap the repo's `.js`-suffixed
 * relative imports, so anything reachable from those scripts must live in
 * this one file. It is therefore the package root export, not a barrel.
 *
 * That constraint is why this owns a package rather than living beside the
 * imposter (docs/archive/IMPOSTER.md §7.1): `erasableSyntaxOnly` is set package-wide
 * here, so the compiler enforces it. A package that also carried a TUI could
 * not set that flag, and a relative import added years from now would surface
 * as a baffling `audit.mjs` failure instead of a type error.
 *
 * Truth flows real CLI → captures → model → projections; this module never
 * contacts a vendor binary. `buildReport` reads captures, `loadModel` reads
 * the model, `diffModelVsReport` is the drift equation's left half.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Model documents (docs/archive/EMULATOR.md §2)
// ---------------------------------------------------------------------------

export interface SurfaceManifest {
  /** v2 adds directional contracts and claim-addressable evidence; v1 stays readable. */
  asmVersion: 1 | 2;
  vendor: string;
  vendorVersion: string;
  generatedAt: string;
  /** Where the captures came from, e.g. "phase-0 + M1 censuses". */
  source?: string;
  /** Model-relative machine-readable provenance index. */
  evidence?: string;
}

/** Loose carrier — detection data is consumed by adapters, not this module. */
export interface SurfaceDetection {
  executables?: string[];
  envVar?: string;
  versionFlag?: string;
  versionPattern?: string;
  [extra: string]: unknown;
}

export interface SurfaceChannel {
  kind: string;
  [extra: string]: unknown;
}

export interface SurfaceChannels {
  channels: Record<string, SurfaceChannel>;
}

/**
 * Deliberately small, recursive JSON-Schema subset (docs/archive/EMULATOR.md §2.2).
 *
 * ACP-style agents put their meaningful discriminants below `params.update`,
 * while hook-style agents mostly use a flat envelope. A top-level-only schema
 * therefore validates one family and merely type-checks the carrier object for
 * the other. Recursion keeps the subset compact while making both families
 * equally useful as drift/conformance gates.
 */
export interface PayloadSchemaNode {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  /** At least one branch must validate. Common constraints on this node still apply. */
  anyOf?: readonly PayloadSchemaNode[];
  enum?: readonly unknown[];
  required?: string[];
  properties?: Record<string, PayloadSchemaNode>;
  items?: PayloadSchemaNode;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

/** Backward-compatible name used by existing model generators. */
export interface PayloadSchemaProperty extends PayloadSchemaNode {}

export interface PayloadSchema extends PayloadSchemaNode {
  type: 'object';
}

/** The cross-vendor evidence ladder defined by the ASM contract. */
export type SurfaceConfidence = 'verified-headless' | 'verified-interactive' | 'unverified';

export type SurfaceDirection = 'client-to-agent' | 'agent-to-client' | 'agent-local';

/** One independently attributable observation/source in an ASM v2 evidence index. */
export interface SurfaceEvidenceClaimRecord {
  id: string;
  kind: 'runtime-capture' | 'binary-probe' | 'generated-schema' | 'exact-source' | 'official-doc' | 'inference';
  confidence: SurfaceConfidence;
  /** Digest-pinned record in evidence.json#records. */
  record?: string;
  /** Artifact identity in evidence.json#artifacts. */
  artifact?: string;
  /** Zero-based reference into evidence.json#sourceReferences. */
  sourceReference?: number;
  platform?: string;
  harness?: string;
  capturedAt?: string;
  notes?: string;
}

export interface SurfaceEvidenceIndex {
  evidenceVersion: 2;
  vendor: string;
  vendorVersion: string;
  artifacts: Array<{ id: string; [extra: string]: unknown }>;
  sourceReferences: Array<Record<string, unknown>>;
  records: Array<{ id: string; [extra: string]: unknown }>;
  claims: SurfaceEvidenceClaimRecord[];
  [extra: string]: unknown;
}

/** Evidence is attached to the precise assertion it supports, not one whole event. */
export interface SurfaceClaimEvidence {
  existence: readonly string[];
  shape: readonly string[];
  trigger?: readonly string[];
  ordering?: readonly string[];
  result?: readonly string[];
  carrier?: readonly string[];
}

export interface SurfaceEventVariant {
  /** Native dotted payload paths and exact values identifying this branch. */
  match: Record<string, string | number | boolean | null>;
  evidence: SurfaceClaimEvidence;
  /** Computed by the loader from evidence records; declarations must agree. */
  confidence: SurfaceConfidence;
}

export interface SurfaceEventFile {
  surface: string;
  surfaceVersion: string;
  event: string;
  /** Primary/default rail, retained for ASM v1 compatibility. */
  channel: string;
  /** Every rail on which this exact native event is observable. */
  channels: readonly string[];
  transport?: string;
  /** Required by ASM v2. A durable copy does not change a live event's direction. */
  direction?: SurfaceDirection;
  trigger?: string;
  payloadSchema?: PayloadSchema;
  /** Result payload for request/response transports, in the reverse direction of the request. */
  resultSchema?: PayloadSchema;
  /** Whole transport carrier, e.g. a durable JSONL record around `params`. */
  recordSchema?: PayloadSchema;
  /** Rail to which recordSchema applies when the event has multiple rails. */
  recordChannel?: string;
  /** Required by ASM v2 and resolved against evidence.json#claims. */
  evidence?: SurfaceClaimEvidence;
  /** Per-discriminant evidence; required in v2 for every enum value in a schema. */
  variants?: SurfaceEventVariant[];
  confidence: SurfaceConfidence;
  /** Hook timeout written into generated settings (claude registry parity). */
  timeoutSec?: number;
  /** Hook registration is ineffective unless its matcher declares what to observe. */
  matcherRequired?: boolean;
  firstSeen?: string;
  lastVerified?: string;
  fixture?: string;
  notes?: string;
}

/**
 * A vendor-native behaviour graph. Nodes are observable native events or
 * methods, never normalized agent states. The graph is deliberately a partial
 * order rather than an exclusive state machine: hook points may be optional,
 * concurrent, re-entrant, or asynchronous.
 */
export type SurfaceBehaviorRelationKind = 'sequence' | 'conditional' | 'loop' | 'resume' | 'async' | 'concurrent';

export interface SurfaceBehaviorLane {
  id: string;
  label: string;
  description?: string;
}

export interface SurfaceBehaviorNode {
  id: string;
  /** Exact event/method name from events/, never a normalized alias. */
  event: string;
  /** Evidence for this event+selector claim, independently of the event file. */
  confidence: SurfaceConfidence;
  /** ASM v2 provenance for this exact event-plus-selector claim. */
  evidence?: SurfaceClaimEvidence;
  lane: string;
  /** Stable layout order inside the lane. It carries no transition semantics. */
  order: number;
  label?: string;
  description?: string;
  source?: string;
  /** Optional native payload discriminants, expressed as dotted field paths. */
  match?: Record<string, string | number | boolean>;
}

export interface SurfaceBehaviorRelation {
  from: string;
  to: string;
  kind: SurfaceBehaviorRelationKind;
  label?: string;
  /** Evidence for the ordering/branch claim, independently of node confidence. */
  confidence: SurfaceConfidence;
  /** ASM v2 provenance for this exact ordering/branch claim. */
  evidence?: SurfaceClaimEvidence;
  source?: string;
}

export interface SurfaceBehavior {
  behaviorVersion: 1;
  title: string;
  description?: string;
  source?: string;
  lanes: SurfaceBehaviorLane[];
  nodes: SurfaceBehaviorNode[];
  relations: SurfaceBehaviorRelation[];
}

export interface SurfaceModel {
  manifest: SurfaceManifest;
  detection: SurfaceDetection;
  channels: SurfaceChannels;
  /** Present for ASM v2; v1 models remain readable as legacy inputs. */
  evidenceIndex?: SurfaceEvidenceIndex;
  /** Sorted by event name for deterministic output. */
  events: SurfaceEventFile[];
  /** Versioned, vendor-native event topology rendered by Imposter Control. */
  behavior: SurfaceBehavior;
}

// ---------------------------------------------------------------------------
// Surface report (built from captures)
// ---------------------------------------------------------------------------

export interface SurfaceReportEvent {
  event: string;
  /** Captured lines observed for this event. */
  count: number;
  /** Top-level payload field → number of lines it appeared on. */
  fields: Record<string, number>;
}

export type SurfaceReportIssueKind = 'invalid-json' | 'invalid-envelope' | 'schema-mismatch';

/** A capture defect with a source location, but never the potentially sensitive payload value. */
export interface SurfaceReportIssue {
  kind: SurfaceReportIssueKind;
  file: string;
  line: number;
  event?: string;
  message: string;
}

export interface SurfaceReport {
  capturesDir: string;
  generatedAt: string;
  events: SurfaceReportEvent[];
  /** Non-empty lines that failed JSON.parse — captures should have none. */
  unparsedLines: number;
  /** Parse/envelope/schema defects found while examining every captured line. */
  issues: SurfaceReportIssue[];
  /** Present when payloads were validated while building the report. */
  validatedAgainst?: { vendor: string; vendorVersion: string };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type DriftKind =
  'invalid-capture' | 'observed-unmodeled' | 'unobserved-verified' | 'schema-mismatch' | 'unmodeled-field';

export interface DriftEntry {
  kind: DriftKind;
  event: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function enumContains(values: readonly unknown[], candidate: unknown): boolean {
  return values.some((value) => {
    if (Object.is(value, candidate)) return true;
    if (value === null || candidate === null || typeof value !== 'object' || typeof candidate !== 'object')
      return false;
    return JSON.stringify(value) === JSON.stringify(candidate);
  });
}

function validateSchemaNode(schema: PayloadSchemaNode, value: unknown, path: string, violations: string[]): void {
  const label = path.length === 0 ? 'payload' : `field "${path}"`;
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const matches = schema.type === 'integer' ? actual === 'number' && Number.isInteger(value) : actual === schema.type;
    if (!matches) {
      violations.push(`${label} is ${actual}, expected ${schema.type}`);
      return;
    }
  }
  if (schema.anyOf !== undefined) {
    const alternatives = schema.anyOf.map((branch) => {
      const branchViolations: string[] = [];
      validateSchemaNode(branch, value, path, branchViolations);
      return branchViolations;
    });
    if (alternatives.every((branch) => branch.length > 0)) {
      violations.push(`${label} does not satisfy anyOf`);
    }
  }
  if (schema.enum !== undefined && !enumContains(schema.enum, value)) {
    violations.push(`${label} value not in enum`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push(`${label} is below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push(`${label} is above maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      violations.push(`${label} is not above exclusive minimum ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      violations.push(`${label} is not below exclusive maximum ${schema.exclusiveMaximum}`);
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(record, field)) {
        violations.push(`missing required field "${path.length === 0 ? field : `${path}.${field}`}"`);
      }
    }
    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(record, field)) {
        validateSchemaNode(property, record[field], path.length === 0 ? field : `${path}.${field}`, violations);
      }
    }
  } else if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => validateSchemaNode(schema.items!, entry, `${path}[${index}]`, violations));
  }
}

/** Validate a captured payload against the recursive subset schema. */
export function validatePayload(schema: PayloadSchema, payload: unknown): string[] {
  const violations: string[] = [];
  validateSchemaNode(schema, payload, '', violations);
  return violations;
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

function readJsonFile(path: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`ASM: cannot parse ${path}: ${(error as Error).message}`);
  }
  return parsed;
}

function requireObject(path: string, value: unknown, what = 'document'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ASM: ${path} ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireFields(path: string, value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (value[field] === undefined) {
      throw new Error(`ASM: ${path} is missing required field "${field}"`);
    }
  }
}

function requireString(path: string, value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`ASM: ${path} field "${field}" must be a non-empty string`);
  }
  return candidate;
}

function validateStringArray(path: string, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`ASM: ${path} field "${field}" must be an array of non-empty strings`);
  }
  return value as string[];
}

const payloadTypes = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const surfaceConfidences = new Set<SurfaceConfidence>(['verified-headless', 'verified-interactive', 'unverified']);
const surfaceDirections = new Set<SurfaceDirection>(['client-to-agent', 'agent-to-client', 'agent-local']);
const evidenceKinds = new Set<SurfaceEvidenceClaimRecord['kind']>([
  'runtime-capture',
  'binary-probe',
  'generated-schema',
  'exact-source',
  'official-doc',
  'inference',
]);
const behaviorRelationKinds = new Set<SurfaceBehaviorRelationKind>([
  'sequence',
  'conditional',
  'loop',
  'resume',
  'async',
  'concurrent',
]);

function validatePayloadSchemaNode(path: string, value: unknown, label: string, depth: number): PayloadSchemaNode {
  if (depth > 16) throw new Error(`ASM: ${path} ${label} exceeds the maximum nesting depth`);
  const schema = requireObject(path, value, label);
  if (schema.type !== undefined && (typeof schema.type !== 'string' || !payloadTypes.has(schema.type))) {
    throw new Error(`ASM: ${path} ${label} has unsupported type`);
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0 || schema.anyOf.length > 16) {
      throw new Error(`ASM: ${path} ${label}.anyOf must be an array of 1..16 schemas`);
    }
    for (const [index, branch] of schema.anyOf.entries()) {
      validatePayloadSchemaNode(path, branch, `${label}.anyOf[${index}]`, depth + 1);
    }
  }
  const required = schema.required === undefined ? [] : validateStringArray(path, schema.required, `${label}.required`);
  if (new Set(required).size !== required.length) {
    throw new Error(`ASM: ${path} ${label}.required contains duplicate fields`);
  }
  if ((required.length > 0 || schema.properties !== undefined) && schema.type !== 'object') {
    throw new Error(`ASM: ${path} ${label} with required/properties must have type "object"`);
  }
  const properties =
    schema.properties === undefined ? {} : requireObject(path, schema.properties, `${label}.properties`);
  if (Object.keys(properties).length > 256) throw new Error(`ASM: ${path} ${label} has too many properties`);
  for (const [field, rawProperty] of Object.entries(properties)) {
    validatePayloadSchemaNode(path, rawProperty, `${label}.properties[${JSON.stringify(field)}]`, depth + 1);
  }
  for (const field of required) {
    if (!Object.hasOwn(properties, field)) {
      const requiredLabel = label === 'payloadSchema' ? 'required payload field' : `${label} required field`;
      throw new Error(`ASM: ${path} ${requiredLabel} "${field}" is absent from properties`);
    }
  }
  if (schema.items !== undefined) {
    if (schema.type !== 'array') throw new Error(`ASM: ${path} ${label}.items requires type "array"`);
    validatePayloadSchemaNode(path, schema.items, `${label}.items`, depth + 1);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new Error(`ASM: ${path} ${label}.enum must be a non-empty array`);
    }
    if (
      schema.type !== undefined &&
      schema.enum.some((entry) =>
        schema.type === 'integer'
          ? typeOf(entry) !== 'number' || !Number.isInteger(entry)
          : typeOf(entry) !== schema.type,
      )
    ) {
      throw new Error(`ASM: ${path} ${label}.enum value has the wrong type`);
    }
  }
  for (const bound of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (
      schema[bound] !== undefined &&
      (!Number.isFinite(schema[bound]) || (schema.type !== 'number' && schema.type !== 'integer'))
    ) {
      throw new Error(`ASM: ${path} ${label}.${bound} requires a numeric type and a finite value`);
    }
  }
  if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number' && schema.minimum > schema.maximum) {
    throw new Error(`ASM: ${path} ${label}.minimum must not exceed maximum`);
  }
  if (
    typeof schema.exclusiveMinimum === 'number' &&
    typeof schema.exclusiveMaximum === 'number' &&
    schema.exclusiveMinimum >= schema.exclusiveMaximum
  ) {
    throw new Error(`ASM: ${path} ${label}.exclusiveMinimum must be below exclusiveMaximum`);
  }
  return schema as unknown as PayloadSchemaNode;
}

function validatePayloadSchema(path: string, value: unknown): PayloadSchema {
  const schema = validatePayloadSchemaNode(path, value, 'payloadSchema', 0);
  if (schema.type !== 'object') throw new Error(`ASM: ${path} payloadSchema.type must be "object"`);
  return schema as PayloadSchema;
}

function schemaNodesAtPath(schema: PayloadSchemaNode, dottedPath: string): PayloadSchemaNode[] {
  let current: PayloadSchemaNode[] = [schema];
  for (const component of dottedPath.split('.')) {
    const next: PayloadSchemaNode[] = [];
    const visit = (node: PayloadSchemaNode): void => {
      const property = node.properties?.[component];
      if (property !== undefined) next.push(property);
      for (const branch of node.anyOf ?? []) visit(branch);
    };
    for (const node of current) visit(node);
    current = [...new Set(next)];
  }
  return current;
}

function enumClaims(schema: PayloadSchemaNode, prefix = ''): Array<{ path: string; values: readonly unknown[] }> {
  const claims: Array<{ path: string; values: readonly unknown[] }> = [];
  if (schema.enum !== undefined && prefix) claims.push({ path: prefix, values: schema.enum });
  for (const branch of schema.anyOf ?? []) claims.push(...enumClaims(branch, prefix));
  for (const [field, child] of Object.entries(schema.properties ?? {})) {
    claims.push(...enumClaims(child, prefix ? `${prefix}.${field}` : field));
  }
  return claims;
}

function validateEventVariants(
  path: string,
  value: unknown,
  schema: PayloadSchema | undefined,
  claims: ReadonlyMap<string, SurfaceEvidenceClaimRecord>,
): SurfaceEventVariant[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error(`ASM: ${path} variants must be an array of 1..256 entries`);
  }
  const variants: SurfaceEventVariant[] = [];
  for (const [index, rawVariant] of value.entries()) {
    const variant = requireObject(path, rawVariant, `variants[${index}]`);
    requireFields(path, variant, ['match', 'evidence']);
    const match = requireObject(path, variant.match, `variants[${index}].match`);
    if (Object.keys(match).length === 0) throw new Error(`ASM: ${path} variants[${index}].match must not be empty`);
    for (const [field, expected] of Object.entries(match)) {
      if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(field)) {
        throw new Error(`ASM: ${path} variants[${index}] has invalid match path "${field}"`);
      }
      if (expected !== null && !['string', 'number', 'boolean'].includes(typeof expected)) {
        throw new Error(`ASM: ${path} variants[${index}] match "${field}" must be scalar or null`);
      }
      const nodes = schema ? schemaNodesAtPath(schema, field) : [];
      if (nodes.length === 0) {
        throw new Error(`ASM: ${path} variants[${index}] match "${field}" is absent from payloadSchema`);
      }
      const alternatives = nodes.map((node) => {
        const violations: string[] = [];
        validateSchemaNode(node, expected, field, violations);
        return violations;
      });
      if (alternatives.every((violations) => violations.length > 0)) {
        throw new Error(
          `ASM: ${path} variants[${index}] match "${field}" violates payloadSchema: ${alternatives[0]?.[0]}`,
        );
      }
    }
    const resolved = validateClaimEvidence(path, variant.evidence, `variants[${index}].evidence`, claims);
    if (variant.confidence !== undefined && variant.confidence !== resolved.confidence) {
      throw new Error(
        `ASM: ${path} variants[${index}] confidence must be computed as ${resolved.confidence}, got ${String(variant.confidence)}`,
      );
    }
    variants.push({
      match: match as SurfaceEventVariant['match'],
      evidence: resolved.evidence,
      confidence: resolved.confidence,
    });
  }
  for (const claim of enumClaims(schema ?? { type: 'object' })) {
    for (const expected of claim.values) {
      if (expected !== null && !['string', 'number', 'boolean'].includes(typeof expected)) {
        throw new Error(`ASM: ${path} enum at "${claim.path}" cannot be attributed by a scalar variant`);
      }
      if (
        !variants.some(
          (variant) => Object.hasOwn(variant.match, claim.path) && enumContains([expected], variant.match[claim.path]),
        )
      ) {
        throw new Error(
          `ASM: ${path} enum value ${JSON.stringify(expected)} at "${claim.path}" has no evidence variant`,
        );
      }
    }
  }
  return variants;
}

function optionalString(path: string, value: Record<string, unknown>, field: string): string | undefined {
  if (value[field] === undefined) return undefined;
  return requireString(path, value, field);
}

const confidenceRank: Record<SurfaceConfidence, number> = {
  unverified: 0,
  'verified-interactive': 1,
  'verified-headless': 2,
};

function confidenceAtRank(rank: number): SurfaceConfidence {
  if (rank >= confidenceRank['verified-headless']) return 'verified-headless';
  if (rank >= confidenceRank['verified-interactive']) return 'verified-interactive';
  return 'unverified';
}

function loadEvidenceIndex(
  path: string,
  vendor: string,
  vendorVersion: string,
): { index: SurfaceEvidenceIndex; claims: Map<string, SurfaceEvidenceClaimRecord> } {
  const raw = requireObject(path, readJsonFile(path));
  requireFields(path, raw, [
    'evidenceVersion',
    'vendor',
    'vendorVersion',
    'artifacts',
    'sourceReferences',
    'records',
    'claims',
  ]);
  if (raw.evidenceVersion !== 2) {
    throw new Error(`ASM: ${path} must use evidenceVersion 2 for an ASM v2 model`);
  }
  if (raw.vendor !== vendor || raw.vendorVersion !== vendorVersion) {
    throw new Error(`ASM: ${path} evidence identity does not match manifest ${vendor}@${vendorVersion}`);
  }
  if (!Array.isArray(raw.artifacts) || !Array.isArray(raw.sourceReferences) || !Array.isArray(raw.records)) {
    throw new Error(`ASM: ${path} artifacts, sourceReferences, and records must be arrays`);
  }
  const artifactIds = new Set<string>();
  for (const [index, entry] of raw.artifacts.entries()) {
    const artifact = requireObject(path, entry, `artifacts[${index}]`);
    const id = requireString(path, artifact, 'id');
    if (artifactIds.has(id)) throw new Error(`ASM: ${path} has duplicate artifact id "${id}"`);
    artifactIds.add(id);
  }
  const recordIds = new Set<string>();
  for (const [index, entry] of raw.records.entries()) {
    const record = requireObject(path, entry, `records[${index}]`);
    const id = requireString(path, record, 'id');
    if (recordIds.has(id)) throw new Error(`ASM: ${path} has duplicate record id "${id}"`);
    recordIds.add(id);
  }
  if (!Array.isArray(raw.claims) || raw.claims.length === 0) {
    throw new Error(`ASM: ${path} claims must be a non-empty array`);
  }
  const claims = new Map<string, SurfaceEvidenceClaimRecord>();
  for (const [index, entry] of raw.claims.entries()) {
    const claim = requireObject(path, entry, `claims[${index}]`);
    requireFields(path, claim, ['id', 'kind', 'confidence']);
    const id = requireString(path, claim, 'id');
    const kind = requireString(path, claim, 'kind');
    const confidence = requireString(path, claim, 'confidence');
    if (claims.has(id)) throw new Error(`ASM: ${path} has duplicate evidence claim "${id}"`);
    if (!evidenceKinds.has(kind as SurfaceEvidenceClaimRecord['kind'])) {
      throw new Error(`ASM: ${path} evidence claim "${id}" has unsupported kind "${kind}"`);
    }
    if (!surfaceConfidences.has(confidence as SurfaceConfidence)) {
      throw new Error(`ASM: ${path} evidence claim "${id}" has unsupported confidence "${confidence}"`);
    }
    const record = optionalString(path, claim, 'record');
    const artifact = optionalString(path, claim, 'artifact');
    if (record !== undefined && !recordIds.has(record)) {
      throw new Error(`ASM: ${path} evidence claim "${id}" references unknown record "${record}"`);
    }
    if (artifact !== undefined && !artifactIds.has(artifact)) {
      throw new Error(`ASM: ${path} evidence claim "${id}" references unknown artifact "${artifact}"`);
    }
    if (
      claim.sourceReference !== undefined &&
      (!Number.isInteger(claim.sourceReference) ||
        (claim.sourceReference as number) < 0 ||
        (claim.sourceReference as number) >= raw.sourceReferences.length)
    ) {
      throw new Error(`ASM: ${path} evidence claim "${id}" has an invalid sourceReference`);
    }
    if (record === undefined && claim.sourceReference === undefined && kind !== 'inference') {
      throw new Error(`ASM: ${path} evidence claim "${id}" must reference a digest-pinned record or source`);
    }
    if (kind === 'runtime-capture' || kind === 'binary-probe') {
      for (const field of ['record', 'artifact', 'platform', 'harness', 'capturedAt'] as const) {
        if (claim[field] === undefined) {
          throw new Error(`ASM: ${path} ${kind} claim "${id}" is missing "${field}"`);
        }
      }
    }
    for (const field of ['platform', 'harness', 'capturedAt', 'notes'] as const) optionalString(path, claim, field);
    if (typeof claim.capturedAt === 'string' && !Number.isFinite(Date.parse(claim.capturedAt))) {
      throw new Error(`ASM: ${path} evidence claim "${id}" capturedAt must be an ISO date or timestamp`);
    }
    claims.set(id, claim as unknown as SurfaceEvidenceClaimRecord);
  }
  return { index: raw as unknown as SurfaceEvidenceIndex, claims };
}

function validateClaimEvidence(
  path: string,
  value: unknown,
  label: string,
  claims: ReadonlyMap<string, SurfaceEvidenceClaimRecord>,
  required: readonly (keyof SurfaceClaimEvidence)[] = ['existence', 'shape'],
): { evidence: SurfaceClaimEvidence; confidence: SurfaceConfidence } {
  const evidence = requireObject(path, value, label);
  const dimensions = ['existence', 'shape', 'trigger', 'ordering', 'result', 'carrier'] as const;
  const ranks: number[] = [];
  for (const dimension of dimensions) {
    const rawRefs = evidence[dimension];
    if (rawRefs === undefined) {
      if (required.includes(dimension)) throw new Error(`ASM: ${path} ${label} is missing "${dimension}" evidence`);
      continue;
    }
    const refs = validateStringArray(path, rawRefs, `${label}.${dimension}`);
    if (refs.length === 0) throw new Error(`ASM: ${path} ${label}.${dimension} must not be empty`);
    if (new Set(refs).size !== refs.length) {
      throw new Error(`ASM: ${path} ${label}.${dimension} contains duplicate evidence references`);
    }
    const referenced = refs.map((id) => {
      const claim = claims.get(id);
      if (!claim) throw new Error(`ASM: ${path} ${label}.${dimension} references unknown evidence "${id}"`);
      return claim;
    });
    // Several independent records may support one assertion; the strongest
    // admissible one is sufficient for that assertion. Across assertions the
    // weakest result wins, so a captured existence cannot launder an inferred
    // shape into "verified".
    ranks.push(Math.max(...referenced.map((claim) => confidenceRank[claim.confidence])));
  }
  return {
    evidence: evidence as unknown as SurfaceClaimEvidence,
    confidence: confidenceAtRank(Math.min(...ranks)),
  };
}

function validateBehavior(
  path: string,
  value: unknown,
  knownEvents: ReadonlySet<string>,
  asmVersion: 1 | 2,
  evidenceClaims: ReadonlyMap<string, SurfaceEvidenceClaimRecord>,
): SurfaceBehavior {
  const behavior = requireObject(path, value);
  requireFields(path, behavior, ['behaviorVersion', 'title', 'lanes', 'nodes', 'relations']);
  if (behavior.behaviorVersion !== 1) {
    throw new Error(`ASM: ${path} has unsupported behaviorVersion ${String(behavior.behaviorVersion)}`);
  }
  requireString(path, behavior, 'title');
  optionalString(path, behavior, 'description');
  optionalString(path, behavior, 'source');

  if (!Array.isArray(behavior.lanes) || behavior.lanes.length === 0 || behavior.lanes.length > 32) {
    throw new Error(`ASM: ${path} lanes must be an array of 1..32 entries`);
  }
  const laneIds = new Set<string>();
  for (const [index, rawLane] of behavior.lanes.entries()) {
    const lane = requireObject(path, rawLane, `lanes[${index}]`);
    requireFields(path, lane, ['id', 'label']);
    const id = requireString(path, lane, 'id');
    requireString(path, lane, 'label');
    optionalString(path, lane, 'description');
    if (laneIds.has(id)) throw new Error(`ASM: ${path} has duplicate behavior lane "${id}"`);
    laneIds.add(id);
  }

  if (!Array.isArray(behavior.nodes) || behavior.nodes.length === 0 || behavior.nodes.length > 256) {
    throw new Error(`ASM: ${path} nodes must be an array of 1..256 entries`);
  }
  const nodeIds = new Set<string>();
  for (const [index, rawNode] of behavior.nodes.entries()) {
    const node = requireObject(path, rawNode, `nodes[${index}]`);
    requireFields(path, node, ['id', 'event', 'confidence', 'lane', 'order']);
    const id = requireString(path, node, 'id');
    const event = requireString(path, node, 'event');
    const confidence = requireString(path, node, 'confidence');
    const lane = requireString(path, node, 'lane');
    if (nodeIds.has(id)) throw new Error(`ASM: ${path} has duplicate behavior node "${id}"`);
    if (!knownEvents.has(event))
      throw new Error(`ASM: ${path} behavior node "${id}" references unknown event "${event}"`);
    if (!surfaceConfidences.has(confidence as SurfaceConfidence)) {
      throw new Error(`ASM: ${path} behavior node "${id}" has unsupported confidence "${confidence}"`);
    }
    if (asmVersion === 2) {
      if (node.evidence === undefined) throw new Error(`ASM: ${path} behavior node "${id}" is missing evidence`);
      const resolved = validateClaimEvidence(path, node.evidence, `behavior node "${id}" evidence`, evidenceClaims);
      if (confidence !== resolved.confidence) {
        throw new Error(
          `ASM: ${path} behavior node "${id}" confidence must be computed as ${resolved.confidence}, got ${confidence}`,
        );
      }
      node.evidence = resolved.evidence;
    }
    if (!laneIds.has(lane)) throw new Error(`ASM: ${path} behavior node "${id}" references unknown lane "${lane}"`);
    if (!Number.isInteger(node.order) || (node.order as number) < 0 || (node.order as number) > 512) {
      throw new Error(`ASM: ${path} behavior node "${id}" order must be an integer from 0 to 512`);
    }
    optionalString(path, node, 'label');
    optionalString(path, node, 'description');
    optionalString(path, node, 'source');
    if (node.match !== undefined) {
      const match = requireObject(path, node.match, `behavior node "${id}" match`);
      for (const [field, expected] of Object.entries(match)) {
        if (!field || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(field)) {
          throw new Error(`ASM: ${path} behavior node "${id}" has invalid match path "${field}"`);
        }
        if (!['string', 'number', 'boolean'].includes(typeof expected)) {
          throw new Error(`ASM: ${path} behavior node "${id}" match "${field}" must be scalar`);
        }
      }
    }
    nodeIds.add(id);
  }

  if (!Array.isArray(behavior.relations) || behavior.relations.length > 512) {
    throw new Error(`ASM: ${path} relations must be an array of at most 512 entries`);
  }
  for (const [index, rawRelation] of behavior.relations.entries()) {
    const relation = requireObject(path, rawRelation, `relations[${index}]`);
    requireFields(path, relation, ['from', 'to', 'kind', 'confidence']);
    const from = requireString(path, relation, 'from');
    const to = requireString(path, relation, 'to');
    const kind = requireString(path, relation, 'kind');
    const confidence = requireString(path, relation, 'confidence');
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      throw new Error(`ASM: ${path} behavior relation ${from} -> ${to} references an unknown node`);
    }
    if (!behaviorRelationKinds.has(kind as SurfaceBehaviorRelationKind)) {
      throw new Error(`ASM: ${path} behavior relation ${from} -> ${to} has unsupported kind "${kind}"`);
    }
    if (!surfaceConfidences.has(confidence as SurfaceConfidence)) {
      throw new Error(`ASM: ${path} behavior relation ${from} -> ${to} has unsupported confidence "${confidence}"`);
    }
    if (asmVersion === 2) {
      if (relation.evidence === undefined) {
        throw new Error(`ASM: ${path} behavior relation ${from} -> ${to} is missing evidence`);
      }
      const resolved = validateClaimEvidence(
        path,
        relation.evidence,
        `behavior relation ${from} -> ${to} evidence`,
        evidenceClaims,
        ['existence', 'shape', 'ordering'],
      );
      if (confidence !== resolved.confidence) {
        throw new Error(
          `ASM: ${path} behavior relation ${from} -> ${to} confidence must be computed as ${resolved.confidence}, got ${confidence}`,
        );
      }
      relation.evidence = resolved.evidence;
    }
    optionalString(path, relation, 'label');
    optionalString(path, relation, 'source');
  }

  return behavior as unknown as SurfaceBehavior;
}

/**
 * Event documents, with the event name each one must declare.
 *
 * The tree mirrors the vendor's own namespace: `events/thread/started.json` is
 * `thread/started`. Flat vendors are the degenerate case, so claude's
 * `events/Stop.json` is unaffected. This exists because JSON-RPC families name
 * their methods with `/` — `item/commandExecution/requestApproval` cannot be a
 * filename, and encoding the slash away would put a name in the model that the
 * vendor never uses.
 */
function eventDocumentFiles(dir: string, prefix = ''): Array<{ path: string; name: string }> {
  const found: Array<{ path: string; name: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...eventDocumentFiles(path, `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.json')) found.push({ path, name: `${prefix}${basename(entry.name, '.json')}` });
  }
  return found;
}

/** Load a model directory, including required behavior.json. Throws on malformed input. */
export function loadModel(dir: string): SurfaceModel {
  const manifestPath = join(dir, 'manifest.json');
  const manifest = requireObject(manifestPath, readJsonFile(manifestPath));
  requireFields(manifestPath, manifest, ['asmVersion', 'vendor', 'vendorVersion', 'generatedAt']);
  if (manifest.asmVersion !== 1 && manifest.asmVersion !== 2) {
    throw new Error(`ASM: ${manifestPath} has unsupported asmVersion ${String(manifest.asmVersion)}`);
  }
  const asmVersion = manifest.asmVersion;
  const vendor = requireString(manifestPath, manifest, 'vendor');
  const vendorVersion = requireString(manifestPath, manifest, 'vendorVersion');
  const generatedAt = requireString(manifestPath, manifest, 'generatedAt');
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error(`ASM: ${manifestPath} field "generatedAt" must be an ISO date or timestamp`);
  }
  if (manifest.evidence !== undefined && (typeof manifest.evidence !== 'string' || manifest.evidence.length === 0)) {
    throw new Error(`ASM: ${manifestPath} field "evidence" must be a non-empty string`);
  }
  let evidenceIndex: SurfaceEvidenceIndex | undefined;
  let evidenceClaims = new Map<string, SurfaceEvidenceClaimRecord>();
  if (asmVersion === 2) {
    if (typeof manifest.evidence !== 'string') {
      throw new Error(`ASM: ${manifestPath} ASM v2 requires an evidence index`);
    }
    const loaded = loadEvidenceIndex(join(dir, manifest.evidence), vendor, vendorVersion);
    evidenceIndex = loaded.index;
    evidenceClaims = loaded.claims;
  }

  const detectionPath = join(dir, 'detection.json');
  const detection = requireObject(detectionPath, readJsonFile(detectionPath));
  if (detection.executables !== undefined) validateStringArray(detectionPath, detection.executables, 'executables');
  for (const field of ['envVar', 'versionFlag', 'versionPattern', 'helpFlag', 'versionOutput'] as const) {
    if (detection[field] !== undefined && (typeof detection[field] !== 'string' || detection[field].length === 0)) {
      throw new Error(`ASM: ${detectionPath} field "${field}" must be a non-empty string`);
    }
  }
  for (const field of ['probedFlags', 'launchFlags'] as const) {
    if (detection[field] === undefined) continue;
    const flags = requireObject(detectionPath, detection[field], `field "${field}"`);
    for (const [name, flag] of Object.entries(flags)) {
      if (typeof flag !== 'string' || flag.length === 0) {
        throw new Error(`ASM: ${detectionPath} ${field}.${name} must be a non-empty string`);
      }
    }
  }
  if (typeof detection.versionPattern === 'string') {
    try {
      new RegExp(detection.versionPattern);
    } catch {
      throw new Error(`ASM: ${detectionPath} field "versionPattern" must be a valid regular expression`);
    }
  }

  const channelsPath = join(dir, 'channels.json');
  const channelsDocument = requireObject(channelsPath, readJsonFile(channelsPath));
  const channelRecords = requireObject(channelsPath, channelsDocument.channels, 'field "channels"');
  if (Object.keys(channelRecords).length === 0)
    throw new Error(`ASM: ${channelsPath} must declare at least one channel`);
  for (const [name, rawChannel] of Object.entries(channelRecords)) {
    const channel = requireObject(channelsPath, rawChannel, `channel "${name}"`);
    requireString(channelsPath, channel, 'kind');
  }

  const eventsDir = join(dir, 'events');
  const events: SurfaceEventFile[] = [];
  const eventNames = new Set<string>();
  for (const { path, name } of eventDocumentFiles(eventsDir)) {
    const event = requireObject(path, readJsonFile(path));
    requireFields(path, event, ['surface', 'surfaceVersion', 'event', 'channel']);
    if (asmVersion === 1) requireFields(path, event, ['confidence']);
    const surface = requireString(path, event, 'surface');
    const surfaceVersion = requireString(path, event, 'surfaceVersion');
    const eventName = requireString(path, event, 'event');
    const channel = requireString(path, event, 'channel');
    const channels = event.channels === undefined ? [channel] : validateStringArray(path, event.channels, 'channels');
    if (!channels.includes(channel)) throw new Error(`ASM: ${path} channels must include primary channel "${channel}"`);
    if (new Set(channels).size !== channels.length) throw new Error(`ASM: ${path} channels contains duplicates`);
    let confidence: SurfaceConfidence;
    const declaredEventConfidence = event.confidence;
    if (surface !== vendor || surfaceVersion !== vendorVersion) {
      throw new Error(`ASM: ${path} surface identity does not match manifest ${vendor}@${vendorVersion}`);
    }
    if (name !== eventName) {
      throw new Error(`ASM: ${path} path does not match event "${eventName}"`);
    }
    if (eventNames.has(eventName)) throw new Error(`ASM: duplicate event "${eventName}"`);
    eventNames.add(eventName);
    for (const declaredChannel of channels) {
      if (!Object.hasOwn(channelRecords, declaredChannel)) {
        throw new Error(`ASM: ${path} references unknown channel "${declaredChannel}"`);
      }
    }
    if (asmVersion === 2) {
      const direction = requireString(path, event, 'direction');
      if (!surfaceDirections.has(direction as SurfaceDirection)) {
        throw new Error(`ASM: ${path} direction must be client-to-agent|agent-to-client|agent-local`);
      }
      // Resolved after optional result/carrier schemas are known, because each
      // adds a separately required evidence dimension.
      confidence = 'unverified';
    } else {
      const declaredConfidence = requireString(path, event, 'confidence');
      if (!surfaceConfidences.has(declaredConfidence as SurfaceConfidence)) {
        throw new Error(`ASM: ${path} confidence must be verified-headless|verified-interactive|unverified`);
      }
      confidence = declaredConfidence as SurfaceConfidence;
    }
    for (const field of ['transport', 'trigger', 'firstSeen', 'lastVerified', 'fixture', 'notes'] as const) {
      if (event[field] !== undefined && (typeof event[field] !== 'string' || event[field].length === 0)) {
        throw new Error(`ASM: ${path} field "${field}" must be a non-empty string`);
      }
    }
    if (event.payloadSchema !== undefined) event.payloadSchema = validatePayloadSchema(path, event.payloadSchema);
    if (event.resultSchema !== undefined) event.resultSchema = validatePayloadSchema(path, event.resultSchema);
    if (event.recordSchema !== undefined) event.recordSchema = validatePayloadSchema(path, event.recordSchema);
    if (asmVersion === 2) {
      if (event.resultSchema !== undefined && !['jsonrpc-request', 'http'].includes(String(event.transport))) {
        throw new Error(`ASM: ${path} resultSchema is only valid for a request transport`);
      }
      if (event.recordChannel !== undefined) {
        if (event.recordSchema === undefined) throw new Error(`ASM: ${path} recordChannel requires recordSchema`);
        if (typeof event.recordChannel !== 'string' || !channels.includes(event.recordChannel)) {
          throw new Error(`ASM: ${path} recordChannel must name one of the event channels`);
        }
      } else if (event.recordSchema !== undefined && channels.length > 1) {
        throw new Error(`ASM: ${path} multi-channel recordSchema requires recordChannel`);
      }
      const requiredEvidence: (keyof SurfaceClaimEvidence)[] = ['existence', 'shape'];
      if (event.resultSchema !== undefined) requiredEvidence.push('result');
      if (event.recordSchema !== undefined) requiredEvidence.push('carrier');
      const resolvedEvidence = validateClaimEvidence(
        path,
        event.evidence,
        'event evidence',
        evidenceClaims,
        requiredEvidence,
      );
      if (typeof declaredEventConfidence === 'string' && declaredEventConfidence !== resolvedEvidence.confidence) {
        throw new Error(
          `ASM: ${path} confidence must be computed as ${resolvedEvidence.confidence}, got ${String(
            declaredEventConfidence,
          )}`,
        );
      }
      event.evidence = resolvedEvidence.evidence;
      event.confidence = resolvedEvidence.confidence;
      confidence = resolvedEvidence.confidence;
      const enums = enumClaims((event.payloadSchema as PayloadSchema | undefined) ?? { type: 'object' });
      if (enums.length > 0 && event.variants === undefined) {
        throw new Error(`ASM: ${path} payload enums require per-variant evidence`);
      }
      if (event.variants !== undefined) {
        event.variants = validateEventVariants(
          path,
          event.variants,
          event.payloadSchema as PayloadSchema | undefined,
          evidenceClaims,
        );
      }
    }
    if (event.timeoutSec !== undefined && (typeof event.timeoutSec !== 'number' || event.timeoutSec <= 0)) {
      throw new Error(`ASM: ${path} timeoutSec must be a positive number`);
    }
    if (event.matcherRequired !== undefined && typeof event.matcherRequired !== 'boolean') {
      throw new Error(`ASM: ${path} matcherRequired must be a boolean`);
    }
    if (
      asmVersion === 1 &&
      confidence !== 'unverified' &&
      (!event.fixture || !event.firstSeen || !event.lastVerified)
    ) {
      throw new Error(`ASM: ${path} verified event must cite fixture, firstSeen, and lastVerified`);
    }
    event.channels = channels;
    events.push(event as unknown as SurfaceEventFile);
  }
  if (events.length === 0) throw new Error(`ASM: ${eventsDir} contains no event documents`);
  events.sort((a, b) => a.event.localeCompare(b.event));

  const behaviorPath = join(dir, 'behavior.json');
  const behavior = validateBehavior(behaviorPath, readJsonFile(behaviorPath), eventNames, asmVersion, evidenceClaims);

  return {
    manifest: manifest as unknown as SurfaceManifest,
    detection: detection as SurfaceDetection,
    channels: channelsDocument as unknown as SurfaceChannels,
    ...(evidenceIndex === undefined ? {} : { evidenceIndex }),
    events,
    behavior,
  };
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function collectJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectJsonlFiles(path));
    } else if (entry.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Build a surface report from a captures directory (recursive, so per-run
 * subdirectories like headless/ + interactive/ all count). The event name is
 * each line's `hook_event_name`, falling back to the file basename.
 *
 * Pass the model to validate every parsed payload while it is in memory. The
 * resulting report retains only source locations and violation descriptions,
 * never captured values. Audits should always pass the model.
 */
export function buildReport(capturesDir: string, model?: SurfaceModel): SurfaceReport {
  const byEvent = new Map<string, { count: number; fields: Map<string, number> }>();
  const modeled = new Map(model?.events.map((event) => [event.event, event]) ?? []);
  const issues: SurfaceReportIssue[] = [];
  let unparsedLines = 0;

  for (const file of collectJsonlFiles(capturesDir)) {
    const fallbackName = file
      .replace(/\\/g, '/')
      .split('/')
      .pop()!
      .replace(/\.jsonl$/, '');
    let lineNumber = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        unparsedLines += 1;
        issues.push({
          kind: 'invalid-json',
          file: relative(capturesDir, file),
          line: lineNumber,
          message: `invalid JSON: ${(error as Error).message}`,
        });
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        unparsedLines += 1;
        issues.push({
          kind: 'invalid-envelope',
          file: relative(capturesDir, file),
          line: lineNumber,
          message: `capture payload is ${typeOf(parsed)}, expected object`,
        });
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (
        Object.hasOwn(record, 'hook_event_name') &&
        (typeof record.hook_event_name !== 'string' || record.hook_event_name.length === 0)
      ) {
        issues.push({
          kind: 'invalid-envelope',
          file: relative(capturesDir, file),
          line: lineNumber,
          message: 'hook_event_name must be a non-empty string when present',
        });
      }
      const name =
        typeof record.hook_event_name === 'string' && record.hook_event_name.length > 0
          ? record.hook_event_name
          : fallbackName;
      if (name !== fallbackName) {
        issues.push({
          kind: 'invalid-envelope',
          file: relative(capturesDir, file),
          line: lineNumber,
          event: name,
          message: `hook_event_name does not match fixture filename "${fallbackName}"`,
        });
      }
      const schema = modeled.get(name)?.payloadSchema;
      if (schema) {
        for (const violation of validatePayload(schema, record)) {
          issues.push({
            kind: 'schema-mismatch',
            file: relative(capturesDir, file),
            line: lineNumber,
            event: name,
            message: violation,
          });
        }
      }
      let entry = byEvent.get(name);
      if (!entry) {
        entry = { count: 0, fields: new Map() };
        byEvent.set(name, entry);
      }
      entry.count += 1;
      for (const field of Object.keys(record)) {
        entry.fields.set(field, (entry.fields.get(field) ?? 0) + 1);
      }
    }
  }

  const events: SurfaceReportEvent[] = [...byEvent.entries()]
    .map(([event, entry]) => ({
      event,
      count: entry.count,
      fields: Object.fromEntries([...entry.fields.entries()].sort(([a], [b]) => a.localeCompare(b))),
    }))
    .sort((a, b) => a.event.localeCompare(b.event));

  return {
    capturesDir,
    generatedAt: new Date().toISOString(),
    events,
    unparsedLines,
    issues,
    ...(model
      ? { validatedAgainst: { vendor: model.manifest.vendor, vendorVersion: model.manifest.vendorVersion } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Diff — the drift equation (docs/archive/EMULATOR.md §7)
// ---------------------------------------------------------------------------

/**
 * Diff a model against a captures report. A clean result (no entries) means
 * the model exactly covers the captures. Drift kinds:
 * - observed-unmodeled: captures contain an event the model doesn't know
 * - unobserved-verified: a non-'unverified' model event never appears in captures
 * - schema-mismatch: a model-required field is missing from some captured lines
 * - unmodeled-field: captures carry a top-level field the schema doesn't list
 */
export function diffModelVsReport(model: SurfaceModel, report: SurfaceReport): DriftEntry[] {
  const drift: DriftEntry[] = [];
  const modeled = new Map(model.events.map((event) => [event.event, event]));
  const observed = new Map(report.events.map((event) => [event.event, event]));

  if (
    report.validatedAgainst &&
    (report.validatedAgainst.vendor !== model.manifest.vendor ||
      report.validatedAgainst.vendorVersion !== model.manifest.vendorVersion)
  ) {
    drift.push({
      kind: 'invalid-capture',
      event: '(captures)',
      message:
        `report was validated against ${report.validatedAgainst.vendor}@${report.validatedAgainst.vendorVersion}, ` +
        `not ${model.manifest.vendor}@${model.manifest.vendorVersion}`,
    });
  }

  const issueCounts = new Map<string, { issue: SurfaceReportIssue; count: number }>();
  for (const issue of report.issues ?? []) {
    const key = `${issue.kind}\0${issue.event ?? ''}\0${issue.message}`;
    const existing = issueCounts.get(key);
    if (existing) existing.count += 1;
    else issueCounts.set(key, { issue, count: 1 });
  }
  if (
    report.unparsedLines > 0 &&
    !(report.issues ?? []).some((issue) => issue.kind === 'invalid-json' || issue.kind === 'invalid-envelope')
  ) {
    drift.push({
      kind: 'invalid-capture',
      event: '(captures)',
      message: `${report.unparsedLines} capture line(s) could not be parsed as JSON objects`,
    });
  }
  for (const { issue, count } of issueCounts.values()) {
    drift.push({
      kind: issue.kind === 'schema-mismatch' ? 'schema-mismatch' : 'invalid-capture',
      event: issue.event ?? '(captures)',
      message: `${issue.message} (${count} occurrence${count === 1 ? '' : 's'}; first at ${issue.file}:${issue.line})`,
    });
  }

  for (const reportEvent of report.events) {
    if (!modeled.has(reportEvent.event)) {
      drift.push({
        kind: 'observed-unmodeled',
        event: reportEvent.event,
        message: `captures contain ${reportEvent.count} line(s) of unmodeled event "${reportEvent.event}"`,
      });
    }
  }

  for (const modelEvent of model.events) {
    const reportEvent = observed.get(modelEvent.event);
    if (!reportEvent) {
      if (modelEvent.confidence !== 'unverified') {
        drift.push({
          kind: 'unobserved-verified',
          event: modelEvent.event,
          message: `model event "${modelEvent.event}" (confidence ${modelEvent.confidence}) has no captures`,
        });
      }
      continue;
    }
    const schema = modelEvent.payloadSchema;
    if (!schema) continue;
    // Reports built without a model retain the legacy presence audit. A
    // model-validated report already contains line-specific violations above.
    if (!report.validatedAgainst) {
      for (const field of schema.required ?? []) {
        const present = reportEvent.fields[field] ?? 0;
        if (present < reportEvent.count) {
          drift.push({
            kind: 'schema-mismatch',
            event: modelEvent.event,
            message: `required field "${field}" present on ${present}/${reportEvent.count} captured line(s)`,
          });
        }
      }
    }
    const properties = schema.properties ?? {};
    for (const field of Object.keys(reportEvent.fields)) {
      if (!(field in properties)) {
        drift.push({
          kind: 'unmodeled-field',
          event: modelEvent.event,
          message: `captured field "${field}" is not in the model's payloadSchema.properties`,
        });
      }
    }
  }

  return drift;
}
