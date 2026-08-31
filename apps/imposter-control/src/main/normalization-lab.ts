/**
 * Adapter normalization as an inspectable, downstream projection.
 *
 * This module is intentionally app-owned. Surface and Imposter remain the
 * native truth; the lab imports adapters and Core in the other direction and
 * can be removed without changing a single native emission. Native sequences
 * are folded once across a persistent logical state; snapshots and live
 * delivery converge through revisioned, gap-aware authoritative-log sync.
 */
import { ClaudeHookNormalizer, type ClaudeHookPayload } from '@vibecook/puppeteer-adapter-claude';
import { CodexNotificationNormalizer, type CodexServerNotification } from '@vibecook/puppeteer-adapter-codex';
import { AntigravityTranscriptNormalizer } from '@vibecook/puppeteer-adapter-antigravity';
import { CopilotSessionNormalizer } from '@vibecook/puppeteer-adapter-copilot';
import { KimiWireNormalizer } from '@vibecook/puppeteer-adapter-kimi';
import { HermesGatewayNormalizer } from '@vibecook/puppeteer-adapter-hermes';
import { OpenCodeNormalizer, type OpenCodeSseRecord } from '@vibecook/puppeteer-adapter-opencode';
import { PiSessionNormalizer } from '@vibecook/puppeteer-adapter-pi';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEvent,
  type AgentEventConfidence,
  type AgentEventEnvelope,
  type AgentEventSource,
  type EnvelopeStamper,
  type SessionRuntimeState,
} from '@vibecook/puppeteer-core';
import type { EmittedEntry, SessionView } from '@vibecook/puppeteer-imposter/control';
import type { ControlPlaneProjection } from './plane.js';

/** One shared presentation window for native evidence and normalized traces. */
export const NORMALIZATION_WINDOW_RECORDS = 300;
/** Bound records waiting behind an unresolved native-sequence gap. */
const MAX_PENDING_RECORDS = 500;
const MAX_STATE_CHANGES = 200;

export type NormalizationDisposition =
  'mapped' | 'retained-native' | 'buffered' | 'no-output' | 'driver-owned' | 'unsupported' | 'blocked' | 'error';

export interface NormalizedEventView {
  sequence: number;
  timestamp: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  promptId?: string;
  turnId?: string;
  event: AgentEvent;
}

export interface NormalizedStateChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface NormalizationTrace {
  id: string;
  nativeSequence: number;
  native: EmittedEntry;
  ruleId: string;
  disposition: NormalizationDisposition;
  explanation: string;
  events: NormalizedEventView[];
  stateBefore: Record<string, unknown>;
  stateAfter: Record<string, unknown>;
  changes: NormalizedStateChange[];
}

export interface NormalizationCoverage {
  total: number;
  mapped: number;
  retainedNative: number;
  buffered: number;
  noOutput: number;
  driverOwned: number;
  unsupported: number;
  blocked: number;
  errors: number;
}

export interface NativeSequenceGap {
  from: number;
  to: number;
}

export interface NormalizationSnapshot {
  projection: 'normalization';
  mode: 'pure-normalizer';
  vendor: string;
  version: string;
  sessionId: string;
  revision: number;
  supported: boolean;
  complete: boolean;
  processedThroughSequence: number;
  observedThroughSequence: number;
  windowStartSequence?: number;
  windowEndSequence?: number;
  gaps: NativeSequenceGap[];
  limitations: string[];
  traces: NormalizationTrace[];
  state: Record<string, unknown>;
  coverage: NormalizationCoverage;
}

export interface NormalizationUpdate {
  revision: number;
  complete: boolean;
  processedThroughSequence: number;
  observedThroughSequence: number;
  windowStartSequence?: number;
  windowEndSequence?: number;
  gaps: NativeSequenceGap[];
  limitations: string[];
  fromNativeSequence: number;
  traces: NormalizationTrace[];
  state: Record<string, unknown>;
  coverage: NormalizationCoverage;
}

