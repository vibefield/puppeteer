/**
 * Control-channel message shapes (docs/archive/IMPOSTER.md §5.1), shared by the
 * imposter's client and the control center's plane.
 *
 * Zero I/O — types, validation, and the two well-known paths. Framing lives in
 * `peer.ts`, dialing in `client.ts`, and the server side is built from the same
 * two by `apps/imposter-control/src/main/plane.ts`.
 *
 * Every parser here refuses rather than coerces. The plane is the boundary
 * between a browser console and a process that impersonates a vendor, so a
 * malformed field must fail loudly at the edge instead of arriving at a channel
 * as `undefined` and teaching the adapter something untrue.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  SurfaceBehavior,
  SurfaceBehaviorRelationKind,
  SurfaceConfidence,
  SurfaceModel,
} from '@vibefield/puppeteer-surface';
import type { Persona } from '../persona/types.ts';
import type { RunflowDescriptor } from '../persona/types.ts';
export type { RunflowDescriptor } from '../persona/types.ts';

// ---------------------------------------------------------------------------
// Errors — JSON-RPC codes, so the plane can map them onto HTTP for the console
// ---------------------------------------------------------------------------

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** The imposter declined: off-model payload, unsupported fault, bad state. */
export const REFUSED = -32000;
/** Addressed something that does not exist (a scenario name, a session). */
export const NOT_FOUND = -32001;

export class ControlError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}

/** HTTP status for a JSON-RPC code, for the plane's browser-facing side. */
export function httpStatusForCode(code: number): number {
  if (code === METHOD_NOT_FOUND || code === NOT_FOUND) return 404;
  if (code === INVALID_PARAMS || code === INVALID_REQUEST || code === PARSE_ERROR) return 400;
  if (code === REFUSED) return 422;
  return 500;
}

// ---------------------------------------------------------------------------
// Well-known paths
// ---------------------------------------------------------------------------

/**
 * `sun_path` is ~103 bytes on macOS and ~107 on Linux, so the socket lives at a
 * short fixed path and never a nested per-session one (§5.2). Windows gets a
 * named pipe, which node's `net` reaches through the same API.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

export function controlHome(): string {
  return join(homedir(), '.puppeteer');
}

export function defaultSocketPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.PUPPETEER_IMPOSTER_SOCKET;
  if (override) return override;
  if (process.platform === 'win32') return '\\\\.\\pipe\\puppeteer-imposter';
  return join(controlHome(), 'imposter.sock');
}

/**
 * The shared secret, beside the socket rather than inside a discovery file.
 *
 * On POSIX the 0700 directory is the real capability and this is belt-and-
 * braces; on Windows named pipes node exposes no ACL, so the token is the only
 * thing standing between the plane and any local process that guesses the pipe
 * name. It carries no URL, no pid, and no liveness — the socket is discovery,
 * and socket close is liveness (§5).
 */
