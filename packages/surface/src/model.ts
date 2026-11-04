/**
 * Agent Surface Model (ASM) runtime — validate, load, report, diff
 * (docs/archive/EMULATOR.md §2, §7).
 *
 * This module is SELF-CONTAINED by design: no relative imports, erasable
 * syntax only. Surface-owned audit scripts and adapter projection generators
 * import it as `@vibefield/puppeteer-surface`, which node (≥22.18, type
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
  /** v2 adds claim evidence; v3 makes schema fidelity explicit. Historical versions stay readable. */
  asmVersion: 1 | 2 | 3;
  vendor: string;
  vendorVersion: string;
  generatedAt: string;
  /** Where the captures came from, e.g. "phase-0 + M1 censuses". */
  source?: string;
  /** Model-relative machine-readable provenance index. */
  evidence?: string;
}

/** ASM versions whose native claims must be backed by evidenceVersion 2. */
export const CLAIM_ADDRESSABLE_ASM_VERSIONS = [2, 3] as const;

export function isClaimAddressableAsmVersion(value: unknown): value is 2 | 3 {
  return value === 2 || value === 3;
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
 * Recursive JSON Schema representation used by the ground-truth layer.
 *
 * ACP-style agents put their meaningful discriminants below `params.update`,
 * while hook-style agents mostly use a flat envelope. A top-level-only schema
 * therefore validates one family and merely type-checks the carrier object for
 * the other. Recursion makes both families equally useful as drift/conformance
 * gates. Validation-bearing and annotation keywords outside the statically
 * typed vocabulary are retained through the index signature below so schema
 * ingestion never becomes a silent lossy projection.
 */
export type PayloadSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/**
 * JSON Schema as retained by Surface.
 *
 * Layer 0 is an evidence record, not merely the implementation detail of our
 * lightweight fixture validator.  Keep the validation-bearing keywords that
 * upstream generated schemas use, even when validatePayload only needs a
 * subset for a particular capture.  Unknown annotation/vocabulary keywords
 * are also retained so a newer vendor schema cannot silently lose truth while
 * passing through an older Puppeteer release.
 */
export interface PayloadSchemaNode {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, PayloadSchemaNode>;
  definitions?: Record<string, PayloadSchemaNode>;
  type?: PayloadSchemaType | readonly PayloadSchemaType[];
  const?: unknown;
  /** At least one branch must validate. Common constraints on this node still apply. */
  anyOf?: readonly PayloadSchemaNode[];
  /** Exactly one branch must validate. */
  oneOf?: readonly PayloadSchemaNode[];
  /** Every branch must validate. */
  allOf?: readonly PayloadSchemaNode[];
  not?: PayloadSchemaNode;
  if?: PayloadSchemaNode;
  then?: PayloadSchemaNode;
  else?: PayloadSchemaNode;
  enum?: readonly unknown[];
  required?: string[];
  properties?: Record<string, PayloadSchemaNode>;
  patternProperties?: Record<string, PayloadSchemaNode>;
  additionalProperties?: boolean | PayloadSchemaNode;
  dependentRequired?: Record<string, readonly string[]>;
  propertyNames?: PayloadSchemaNode;
  minProperties?: number;
  maxProperties?: number;
  items?: PayloadSchemaNode | readonly PayloadSchemaNode[];
  prefixItems?: readonly PayloadSchemaNode[];
  contains?: PayloadSchemaNode;
  minContains?: number;
  maxContains?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: readonly unknown[];
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  /** A string's encoded content: its media type, transfer encoding, and the schema of its decoded document. */
  contentMediaType?: string;
  contentEncoding?: string;
  contentSchema?: PayloadSchemaNode;
  /** Preserve newer JSON-Schema vocabulary instead of silently discarding it. */
  [keyword: string]: unknown;
}

/** Backward-compatible name used by existing model generators. */
export interface PayloadSchemaProperty extends PayloadSchemaNode {}

/** A native event payload can be an object, scalar, array, union, or root reference. */
export interface PayloadSchema extends PayloadSchemaNode {}

export type SurfaceSchemaFidelity = 'exact' | 'semantic' | 'structural' | 'sampled' | 'unknown';

export interface SurfaceSchemaFidelityRecord {
  payload?: SurfaceSchemaFidelity;
  result?: SurfaceSchemaFidelity;
  carrier?: SurfaceSchemaFidelity;
  /** Required whenever a declared schema is known to omit native contract detail. */
  limitations?: readonly string[];
}

function jsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function decodeJsonPointerToken(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveLocalSchemaReference(root: unknown, reference: string): unknown {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return undefined;
  let current = root;
  for (const raw of reference.slice(2).split('/')) {
    const component = decodeJsonPointerToken(raw);
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[component];
  }
  return current;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, cloneJsonValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Retain one vendor JSON-Schema node without copying its entire root bundle.
 * Reachable local references are closed over into `$defs`; validation-bearing
 * and annotation keywords are otherwise preserved verbatim. This is the
 * shared ingestion path for generated vendor contracts and deliberately does
 * not derive anything from an adapter.
 */
export function projectJsonSchema(value: unknown, root: unknown = value): PayloadSchemaNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};

  const referenceNames = new Map<string, string>();
  const claimedNames = new Set<string>();
  const pendingReferences: string[] = [];
  const definitions: Record<string, PayloadSchemaNode> = {};

  const nameForReference = (reference: string): string => {
    const known = referenceNames.get(reference);
    if (known) return known;
    const components = reference.split('/');
    const rawBase = decodeJsonPointerToken(components.at(-1) || 'schema').replace(/[^A-Za-z0-9_.-]+/g, '_');
    const base = rawBase || 'schema';
    let name = base;
    for (let suffix = 2; claimedNames.has(name); suffix += 1) name = `${base}_${suffix}`;
    referenceNames.set(reference, name);
    claimedNames.add(name);
    pendingReferences.push(reference);
    return name;
  };

  const schemaMapKeywords = new Set(['properties', 'patternProperties']);
  const schemaArrayKeywords = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
  // `contentSchema` describes a string's decoded content (an encoded JSON
  // payload), so its references are closed over like any other subschema's.
  const schemaKeywords = new Set([
    'not',
    'if',
    'then',
    'else',
    'additionalProperties',
    'propertyNames',
    'contains',
    'contentSchema',
  ]);

  const visit = (raw: unknown): PayloadSchemaNode => {
    if (raw === true) return {};
    if (raw === false) return { not: {} };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const source = raw as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      // Definitions are closed over from actual `$ref` use below. Copying a
      // vendor's whole protocol bundle into every event both obscures the
      // contract and multiplies canonical files by hundreds of megabytes.
      if (key === '$defs' || key === 'definitions') continue;
      if (key === '$ref' && typeof child === 'string') {
        if (child.startsWith('#')) {
          const target = resolveLocalSchemaReference(root, child);
          if (target !== undefined) {
            projected.$ref = `#/$defs/${jsonPointerToken(nameForReference(child))}`;
            continue;
          }
        }
        projected.$ref = child;
        continue;
      }
      if (schemaMapKeywords.has(key) && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        projected[key] = Object.fromEntries(
          Object.keys(child as Record<string, unknown>)
            .sort()
            .map((name) => [name, visit((child as Record<string, unknown>)[name])]),
        );
        continue;
      }
      if (schemaArrayKeywords.has(key) && Array.isArray(child)) {
        projected[key] = child.map(visit);
        continue;
      }
      if (key === 'items') {
        projected.items = Array.isArray(child) ? child.map(visit) : visit(child);
        continue;
      }
      if (schemaKeywords.has(key) && child !== undefined) {
        projected[key] = typeof child === 'boolean' ? child : visit(child);
        continue;
      }
      projected[key] = cloneJsonValue(child);
    }
    return projected as PayloadSchemaNode;
  };

  const projected = visit(value);
  for (let index = 0; index < pendingReferences.length; index += 1) {
    const reference = pendingReferences[index]!;
    const target = resolveLocalSchemaReference(root, reference);
    if (target !== undefined) definitions[referenceNames.get(reference)!] = visit(target);
  }
  if (Object.keys(definitions).length > 0) projected.$defs = definitions;
  if (projected.$schema === undefined) {
    const dialect = (root as Record<string, unknown> | null)?.$schema;
    if (typeof dialect === 'string') projected.$schema = dialect;
  }
  return projected;
}

/** The cross-vendor evidence ladder defined by the ASM contract. */
export type SurfaceConfidence = 'verified-headless' | 'verified-interactive' | 'unverified';

export type SurfaceDirection = 'client-to-agent' | 'agent-to-client' | 'agent-local';

/**
 * Whether installing an observer preserves native behavior and whether it needs a native matcher.
 * `timeout-blocks` preserves native behavior only while the observer answers before its timeout:
 * a missed deadline blocks the native action, so it is never safe to register as a default observer.
 */
export type SurfaceObservationMode = 'passive' | 'matcher-required' | 'response-required' | 'timeout-blocks';

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