interface NormalizerResult {
  events: AgentEvent[];
  promptId?: string;
  turnId?: string;
  source: AgentEventSource;
  confidence?: AgentEventConfidence;
  timestamp?: string;
  nativeEvent: unknown;
  disposition?: NormalizationDisposition;
  explanation?: string;
}

interface NativeNormalizer {
  normalize(session: SessionView, entry: EmittedEntry): NormalizerResult;
}

interface LabSession {
  view: SessionView;
  normalizer: NativeNormalizer | undefined;
  stamper: EnvelopeStamper;
  pending: Map<number, EmittedEntry>;
  traces: Map<number, NormalizationTrace>;
  state: SessionRuntimeState;
  processedThroughSequence: number;
  observedThroughSequence: number;
  pendingOverflowed: boolean;
  revision: number;
}

function plain(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entry]) => ({ key, value: plain(entry) }));
  }
  if (value instanceof Set) {
    return [...value].map(plain).sort((left, right) => String(left).localeCompare(String(right)));
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, plain(entry)]),
    );
  }
  return value;
}

function stateView(state: SessionRuntimeState): Record<string, unknown> {
  return plain(state) as Record<string, unknown>;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stateChanges(
  before: unknown,
  after: unknown,
  path = '',
  changes: NormalizedStateChange[] = [],
): NormalizedStateChange[] {
  if (changes.length >= MAX_STATE_CHANGES || equal(before, after)) return changes;
  const beforeRecord = before !== null && typeof before === 'object' && !Array.isArray(before);
  const afterRecord = after !== null && typeof after === 'object' && !Array.isArray(after);
  if (beforeRecord && afterRecord) {
    const keys = new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ]);
    for (const key of [...keys].sort()) {
      stateChanges(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        changes,
      );
      if (changes.length >= MAX_STATE_CHANGES) break;
    }
    return changes;
  }
  changes.push({
    path: path || '$',
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  });
  return changes;
}