export function defaultTokenPath(env: Record<string, string | undefined> = process.env): string {
  return env.PUPPETEER_IMPOSTER_TOKEN_FILE ?? join(controlHome(), 'imposter.token');
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface NativeEventDescriptor {
  event: string;
  /** PayloadSchema property names, for the console's trigger form. */
  fields: string[];
  channel: string;
  /** All native rails on which this event may be observed. */
  channels: string[];
  confidence: SurfaceConfidence;
  transport?: string;
  trigger?: string;
  notes?: string;
}

/**
 * One semantic op as this persona binds it. The console drives sessions by op
 * first and by raw event second: an op is what a turn is made of, so firing one
 * produces traffic a real vendor would produce, while a raw event is the
 * adversarial escape hatch that deliberately does not.
 */
export interface OpDescriptor {
  op: string;
  /** Delivery kinds this op fans out to. */
  channels: string[];
  /** Wire names it produces — hook events, or JSON-RPC methods. */
  events: string[];
  /** `$op.<field>` references in the persona's templates, i.e. the op's arguments. */
  fields: string[];
  /** The op suspends until the client answers (an approval). */
  awaits?: boolean;
}

/**
 * Internal portable scenario intent. This is deliberately not named or
 * presented as the vendor's lifecycle; native truth lives in SurfaceBehavior.
 */
export interface ScenarioDriverView {
  state: string;
  enabled: string[];
  offModel: number;
  applied: number;
  heartbeats: number;
}

/** imposter -> plane, first message on the connection. */
export interface SessionHello {
  token: string;
  vendor: string;
  version: string;
  sessionId: string;
  pid: number;
  cwd: string;
  channels: string[];
  nativeBehavior: SurfaceBehavior;
  nativeEvents: NativeEventDescriptor[];
  ops: OpDescriptor[];
  runflows: RunflowDescriptor[];
  scenarioDriver: ScenarioDriverView;
}

/** What the plane shows the console. Never carries the token. */
export interface SessionView {
  vendor: string;
  version: string;
  sessionId: string;
  pid: number;
  cwd: string;
  channels: string[];
  nativeBehavior: SurfaceBehavior;
  nativeEvents: NativeEventDescriptor[];
  ops: OpDescriptor[];
  runflows: RunflowDescriptor[];
  scenarioDriver: ScenarioDriverView;
  /** Latest automation run, retained so a reconnecting console can recover. */
  scenarioRun?: ScenarioRunProgressView;
  joinedAt: string;
}

export interface EmittedEntry {
  at: string;
  sequence: number;
  event: string;
  channel?: string;
  payload?: Record<string, unknown>;
  truncated?: boolean;
}

export interface TriggerRequest {
  event: string;
  /** Select one declared native rail; absent means the event's primary rail. */
  channel?: string;
  with: Record<string, unknown>;
}

export interface OpRequest {
  op: string;
  with: Record<string, unknown>;
}

export interface ScenarioRunRequest {
  name?: string;
  script?: unknown;
  /** Devkit catalog identity; never passed into a native payload. */
  runflowId?: string;
  mode: 'play' | 'pause' | 'step';
  speed: number;
  stimulus?: Record<string, unknown>;
}

export type ScenarioRunStatus = 'running' | 'paused' | 'completed' | 'failed';

/** Control-plane lifecycle for one scenario execution, separate from evidence. */
export interface ScenarioRunProgressView {
  runId: string;
  scenario?: string;
  runflowId?: string;
  mode: 'play' | 'pause' | 'step';
  status: ScenarioRunStatus;
  step: number;
  steps: number;
  /** Inclusive native sequence window. It may be empty when through < from. */
  fromSequence: number;
  throughSequence?: number;
  error?: string;
}

export type ScenarioControlAction = 'pause' | 'step' | 'resume';

export interface ScenarioControlRequest {
  action: ScenarioControlAction;
}

export type FaultKind = 'crash' | 'exit' | 'hang' | 'flood' | 'channel-drop';

export interface FaultRequest {
  kind: FaultKind;
  channel?: string;
  count?: number;
  event?: string;
  with?: Record<string, unknown>;
  exitCode?: number;
}

export const FAULT_KINDS: readonly FaultKind[] = ['crash', 'exit', 'hang', 'flood', 'channel-drop'];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new ControlError(INVALID_PARAMS, message);
}