/** Provenance retained by readable ASM v1 baselines without claim-addressable evidence. */
export interface SurfaceLegacyEvidenceIndex {
  evidenceVersion: 1;
  vendor: string;
  vendorVersion: string;
  artifacts: Array<{ id: string; [extra: string]: unknown }>;
  sourceReferences: Array<Record<string, unknown>>;
  records: Array<{ id: string; [extra: string]: unknown }>;
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

/** Evidence-bound schema that sharpens one nested payload path, optionally for a discriminated branch. */
export interface SurfacePayloadRefinement {
  /** Native dotted payload paths and exact values selecting this refinement. Omit when unconditional. */
  match?: Record<string, string | number | boolean | null>;
  /** Native dotted payload path whose value is described by `schema`. */
  path: string;
  schema: PayloadSchema;
  evidence: SurfaceClaimEvidence;
  /** Computed by the loader from evidence records; declarations must agree. */
  confidence: SurfaceConfidence;
  fidelity: SurfaceSchemaFidelity;
  limitations?: readonly string[];
}

export interface SurfaceEventFile {
  surface: string;
  surfaceVersion: string;
  /** Exact vendor wire name when `event` is a collision-safe ASM identity. */
  nativeName?: string;
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
  /** Runtime/behavior evidence for explicitly selected native discriminants. */
  variants?: SurfaceEventVariant[];
  /** Conditional or observed nested schemas that are more precise than the legal base payload schema. */
  payloadRefinements?: SurfacePayloadRefinement[];
  /**
   * Native paths whose complete scalar enum inventory is intentionally treated
   * as a set of runtime/behavior variants. Enums elsewhere remain schema facts
   * and do not require one runtime observation per legal value.
   */
  variantDiscriminants?: readonly string[];
  /** How faithfully each retained schema represents its native source. */
  schemaFidelity?: SurfaceSchemaFidelityRecord;
  confidence: SurfaceConfidence;
  /** Hook timeout written into generated settings (claude registry parity). */
  timeoutSec?: number;
  /** Native registration semantics; callback shape alone does not say whether an empty response is safe. */
  observationMode?: SurfaceObservationMode;
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
  /** Preserved in canonical documents for legacy ASM v1 models. */
  legacyEvidenceIndex?: SurfaceLegacyEvidenceIndex;
  /** Sorted by event name for deterministic output. */
  events: SurfaceEventFile[];
  /** Versioned, vendor-native event topology rendered by Imposter Control. */
  behavior: SurfaceBehavior;
}

/** One agent's canonical runtime snapshot; the manifest identifies its active vendor version. */
export interface SurfaceGroundTruth extends SurfaceModel {
  format: 'puppeteer-groundtruth/1';
}

export const SURFACE_GROUND_TRUTH_FORMAT = 'puppeteer-groundtruth/1' as const;

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

function validateSchemaNode(
  schema: PayloadSchemaNode,
  value: unknown,
  path: string,
  violations: string[],
  root: PayloadSchemaNode = schema,
  depth = 0,
  allowRedactedPlaceholders = false,
): void {
  const label = path.length === 0 ? 'payload' : `field "${path}"`;
  if (depth > 128) {
    violations.push(`${label} exceeds recursive schema validation depth`);
    return;
  }
  if (schema.$ref !== undefined) {
    const target = resolveLocalSchemaReference(root, schema.$ref);
    if (target === undefined || target === null || typeof target !== 'object' || Array.isArray(target)) {
      if (schema.$ref.startsWith('#')) violations.push(`${label} uses unresolved schema reference ${schema.$ref}`);
    } else {
      validateSchemaNode(
        target as PayloadSchemaNode,
        value,
        path,
        violations,
        root,
        depth + 1,
        allowRedactedPlaceholders,
      );
    }
  }
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = expected.some((type) =>
      type === 'integer' ? actual === 'number' && Number.isInteger(value) : actual === type,
    );
    if (!matches) {
      violations.push(`${label} is ${actual}, expected ${expected.join('|')}`);
      return;
    }
  }
  // Sanitized evidence may intentionally replace a sensitive string while
  // preserving its JSON type. It cannot prove enum/pattern/length assertions,
  // but it must not make an otherwise shape-faithful carrier invalid either.
  // That covers both a `<redacted…>` placeholder and the stable `anon-<16 hex>`
  // pseudonym the sanitizer gives id-keyed values (for example a `modelId`).
  const redactedString =
    allowRedactedPlaceholders &&
    typeof value === 'string' &&
    /^(?:<redacted(?::[^>\r\n]+)?>|anon-[a-f0-9]{16})$/.test(value);
  if (redactedString) return;
  if (schema.const !== undefined && !enumContains([schema.const], value)) {
    violations.push(`${label} does not equal const`);
  }
  if (schema.anyOf !== undefined) {
    const alternatives = schema.anyOf.map((branch) => {
      const branchViolations: string[] = [];
      validateSchemaNode(branch, value, path, branchViolations, root, depth + 1, allowRedactedPlaceholders);
      return branchViolations;
    });
    if (alternatives.every((branch) => branch.length > 0)) {
      violations.push(`${label} does not satisfy anyOf`);
    }
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => {
      const branchViolations: string[] = [];
      validateSchemaNode(branch, value, path, branchViolations, root, depth + 1, allowRedactedPlaceholders);
      return branchViolations.length === 0;
    }).length;
    if (matches !== 1) violations.push(`${label} satisfies ${matches} oneOf branches, expected exactly one`);
  }
  for (const branch of schema.allOf ?? []) {
    validateSchemaNode(branch, value, path, violations, root, depth + 1, allowRedactedPlaceholders);
  }
  if (schema.not !== undefined) {
    const branchViolations: string[] = [];
    validateSchemaNode(schema.not, value, path, branchViolations, root, depth + 1, allowRedactedPlaceholders);
    if (branchViolations.length === 0) violations.push(`${label} satisfies forbidden schema`);
  }
  if (schema.if !== undefined) {
    const conditionViolations: string[] = [];
    validateSchemaNode(schema.if, value, path, conditionViolations, root, depth + 1, allowRedactedPlaceholders);
    const branch = conditionViolations.length === 0 ? schema.then : schema.else;
    if (branch !== undefined)
      validateSchemaNode(branch, value, path, violations, root, depth + 1, allowRedactedPlaceholders);
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
    if (schema.multipleOf !== undefined) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient))) {
        violations.push(`${label} is not a multiple of ${schema.multipleOf}`);
      }
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      violations.push(`${label} is shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
      violations.push(`${label} is longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      violations.push(`${label} does not match pattern ${schema.pattern}`);
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const names = Object.keys(record);
    if (schema.minProperties !== undefined && names.length < schema.minProperties) {
      violations.push(`${label} has fewer than ${schema.minProperties} properties`);
    }
    if (schema.maxProperties !== undefined && names.length > schema.maxProperties) {
      violations.push(`${label} has more than ${schema.maxProperties} properties`);
    }
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(record, field)) {
        violations.push(`missing required field "${path.length === 0 ? field : `${path}.${field}`}"`);
      }
    }
    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(record, field)) {
        validateSchemaNode(
          property,
          record[field],
          path.length === 0 ? field : `${path}.${field}`,
          violations,
          root,
          depth + 1,
          allowRedactedPlaceholders,
        );
      }
    }
    const patterns = Object.entries(schema.patternProperties ?? {}).map(
      ([pattern, child]) => [new RegExp(pattern, 'u'), child] as const,
    );
    for (const field of names) {
      const matchingPatterns = patterns.filter(([pattern]) => pattern.test(field));
      for (const [, child] of matchingPatterns) {
        validateSchemaNode(
          child,
          record[field],
          path.length === 0 ? field : `${path}.${field}`,
          violations,
          root,
          depth + 1,
          allowRedactedPlaceholders,
        );
      }
      if (Object.hasOwn(schema.properties ?? {}, field) || matchingPatterns.length > 0) continue;
      if (schema.additionalProperties === false) {
        violations.push(`${label} has unsupported property "${field}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateSchemaNode(
          schema.additionalProperties,
          record[field],
          path.length === 0 ? field : `${path}.${field}`,
          violations,
          root,
          depth + 1,
          allowRedactedPlaceholders,
        );
      }
    }
    for (const [field, dependencies] of Object.entries(schema.dependentRequired ?? {})) {
      if (!Object.hasOwn(record, field)) continue;
      for (const dependency of dependencies) {
        if (!Object.hasOwn(record, dependency)) {
          violations.push(`field "${path.length === 0 ? field : `${path}.${field}`}" requires "${dependency}"`);
        }
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const field of names)
        validateSchemaNode(
          schema.propertyNames,
          field,
          `${path}{key}`,
          violations,
          root,
          depth + 1,
          allowRedactedPlaceholders,
        );
    }
  } else if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      violations.push(`${label} has fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      violations.push(`${label} has more than ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const encoded = value.map((entry) => JSON.stringify(entry));
      if (new Set(encoded).size !== encoded.length) violations.push(`${label} has duplicate items`);
    }
    const prefix = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : []);
    prefix.forEach((child, index) => {
      if (index < value.length)
        validateSchemaNode(
          child,
          value[index],
          `${path}[${index}]`,
          violations,
          root,
          depth + 1,
          allowRedactedPlaceholders,
        );
    });
    if (schema.items !== undefined && !Array.isArray(schema.items)) {
      const start = schema.prefixItems?.length ?? 0;
      value
        .slice(start)
        .forEach((entry, offset) =>
          validateSchemaNode(
            schema.items as PayloadSchemaNode,
            entry,
            `${path}[${start + offset}]`,
            violations,
            root,
            depth + 1,
            allowRedactedPlaceholders,
          ),
        );
    }
    if (schema.contains !== undefined) {
      const matches = value.filter((entry, index) => {
        const childViolations: string[] = [];
        validateSchemaNode(
          schema.contains!,
          entry,
          `${path}[${index}]`,
          childViolations,
          root,
          depth + 1,
          allowRedactedPlaceholders,
        );
        return childViolations.length === 0;
      }).length;
      const minimum = schema.minContains ?? 1;
      if (matches < minimum) violations.push(`${label} has fewer than ${minimum} matching items`);
      if (schema.maxContains !== undefined && matches > schema.maxContains) {
        violations.push(`${label} has more than ${schema.maxContains} matching items`);
      }
    }
  }
}

/** Validate a captured payload against the recursive subset schema. */
export function validatePayload(schema: PayloadSchema, payload: unknown): string[] {
  const violations: string[] = [];
  validateSchemaNode(schema, payload, '', violations);
  return violations;
}

/** Validate privacy-sanitized evidence without treating redaction tokens as native enum values. */
export function validateSanitizedPayload(schema: PayloadSchema, payload: unknown): string[] {
  const violations: string[] = [];
  validateSchemaNode(schema, payload, '', violations, schema, 0, true);
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
const schemaFidelities = new Set<SurfaceSchemaFidelity>(['exact', 'semantic', 'structural', 'sampled', 'unknown']);
const surfaceDirections = new Set<SurfaceDirection>(['client-to-agent', 'agent-to-client', 'agent-local']);
const surfaceObservationModes = new Set<SurfaceObservationMode>([
  'passive',
  'matcher-required',
  'response-required',
  'timeout-blocks',
]);
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
  if (depth > 64) throw new Error(`ASM: ${path} ${label} exceeds the maximum nesting depth`);
  const schema = requireObject(path, value, label);
  const declaredTypes = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    declaredTypes.some((type) => typeof type !== 'string' || !payloadTypes.has(type)) ||
    new Set(declaredTypes).size !== declaredTypes.length
  ) {
    throw new Error(`ASM: ${path} ${label} has unsupported or duplicate type`);
  }
  if (schema.$ref !== undefined && (typeof schema.$ref !== 'string' || schema.$ref.length === 0)) {
    throw new Error(`ASM: ${path} ${label}.$ref must be a non-empty string`);
  }
  for (const union of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (schema[union] !== undefined) {
      if (!Array.isArray(schema[union]) || schema[union].length === 0 || schema[union].length > 256) {
        throw new Error(`ASM: ${path} ${label}.${union} must be an array of 1..256 schemas`);
      }
      for (const [index, branch] of schema[union].entries()) {
        validatePayloadSchemaNode(path, branch, `${label}.${union}[${index}]`, depth + 1);
      }
    }
  }
  for (const keyword of ['not', 'if', 'then', 'else', 'propertyNames', 'contains', 'contentSchema'] as const) {
    if (schema[keyword] !== undefined) {
      validatePayloadSchemaNode(path, schema[keyword], `${label}.${keyword}`, depth + 1);
    }
  }
  const required = schema.required === undefined ? [] : validateStringArray(path, schema.required, `${label}.required`);
  if (new Set(required).size !== required.length) {
    throw new Error(`ASM: ${path} ${label}.required contains duplicate fields`);
  }
  if (required.length > 0 || schema.properties !== undefined) {
    if (declaredTypes.length > 0 && !declaredTypes.includes('object')) {
      throw new Error(`ASM: ${path} ${label} with required/properties must allow type "object"`);
    }
  }
  const properties =
    schema.properties === undefined ? {} : requireObject(path, schema.properties, `${label}.properties`);
  if (Object.keys(properties).length > 2_048) throw new Error(`ASM: ${path} ${label} has too many properties`);
  for (const [field, rawProperty] of Object.entries(properties)) {
    validatePayloadSchemaNode(path, rawProperty, `${label}.properties[${JSON.stringify(field)}]`, depth + 1);
  }
  for (const field of required) {
    if (!Object.hasOwn(properties, field)) {
      const requiredLabel = label === 'payloadSchema' ? 'required payload field' : `${label} required field`;
      throw new Error(`ASM: ${path} ${requiredLabel} "${field}" is absent from properties`);
    }
  }
  for (const keyword of ['$defs', 'definitions', 'patternProperties'] as const) {
    if (schema[keyword] === undefined) continue;
    const entries = requireObject(path, schema[keyword], `${label}.${keyword}`);
    for (const [name, child] of Object.entries(entries)) {
      if (keyword === 'patternProperties') {
        try {
          new RegExp(name, 'u');
        } catch {
          throw new Error(`ASM: ${path} ${label}.patternProperties has invalid pattern ${JSON.stringify(name)}`);
        }
      }
      validatePayloadSchemaNode(path, child, `${label}.${keyword}[${JSON.stringify(name)}]`, depth + 1);
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    validatePayloadSchemaNode(path, schema.additionalProperties, `${label}.additionalProperties`, depth + 1);
  }
  if (schema.items !== undefined) {
    if (declaredTypes.length > 0 && !declaredTypes.includes('array')) {
      throw new Error(`ASM: ${path} ${label}.items requires an array-compatible type`);
    }
    if (Array.isArray(schema.items)) {
      for (const [index, child] of schema.items.entries()) {
        validatePayloadSchemaNode(path, child, `${label}.items[${index}]`, depth + 1);
      }
    } else {
      validatePayloadSchemaNode(path, schema.items, `${label}.items`, depth + 1);
    }
  }
  if (schema.prefixItems !== undefined) {
    if (!Array.isArray(schema.prefixItems)) throw new Error(`ASM: ${path} ${label}.prefixItems must be an array`);
    for (const [index, child] of schema.prefixItems.entries()) {
      validatePayloadSchemaNode(path, child, `${label}.prefixItems[${index}]`, depth + 1);
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new Error(`ASM: ${path} ${label}.enum must be a non-empty array`);
    }
    if (
      declaredTypes.length > 0 &&
      schema.enum.some(
        (entry) =>
          !declaredTypes.some((type) =>
            type === 'integer' ? typeOf(entry) === 'number' && Number.isInteger(entry) : typeOf(entry) === type,
          ),
      )
    ) {
      throw new Error(`ASM: ${path} ${label}.enum value has the wrong type`);
    }
  }
  if (
    schema.const !== undefined &&
    declaredTypes.length > 0 &&
    !declaredTypes.some((type) =>
      type === 'integer'
        ? typeOf(schema.const) === 'number' && Number.isInteger(schema.const)
        : typeOf(schema.const) === type,
    )
  ) {
    throw new Error(`ASM: ${path} ${label}.const has the wrong type`);
  }
  for (const bound of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (
      schema[bound] !== undefined &&
      (!Number.isFinite(schema[bound]) ||
        (declaredTypes.length > 0 && !declaredTypes.includes('number') && !declaredTypes.includes('integer')))
    ) {
      throw new Error(`ASM: ${path} ${label}.${bound} requires a numeric type and a finite value`);
    }
  }
  if (
    schema.multipleOf !== undefined &&
    (typeof schema.multipleOf !== 'number' || !Number.isFinite(schema.multipleOf) || schema.multipleOf <= 0)
  ) {
    throw new Error(`ASM: ${path} ${label}.multipleOf must be a positive finite number`);
  }
  for (const bound of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minContains',
    'maxContains',
    'minProperties',
    'maxProperties',
  ] as const) {
    const value = schema[bound];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
      throw new Error(`ASM: ${path} ${label}.${bound} must be a non-negative integer`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') throw new Error(`ASM: ${path} ${label}.pattern must be a string`);
    try {
      new RegExp(schema.pattern, 'u');
    } catch {
      throw new Error(`ASM: ${path} ${label}.pattern must be a valid regular expression`);
    }
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
    throw new Error(`ASM: ${path} ${label}.uniqueItems must be a boolean`);
  }
  if (schema.dependentRequired !== undefined) {
    const dependencies = requireObject(path, schema.dependentRequired, `${label}.dependentRequired`);
    for (const [field, names] of Object.entries(dependencies)) {
      validateStringArray(path, names, `${label}.dependentRequired[${JSON.stringify(field)}]`);
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
  const visited = new Set<PayloadSchemaNode>();
  const inspectReferences = (node: PayloadSchemaNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.$ref?.startsWith('#') && resolveLocalSchemaReference(schema, node.$ref) === undefined) {
      throw new Error(`ASM: ${path} payloadSchema has unresolved local reference ${node.$ref}`);
    }
    for (const child of Object.values(node.properties ?? {})) inspectReferences(child);
    for (const child of Object.values(node.patternProperties ?? {})) inspectReferences(child);
    for (const child of Object.values(node.$defs ?? {})) inspectReferences(child);
    for (const child of Object.values(node.definitions ?? {})) inspectReferences(child);
    for (const union of [node.anyOf, node.oneOf, node.allOf, node.prefixItems]) {
      for (const child of union ?? []) inspectReferences(child);
    }
    if (Array.isArray(node.items)) {
      for (const child of node.items) inspectReferences(child);
    } else if (node.items) inspectReferences(node.items as PayloadSchemaNode);
    for (const child of [
      node.not,
      node.if,
      node.then,
      node.else,
      node.propertyNames,
      node.contains,
      node.contentSchema,
    ]) {
      if (child) inspectReferences(child);
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      inspectReferences(node.additionalProperties);
    }
  };
  inspectReferences(schema);
  return schema as PayloadSchema;
}

function schemaNodesAtPath(schema: PayloadSchemaNode, dottedPath: string): PayloadSchemaNode[] {
  let current: PayloadSchemaNode[] = [schema];
  for (const component of dottedPath.split('.')) {
    const next: PayloadSchemaNode[] = [];
    const visited = new Set<PayloadSchemaNode>();
    const visit = (node: PayloadSchemaNode): void => {
      if (visited.has(node)) return;
      visited.add(node);
      if (node.$ref?.startsWith('#')) {
        const target = resolveLocalSchemaReference(schema, node.$ref);
        if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
          visit(target as PayloadSchemaNode);
        }
      }
      const property = node.properties?.[component];
      if (property !== undefined) next.push(property);
      for (const branch of node.anyOf ?? []) visit(branch);
      for (const branch of node.oneOf ?? []) visit(branch);
      for (const branch of node.allOf ?? []) visit(branch);
    };
    for (const node of current) visit(node);
    current = [...new Set(next)];
  }
  return current;
}

function enumValuesAtPath(schema: PayloadSchemaNode, dottedPath: string): readonly unknown[] {
  const values: unknown[] = [];
  const visited = new Set<PayloadSchemaNode>();
  const visit = (node: PayloadSchemaNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.enum !== undefined) values.push(...node.enum);
    if (node.const !== undefined) values.push(node.const);
    if (node.$ref?.startsWith('#')) {
      const target = resolveLocalSchemaReference(schema, node.$ref);
      if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
        visit(target as PayloadSchemaNode);
      }
    }
    for (const branch of node.anyOf ?? []) visit(branch);
    for (const branch of node.oneOf ?? []) visit(branch);
    for (const branch of node.allOf ?? []) visit(branch);
  };
  for (const node of schemaNodesAtPath(schema, dottedPath)) visit(node);
  return values.filter((value, index) => values.findIndex((candidate) => enumContains([candidate], value)) === index);
}

function validateEventVariants(
  path: string,
  value: unknown,
  schema: PayloadSchema | undefined,
  claims: ReadonlyMap<string, SurfaceEvidenceClaimRecord>,
  variantDiscriminants: readonly string[] = [],
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
        // A matched node may itself reference the payload schema's $defs (a generated enum).
        validateSchemaNode(node, expected, field, violations, schema ?? node);
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
  for (const discriminant of variantDiscriminants) {
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(discriminant)) {
      throw new Error(`ASM: ${path} has invalid variant discriminant "${discriminant}"`);
    }
    const values = schema ? enumValuesAtPath(schema, discriminant) : [];
    if (values.length === 0) {
      throw new Error(`ASM: ${path} variant discriminant "${discriminant}" has no enum or const schema`);
    }
    for (const expected of values) {
      if (expected !== null && !['string', 'number', 'boolean'].includes(typeof expected)) {
        throw new Error(`ASM: ${path} enum at "${discriminant}" cannot be attributed by a scalar variant`);
      }
      if (
        !variants.some(
          (variant) =>
            Object.hasOwn(variant.match, discriminant) && enumContains([expected], variant.match[discriminant]),
        )
      ) {
        throw new Error(
          `ASM: ${path} enum value ${JSON.stringify(expected)} at "${discriminant}" has no evidence variant`,
        );
      }
    }
  }
  return variants;
}

function validatePayloadRefinements(
  path: string,
  value: unknown,
  payloadSchema: PayloadSchema | undefined,
  claims: ReadonlyMap<string, SurfaceEvidenceClaimRecord>,
): SurfacePayloadRefinement[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    throw new Error(`ASM: ${path} payloadRefinements must be an array of 1..512 entries`);
  }
  if (payloadSchema === undefined) {
    throw new Error(`ASM: ${path} payloadRefinements require payloadSchema`);
  }
  return value.map((rawRefinement, index) => {
    const label = `payloadRefinements[${index}]`;
    const refinement = requireObject(path, rawRefinement, label);
    requireFields(path, refinement, ['path', 'schema', 'evidence', 'confidence', 'fidelity']);
    const targetPath = requireString(path, refinement, 'path');
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(targetPath)) {
      throw new Error(`ASM: ${path} ${label} has invalid path "${targetPath}"`);
    }
    if (schemaNodesAtPath(payloadSchema, targetPath).length === 0) {
      throw new Error(`ASM: ${path} ${label} path "${targetPath}" is absent from payloadSchema`);
    }
    let match: SurfacePayloadRefinement['match'];
    if (refinement.match !== undefined) {
      const rawMatch = requireObject(path, refinement.match, `${label}.match`);
      if (Object.keys(rawMatch).length === 0) {
        throw new Error(`ASM: ${path} ${label}.match must not be empty`);
      }
      for (const [field, expected] of Object.entries(rawMatch)) {
        if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(field)) {
          throw new Error(`ASM: ${path} ${label}.match has invalid path "${field}"`);
        }
        if (expected !== null && !['string', 'number', 'boolean'].includes(typeof expected)) {
          throw new Error(`ASM: ${path} ${label}.match "${field}" must be scalar or null`);
        }
        const nodes = schemaNodesAtPath(payloadSchema, field);
        if (nodes.length === 0) {
          throw new Error(`ASM: ${path} ${label}.match "${field}" is absent from payloadSchema`);
        }
        const alternatives = nodes.map((node) => {
          const violations: string[] = [];
          validateSchemaNode(node, expected, field, violations);
          return violations;
        });
        if (alternatives.every((violations) => violations.length > 0)) {
          throw new Error(`ASM: ${path} ${label}.match "${field}" violates payloadSchema: ${alternatives[0]?.[0]}`);
        }
      }
      match = rawMatch as SurfacePayloadRefinement['match'];
    }
    const schema = validatePayloadSchema(`${path} ${label}.schema`, refinement.schema);
    const resolved = validateClaimEvidence(path, refinement.evidence, `${label}.evidence`, claims);
    const confidence = requireString(path, refinement, 'confidence');
    if (confidence !== resolved.confidence) {
      throw new Error(`ASM: ${path} ${label}.confidence must be computed as ${resolved.confidence}, got ${confidence}`);
    }
    const fidelity = requireString(path, refinement, 'fidelity');
    if (!schemaFidelities.has(fidelity as SurfaceSchemaFidelity)) {
      throw new Error(`ASM: ${path} ${label}.fidelity has unsupported value "${fidelity}"`);
    }
    const limitations =
      refinement.limitations === undefined
        ? []
        : validateStringArray(path, refinement.limitations, `${label}.limitations`);
    if (['structural', 'sampled', 'unknown'].includes(fidelity) && limitations.length === 0) {
      throw new Error(`ASM: ${path} ${label} lossy fidelity requires explicit limitations`);
    }
    return {
      ...(match === undefined ? {} : { match }),
      path: targetPath,
      schema,
      evidence: resolved.evidence,
      confidence: resolved.confidence,
      fidelity: fidelity as SurfaceSchemaFidelity,
      ...(limitations.length === 0 ? {} : { limitations }),
    };
  });
}

function optionalString(path: string, value: Record<string, unknown>, field: string): string | undefined {
  if (value[field] === undefined) return undefined;
  return requireString(path, value, field);
}

function validateEventOperationalMetadata(path: string, event: Record<string, unknown>): void {
  if (event.timeoutSec !== undefined && (typeof event.timeoutSec !== 'number' || event.timeoutSec <= 0)) {
    throw new Error(`ASM: ${path} timeoutSec must be a positive number`);
  }
  if (
    event.observationMode !== undefined &&
    (typeof event.observationMode !== 'string' ||
      !surfaceObservationModes.has(event.observationMode as SurfaceObservationMode))
  ) {
    throw new Error(`ASM: ${path} observationMode must be passive|matcher-required|response-required|timeout-blocks`);
  }
}

const eventStringMetadataFields = [
  'nativeName',
  'transport',
  'trigger',
  'firstSeen',
  'lastVerified',
  'fixture',
  'notes',
  'recordChannel',
] as const;

function validateEventStringMetadata(path: string, event: Record<string, unknown>): void {
  for (const field of eventStringMetadataFields) {
    if (event[field] !== undefined && (typeof event[field] !== 'string' || event[field].length === 0)) {
      throw new Error(`ASM: ${path} field "${field}" must be a non-empty string`);
    }
  }
}

function validateEventTransportSchemas(
  path: string,
  event: Record<string, unknown>,
  channels: readonly string[],
): void {
  if (
    event.resultSchema !== undefined &&
    !['jsonrpc-request', 'http', 'command', 'hook-callback'].includes(String(event.transport))
  ) {
    throw new Error(`ASM: ${path} resultSchema is only valid for a request/callback transport`);
  }
  if (event.recordChannel !== undefined) {
    if (event.recordSchema === undefined) throw new Error(`ASM: ${path} recordChannel requires recordSchema`);
    if (typeof event.recordChannel !== 'string' || !channels.includes(event.recordChannel)) {
      throw new Error(`ASM: ${path} recordChannel must name one of the event channels`);
    }
  } else if (event.recordSchema !== undefined && channels.length > 1) {
    throw new Error(`ASM: ${path} multi-channel recordSchema requires recordChannel`);
  }
}

function claimNativeEventRoutes(
  path: string,
  event: Record<string, unknown>,
  eventName: string,
  channels: readonly string[],
  claims: Map<string, string>,
): void {
  const nativeName = typeof event.nativeName === 'string' ? event.nativeName : eventName;
  const transport = typeof event.transport === 'string' ? event.transport : '';
  const direction = typeof event.direction === 'string' ? event.direction : '';
  for (const channel of channels) {
    const key = JSON.stringify([channel, transport, direction, nativeName]);
    const existing = claims.get(key);
    if (existing !== undefined) {
      throw new Error(
        `ASM: ${path} duplicates native route ${channel}:${transport || '(unspecified)'}:${direction || '(unspecified)'}:${nativeName} already modeled by "${existing}"`,
      );
    }
    claims.set(key, eventName);
  }
}

function validateSchemaFidelity(
  path: string,
  value: unknown,
  schemas: { payload: boolean; result: boolean; carrier: boolean },
): SurfaceSchemaFidelityRecord {
  const fidelity = requireObject(path, value, 'schemaFidelity');
  for (const kind of ['payload', 'result', 'carrier'] as const) {
    const declared = fidelity[kind];
    if (schemas[kind] && declared === undefined) {
      throw new Error(`ASM: ${path} schemaFidelity is missing "${kind}"`);
    }
    if (!schemas[kind] && declared !== undefined) {
      throw new Error(`ASM: ${path} schemaFidelity.${kind} has no corresponding schema`);
    }
    if (
      declared !== undefined &&
      (typeof declared !== 'string' || !schemaFidelities.has(declared as SurfaceSchemaFidelity))
    ) {
      throw new Error(`ASM: ${path} schemaFidelity.${kind} has unsupported value ${String(declared)}`);
    }
  }
  const limitations =
    fidelity.limitations === undefined
      ? []
      : validateStringArray(path, fidelity.limitations, 'schemaFidelity.limitations');
  const lossy = ['payload', 'result', 'carrier'].some((kind) => {
    const level = fidelity[kind];
    return level === 'structural' || level === 'sampled' || level === 'unknown';
  });
  if (lossy && limitations.length === 0) {
    throw new Error(`ASM: ${path} lossy schemaFidelity requires explicit limitations`);
  }
  return fidelity as unknown as SurfaceSchemaFidelityRecord;
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

function validateEvidenceIndex(
  path: string,
  value: unknown,
  vendor: string,
  vendorVersion: string,
): { index: SurfaceEvidenceIndex; claims: Map<string, SurfaceEvidenceClaimRecord> } {
  const raw = requireObject(path, value);
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
    throw new Error(`ASM: ${path} must use evidenceVersion 2 for an ASM v2+ model`);
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

function loadEvidenceIndex(
  path: string,
  vendor: string,
  vendorVersion: string,
): { index: SurfaceEvidenceIndex; claims: Map<string, SurfaceEvidenceClaimRecord> } {
  return validateEvidenceIndex(path, readJsonFile(path), vendor, vendorVersion);
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
  asmVersion: 1 | 2 | 3,
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
    if (asmVersion >= 2) {
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
    if (asmVersion >= 2) {
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

/** A portable authoring path; event identities keep the vendor's exact spelling. */
export function eventDocumentPath(event: string): string {
  const segments = event.split('/');
  if (segments.some((segment) => !segment)) throw new Error('ASM: event names need nonempty path segments');
  const escape = (character: string): string =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  return `${segments
    .map((segment) => {
      let encoded = segment.replace(/[%<>:"\\|?*\u0000-\u001f]/g, escape);
      if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(encoded)) {
        encoded = escape(encoded[0]!) + encoded.slice(1);
      }
      return encoded.replace(/[ .]+$/g, (suffix) => [...suffix].map(escape).join(''));
    })
    .join('/')}.json`;
}

/** Namespaces use directories; percent escapes preserve names Windows cannot store. */
function eventDocumentFiles(dir: string, prefix = ''): Array<{ path: string; name: string }> {
  const found: Array<{ path: string; name: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...eventDocumentFiles(path, `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.json')) {
      found.push({ path, name: decodeURIComponent(`${prefix}${basename(entry.name, '.json')}`) });
    }
  }
  return found;
}

/**
 * Load and fully validate the split authoring documents for one model.
 *
 * Runtime consumers must use loadModel(), which reads only groundtruth.json.
 * This entrypoint exists for the ground-truth builder and source-focused tests.
 */
export function loadModelSources(dir: string): SurfaceModel {
  const manifestPath = join(dir, 'manifest.json');
  const manifest = requireObject(manifestPath, readJsonFile(manifestPath));
  requireFields(manifestPath, manifest, ['asmVersion', 'vendor', 'vendorVersion', 'generatedAt']);
  if (manifest.asmVersion !== 1 && manifest.asmVersion !== 2 && manifest.asmVersion !== 3) {
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
  if (asmVersion >= 2) {
    if (typeof manifest.evidence !== 'string') {
      throw new Error(`ASM: ${manifestPath} ASM v2+ requires an evidence index`);
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
  const nativeEventRoutes = new Map<string, string>();
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
    if (asmVersion >= 2) {
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
    validateEventStringMetadata(path, event);
    if (event.payloadSchema !== undefined) event.payloadSchema = validatePayloadSchema(path, event.payloadSchema);
    if (event.resultSchema !== undefined) event.resultSchema = validatePayloadSchema(path, event.resultSchema);
    if (event.recordSchema !== undefined) event.recordSchema = validatePayloadSchema(path, event.recordSchema);
    if (asmVersion >= 2) {
      const hasSchemas = {
        payload: event.payloadSchema !== undefined,
        result: event.resultSchema !== undefined,
        carrier: event.recordSchema !== undefined,
      };
      if (asmVersion >= 3 && Object.values(hasSchemas).some(Boolean)) {
        if (event.schemaFidelity === undefined) {
          throw new Error(`ASM: ${path} ASM v3 schemas require schemaFidelity`);
        }
        event.schemaFidelity = validateSchemaFidelity(path, event.schemaFidelity, hasSchemas);
      } else if (event.schemaFidelity !== undefined) {
        event.schemaFidelity = validateSchemaFidelity(path, event.schemaFidelity, hasSchemas);
      }
      validateEventTransportSchemas(path, event, channels);
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
      const variantDiscriminants =
        event.variantDiscriminants === undefined
          ? []
          : validateStringArray(path, event.variantDiscriminants, 'variantDiscriminants');
      if (new Set(variantDiscriminants).size !== variantDiscriminants.length) {
        throw new Error(`ASM: ${path} variantDiscriminants contains duplicates`);
      }
      if (variantDiscriminants.length > 0 && event.variants === undefined) {
        throw new Error(`ASM: ${path} variantDiscriminants require variants`);
      }
      if (event.variants !== undefined) {
        event.variants = validateEventVariants(
          path,
          event.variants,
          event.payloadSchema as PayloadSchema | undefined,
          evidenceClaims,
          variantDiscriminants,
        );
      }
      if (event.payloadRefinements !== undefined) {
        event.payloadRefinements = validatePayloadRefinements(
          path,
          event.payloadRefinements,
          event.payloadSchema as PayloadSchema | undefined,
          evidenceClaims,
        );
      }
      if (variantDiscriminants.length > 0) event.variantDiscriminants = variantDiscriminants;
    }
    validateEventOperationalMetadata(path, event);
    claimNativeEventRoutes(path, event, eventName, channels, nativeEventRoutes);
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

function validateLegacyEvidenceIndex(
  path: string,
  value: unknown,
  vendor: string,
  vendorVersion: string,
): SurfaceLegacyEvidenceIndex {
  const raw = requireObject(path, value);
  requireFields(path, raw, ['evidenceVersion', 'vendor', 'vendorVersion', 'artifacts', 'sourceReferences', 'records']);
  if (raw.evidenceVersion !== 1) throw new Error(`ASM: ${path} must use evidenceVersion 1 for an ASM v1 model`);
  if (raw.vendor !== vendor || raw.vendorVersion !== vendorVersion) {
    throw new Error(`ASM: ${path} evidence identity does not match manifest ${vendor}@${vendorVersion}`);
  }
  if (!Array.isArray(raw.artifacts) || !Array.isArray(raw.sourceReferences) || !Array.isArray(raw.records)) {
    throw new Error(`ASM: ${path} artifacts, sourceReferences, and records must be arrays`);
  }
  return raw as unknown as SurfaceLegacyEvidenceIndex;
}

/** Build the canonical in-memory document from fully validated authoring inputs. */
export function buildGroundTruth(dir: string): SurfaceGroundTruth {
  const model = loadModelSources(dir);
  let legacyEvidenceIndex: SurfaceLegacyEvidenceIndex | undefined;
  if (model.manifest.asmVersion === 1 && model.manifest.evidence) {
    const evidencePath = join(dir, model.manifest.evidence);
    legacyEvidenceIndex = validateLegacyEvidenceIndex(
      evidencePath,
      readJsonFile(evidencePath),
      model.manifest.vendor,
      model.manifest.vendorVersion,
    );
  }
  return {
    format: SURFACE_GROUND_TRUTH_FORMAT,
    ...model,
    ...(legacyEvidenceIndex === undefined ? {} : { legacyEvidenceIndex }),
  };
}

/** Load one canonical groundtruth.json file. Split source documents are never consulted. */
export function loadGroundTruth(path: string): SurfaceGroundTruth {
  const document = requireObject(path, readJsonFile(path));
  requireFields(path, document, ['format', 'manifest', 'detection', 'channels', 'events', 'behavior']);
  if (document.format !== SURFACE_GROUND_TRUTH_FORMAT) {
    throw new Error(`ASM: ${path} has unsupported ground-truth format ${String(document.format)}`);
  }

  const manifest = requireObject(path, document.manifest, 'field "manifest"');
  requireFields(path, manifest, ['asmVersion', 'vendor', 'vendorVersion', 'generatedAt']);
  if (manifest.asmVersion !== 1 && manifest.asmVersion !== 2 && manifest.asmVersion !== 3) {
    throw new Error(`ASM: ${path} has unsupported asmVersion ${String(manifest.asmVersion)}`);
  }
  const asmVersion = manifest.asmVersion;
  const vendor = requireString(path, manifest, 'vendor');
  const vendorVersion = requireString(path, manifest, 'vendorVersion');
  const generatedAt = requireString(path, manifest, 'generatedAt');
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error(`ASM: ${path} field "generatedAt" must be an ISO date or timestamp`);
  }

  const detection = requireObject(path, document.detection, 'field "detection"');
  const channelsDocument = requireObject(path, document.channels, 'field "channels"');
  const channelRecords = requireObject(path, channelsDocument.channels, 'field "channels.channels"');
  if (Object.keys(channelRecords).length === 0) throw new Error(`ASM: ${path} must declare at least one channel`);
  for (const [name, rawChannel] of Object.entries(channelRecords)) {
    requireString(path, requireObject(path, rawChannel, `channel "${name}"`), 'kind');
  }

  let evidenceIndex: SurfaceEvidenceIndex | undefined;
  let legacyEvidenceIndex: SurfaceLegacyEvidenceIndex | undefined;
  let evidenceClaims = new Map<string, SurfaceEvidenceClaimRecord>();
  if (asmVersion >= 2) {
    if (document.evidenceIndex === undefined) throw new Error(`ASM: ${path} ASM v2+ requires an evidence index`);
    const loaded = validateEvidenceIndex(path, document.evidenceIndex, vendor, vendorVersion);
    evidenceIndex = loaded.index;
    evidenceClaims = loaded.claims;
  } else if (document.legacyEvidenceIndex !== undefined) {
    legacyEvidenceIndex = validateLegacyEvidenceIndex(path, document.legacyEvidenceIndex, vendor, vendorVersion);
  }

  if (!Array.isArray(document.events) || document.events.length === 0) {
    throw new Error(`ASM: ${path} events must be a non-empty array`);
  }
  const events: SurfaceEventFile[] = [];
  const eventNames = new Set<string>();
  const nativeEventRoutes = new Map<string, string>();
  for (const [index, rawEvent] of document.events.entries()) {
    const label = `${path}#events[${index}]`;
    const event = requireObject(label, rawEvent);
    requireFields(label, event, ['surface', 'surfaceVersion', 'event', 'channel', 'confidence']);
    const surface = requireString(label, event, 'surface');
    const surfaceVersion = requireString(label, event, 'surfaceVersion');
    const eventName = requireString(label, event, 'event');
    const channel = requireString(label, event, 'channel');
    const channels = event.channels === undefined ? [channel] : validateStringArray(label, event.channels, 'channels');
    if (surface !== vendor || surfaceVersion !== vendorVersion) {
      throw new Error(`ASM: ${label} surface identity does not match manifest ${vendor}@${vendorVersion}`);
    }
    if (eventNames.has(eventName)) throw new Error(`ASM: duplicate event "${eventName}"`);
    eventNames.add(eventName);
    if (!channels.includes(channel))
      throw new Error(`ASM: ${label} channels must include primary channel "${channel}"`);
    if (new Set(channels).size !== channels.length) throw new Error(`ASM: ${label} channels contains duplicates`);
    for (const declaredChannel of channels) {
      if (!Object.hasOwn(channelRecords, declaredChannel)) {
        throw new Error(`ASM: ${label} references unknown channel "${declaredChannel}"`);
      }
    }
    const confidence = requireString(label, event, 'confidence');
    if (!surfaceConfidences.has(confidence as SurfaceConfidence)) {
      throw new Error(`ASM: ${label} has unsupported confidence "${confidence}"`);
    }
    validateEventStringMetadata(label, event);
    validateEventOperationalMetadata(label, event);
    if (event.payloadSchema !== undefined) event.payloadSchema = validatePayloadSchema(label, event.payloadSchema);
    if (event.resultSchema !== undefined) event.resultSchema = validatePayloadSchema(label, event.resultSchema);
    if (event.recordSchema !== undefined) event.recordSchema = validatePayloadSchema(label, event.recordSchema);
    if (asmVersion >= 2) {
      const hasSchemas = {
        payload: event.payloadSchema !== undefined,
        result: event.resultSchema !== undefined,
        carrier: event.recordSchema !== undefined,
      };
      if (asmVersion >= 3 && Object.values(hasSchemas).some(Boolean)) {
        if (event.schemaFidelity === undefined) {
          throw new Error(`ASM: ${label} ASM v3 schemas require schemaFidelity`);
        }
        event.schemaFidelity = validateSchemaFidelity(label, event.schemaFidelity, hasSchemas);
      } else if (event.schemaFidelity !== undefined) {
        event.schemaFidelity = validateSchemaFidelity(label, event.schemaFidelity, hasSchemas);
      }
      validateEventTransportSchemas(label, event, channels);
      const direction = requireString(label, event, 'direction');
      if (!surfaceDirections.has(direction as SurfaceDirection)) {
        throw new Error(`ASM: ${label} direction must be client-to-agent|agent-to-client|agent-local`);
      }
      const requiredEvidence: (keyof SurfaceClaimEvidence)[] = ['existence', 'shape'];
      if (event.resultSchema !== undefined) requiredEvidence.push('result');
      if (event.recordSchema !== undefined) requiredEvidence.push('carrier');
      const resolved = validateClaimEvidence(label, event.evidence, 'event evidence', evidenceClaims, requiredEvidence);
      if (confidence !== resolved.confidence) {
        throw new Error(`ASM: ${label} confidence must be computed as ${resolved.confidence}, got ${confidence}`);
      }
      event.evidence = resolved.evidence;
      const variantDiscriminants =
        event.variantDiscriminants === undefined
          ? []
          : validateStringArray(label, event.variantDiscriminants, 'variantDiscriminants');
      if (new Set(variantDiscriminants).size !== variantDiscriminants.length) {
        throw new Error(`ASM: ${label} variantDiscriminants contains duplicates`);
      }
      if (variantDiscriminants.length > 0 && event.variants === undefined) {
        throw new Error(`ASM: ${label} variantDiscriminants require variants`);
      }
      if (event.variants !== undefined) {
        event.variants = validateEventVariants(
          label,
          event.variants,
          event.payloadSchema as PayloadSchema | undefined,
          evidenceClaims,
          variantDiscriminants,
        );
      }
      if (event.payloadRefinements !== undefined) {
        event.payloadRefinements = validatePayloadRefinements(
          label,
          event.payloadRefinements,
          event.payloadSchema as PayloadSchema | undefined,
          evidenceClaims,
        );
      }
      if (variantDiscriminants.length > 0) event.variantDiscriminants = variantDiscriminants;
    }
    claimNativeEventRoutes(label, event, eventName, channels, nativeEventRoutes);
    if (
      asmVersion === 1 &&
      confidence !== 'unverified' &&
      (!event.fixture || !event.firstSeen || !event.lastVerified)
    ) {
      throw new Error(`ASM: ${label} verified event must cite fixture, firstSeen, and lastVerified`);
    }
    event.channels = channels;
    events.push(event as unknown as SurfaceEventFile);
  }
  const sortedNames = [...eventNames].sort((left, right) => left.localeCompare(right));
  if (events.some((event, index) => event.event !== sortedNames[index])) {
    throw new Error(`ASM: ${path} events must be sorted by event name`);
  }
  const behavior = validateBehavior(path, document.behavior, eventNames, asmVersion, evidenceClaims);

  return {
    format: SURFACE_GROUND_TRUTH_FORMAT,
    manifest: manifest as unknown as SurfaceManifest,
    detection: detection as SurfaceDetection,
    channels: channelsDocument as unknown as SurfaceChannels,
    ...(evidenceIndex === undefined ? {} : { evidenceIndex }),
    ...(legacyEvidenceIndex === undefined ? {} : { legacyEvidenceIndex }),
    events,
    behavior,
  };
}

/** Load the sole runtime authority for a model directory (or an explicit canonical file). */
export function loadModel(pathOrDir: string): SurfaceGroundTruth {
  const path = statSync(pathOrDir).isDirectory() ? join(pathOrDir, 'groundtruth.json') : pathOrDir;
  return loadGroundTruth(path);
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
 * Pass the model to validate every parsed, privacy-sanitized payload while it
 * is in memory. Redaction tokens retain their JSON type but cannot prove a
 * sensitive enum/pattern value; all other schema assertions remain active. The
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
        for (const violation of validateSanitizedPayload(schema, record)) {
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

// ---------------------------------------------------------------------------
// OpenAPI 3.1 HTTP contracts
// ---------------------------------------------------------------------------

/** The Path Item fields that are operations, in output order. */
const OPENAPI_METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'] as const;

/** Where each parameter location travels in a request record. */
const OPENAPI_PARAMETER_PROPERTIES = { path: 'params', query: 'query', header: 'headers', cookie: 'cookies' } as const;

/** Parameter properties a result repeats so it names the resource it answers for. */
const OPENAPI_RESULT_IDENTITY = ['params', 'query'] as const;

/** OpenAPI 3.1 §4.8.12.1: these header parameters SHALL be ignored; the operation's own fields describe them. */
const OPENAPI_IGNORED_HEADERS = new Set(['accept', 'authorization', 'content-type']);

/** JSON media types only, the projection the first HTTP generators used. */
export const OPENAPI_JSON_MEDIA_TYPES = ['application/json', 'application/*+json'] as const;

/** The default: JSON first, then whatever single media type the operation declares. */
export const OPENAPI_ANY_MEDIA_TYPES = [...OPENAPI_JSON_MEDIA_TYPES, '*'] as const;

export interface OpenApiHttpOptions {
  /**
   * Media types whose schemas become a request or result `body`, in preference
   * order. `*` matches any declared type, and a `*` inside a pattern matches
   * within one type (`application/*+json`). Parameters after `;` are ignored.
   * Default {@link OPENAPI_ANY_MEDIA_TYPES}.
   */
  bodyMediaTypes?: readonly string[];
}

/** One declared response, its schema closed over the document's local references. */
export interface OpenApiHttpResponse {
  /** Exactly as declared: `200`, `4XX` or `default`. */
  status: string;
  mediaType?: string;
  schema?: PayloadSchemaNode;
}

/** One OpenAPI operation projected into the ASM's HTTP request/result/record schemas. */
export interface OpenApiHttpOperation {
  operationId: string;
  /** Upper-case HTTP method. */
  method: string;
  /** Templated OpenAPI path, `/session/{sessionID}`. */
  path: string;
  /** The same path with `:name` parameters, the form request traces carry. */
  route: string;
  /** Summary and description, deduplicated and joined. */
  trigger?: string;
  /** Media type of the request `body`, when one is modeled. */
  requestMediaType?: string;
  /** The first explicit 2xx status, absent when only a `2XX` range is declared. */
  successStatus?: number;
  /** Media type of the result `body`, when one is modeled. */
  successMediaType?: string;
  /** `{method, route, params?, query?, headers?, cookies?, body?}`. */
  payloadSchema: PayloadSchemaNode;
  /** `{method, route, status, params?, query?, body?}` for a 2xx answer. */
  resultSchema: PayloadSchemaNode;
  /** `{direction: client-to-agent, request}` with method and route pinned. */
  recordSchema: PayloadSchemaNode;
  /** Every declared response, errors included, sorted by status. */
  responses: OpenApiHttpResponse[];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Follow local Reference Objects to the Parameter, Request Body, Response or
 * Path Item they name, whatever component holds it. OpenAPI 3.1 lets a
 * reference carry `summary` and `description`, which override the target's;
 * the outermost wins. Schema references are not followed here: schema
 * projection closes over them instead. Unresolved or cyclic: `undefined`.
 */
export function resolveOpenApiReference(node: unknown, document: unknown): unknown {
  let current = node;
  const seen = new Set<string>();
  const overrides: Record<string, unknown> = {};
  while (isJsonObject(current) && typeof current.$ref === 'string') {
    for (const field of ['summary', 'description']) {
      if (current[field] !== undefined && overrides[field] === undefined) overrides[field] = current[field];
    }
    if (!current.$ref.startsWith('#') || seen.has(current.$ref)) return undefined;
    seen.add(current.$ref);
    current = resolveLocalSchemaReference(document, current.$ref);
  }
  return isJsonObject(current) && Object.keys(overrides).length > 0 ? { ...current, ...overrides } : current;
}

/** `/session/{sessionID}` → `/session/:sessionID`. */
export function openApiRoute(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

function mediaTypeMatches(pattern: string, declared: string): boolean {
  if (pattern === '*') return true;
  const base = (value: string): string => value.split(';')[0]!.trim().toLowerCase();
  const wanted = base(pattern);
  const actual = base(declared);
  if (wanted === actual) return true;
  if (!wanted.includes('*')) return false;
  const expression = wanted
    .split('*')
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\/]/g, '\\$&'))
    .join('[^/;]*');
  return new RegExp(`^${expression}$`).test(actual);
}

/** The preferred declared media type and its (raw) schema; `schema` is absent when the media type declares none. */
function selectOpenApiMedia(
  content: unknown,
  preferences: readonly string[],
): { mediaType: string; schema?: unknown } | undefined {
  if (!isJsonObject(content)) return undefined;
  const declared = Object.keys(content);
  for (const preference of preferences) {
    const mediaType = declared.find((candidate) => mediaTypeMatches(preference, candidate));
    if (mediaType === undefined) continue;
    const media = content[mediaType];
    const schema = isJsonObject(media) ? media.schema : undefined;
    return schema === undefined || schema === null ? { mediaType } : { mediaType, schema };
  }
  return undefined;
}

/** Path-level parameters, overridden by operation parameters with the same name and location (OpenAPI 3.1 §4.8.10). */
function openApiParameters(pathItem: Record<string, unknown>, operation: Record<string, unknown>, document: unknown) {
  const merged = new Map<string, Record<string, unknown>>();
  for (const list of [pathItem.parameters, operation.parameters]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const parameter = resolveOpenApiReference(raw, document);
      if (!isJsonObject(parameter) || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') continue;
      if (parameter.in === 'header' && OPENAPI_IGNORED_HEADERS.has(parameter.name.toLowerCase())) continue;
      merged.set(`${parameter.in}\0${parameter.name}`, parameter);
    }
  }
  return [...merged.values()];
}

/** A parameter's schema, from `schema` or from the single media type of `content`. */
function openApiParameterSchema(parameter: Record<string, unknown>): unknown {
  if (parameter.schema !== undefined) return parameter.schema;
  return selectOpenApiMedia(parameter.content, ['*'])?.schema ?? {};
}

function openApiTrigger(operation: Record<string, unknown>): string | undefined {
  const text = [operation.summary, operation.description]
    .filter((value, index, values) => typeof value === 'string' && value.length > 0 && values.indexOf(value) === index)
    .join(' — ');
  return text.length > 0 ? text : undefined;
}

/**
 * Project every operation of an OpenAPI 3.1 document into the ASM's HTTP
 * schemas, sorted by path and then method. Operations without an
 * `operationId` have no stable event name and are skipped. Schemas keep the
 * document's full JSON Schema 2020-12 vocabulary (`prefixItems`,
 * `contentMediaType`, `const`, type arrays, `$ref` siblings) and close over
 * the local references they use.
 */
export function openApiHttpOperations(document: unknown, options: OpenApiHttpOptions = {}): OpenApiHttpOperation[] {
  if (!isJsonObject(document)) return [];
  const preferences = options.bodyMediaTypes ?? OPENAPI_ANY_MEDIA_TYPES;
  const paths = isJsonObject(document.paths) ? document.paths : {};
  const operations: OpenApiHttpOperation[] = [];
  for (const path of Object.keys(paths).sort()) {
    const pathItem = resolveOpenApiReference(paths[path], document);
    if (!isJsonObject(pathItem)) continue;
    for (const method of OPENAPI_METHODS) {
      const operation = pathItem[method];
      if (!isJsonObject(operation) || typeof operation.operationId !== 'string') continue;
      const upper = method.toUpperCase();
      const route = openApiRoute(path);

      const requestProperties: Record<string, unknown> = { method: { type: 'string' }, route: { type: 'string' } };
      const requestRequired = ['method', 'route'];
      const parameters = openApiParameters(pathItem, operation, document);
      for (const [location, property] of Object.entries(OPENAPI_PARAMETER_PROPERTIES)) {
        const selected = parameters
          .filter((parameter) => parameter.in === location)
          .sort((left, right) => (left.name as string).localeCompare(right.name as string));
        if (selected.length === 0) continue;
        const parameterProperties: Record<string, unknown> = {};
        const parameterRequired: string[] = [];
        for (const parameter of selected) {
          const name = parameter.name as string;
          parameterProperties[name] = openApiParameterSchema(parameter);
          // A path parameter is required by definition in OpenAPI 3.1.
          if (parameter.required === true || location === 'path') parameterRequired.push(name);
        }
        requestProperties[property] = {
          type: 'object',
          properties: parameterProperties,
          ...(parameterRequired.length > 0 ? { required: parameterRequired } : {}),
        };
        if (parameterRequired.length > 0) requestRequired.push(property);
      }
      const requestBody = resolveOpenApiReference(operation.requestBody, document);
      const requestMedia = isJsonObject(requestBody) ? selectOpenApiMedia(requestBody.content, preferences) : undefined;
      if (requestMedia?.schema !== undefined) {
        requestProperties.body = requestMedia.schema;
        if (isJsonObject(requestBody) && requestBody.required === true) requestRequired.push('body');
      }
      const requestContract = { type: 'object', properties: requestProperties, required: requestRequired };

      const responseEntries = isJsonObject(operation.responses) ? Object.entries(operation.responses) : [];
      const explicitSuccess = responseEntries
        .filter(([status]) => /^2\d\d$/.test(status))
        .sort(([left], [right]) => left.localeCompare(right))[0];
      const success = explicitSuccess ?? responseEntries.find(([status]) => /^2XX$/i.test(status));
      const successResponse = success ? resolveOpenApiReference(success[1], document) : undefined;
      const successMedia = isJsonObject(successResponse)
        ? selectOpenApiMedia(successResponse.content, preferences)
        : undefined;
      const resultProperties: Record<string, unknown> = {
        method: { type: 'string', enum: [upper] },
        route: { type: 'string', enum: [route] },
        status: { type: 'integer', minimum: 200, maximum: 299 },
      };
      const resultRequired = ['method', 'route', 'status'];
      for (const property of OPENAPI_RESULT_IDENTITY) {
        if (!requestProperties[property]) continue;
        resultProperties[property] = cloneJsonValue(requestProperties[property]);
        if (requestRequired.includes(property)) resultRequired.push(property);
      }
      if (successMedia?.schema !== undefined) {
        resultProperties.body = successMedia.schema;
        resultRequired.push('body');
      }

      const exactRequest = cloneJsonValue(requestContract) as { properties: Record<string, Record<string, unknown>> };
      exactRequest.properties.method!.enum = [upper];
      exactRequest.properties.route!.enum = [route];

      const responses: OpenApiHttpResponse[] = responseEntries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, raw]) => {
          const response = resolveOpenApiReference(raw, document);
          const media = isJsonObject(response) ? selectOpenApiMedia(response.content, preferences) : undefined;
          return {
            status,
            ...(media ? { mediaType: media.mediaType } : {}),
            ...(media?.schema !== undefined ? { schema: projectJsonSchema(media.schema, document) } : {}),
          };
        });

      const trigger = openApiTrigger(operation);
      operations.push({
        operationId: operation.operationId,
        method: upper,
        path,
        route,
        ...(trigger ? { trigger } : {}),
        ...(requestMedia?.schema !== undefined ? { requestMediaType: requestMedia.mediaType } : {}),
        ...(explicitSuccess ? { successStatus: Number(explicitSuccess[0]) } : {}),
        ...(successMedia?.schema !== undefined ? { successMediaType: successMedia.mediaType } : {}),
        payloadSchema: projectJsonSchema(requestContract, document),
        resultSchema: projectJsonSchema(
          { type: 'object', properties: resultProperties, required: resultRequired },
          document,
        ),
        recordSchema: projectJsonSchema(
          {
            type: 'object',
            properties: { direction: { type: 'string', enum: ['client-to-agent'] }, request: exactRequest },
            required: ['direction', 'request'],
          },
          document,
        ),
        responses,
      });
    }
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Exact-source event contracts
// ---------------------------------------------------------------------------

/**
 * How an envelope carries its payload. `json-string` is the payload serialized
 * into a string (OpenAPI 3.1 `contentMediaType: application/json`); a contract
 * that lists both says the wire may use either.
 */
export type ExactSourcePayloadEncoding = 'object' | 'json-string';

/** One native event type read from the vendor's exact-release source. */
export interface ExactSourceEventDefinition {
  payloadSchema: PayloadSchemaNode;
  /** Where the event is declared, a path listed in `sourceFiles`. */
  source?: { path: string; symbol?: string };
  /** Envelope fields this event always carries, e.g. a durability record. */
  envelopeRequired?: readonly string[];
  /** Envelope fields this event never carries. */
  envelopeOmitted?: readonly string[];
  notes?: string;
}

/**
 * A digest-pinned event contract for a native stream whose generated schema
 * does not enumerate its events (OpenCode 2.x declares only an encoded
 * `V2EventEncoded` string). Every event shares one envelope; the envelope's
 * `discriminator` field names the event and its `payload` field carries the
 * event's own schema. Local `$ref`s resolve against this document, so shared
 * schemas live in its `$defs`.
 */
export interface ExactSourceEventContract {
  kind: 'exact-source-event-contract';
  contractVersion: 1;
  vendor: string;
  vendorVersion: string;
  sourceRepository: string;
  sourceTag: string;
  sourceRevision: string;
  sourceFiles: ReadonlyArray<{ path: string; sha256: string; bytes: number; symbols?: readonly string[] }>;
  envelope: {
    discriminator: string;
    payload: string;
    payloadEncodings: readonly ExactSourcePayloadEncoding[];
    /** The carrier's own fields; the discriminator and payload are filled in per event. */
    schema: PayloadSchemaNode;
  };
  events: Record<string, ExactSourceEventDefinition>;
  $defs?: Record<string, PayloadSchemaNode>;
  limitations?: readonly string[];
}

/** One event of a contract, with its schemas closed over the contract's `$defs`. */
export interface ExactSourceEventSchemas {
  event: string;
  payloadSchema: PayloadSchemaNode;
  /** The whole envelope with this event's discriminator and payload pinned. */
  recordSchema: PayloadSchemaNode;
  source?: { path: string; symbol?: string };
  notes?: string;
}

function collectLocalReferences(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectLocalReferences(entry, found);
    return;
  }
  if (!isJsonObject(node)) return;
  for (const [key, child] of Object.entries(node)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#')) found.push(child);
    else collectLocalReferences(child, found);
  }
}

/** Every reason `value` is not a usable exact-source event contract; empty when it is. */
export function exactSourceEventContractProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isJsonObject(value)) return ['contract must be a JSON object'];
  if (value.kind !== 'exact-source-event-contract') problems.push('kind must be "exact-source-event-contract"');
  if (value.contractVersion !== 1) problems.push('contractVersion must be 1');
  for (const field of ['vendor', 'vendorVersion', 'sourceRepository', 'sourceTag']) {
    if (typeof value[field] !== 'string' || (value[field] as string).length === 0) {
      problems.push(`${field} must be a non-empty string`);
    }
  }
  if (typeof value.sourceRevision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.sourceRevision)) {
    problems.push('sourceRevision must be a full commit hash');
  }
  const sourcePaths = new Set<string>();
  if (!Array.isArray(value.sourceFiles) || value.sourceFiles.length === 0) {
    problems.push('sourceFiles must list the digest-pinned files the contract was read from');
  } else {
    for (const [index, file] of value.sourceFiles.entries()) {
      if (
        !isJsonObject(file) ||
        typeof file.path !== 'string' ||
        file.path.length === 0 ||
        typeof file.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(file.sha256) ||
        typeof file.bytes !== 'number' ||
        !Number.isInteger(file.bytes) ||
        file.bytes < 0
      ) {
        problems.push(`sourceFiles[${index}] needs a path, a sha256 hex digest and a byte count`);
      } else if (sourcePaths.has(file.path)) {
        problems.push(`sourceFiles lists ${file.path} twice`);
      } else {
        sourcePaths.add(file.path);
      }
    }
  }

  const envelope = value.envelope;
  let envelopeFields = new Set<string>();
  if (!isJsonObject(envelope)) {
    problems.push('envelope must be an object');
  } else {
    if (typeof envelope.discriminator !== 'string' || envelope.discriminator.length === 0) {
      problems.push('envelope.discriminator must name the event-type field');
    }
    if (typeof envelope.payload !== 'string' || envelope.payload.length === 0) {
      problems.push('envelope.payload must name the payload field');
    }
    if (envelope.discriminator === envelope.payload) problems.push('envelope.discriminator and payload must differ');
    const encodings = envelope.payloadEncodings;
    if (
      !Array.isArray(encodings) ||
      encodings.length === 0 ||
      new Set(encodings).size !== encodings.length ||
      encodings.some((encoding) => encoding !== 'object' && encoding !== 'json-string')
    ) {
      problems.push('envelope.payloadEncodings must list "object" and/or "json-string" once each');
    }
    try {
      validatePayloadSchemaNode('contract', envelope.schema, 'envelope.schema', 0);
      envelopeFields = new Set(Object.keys((envelope.schema as PayloadSchemaNode).properties ?? {}));
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  if (value.$defs !== undefined) {
    if (!isJsonObject(value.$defs)) problems.push('$defs must be an object');
    else {
      for (const [name, schema] of Object.entries(value.$defs)) {
        try {
          validatePayloadSchemaNode('contract', schema, `$defs[${JSON.stringify(name)}]`, 0);
        } catch (error) {
          problems.push((error as Error).message);
        }
      }
    }
  }

  if (!isJsonObject(value.events) || Object.keys(value.events).length === 0) {
    problems.push('events must map at least one event type to its definition');
  } else {
    for (const [event, definition] of Object.entries(value.events)) {
      const label = `events[${JSON.stringify(event)}]`;
      if (event.length === 0) problems.push('events has an empty event type');
      if (!isJsonObject(definition)) {
        problems.push(`${label} must be an object`);
        continue;
      }
      try {
        validatePayloadSchemaNode('contract', definition.payloadSchema, `${label}.payloadSchema`, 0);
      } catch (error) {
        problems.push((error as Error).message);
      }
      if (definition.source !== undefined) {
        const source = definition.source;
        if (!isJsonObject(source) || typeof source.path !== 'string' || !sourcePaths.has(source.path)) {
          problems.push(`${label}.source.path must be one of sourceFiles`);
        } else if (source.symbol !== undefined && (typeof source.symbol !== 'string' || source.symbol.length === 0)) {
          problems.push(`${label}.source.symbol must be a non-empty string`);
        }
      }
      const required = definition.envelopeRequired ?? [];
      const omitted = definition.envelopeOmitted ?? [];
      for (const [field, list] of [
        ['envelopeRequired', required],
        ['envelopeOmitted', omitted],
      ] as const) {
        if (!Array.isArray(list) || list.some((name) => typeof name !== 'string' || !envelopeFields.has(name))) {
          problems.push(`${label}.${field} must name fields of envelope.schema`);
        }
      }
      if (Array.isArray(required) && Array.isArray(omitted) && required.some((name) => omitted.includes(name))) {
        problems.push(`${label} both requires and omits the same envelope field`);
      }
      if (
        isJsonObject(envelope) &&
        [...(Array.isArray(omitted) ? omitted : [])].some(
          (name) => name === envelope.discriminator || name === envelope.payload,
        )
      ) {
        problems.push(`${label} cannot omit the discriminator or the payload`);
      }
    }
  }

  const references: string[] = [];
  collectLocalReferences([value.envelope, value.events, value.$defs], references);
  for (const reference of new Set(references)) {
    if (resolveLocalSchemaReference(value, reference) === undefined) {
      problems.push(`unresolved local reference ${reference}`);
    }
  }
  return problems;
}

function encodedPayloadSchema(payload: PayloadSchemaNode): PayloadSchemaNode {
  return { type: 'string', contentMediaType: 'application/json', contentSchema: payload };
}

/**
 * Every event of a valid contract with its payload and record schemas, sorted
 * by event type. Throws when the contract has problems: generating evidence
 * from a malformed contract is a programmer error, not a runtime outcome.
 */
export function exactSourceEventSchemas(contract: ExactSourceEventContract): ExactSourceEventSchemas[] {
  const problems = exactSourceEventContractProblems(contract);
  if (problems.length > 0) throw new Error(`exact-source event contract: ${problems.join('; ')}`);
  const { discriminator, payload, payloadEncodings, schema } = contract.envelope;
  return Object.keys(contract.events)
    .sort()
    .map((event) => {
      const definition = contract.events[event]!;
      const record = cloneJsonValue(schema) as PayloadSchemaNode;
      const properties: Record<string, PayloadSchemaNode> = { ...(record.properties ?? {}) };
      properties[discriminator] = { type: 'string', enum: [event] };
      properties[payload] =
        payloadEncodings.length > 1
          ? { anyOf: [definition.payloadSchema, encodedPayloadSchema(definition.payloadSchema)] }
          : payloadEncodings[0] === 'object'
            ? definition.payloadSchema
            : encodedPayloadSchema(definition.payloadSchema);
      const omitted = new Set(definition.envelopeOmitted ?? []);
      // A false schema: the field may not appear at all on this event.
      for (const field of omitted) properties[field] = { not: {} };
      const required = [
        ...new Set([...(record.required ?? []), discriminator, payload, ...(definition.envelopeRequired ?? [])]),
      ].filter((field) => !omitted.has(field));
      return {
        event,
        payloadSchema: projectJsonSchema(definition.payloadSchema, contract),
        recordSchema: projectJsonSchema({ ...record, type: 'object', properties, required }, contract),
        ...(definition.source ? { source: { ...definition.source } } : {}),
        ...(definition.notes ? { notes: definition.notes } : {}),
      };
    });
}