function descriptorFor(session: SessionView, entry: EmittedEntry) {
  return session.nativeEvents.find((descriptor) => descriptor.event === entry.event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createNormalizer(view: SessionView): NativeNormalizer | undefined {
  const { vendor } = view;
  if (vendor === 'antigravity') {
    const normalizer = new AntigravityTranscriptNormalizer();
    return {
      normalize(_session, entry) {
        const nativeEvent = {
          ...(entry.payload ?? {}),
          type: entry.event,
          created_at: entry.at,
          step_index: entry.sequence - 1,
        };
        const normalized = normalizer.normalize(nativeEvent);
        return {
          events: normalized.events,
          promptId: normalized.promptId,
          turnId: normalized.turnId,
          source: normalized.source,
          confidence: normalized.confidence,
          timestamp: normalized.timestamp,
          nativeEvent,
          disposition: normalized.disposition,
        };
      },
    };
  }

  if (vendor === 'claude') {
    const normalizer = new ClaudeHookNormalizer();
    return {
      normalize(_session, entry) {
        const body = {
          ...(entry.payload ?? {}),
          hook_event_name: entry.payload?.hook_event_name ?? entry.event,
        } as ClaudeHookPayload;
        const normalized = normalizer.normalize(body);
        return {
          events: normalized.events,
          promptId: normalized.promptId,
          turnId: normalized.turnId,
          source: 'native-hook',
          nativeEvent: body,
        };
      },
    };
  }

  if (vendor === 'codex') {
    const normalizer = new CodexNotificationNormalizer();
    return {
      normalize(session, entry) {
        const descriptor = descriptorFor(session, entry);
        if (descriptor?.transport === 'jsonrpc-request') {
          return {
            events: [],
            source: 'native-protocol',
            nativeEvent: { method: entry.event, params: entry.payload ?? {} },
            disposition: 'driver-owned',
            explanation:
              'Server requests are normalized by the live driver because their request id and client decision are not present in the Imposter emission record.',
          };
        }
        const nativeEvent: CodexServerNotification = { method: entry.event, params: entry.payload ?? {} };
        const normalized = normalizer.normalize(nativeEvent);
        return {
          events: normalized.events,
          turnId: normalized.turnId,
          source: 'native-protocol',
          nativeEvent,
          ...(normalized.events.length === 0 && entry.event === 'turn/started'
            ? {
                disposition: 'buffered' as const,
                explanation: 'Codex defers turn:started until the matching userMessage item supplies the prompt.',
              }
            : {}),
        };
      },
    };
  }

  if (vendor === 'copilot') {
    const normalizer = new CopilotSessionNormalizer();
    return {
      normalize(_session, entry) {
        const nativeEvent = {
          type: entry.event,
          id: `control:${entry.sequence}`,
          timestamp: entry.at,
          data: entry.payload ?? {},
        };
        const normalized = normalizer.normalize(nativeEvent);
        return {
          events: normalized.events,
          promptId: normalized.promptId,
          turnId: normalized.turnId,
          source: normalized.source,
          confidence: normalized.confidence,
          timestamp: normalized.timestamp,
          nativeEvent,
          disposition: normalized.disposition,
        };
      },
    };
  }

  if (vendor === 'kimi') {
    const normalizer = new KimiWireNormalizer();
    return {
      normalize(session, entry) {
        const descriptor = descriptorFor(session, entry);
        const payload = entry.payload ?? {};
        const nativeEvent = {
          ...payload,
          type: entry.event,
          time: payload.time ?? Date.parse(entry.at),
        };
        if (descriptor?.transport !== 'jsonl-record') {
          return {
            events: [],
            source: descriptor?.transport === 'command-stdin' ? 'native-hook' : 'native-log',
            nativeEvent,
            disposition: 'no-output',
            explanation:
              'Kimi portable state is normalized from its authoritative wire journal; hook and state mirrors remain visible only on the native side to avoid double counting.',
          };
        }
        const normalized = normalizer.normalize(nativeEvent);
        return {
          events: normalized.events,
          promptId: normalized.promptId,
          turnId: normalized.turnId,
          source: normalized.source,
          confidence: normalized.confidence,
          timestamp: normalized.timestamp,
          nativeEvent: normalized.nativeEvent,
          disposition: normalized.disposition,
          explanation: normalized.explanation,
        };
      },
    };
  }

  if (vendor === 'hermes') {
    const normalizer = new HermesGatewayNormalizer();
    return {
      normalize(_session, entry) {
        const payload = entry.payload ?? {};
        const liveSessionId =
          typeof payload.session_id === 'string'
            ? payload.session_id
            : typeof payload.stored_session_id === 'string'
              ? payload.stored_session_id
              : view.sessionId;
        const nativeEvent = {
          method: 'event',
          params: { type: entry.event, session_id: liveSessionId, payload },
        };
        const normalized = normalizer.normalize(nativeEvent);
        return {
          events: normalized.events,
          turnId: normalized.turnId,
          source: normalized.source,
          confidence: normalized.confidence,
          nativeEvent,
          disposition: normalized.disposition === 'no-output' ? 'no-output' : undefined,
        };
      },
    };
  }

  if (vendor === 'opencode') {
    const normalizer = new OpenCodeNormalizer({ sessionID: view.sessionId });
    const knownMessages = new Set<string>();
    return {
      normalize(_session, entry) {
        const properties = entry.payload ?? {};
        const info = isRecord(properties.info) ? properties.info : undefined;
        const part = isRecord(properties.part) ? properties.part : undefined;
        const messageID =
          typeof part?.messageID === 'string'
            ? part.messageID
            : typeof properties.messageID === 'string'
              ? properties.messageID
              : undefined;
        const partArrivedBeforeMessage = messageID !== undefined && !knownMessages.has(messageID);
        const nativeEvent: OpenCodeSseRecord = {
          id: `control:${entry.sequence}`,
          type: entry.event,
          properties,
        };
        const normalized = normalizer.normalize(nativeEvent);
        if (entry.event === 'message.updated' && typeof info?.id === 'string') knownMessages.add(info.id);
        const first = normalized[0];
        const establishesAssistantCorrelation =
          entry.event === 'message.updated' && info?.role === 'assistant' && normalized.length === 0;
        const buffered = normalized.length === 0 && (partArrivedBeforeMessage || establishesAssistantCorrelation);
        return {
          events: normalized.map((event) => event.event),
          promptId: first?.promptId,
          turnId: first?.turnId,
          source: first?.source ?? 'native-protocol',
          confidence: first?.confidence,
          timestamp: first?.timestamp ?? entry.at,
          nativeEvent,
          ...(buffered
            ? {
                disposition: 'buffered' as const,
                explanation: partArrivedBeforeMessage
                  ? 'OpenCode retained this part until its owning message supplied role and turn correlation.'
                  : 'OpenCode retained this assistant message as correlation state for its parts and turn.',
              }
            : {}),
        };
      },
    };
  }

  if (vendor === 'pi') {
    const normalizer = new PiSessionNormalizer();
    return {
      normalize(_session, entry) {
        const nativeEvent = {
          id: `control:${entry.sequence}`,
          timestamp: entry.at,
          ...(entry.payload ?? {}),
          type: entry.event,
        };
        const normalized = normalizer.normalize(nativeEvent);
        return {
          events: normalized.events,
          promptId: normalized.promptId,
          turnId: normalized.turnId,
          source: normalized.source,
          confidence: normalized.confidence,
          timestamp: normalized.timestamp,
          nativeEvent,
          disposition: normalized.disposition,
        };
      },
    };
  }

  return undefined;
}

function dispositionFor(result: NormalizerResult): NormalizationDisposition {
  if (result.disposition) return result.disposition;
  if (result.events.length === 0) return 'no-output';
  return result.events.every((event) => event.type === 'adapter:native-event') ? 'retained-native' : 'mapped';
}

function explanationFor(entry: EmittedEntry, result: NormalizerResult, disposition: NormalizationDisposition): string {
  if (result.explanation) return result.explanation;
  const outputs = result.events.map((event) => event.type);
  switch (disposition) {
    case 'mapped':
      return `${entry.event} produced ${outputs.join(', ')}.`;
    case 'retained-native':
      return `${entry.event} has no portable interpretation; the adapter retained its native identity.`;
    case 'buffered':
      return `${entry.event} updated normalizer correlation state and intentionally emitted nothing yet.`;
    case 'no-output':
      return `${entry.event} produced no portable event; inspect the adapter to distinguish filtering from stateful buffering.`;
    case 'driver-owned':
      return `${entry.event} requires driver context that a pure normalizer replay does not possess.`;
    case 'unsupported':
      return `No pure ${entry.event} normalizer is wired for this vendor yet.`;
    case 'blocked':
      return `${entry.event} is waiting behind missing native evidence and has not been normalized.`;
    case 'error':
      return `The adapter normalizer rejected ${entry.event}.`;
  }
}

function emptyCoverage(): NormalizationCoverage {
  return {
    total: 0,
    mapped: 0,
    retainedNative: 0,
    buffered: 0,
    noOutput: 0,
    driverOwned: 0,
    unsupported: 0,
    blocked: 0,
    errors: 0,
  };
}

function coverageFor(traces: readonly NormalizationTrace[]): NormalizationCoverage {
  const coverage = emptyCoverage();
  coverage.total = traces.length;
  for (const trace of traces) {
    switch (trace.disposition) {
      case 'mapped':
        coverage.mapped += 1;
        break;
      case 'retained-native':
        coverage.retainedNative += 1;
        break;
      case 'buffered':
        coverage.buffered += 1;
        break;
      case 'no-output':
        coverage.noOutput += 1;
        break;
      case 'driver-owned':
        coverage.driverOwned += 1;
        break;
      case 'unsupported':
        coverage.unsupported += 1;
        break;
      case 'blocked':
        coverage.blocked += 1;
        break;
      case 'error':
        coverage.errors += 1;
        break;
    }
  }
  return coverage;
}

function limitationsFor(vendor: string, supported: boolean): string[] {
  if (!supported) {
    return [
      'This vendor composes multiple native rails in its driver; a pure emitted-record normalizer is not available yet.',
    ];
  }
  if (vendor === 'kimi') {
    return [
      'This projection replays the authoritative main-agent wire journal; hook and state mirrors are shown natively but are not reduced twice.',
      'Private subagent journals require their journal identity from the live observer and are not reconstructed from the flat control log.',
      'This view exercises the pure normalizer; prompt injection, session discovery, tailing, and replay boundaries remain driver-conformance concerns.',
    ];
  }
  if (vendor === 'antigravity') {
    return [
      'This projection rebuilds transcript envelope fields from the ordered control log; the live observer remains authoritative for file cursor and replay boundaries.',
      'Antigravity turn and tool correlation is derived because the native transcript exposes step indexes and result kinds rather than stable portable identifiers.',
    ];
  }
  if (vendor === 'copilot') {
    return [
      'This projection rebuilds Copilot journal envelopes around control-log payloads; live file identity, parent links, cursor boundaries, and singleton replay remain observer-conformance concerns.',
      'The projection exercises the stateful session normalizer, not native launch, resume, or prompt injection.',
    ];
  }
  if (vendor === 'pi') {
    return [
      'This projection rebuilds Pi journal envelope fields around control-log payloads; live entry identity, parent links, cursor boundaries, and branch selection remain observer-conformance concerns.',
      'The projection exercises the stateful session normalizer, not native launch, resume, or prompt injection.',
    ];
  }
  if (vendor === 'opencode') {
    return [
      'This projection replays native SSE payloads through the OpenCode normalizer; stable control-log sequence ids stand in for SSE event ids.',
      'Native duplicate-id suppression, reconnect, REST hydration, blocker reconciliation, prompt receipts, and exact attach remain adapter-conformance concerns.',
    ];
  }
  if (vendor === 'hermes') {
    return [
      'This projection replays tui_gateway notifications through the Hermes normalizer. Plugin-hook copies are retained natively.',
      'Owned-gateway attach, prompt receipts, and native-TUI approvals remain adapter-conformance concerns.',
    ];
  }
  return [
    'This first slice exercises the adapter normalizer directly, not the complete launch/transport driver.',
    'Transcript and statusline records are not yet mirrored by the Imposter control log.',
    'Driver-owned request ids, decisions, and runtime-derived events require the later paired-session mode.',
  ];
}

function rememberTrace(session: LabSession, trace: NormalizationTrace): void {
  session.traces.set(trace.nativeSequence, trace);
  while (session.traces.size > NORMALIZATION_WINDOW_RECORDS) {
    const oldest = Math.min(...session.traces.keys());
    session.traces.delete(oldest);
  }
}

function processEntry(session: LabSession, entry: EmittedEntry): void {
  const before = stateView(session.state);
  let result: NormalizerResult;
  try {
    result = session.normalizer
      ? session.normalizer.normalize(session.view, entry)
      : {
          events: [],
          source: 'native-protocol',
          nativeEvent: entry.payload,
          disposition: 'unsupported',
        };
  } catch (error) {
    result = {
      events: [],
      source: session.view.vendor === 'claude' ? 'native-hook' : 'native-protocol',
      nativeEvent: entry.payload,
      disposition: 'error',
      explanation: error instanceof Error ? error.message : String(error),
    };
  }

  const envelopes: AgentEventEnvelope[] = [];
  for (const event of result.events) {
    const envelope = session.stamper.next({
      sessionId: session.view.sessionId,
      nativeSessionId: session.view.sessionId,
      ...(result.promptId === undefined ? {} : { promptId: result.promptId }),
      ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
      timestamp: result.timestamp ?? entry.at,
      monotonicTime: entry.sequence,
      source: result.source,
      confidence: result.confidence ?? 'authoritative',
      event,
      nativeEvent: result.nativeEvent,
    });
    session.state = reduceSessionState(session.state, envelope);
    envelopes.push(envelope);
  }
  const after = stateView(session.state);
  const disposition = dispositionFor(result);
  rememberTrace(session, {
    id: `${session.view.vendor}:${session.view.sessionId}:${entry.sequence}`,
    nativeSequence: entry.sequence,
    native: entry,
    ruleId: `${session.view.vendor}.${entry.event}`,
    disposition,
    explanation: explanationFor(entry, result, disposition),
    events: envelopes.map(({ sequence, timestamp, source, confidence, promptId, turnId, event }) => ({
      sequence,
      timestamp,
      source,
      confidence,
      ...(promptId === undefined ? {} : { promptId }),
      ...(turnId === undefined ? {} : { turnId }),
      event,
    })),
    stateBefore: before,
    stateAfter: after,
    changes: stateChanges(before, after),
  });
}

function gapsFor(session: LabSession): NativeSequenceGap[] {
  const gaps: NativeSequenceGap[] = [];
  let expected = session.processedThroughSequence + 1;
  for (const sequence of [...session.pending.keys()].sort((left, right) => left - right)) {
    if (sequence > expected) gaps.push({ from: expected, to: sequence - 1 });
    expected = sequence + 1;
  }
  if (expected <= session.observedThroughSequence) {
    gaps.push({ from: expected, to: session.observedThroughSequence });
  }
  return gaps;
}

function refreshBlockedTraces(session: LabSession): void {
  for (const [sequence, trace] of session.traces) {
    if (trace.disposition === 'blocked' && !session.pending.has(sequence)) session.traces.delete(sequence);
  }
  if (session.pending.size === 0) return;
  const gap = gapsFor(session)[0];
  const state = stateView(session.state);
  for (const entry of session.pending.values()) {
    rememberTrace(session, {
      id: `${session.view.vendor}:${session.view.sessionId}:${entry.sequence}`,
      nativeSequence: entry.sequence,
      native: entry,
      ruleId: `${session.view.vendor}.${entry.event}`,
      disposition: 'blocked',
      explanation: gap
        ? `Missing native sequence ${gap.from}${gap.to === gap.from ? '' : `..${gap.to}`}; ${entry.event} is held until the authoritative log closes the gap.`
        : `${entry.event} is waiting for preceding native evidence.`,
      events: [],
      stateBefore: state,
      stateAfter: state,
      changes: [],
    });
  }
}

function drainContiguous(session: LabSession): void {
  let next: EmittedEntry | undefined;
  while ((next = session.pending.get(session.processedThroughSequence + 1)) !== undefined) {
    session.pending.delete(next.sequence);
    processEntry(session, next);
    session.processedThroughSequence = next.sequence;
  }
}

function addEntries(session: LabSession, entries: readonly EmittedEntry[]): number | undefined {
  let firstNewSequence: number | undefined;
  for (const entry of [...entries].sort((left, right) => left.sequence - right.sequence)) {
    if (entry.sequence <= session.processedThroughSequence || session.pending.has(entry.sequence)) continue;
    session.pending.set(entry.sequence, entry);
    session.observedThroughSequence = Math.max(session.observedThroughSequence, entry.sequence);
    firstNewSequence = Math.min(firstNewSequence ?? entry.sequence, entry.sequence);
    drainContiguous(session);
    while (session.pending.size > MAX_PENDING_RECORDS) {
      // Preserve the records nearest the gap. Evicting the oldest pending
      // record would discard the very sequence required to make progress and
      // could leave the projection permanently stuck even after backfill.
      const farthest = Math.max(...session.pending.keys());
      session.pending.delete(farthest);
      session.pendingOverflowed = true;
    }
  }
  if (firstNewSequence === undefined) return undefined;
  refreshBlockedTraces(session);
  if (session.processedThroughSequence === session.observedThroughSequence) {
    session.pendingOverflowed = false;
  }
  session.revision += 1;
  return firstNewSequence;
}

function sortedTraces(session: LabSession): NormalizationTrace[] {
  return [...session.traces.values()].sort((left, right) => left.nativeSequence - right.nativeSequence);
}

function windowFor(traces: readonly NormalizationTrace[]): {
  windowStartSequence?: number;
  windowEndSequence?: number;
} {
  if (traces.length === 0) return {};
  return {
    windowStartSequence: traces[0]!.nativeSequence,
    windowEndSequence: traces.at(-1)!.nativeSequence,
  };
}

function snapshotFor(session: LabSession): NormalizationSnapshot {
  const supported = session.normalizer !== undefined;
  const traces = sortedTraces(session);
  const complete = session.processedThroughSequence === session.observedThroughSequence;
  const limitations = limitationsFor(session.view.vendor, supported);
  if (!complete) {
    limitations.push(
      'Normalized state is paused at the last contiguous native sequence until log backfill closes the reported gap.',
    );
  }
  if (session.pendingOverflowed) {
    limitations.push(
      'Pending evidence exceeded the in-memory bound; a later authoritative replay must restore the released farthest records before this projection can become complete.',
    );
  }
  return {
    projection: 'normalization',
    mode: 'pure-normalizer',
    vendor: session.view.vendor,
    version: session.view.version,
    sessionId: session.view.sessionId,
    revision: session.revision,
    supported,
    complete,
    processedThroughSequence: session.processedThroughSequence,
    observedThroughSequence: session.observedThroughSequence,
    ...windowFor(traces),
    gaps: gapsFor(session),
    limitations,
    traces,
    state: stateView(session.state),
    coverage: coverageFor(traces),
  };
}

function updateFor(session: LabSession, firstChangedSequence: number): NormalizationUpdate {
  const snapshot = snapshotFor(session);
  const fromNativeSequence = Math.max(snapshot.windowStartSequence ?? firstChangedSequence, firstChangedSequence);
  return {
    revision: snapshot.revision,
    complete: snapshot.complete,
    processedThroughSequence: snapshot.processedThroughSequence,
    observedThroughSequence: snapshot.observedThroughSequence,
    ...(snapshot.windowStartSequence === undefined ? {} : { windowStartSequence: snapshot.windowStartSequence }),
    ...(snapshot.windowEndSequence === undefined ? {} : { windowEndSequence: snapshot.windowEndSequence }),
    gaps: snapshot.gaps,
    limitations: snapshot.limitations,
    fromNativeSequence,
    traces: snapshot.traces.filter((trace) => trace.nativeSequence >= fromNativeSequence),
    state: snapshot.state,
    coverage: snapshot.coverage,
  };
}

/** Create the app-owned projection consumed by the normalization workbench. */
export function createNormalizationLab(): ControlPlaneProjection {
  const sessions = new Map<string, LabSession>();
  const keyFor = (view: SessionView): string => `${view.vendor}\0${view.sessionId}`;
  const ensure = (view: SessionView): LabSession => {
    const key = keyFor(view);
    let session = sessions.get(key);
    if (!session) {
      session = {
        view,
        normalizer: createNormalizer(view),
        stamper: createEnvelopeStamper(),
        pending: new Map(),
        traces: new Map(),
        state: createInitialSessionState(),
        processedThroughSequence: 0,
        observedThroughSequence: 0,
        pendingOverflowed: false,
        revision: 0,
      };
      sessions.set(key, session);
    } else {
      session.view = view;
    }
    return session;
  };

  return {
    id: 'normalization',
    join(view) {
      ensure(view);
    },
    ingest(view, entry): NormalizationUpdate | undefined {
      const session = ensure(view);
      const firstChangedSequence = addEntries(session, [entry]);
      return firstChangedSequence === undefined ? undefined : updateFor(session, firstChangedSequence);
    },
    synchronize(view, entries): NormalizationSnapshot {
      const session = ensure(view);
      addEntries(session, entries);
      return snapshotFor(session);
    },
    snapshot(view): NormalizationSnapshot {
      return snapshotFor(ensure(view));
    },
    leave(view) {
      sessions.delete(keyFor(view));
    },
  };
}