export function asRecord(value: unknown, label = 'params'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, field: string, maxLength = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\r\n\0]/.test(value)) {
    invalid(`${field} must be a non-empty single-line string of at most ${maxLength} characters`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function stringArray(value: unknown, field: string, maxEntries: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    invalid(`${field} must be an array of at most ${maxEntries} entries`);
  }
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`, maxLength));
}

export function parseHello(params: unknown): SessionHello {
  const record = asRecord(params, 'hello');
  const nativeBehavior = parseNativeBehavior(record.nativeBehavior);
  const nativeEvents = parseNativeEvents(record.nativeEvents);
  const eventNames = new Set(nativeEvents.map((event) => event.event));
  for (const node of nativeBehavior.nodes) {
    if (!eventNames.has(node.event)) invalid(`nativeBehavior node "${node.id}" references unknown native event`);
  }
  return {
    token: requiredString(record.token, 'token', 512),
    vendor: requiredString(record.vendor, 'vendor', 128),
    version: requiredString(record.version, 'version', 128),
    sessionId: requiredString(record.sessionId, 'sessionId', 512),
    pid: boundedInteger(record.pid, 'pid', 1, Number.MAX_SAFE_INTEGER),
    cwd: requiredString(record.cwd, 'cwd', 4096),
    channels: [...new Set(stringArray(record.channels, 'channels', 64, 128))],
    nativeBehavior,
    nativeEvents,
    ops: parseOps(record.ops),
    runflows: record.runflows === undefined ? [] : parseRunflows(record.runflows),
    scenarioDriver: parseScenarioDriver(record.scenarioDriver),
  };
}

export function parseRunflows(value: unknown): RunflowDescriptor[] {
  if (!Array.isArray(value) || value.length > 64) invalid('runflows must be an array of at most 64 entries');
  const parsed = value.map((rawEntry, index): RunflowDescriptor => {
    const label = `runflows[${index}]`;
    const entry = asRecord(rawEntry, label);
    const kind = requiredString(entry.kind, `${label}.kind`, 32);
    const danger = requiredString(entry.danger, `${label}.danger`, 32);
    if (!['typical', 'lifecycle', 'vendor', 'adversarial', 'fault'].includes(kind)) {
      invalid(`${label}.kind is unsupported`);
    }
    if (!['safe', 'disruptive', 'terminal'].includes(danger)) invalid(`${label}.danger is unsupported`);
    const speed = entry.defaultSpeed;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0 || speed > 100) {
      invalid(`${label}.defaultSpeed must be greater than 0 and at most 100`);
    }
    if (typeof entry.requiresClient !== 'boolean') invalid(`${label}.requiresClient must be a boolean`);
    return {
      id: requiredString(entry.id, `${label}.id`, 64),
      intent: requiredString(entry.intent, `${label}.intent`, 128),
      scenario: requiredString(entry.scenario, `${label}.scenario`, 64),
      title: requiredString(entry.title, `${label}.title`, 160),
      summary: requiredString(entry.summary, `${label}.summary`, 1000),
      kind: kind as RunflowDescriptor['kind'],
      danger: danger as RunflowDescriptor['danger'],
      tags: [...new Set(stringArray(entry.tags, `${label}.tags`, 16, 128))],
      defaultStimulus: asRecord(entry.defaultStimulus, `${label}.defaultStimulus`),
      defaultSpeed: speed,
      steps: boundedInteger(entry.steps, `${label}.steps`, 1, 10_000),
      events: [...new Set(stringArray(entry.events, `${label}.events`, 1024, 256))],
      channels: [...new Set(stringArray(entry.channels, `${label}.channels`, 64, 128))],
      requiresClient: entry.requiresClient,
    };
  });
  if (new Set(parsed.map((flow) => flow.id)).size !== parsed.length) invalid('runflow ids must be unique');
  return parsed;
}

export function parseScenarioRunProgress(value: unknown): ScenarioRunProgressView {
  const record = asRecord(value, 'scenarioRun');
  const mode = requiredString(record.mode, 'scenarioRun.mode', 16);
  const status = requiredString(record.status, 'scenarioRun.status', 16);
  if (!['play', 'pause', 'step'].includes(mode)) invalid('scenarioRun.mode must be play|pause|step');
  if (!['running', 'paused', 'completed', 'failed'].includes(status)) {
    invalid('scenarioRun.status must be running|paused|completed|failed');
  }
  const steps = boundedInteger(record.steps, 'scenarioRun.steps', 0, 10_000);
  const step = boundedInteger(record.step, 'scenarioRun.step', 0, steps);
  const terminal = status === 'completed' || status === 'failed';
  if (terminal !== (record.throughSequence !== undefined)) {
    invalid('scenarioRun.throughSequence is required exactly when the run is terminal');
  }
  if ((status === 'failed') !== (record.error !== undefined)) {
    invalid('scenarioRun.error is required exactly when the run failed');
  }
  return {
    runId: requiredString(record.runId, 'scenarioRun.runId', 128),
    ...(record.scenario === undefined ? {} : { scenario: requiredString(record.scenario, 'scenarioRun.scenario', 64) }),
    ...(record.runflowId === undefined
      ? {}
      : { runflowId: requiredString(record.runflowId, 'scenarioRun.runflowId', 64) }),
    mode: mode as ScenarioRunProgressView['mode'],
    status: status as ScenarioRunProgressView['status'],
    step,
    steps,
    fromSequence: boundedInteger(record.fromSequence, 'scenarioRun.fromSequence', 0, Number.MAX_SAFE_INTEGER),
    ...(record.throughSequence === undefined
      ? {}
      : {
          throughSequence: boundedInteger(
            record.throughSequence,
            'scenarioRun.throughSequence',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        }),
    ...(record.error === undefined ? {} : { error: requiredString(record.error, 'scenarioRun.error', 2048) }),
  };
}

export function parseOps(value: unknown): OpDescriptor[] {
  if (!Array.isArray(value) || value.length > 128) invalid('ops must be an array of at most 128 entries');
  return value.map((rawEntry, index) => {
    const entry = asRecord(rawEntry, `ops[${index}]`);
    return {
      op: requiredString(entry.op, `ops[${index}].op`, 64),
      channels: stringArray(entry.channels, `ops[${index}].channels`, 16, 128),
      events: stringArray(entry.events, `ops[${index}].events`, 16, 256),
      fields: stringArray(entry.fields, `ops[${index}].fields`, 64, 128),
      ...(entry.awaits === undefined ? {} : { awaits: entry.awaits === true }),
    };
  });
}

export function parseScenarioDriver(value: unknown): ScenarioDriverView {
  const record = asRecord(value, 'scenarioDriver');
  const count = (field: string): number =>
    boundedInteger(record[field], `scenarioDriver.${field}`, 0, Number.MAX_SAFE_INTEGER);
  return {
    state: requiredString(record.state, 'scenarioDriver.state', 64),
    enabled: stringArray(record.enabled, 'scenarioDriver.enabled', 64, 64),
    offModel: count('offModel'),
    applied: count('applied'),
    heartbeats: count('heartbeats'),
  };
}

const SURFACE_CONFIDENCES: readonly SurfaceConfidence[] = ['verified-headless', 'verified-interactive', 'unverified'];
const BEHAVIOR_RELATION_KINDS: readonly SurfaceBehaviorRelationKind[] = [
  'sequence',
  'conditional',
  'loop',
  'resume',
  'async',
  'concurrent',
];

function optionalControlString(
  record: Record<string, unknown>,
  field: string,
  label: string,
  maxLength = 4096,
): string | undefined {
  return record[field] === undefined ? undefined : requiredString(record[field], `${label}.${field}`, maxLength);
}

/**
 * Human-facing Surface prose may contain paragraphs. Unlike identifiers and
 * transport names it is never used as a path, header, or protocol selector,
 * so preserve line breaks while retaining the same size/NUL boundary.
 */
function optionalControlText(
  record: Record<string, unknown>,
  field: string,
  label: string,
  maxLength = 4096,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    invalid(`${label}.${field} must be non-empty text of at most ${maxLength} characters`);
  }
  return value;
}

export function parseNativeEvents(value: unknown): NativeEventDescriptor[] {
  if (!Array.isArray(value) || value.length > 1024) {
    invalid('nativeEvents must be an array of at most 1024 entries');
  }
  const parsed = value.map((rawEntry, index) => {
    const label = `nativeEvents[${index}]`;
    const entry = asRecord(rawEntry, label);
    const confidence = requiredString(entry.confidence, `${label}.confidence`, 32) as SurfaceConfidence;
    const transport = optionalControlString(entry, 'transport', label, 128);
    const trigger = optionalControlText(entry, 'trigger', label);
    const notes = optionalControlText(entry, 'notes', label);
    if (!SURFACE_CONFIDENCES.includes(confidence)) invalid(`${label}.confidence is unsupported`);
    const channel = requiredString(entry.channel, `${label}.channel`, 128);
    const channels =
      entry.channels === undefined
        ? [channel]
        : [...new Set(stringArray(entry.channels, `${label}.channels`, 32, 128))];
    if (!channels.includes(channel)) invalid(`${label}.channels must include its primary channel`);
    return {
      event: requiredString(entry.event, `${label}.event`, 256),
      fields: [...new Set(stringArray(entry.fields, `${label}.fields`, 256, 256))],
      channel,
      channels,
      confidence,
      ...(transport === undefined ? {} : { transport }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(notes === undefined ? {} : { notes }),
    };
  });
  if (new Set(parsed.map((event) => event.event)).size !== parsed.length) {
    invalid('nativeEvents event names must be unique');
  }
  return parsed;
}

export function parseNativeBehavior(value: unknown): SurfaceBehavior {
  const record = asRecord(value, 'nativeBehavior');
  if (record.behaviorVersion !== 1) invalid('nativeBehavior.behaviorVersion must be 1');
  const lanes = record.lanes;
  const nodes = record.nodes;
  const relations = record.relations;
  if (!Array.isArray(lanes) || lanes.length === 0 || lanes.length > 32) {
    invalid('nativeBehavior.lanes must contain 1..32 entries');
  }
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 256) {
    invalid('nativeBehavior.nodes must contain 1..256 entries');
  }
  if (!Array.isArray(relations) || relations.length > 512) {
    invalid('nativeBehavior.relations must contain at most 512 entries');
  }

  const parsedLanes = lanes.map((rawLane, index) => {
    const label = `nativeBehavior.lanes[${index}]`;
    const lane = asRecord(rawLane, label);
    const description = optionalControlString(lane, 'description', label);
    return {
      id: requiredString(lane.id, `${label}.id`, 128),
      label: requiredString(lane.label, `${label}.label`, 256),
      ...(description === undefined ? {} : { description }),
    };
  });
  const laneIds = new Set(parsedLanes.map((lane) => lane.id));
  if (laneIds.size !== parsedLanes.length) invalid('nativeBehavior lane ids must be unique');

  const parsedNodes = nodes.map((rawNode, index) => {
    const label = `nativeBehavior.nodes[${index}]`;
    const node = asRecord(rawNode, label);
    const lane = requiredString(node.lane, `${label}.lane`, 128);
    const confidence = requiredString(node.confidence, `${label}.confidence`, 32) as SurfaceConfidence;
    const nodeLabel = optionalControlString(node, 'label', label, 256);
    const description = optionalControlString(node, 'description', label);
    const source = optionalControlString(node, 'source', label);
    if (!laneIds.has(lane)) invalid(`${label}.lane is unknown`);
    if (!SURFACE_CONFIDENCES.includes(confidence)) invalid(`${label}.confidence is unsupported`);
    let match: Record<string, string | number | boolean> | undefined;
    if (node.match !== undefined) {
      const rawMatch = asRecord(node.match, `${label}.match`);
      if (Object.keys(rawMatch).length > 32) invalid(`${label}.match must contain at most 32 discriminants`);
      match = {};
      for (const [field, expected] of Object.entries(rawMatch)) {
        if (
          !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(field) ||
          !['string', 'number', 'boolean'].includes(typeof expected)
        ) {
          invalid(`${label}.match must contain scalar native discriminants`);
        }
        match[field] = expected as string | number | boolean;
      }
    }
    return {
      id: requiredString(node.id, `${label}.id`, 128),
      event: requiredString(node.event, `${label}.event`, 256),
      confidence,
      lane,
      order: boundedInteger(node.order, `${label}.order`, 0, 512),
      ...(nodeLabel === undefined ? {} : { label: nodeLabel }),
      ...(description === undefined ? {} : { description }),
      ...(source === undefined ? {} : { source }),
      ...(match === undefined ? {} : { match }),
    };
  });
  const nodeIds = new Set(parsedNodes.map((node) => node.id));
  if (nodeIds.size !== parsedNodes.length) invalid('nativeBehavior node ids must be unique');

  const parsedRelations = relations.map((rawRelation, index) => {
    const label = `nativeBehavior.relations[${index}]`;
    const relation = asRecord(rawRelation, label);
    const from = requiredString(relation.from, `${label}.from`, 128);
    const to = requiredString(relation.to, `${label}.to`, 128);
    if (!nodeIds.has(from) || !nodeIds.has(to)) invalid(`${label} references an unknown node`);
    const kind = requiredString(relation.kind, `${label}.kind`, 32) as SurfaceBehaviorRelationKind;
    if (!BEHAVIOR_RELATION_KINDS.includes(kind)) invalid(`${label}.kind is unsupported`);
    const confidence = requiredString(relation.confidence, `${label}.confidence`, 32) as SurfaceConfidence;
    const relationLabel = optionalControlString(relation, 'label', label, 256);
    const source = optionalControlString(relation, 'source', label);
    if (!SURFACE_CONFIDENCES.includes(confidence)) invalid(`${label}.confidence is unsupported`);
    return {
      from,
      to,
      kind,
      confidence,
      ...(relationLabel === undefined ? {} : { label: relationLabel }),
      ...(source === undefined ? {} : { source }),
    };
  });

  const description = optionalControlString(record, 'description', 'nativeBehavior', 8192);
  const source = optionalControlString(record, 'source', 'nativeBehavior', 8192);

  return {
    behaviorVersion: 1,
    title: requiredString(record.title, 'nativeBehavior.title', 512),
    ...(description === undefined ? {} : { description }),
    ...(source === undefined ? {} : { source }),
    lanes: parsedLanes,
    nodes: parsedNodes,
    relations: parsedRelations,
  };
}

export function parseTrigger(params: unknown): TriggerRequest {
  const record = asRecord(params, 'trigger');
  return {
    event: requiredString(record.event, 'event', 256),
    ...(record.channel === undefined ? {} : { channel: requiredString(record.channel, 'channel', 128) }),
    with: record.with === undefined ? {} : asRecord(record.with, 'with'),
  };
}

export function parseOpRequest(params: unknown): OpRequest {
  const record = asRecord(params, 'op');
  return {
    op: requiredString(record.op, 'op', 64),
    with: record.with === undefined ? {} : asRecord(record.with, 'with'),
  };
}

export function parseScenarioRun(params: unknown): ScenarioRunRequest {
  const record = asRecord(params, 'scenario');
  if ((record.name === undefined) === (record.script === undefined)) {
    invalid('scenario requires exactly one of name or script');
  }
  const mode = record.mode === undefined ? 'play' : String(record.mode);
  if (!['play', 'pause', 'step'].includes(mode)) invalid('scenario mode must be play|pause|step');
  const speed = record.speed === undefined ? 1 : record.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0 || speed > 100) {
    invalid('scenario speed must be greater than 0 and at most 100');
  }
  const runflowId = record.runflowId === undefined ? undefined : requiredString(record.runflowId, 'runflow id', 64);
  if (runflowId !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(runflowId)) {
    invalid('runflow id must use lowercase letters, digits, and hyphens');
  }
  if (runflowId !== undefined && record.name === undefined) invalid('runflow id requires a named scenario');
  return {
    ...(record.name === undefined ? {} : { name: requiredString(record.name, 'scenario name', 256) }),
    ...(record.script === undefined ? {} : { script: record.script }),
    ...(runflowId === undefined ? {} : { runflowId }),
    mode: mode as 'play' | 'pause' | 'step',
    speed,
    ...(record.stimulus === undefined ? {} : { stimulus: asRecord(record.stimulus, 'stimulus') }),
  };
}

export function parseScenarioControl(params: unknown): ScenarioControlRequest {
  const record = asRecord(params, 'scenario.control');
  const action = requiredString(record.action, 'action', 16);
  if (!['pause', 'step', 'resume'].includes(action)) invalid('scenario control action must be pause|step|resume');
  return { action: action as ScenarioControlAction };
}

export function parseFault(params: unknown, channels: readonly string[] = []): FaultRequest {
  const record = asRecord(params, 'fault');
  const kind = requiredString(record.kind, 'kind', 32);
  if (!FAULT_KINDS.includes(kind as FaultKind)) invalid(`fault kind must be ${FAULT_KINDS.join('|')}`);
  const request: FaultRequest = {
    kind: kind as FaultKind,
    ...(record.channel === undefined ? {} : { channel: requiredString(record.channel, 'channel', 128) }),
    ...(record.event === undefined ? {} : { event: requiredString(record.event, 'event', 256) }),
    ...(record.count === undefined ? {} : { count: boundedInteger(record.count, 'count', 1, 10_000) }),
    ...(record.with === undefined ? {} : { with: asRecord(record.with, 'with') }),
    ...(record.exitCode === undefined ? {} : { exitCode: boundedInteger(record.exitCode, 'exitCode', 0, 255) }),
  };
  if (
    request.kind === 'channel-drop' &&
    (!request.channel || (channels.length > 0 && !channels.includes(request.channel)))
  ) {
    invalid(`channel-drop requires one of: ${channels.join('|')}`);
  }
  return request;
}

export function parseEmitted(params: unknown): EmittedEntry {
  const record = asRecord(params, 'emitted');
  return {
    at: requiredString(record.at, 'at', 64),
    sequence: boundedInteger(record.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER),
    event: requiredString(record.event, 'event', 256),
    ...(record.channel === undefined ? {} : { channel: requiredString(record.channel, 'channel', 128) }),
    ...(record.payload === undefined ? {} : { payload: asRecord(record.payload, 'payload') }),
    ...(record.truncated === undefined ? {} : { truncated: record.truncated === true }),
  };
}

// ---------------------------------------------------------------------------
// Native event-control derivation
// ---------------------------------------------------------------------------

/**
 * The console's trigger forms are generated from the ASM, never hand-listed —
 * an event the model does not describe is an event the imposter would refuse
 * to emit anyway (§7.3 item 3).
 */
export function nativeEventsFromModel(model: SurfaceModel): NativeEventDescriptor[] {
  return model.events.map((event) => ({
    event: event.event,
    fields: Object.keys(event.payloadSchema?.properties ?? {}).sort(),
    channel: event.channel,
    channels: [...event.channels],
    confidence: event.confidence,
    ...(event.transport === undefined ? {} : { transport: event.transport }),
    ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
    ...(event.notes === undefined ? {} : { notes: event.notes }),
  }));
}

/** Every `$op.<field>` reference in a binding template, at any depth. */
function opFields(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    const match = /^\$op\.([A-Za-z0-9_]+)$/.exec(value);
    if (match) into.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) return void value.forEach((entry) => opFields(entry, into));
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) opFields(entry, into);
  }
}

/**
 * The ops this persona binds, derived from ops.json rather than listed by hand
 * — an op the persona does not bind is an op the console must not offer as if
 * it produced traffic. The scenario driver's own description supplies the full
 * vocabulary, so the console can still show the authoring gap.
 */
export function opsFromPersona(persona: Pick<Persona, 'ops' | 'channelFor'>): OpDescriptor[] {
  return Object.entries(persona.ops).map(([op, bindings]) => {
    const fields = new Set<string>();
    for (const binding of bindings) opFields(binding.with, fields);
    return {
      op,
      channels: [...new Set(bindings.map((binding) => persona.channelFor(binding.channel) ?? binding.channel))],
      events: bindings.flatMap((binding) => (binding.event ? [binding.event] : [])),
      fields: [...fields].sort(),
      ...(bindings.some((binding) => binding.await) ? { awaits: true } : {}),
    };
  });
}
