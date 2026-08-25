/** Stateful OpenCode HTTP/SSE -> Core event normalization. */

import type { AgentEvent, AgentEventConfidence, AgentEventSource, ToolPresentation } from '@vibecook/chopsticks-core';
import type { OpenCodeSessionInfo } from './client.js';
import type { OpenCodeSseRecord } from './event-stream.js';
import { openCodeStructuredQuestions } from './monitor-evidence.js';

/**
 * Claim-addressable sources for every portable mapping in this file. Paths are
 * relative to `packages/surface/vendors/opencode/model/opencode@1.18.16/`.
 * The behavior-node ids carry the independently evidenced semantic ordering.
 */
export const OPENCODE_NORMALIZATION_EVIDENCE = {
  session: ['events/session.created.json', 'events/session.updated.json', 'behavior.json#session-created'],
  turn: ['events/message.updated.json', 'events/session.status.json', 'behavior.json#user-message'],
  assistant: [
    'events/message.part.updated.json',
    'events/message.part.delta.json',
    'behavior.json#assistant-message',
    'behavior.json#text-delta',
  ],
  reasoning: ['events/message.part.updated.json', 'events/message.part.delta.json', 'behavior.json#reasoning-part'],
  tool: ['events/message.part.updated.json', 'behavior.json#tool-pending'],
  permission: ['events/permission.asked.json', 'events/permission.replied.json', 'behavior.json#permission-asked'],
  question: [
    'events/question.asked.json',
    'events/question.replied.json',
    'events/question.rejected.json',
    'behavior.json#question-asked',
  ],
  failure: ['events/session.error.json', 'behavior.json#session-error'],
  context: [
    'events/message.part.updated.json',
    'events/session.compacted.json',
    'behavior.json#session-compacted-manual',
    'behavior.json#session-compacted-auto',
    'behavior.json#session-compacted-overflow',
  ],
  deletion: ['events/session.deleted.json', 'behavior.json#session-deleted'],
  subagent: [
    'events/session.created.json',
    'events/session.idle.json',
    'behavior.json#subagent-child-created',
    'behavior.json#subagent-child-idle',
    'behavior.json#subagent-background-task-completed',
  ],
} as const;

export interface OpenCodeNormalizedEvent {
  event: AgentEvent;
  promptId?: string;
  turnId?: string;
  timestamp: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  replay?: boolean;
  nativeEvent: unknown;
}

export interface NormalizeOpenCodeOptions {
  replay?: boolean;
  /** Durable HTTP projections retain their source response here. */
  nativeEvent?: unknown;
}

export interface OpenCodeNormalizerOptions {
  sessionID: string;
  contextWindowCapacityTokens?: number;
  maxSeenEventIds?: number;
  maxCorrelationEntries?: number;
}

interface TextPartState {
  kind: 'text' | 'reasoning';
  text: string;
  final: boolean;
}

interface ChildSessionState {
  started: boolean;
  stopped: boolean;
}

const FILTERED_INFRASTRUCTURE = new Set([
  'server.connected',
  'server.heartbeat',
  'plugin.added',
  'catalog.updated',
  'integration.updated',
  'integration.connection.updated',
  'reference.updated',
  'models-dev.refreshed',
  'session.diff',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isoTimestamp(...values: unknown[]): string {
  for (const value of values) {
    const milliseconds = number(value);
    if (milliseconds !== undefined) return new Date(milliseconds).toISOString();
  }
  return new Date().toISOString();
}

function nestedTimestamp(properties: Record<string, unknown>): string {
  const info = isRecord(properties.info) ? properties.info : undefined;
  const part = isRecord(properties.part) ? properties.part : undefined;
  const infoTime = isRecord(info?.time) ? info.time : undefined;
  const partTime = isRecord(part?.time) ? part.time : undefined;
  return isoTimestamp(
    properties.time,
    partTime?.end,
    partTime?.start,
    infoTime?.completed,
    infoTime?.updated,
    infoTime?.created,
  );
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return text(value);
  const data = isRecord(value.data) ? value.data : undefined;
  return text(data?.message) ?? text(value.message) ?? text(value.name);
}

function toolPresentation(tool: string, input: unknown): ToolPresentation {
  const lower = tool.toLowerCase();
  const record = isRecord(input) ? input : undefined;
  const detail = text(record?.command) ?? text(record?.filePath) ?? text(record?.path) ?? text(record?.url);
  const kind: ToolPresentation['kind'] =
    lower === 'bash' || lower.includes('shell')
      ? 'command'
      : lower === 'read'
        ? 'file-read'
        : ['write', 'edit', 'apply_patch', 'patch'].includes(lower)
          ? 'file-edit'
          : lower.includes('web')
            ? 'web-search'
            : lower.includes('browser')
              ? 'browser'
              : lower.includes('mcp')
                ? 'mcp'
                : 'other';
  return { kind, title: tool, ...(detail ? { detail } : {}) };
}

function boundedAdd<T>(set: Set<T>, value: T, maximum: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > maximum) {
    const oldest = set.values().next().value as T | undefined;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export class OpenCodeNormalizer {
  readonly sessionID: string;
  private readonly maxSeenEventIds: number;
  private readonly maxCorrelationEntries: number;
  private readonly contextWindowCapacityTokens: number | undefined;
  private readonly seenEventIds = new Set<string>();
  private readonly seenUserMessages = new Set<string>();
  private readonly completedTurns = new Set<string>();
  private readonly messageRoles = new Map<string, 'user' | 'assistant'>();
  private readonly messageTurns = new Map<string, string>();
  private readonly assistantMessagesByTurn = new Map<string, string[]>();
  private readonly completedAssistantMessages = new Set<string>();
  private readonly partStates = new Map<string, TextPartState>();
  private readonly textPartsByMessage = new Map<string, Map<string, string>>();
  private readonly pendingParts = new Map<string, OpenCodeSseRecord[]>();
  private readonly toolStates = new Map<string, 'requested' | 'running' | 'completed' | 'failed'>();
  private readonly permissionStates = new Map<string, 'requested' | 'resolved'>();
  private readonly questionStates = new Map<string, 'requested' | 'resolved'>();
  private readonly childStates = new Map<string, ChildSessionState>();
  private activeTurnID: string | undefined;
  private pendingFailure: { turnID: string; error?: string } | undefined;
  private sessionStarted = false;
  private exited = false;
  private currentDirectory: string | undefined;
  private currentModelID: string | undefined;
  private lastContextUsage: string | undefined;

  constructor(options: OpenCodeNormalizerOptions) {
    this.sessionID = options.sessionID;
    this.maxSeenEventIds = options.maxSeenEventIds ?? 4096;
    this.maxCorrelationEntries = options.maxCorrelationEntries ?? 1024;
    this.contextWindowCapacityTokens = options.contextWindowCapacityTokens;
  }

  normalizeSession(
    info: OpenCodeSessionInfo | Record<string, unknown>,
    options: NormalizeOpenCodeOptions = {},
  ): OpenCodeNormalizedEvent[] {
    if (info.id !== this.sessionID) return [];
    const nativeEvent = options.nativeEvent ?? { type: 'http/session.get', body: info };
    const timestamp = isoTimestamp(
      isRecord(info.time) ? info.time.updated : undefined,
      isRecord(info.time) ? info.time.created : undefined,
    );
    const events: OpenCodeNormalizedEvent[] = [];
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      events.push(
        this.output(
          {
            type: 'session.started',
            nativeSessionId: this.sessionID,
            ...(text(info.title) ? { title: text(info.title) } : {}),
          },
          timestamp,
          options,
          nativeEvent,
        ),
      );
    }
    events.push(...this.environmentEvents(info, timestamp, options, nativeEvent));
    return events;
  }

  normalize(record: OpenCodeSseRecord, options: NormalizeOpenCodeOptions = {}): OpenCodeNormalizedEvent[] {
    if (this.seenEventIds.has(record.id)) return [];
    boundedAdd(this.seenEventIds, record.id, this.maxSeenEventIds);
    const timestamp = nestedTimestamp(record.properties);
    const childID = this.childRecordID(record);
    if (childID) return this.normalizeChild(record, childID, timestamp, options);
    if (!this.belongsToSession(record)) return [];

    switch (record.type) {
      case 'session.created': {
        const info = isRecord(record.properties.info) ? record.properties.info : undefined;
        return info ? this.normalizeSession(info, { ...options, nativeEvent: options.nativeEvent ?? record }) : [];
      }
      case 'session.updated': {
        const info = isRecord(record.properties.info) ? record.properties.info : undefined;
        if (!info) return [this.native(record, timestamp, options)];
        return [
          ...this.environmentEvents(info, timestamp, options, options.nativeEvent ?? record),
          this.native(record, timestamp, options),
        ];
      }
      case 'session.deleted':
        return this.deleteSession(record, timestamp, options);
      case 'message.updated':
        return this.messageUpdated(record, timestamp, options);
      case 'message.part.updated':
        return this.partUpdated(record, timestamp, options);
      case 'message.part.delta':
        return this.partDelta(record, timestamp, options);
      case 'session.status':
        return this.sessionStatus(record, timestamp, options);
      case 'session.idle':
        return this.completeTurn(record, timestamp, options, 'idle');
      case 'session.error':
        return this.notePendingFailure(record, timestamp, options);
      case 'permission.asked':
        return this.permissionAsked(record, timestamp, options);
      case 'permission.replied':
        return this.permissionReplied(record, timestamp, options);
      case 'session.compacted':
        return [
          this.output(
            { type: 'context-window.invalidated', reason: 'compacted' },
            timestamp,
            options,
            options.nativeEvent ?? record,
          ),
        ];
      case 'question.asked':
        return this.questionAsked(record, timestamp, options);
      case 'question.replied':
      case 'question.rejected':
        return this.questionResolved(record, timestamp, options);
      case 'file.edited':
      case 'file.watcher.updated':
      case 'message.part.removed':
      case 'message.removed':
        return [this.native(record, timestamp, options)];
      default:
        return FILTERED_INFRASTRUCTURE.has(record.type) ? [] : [this.native(record, timestamp, options)];
    }
  }

  private recordSessionID(record: OpenCodeSseRecord): string | undefined {
    const info = isRecord(record.properties.info) ? record.properties.info : undefined;
    const direct = text(record.properties.sessionID) ?? text(info?.sessionID);
    if (direct) return direct;
    const infoID = text(info?.id);
    if (
      infoID &&
      (record.type === 'session.created' || record.type === 'session.updated' || record.type === 'session.deleted')
    ) {
      return infoID;
    }
    return undefined;
  }

  private childRecordID(record: OpenCodeSseRecord): string | undefined {
    const sessionID = this.recordSessionID(record);
    if (!sessionID || sessionID === this.sessionID) return undefined;
    if (this.childStates.has(sessionID)) return sessionID;
    const info = isRecord(record.properties.info) ? record.properties.info : undefined;
    return text(info?.parentID) === this.sessionID ? sessionID : undefined;
  }

  private belongsToSession(record: OpenCodeSseRecord): boolean {
    const sessionID = this.recordSessionID(record);
    return sessionID === undefined || sessionID === this.sessionID;
  }

  private normalizeChild(
    record: OpenCodeSseRecord,
    childID: string,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const info = isRecord(record.properties.info) ? record.properties.info : undefined;
    if (record.type === 'session.created' || record.type === 'session.updated') {
      return this.startChild(childID, text(info?.agent), timestamp, options, options.nativeEvent ?? record);
    }
    const status = isRecord(record.properties.status) ? record.properties.status : undefined;
    if (
      record.type === 'session.idle' ||
      record.type === 'session.deleted' ||
      (record.type === 'session.status' && status?.type === 'idle')
    ) {
      return this.stopChild(childID, timestamp, options, options.nativeEvent ?? record);
    }
    return [];
  }

  private startChild(
    childID: string,
    agentType: string | undefined,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
    nativeEvent: unknown,
  ): OpenCodeNormalizedEvent[] {
    const existing = this.childStates.get(childID);
    if (existing?.started || existing?.stopped) return [];
    boundedMapSet(this.childStates, childID, { started: true, stopped: false }, this.maxCorrelationEntries);
    return [
      this.output(
        {
          type: 'subagent.started',
          subagentId: childID,
          ...(agentType ? { agentType } : {}),
        },
        timestamp,
        options,
        nativeEvent,
        this.activeTurnID ? { promptId: this.activeTurnID, turnId: this.activeTurnID } : {},
      ),
    ];
  }

  private stopChild(
    childID: string,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
    nativeEvent: unknown,
  ): OpenCodeNormalizedEvent[] {
    const existing = this.childStates.get(childID);
    if (!existing?.started || existing.stopped) {
      boundedMapSet(
        this.childStates,
        childID,
        { started: existing?.started ?? false, stopped: true },
        this.maxCorrelationEntries,
      );
      return [];
    }
    boundedMapSet(this.childStates, childID, { started: true, stopped: true }, this.maxCorrelationEntries);
    return [
      this.output(
        { type: 'subagent.stopped', subagentId: childID },
        timestamp,
        options,
        nativeEvent,
        this.activeTurnID ? { promptId: this.activeTurnID, turnId: this.activeTurnID } : {},
      ),
    ];
  }

  private adoptSyntheticContinuation(part: Record<string, unknown>, messageID: string): boolean {
    const metadata = isRecord(part.metadata) ? part.metadata : undefined;
    const compaction = text(part.type) === 'compaction';
    const continuation = metadata?.compaction_continue === true;
    if (!compaction && !continuation) return false;
    if (this.activeTurnID) this.messageTurns.set(messageID, this.activeTurnID);
    if ((compaction && part.auto === true) || continuation) this.pendingFailure = undefined;
    return true;
  }

  private joinChildFromTool(
    state: Record<string, unknown>,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
    nativeEvent: unknown,
  ): OpenCodeNormalizedEvent[] {
    const metadata = isRecord(state.metadata) ? state.metadata : undefined;
    const childID = text(metadata?.sessionId);
    if (!childID) return [];
    const parentID = text(metadata?.parentSessionId);
    if (parentID && parentID !== this.sessionID) return [];
    const input = isRecord(state.input) ? state.input : undefined;
    return this.startChild(childID, text(input?.subagent_type), timestamp, options, nativeEvent);
  }

  private output(
    event: AgentEvent,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
    nativeEvent: unknown,
    correlation: { promptId?: string; turnId?: string } = {},
    confidence: AgentEventConfidence = 'authoritative',
  ): OpenCodeNormalizedEvent {
    return {
      event,
      ...correlation,
      timestamp,
      source: 'native-protocol',
      confidence,
      ...(options.replay === undefined ? {} : { replay: options.replay }),
      nativeEvent,
    };
  }

  private native(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent {
    return this.output(
      { type: 'adapter.native-event', adapter: 'opencode', nativeType: record.type },
      timestamp,
      options,
      options.nativeEvent ?? record,
      this.correlationFor(record),
    );
  }

  private correlationFor(record: OpenCodeSseRecord): { promptId?: string; turnId?: string } {
    const info = isRecord(record.properties.info) ? record.properties.info : undefined;
    const part = isRecord(record.properties.part) ? record.properties.part : undefined;
    const messageID = text(info?.id) ?? text(part?.messageID) ?? text(record.properties.messageID);
    const turnID = messageID ? this.messageTurns.get(messageID) : this.activeTurnID;
    return turnID ? { promptId: turnID, turnId: turnID } : {};
  }

  private environmentEvents(
    info: Record<string, unknown>,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
    nativeEvent: unknown,
  ): OpenCodeNormalizedEvent[] {
    const directory = text(info.directory);
    const model = isRecord(info.model) ? info.model : undefined;
    const modelID = text(model?.id);
    const changedDirectory = directory !== undefined && directory !== this.currentDirectory;
    const changedModel = modelID !== undefined && modelID !== this.currentModelID;
    if (!changedDirectory && !changedModel) return [];
    if (changedDirectory) this.currentDirectory = directory;
    if (changedModel) this.currentModelID = modelID;
    return [
      this.output(
        {
          type: 'session.environment.updated',
          ...(changedDirectory ? { currentCwd: directory } : {}),
          ...(changedModel
            ? { model: { id: modelID!, ...(text(model?.providerID) ? { provider: text(model?.providerID) } : {}) } }
            : {}),
        },
        timestamp,
        options,
        nativeEvent,
      ),
    ];
  }

  private messageUpdated(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const info = isRecord(record.properties.info) ? record.properties.info : undefined;
    const messageID = text(info?.id);
    const role = info?.role;
    if (!info || !messageID || (role !== 'user' && role !== 'assistant')) {
      return [this.native(record, timestamp, options)];
    }
    this.messageRoles.set(messageID, role);
    if (role === 'user') return this.userMessage(record, info, messageID, timestamp, options);

    const parentID = text(info.parentID);
    const turnID = (parentID ? this.messageTurns.get(parentID) : undefined) ?? parentID ?? this.activeTurnID;
    if (!turnID) return [this.native(record, timestamp, options)];
    this.messageTurns.set(messageID, turnID);
    const assistants = this.assistantMessagesByTurn.get(turnID) ?? [];
    if (!assistants.includes(messageID)) assistants.push(messageID);
    boundedMapSet(this.assistantMessagesByTurn, turnID, assistants, this.maxCorrelationEntries);
    const time = isRecord(info.time) ? info.time : undefined;
    if (number(time?.completed) !== undefined || text(info.finish)) {
      boundedAdd(this.completedAssistantMessages, messageID, this.maxCorrelationEntries);
    }
    return this.flushPending(messageID, options);
  }

  private userMessage(
    record: OpenCodeSseRecord,
    info: Record<string, unknown>,
    messageID: string,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    this.messageTurns.set(messageID, messageID);
    if (this.seenUserMessages.has(messageID)) return [];
    boundedAdd(this.seenUserMessages, messageID, this.maxCorrelationEntries);
    const events: OpenCodeNormalizedEvent[] = [];
    if (this.activeTurnID && this.activeTurnID !== messageID) {
      if (this.pendingFailure?.turnID === this.activeTurnID) {
        this.messageTurns.set(messageID, this.activeTurnID);
        events.push(...this.flushPending(messageID, options));
        return events;
      }
      if (options.replay && this.turnHasCompletedAssistant(this.activeTurnID)) {
        events.push(...this.completeTurn(record, timestamp, options, 'history-boundary', 'derived'));
      } else {
        events.push(this.native(record, timestamp, options));
        return events;
      }
    }
    if (this.completedTurns.has(messageID) || this.exited) return events;
    this.activeTurnID = messageID;
    const model = isRecord(info.model) ? info.model : undefined;
    if (text(model?.modelID)) this.currentModelID = text(model?.modelID);
    events.push(
      this.output({ type: 'turn.started', turnId: messageID }, timestamp, options, options.nativeEvent ?? record, {
        promptId: messageID,
        turnId: messageID,
      }),
    );
    events.push(...this.flushPending(messageID, options));
    return events;
  }

  private partUpdated(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const part = isRecord(record.properties.part) ? record.properties.part : undefined;
    const messageID = text(part?.messageID);
    if (!part || !messageID) return [this.native(record, timestamp, options)];
    if (!this.messageRoles.has(messageID)) return this.bufferPart(messageID, record, timestamp, options);
    const events = this.handlePartRecord(record, timestamp, options);
    events.push(...this.flushPending(messageID, options));
    return events;
  }

  private bufferPart(
    messageID: string,
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const events: OpenCodeNormalizedEvent[] = [];
    if (!this.pendingParts.has(messageID) && this.pendingParts.size >= this.maxCorrelationEntries) {
      const oldest = this.pendingParts.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        const evicted = this.pendingParts.get(oldest) ?? [];
        this.pendingParts.delete(oldest);
        events.push(...evicted.map((pending) => this.native(pending, nestedTimestamp(pending.properties), options)));
      }
    }
    const queued = this.pendingParts.get(messageID) ?? [];
    queued.push(record);
    this.pendingParts.set(messageID, queued);
    if (queued.length <= this.maxCorrelationEntries) return events;
    const evicted = queued.shift();
    if (evicted) events.push(this.native(evicted, timestamp, options));
    return events;
  }

  private flushPending(messageID: string, options: NormalizeOpenCodeOptions): OpenCodeNormalizedEvent[] {
    const buffered = this.pendingParts.get(messageID) ?? [];
    this.pendingParts.delete(messageID);
    const events: OpenCodeNormalizedEvent[] = [];
    for (const pending of buffered) {
      const timestamp = nestedTimestamp(pending.properties);
      if (pending.type === 'message.part.updated') {
        events.push(...this.handlePartRecord(pending, timestamp, options));
      } else if (pending.type === 'message.part.delta') {
        events.push(...this.partDelta(pending, timestamp, options));
      } else {
        events.push(this.native(pending, timestamp, options));
      }
    }
    return events;
  }

  private handlePartRecord(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const part = record.properties.part as Record<string, unknown>;
    const messageID = text(part.messageID)!;
    const role = this.messageRoles.get(messageID);
    const partType = text(part.type);
    if (role === 'user') {
      if (this.adoptSyntheticContinuation(part, messageID)) {
        return [this.native(record, timestamp, options)];
      }
      return partType === 'file' ? [this.native(record, timestamp, options)] : [];
    }
    const turnID = this.messageTurns.get(messageID);
    if (!turnID || !partType) return [this.native(record, timestamp, options)];

    if (partType === 'text' || partType === 'reasoning') {
      return this.textPart(record, part, messageID, turnID, partType, timestamp, options);
    }
    if (partType === 'tool') return this.toolPart(record, part, turnID, timestamp, options);
    if (partType === 'step-finish') return this.stepFinish(record, part, turnID, timestamp, options);
    if (partType === 'step-start') return [];
    return [this.native(record, timestamp, options)];
  }

  private textPart(
    record: OpenCodeSseRecord,
    part: Record<string, unknown>,
    messageID: string,
    turnID: string,
    kind: 'text' | 'reasoning',
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const partID = text(part.id);
    if (!partID) return [this.native(record, timestamp, options)];
    const previous = this.partStates.get(partID);
    const nextText = typeof part.text === 'string' ? part.text : (previous?.text ?? '');
    const time = isRecord(part.time) ? part.time : undefined;
    const final = number(time?.end) !== undefined;
    const changed = previous?.text !== nextText;
    const newlyFinal = final && !previous?.final;
    boundedMapSet(this.partStates, partID, { kind, text: nextText, final }, this.maxCorrelationEntries * 4);

    if (kind === 'text') {
      const parts = this.textPartsByMessage.get(messageID) ?? new Map<string, string>();
      boundedMapSet(parts, partID, nextText, this.maxCorrelationEntries);
      boundedMapSet(this.textPartsByMessage, messageID, parts, this.maxCorrelationEntries);
      if (!changed && !newlyFinal) return [];
      return [
        this.output(
          {
            type: 'assistant.message',
            messageId: messageID,
            turnId: turnID,
            text: [...parts.values()].join(''),
            final,
          },
          timestamp,
          options,
          options.nativeEvent ?? record,
          { promptId: turnID, turnId: turnID },
        ),
      ];
    }

    const events: OpenCodeNormalizedEvent[] = [];
    if (!previous) {
      events.push(
        this.output(
          { type: 'reasoning.started', reasoningId: partID },
          timestamp,
          options,
          options.nativeEvent ?? record,
          { promptId: turnID, turnId: turnID },
        ),
      );
    }
    if ((changed || newlyFinal) && nextText.length > 0) {
      events.push(
        this.output(
          { type: 'reasoning.summary', reasoningId: partID, text: nextText, final },
          timestamp,
          options,
          options.nativeEvent ?? record,
          { promptId: turnID, turnId: turnID },
        ),
      );
    }
    if (newlyFinal) {
      events.push(
        this.output(
          { type: 'reasoning.completed', reasoningId: partID },
          timestamp,
          options,
          options.nativeEvent ?? record,
          { promptId: turnID, turnId: turnID },
        ),
      );
    }
    return events;
  }

  private partDelta(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const partID = text(record.properties.partID);
    const messageID = text(record.properties.messageID);
    const delta = typeof record.properties.delta === 'string' ? record.properties.delta : undefined;
    if (!partID || !messageID || record.properties.field !== 'text' || delta === undefined) {
      return [this.native(record, timestamp, options)];
    }
    if (this.messageRoles.get(messageID) === 'user') return [];
    const state = this.partStates.get(partID);
    const turnID = this.messageTurns.get(messageID);
    if (!state || !turnID) return this.bufferPart(messageID, record, timestamp, options);
    if (state.final) return [];
    const nextText = `${state.text}${delta}`;
    boundedMapSet(this.partStates, partID, { ...state, text: nextText }, this.maxCorrelationEntries * 4);
    if (state.kind === 'reasoning') {
      return [
        this.output(
          { type: 'reasoning.summary', reasoningId: partID, text: nextText, final: false },
          timestamp,
          options,
          options.nativeEvent ?? record,
          { promptId: turnID, turnId: turnID },
        ),
      ];
    }
    const parts = this.textPartsByMessage.get(messageID) ?? new Map<string, string>();
    boundedMapSet(parts, partID, nextText, this.maxCorrelationEntries);
    boundedMapSet(this.textPartsByMessage, messageID, parts, this.maxCorrelationEntries);
    return [
      this.output(
        {
          type: 'assistant.message',
          messageId: messageID,
          turnId: turnID,
          text: [...parts.values()].join(''),
          final: false,
        },
        timestamp,
        options,
        options.nativeEvent ?? record,
        { promptId: turnID, turnId: turnID },
      ),
    ];
  }

  private toolPart(
    record: OpenCodeSseRecord,
    part: Record<string, unknown>,
    turnID: string,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const callID = text(part.callID);
    const tool = text(part.tool);
    const state = isRecord(part.state) ? part.state : undefined;
    const status = text(state?.status);
    if (!callID || !tool || !state || !status) return [this.native(record, timestamp, options)];
    const previous = this.toolStates.get(callID);
    const correlation = { promptId: turnID, turnId: turnID };
    const presentation = toolPresentation(tool, state.input);
    const nativeEvent = options.nativeEvent ?? record;
    const joined = tool === 'task' ? this.joinChildFromTool(state, timestamp, options, nativeEvent) : [];
    if (previous === 'completed' || previous === 'failed') return joined;

    if (status === 'pending') {
      if (previous) return joined;
      boundedMapSet(this.toolStates, callID, 'requested', this.maxCorrelationEntries);
      return [
        ...joined,
        this.output(
          { type: 'tool.requested', toolCallId: callID, tool, input: state.input, presentation },
          timestamp,
          options,
          nativeEvent,
          correlation,
        ),
      ];
    }
    if (status === 'running') {
      if (previous === 'running') return joined;
      boundedMapSet(this.toolStates, callID, 'running', this.maxCorrelationEntries);
      return [
        ...joined,
        this.output(
          { type: 'tool.started', toolCallId: callID, tool, input: state.input, presentation },
          timestamp,
          options,
          nativeEvent,
          correlation,
        ),
      ];
    }
    if (status === 'completed') {
      boundedMapSet(this.toolStates, callID, 'completed', this.maxCorrelationEntries);
      const time = isRecord(state.time) ? state.time : undefined;
      const start = number(time?.start);
      const end = number(time?.end);
      return [
        ...joined,
        this.output(
          {
            type: 'tool.completed',
            toolCallId: callID,
            tool,
            output: state.output,
            ...(start !== undefined && end !== undefined && end >= start ? { durationMs: end - start } : {}),
            presentation,
          },
          timestamp,
          options,
          nativeEvent,
          correlation,
        ),
      ];
    }
    if (status === 'error') {
      boundedMapSet(this.toolStates, callID, 'failed', this.maxCorrelationEntries);
      return [
        ...joined,
        this.output(
          { type: 'tool.failed', toolCallId: callID, tool, error: errorMessage(state.error), presentation },
          timestamp,
          options,
          nativeEvent,
          correlation,
        ),
      ];
    }
    return [...joined, this.native(record, timestamp, options)];
  }

  private stepFinish(
    record: OpenCodeSseRecord,
    part: Record<string, unknown>,
    turnID: string,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    if (!this.contextWindowCapacityTokens) return [];
    const tokens = isRecord(part.tokens) ? part.tokens : undefined;
    const cache = isRecord(tokens?.cache) ? tokens.cache : undefined;
    const used =
      number(tokens?.total) ??
      [tokens?.input, tokens?.output, cache?.read, cache?.write].reduce<number>(
        (sum, candidate) => sum + (number(candidate) ?? 0),
        0,
      );
    const identity = `${used}/${this.contextWindowCapacityTokens}/${this.currentModelID ?? ''}`;
    if (identity === this.lastContextUsage) return [];
    this.lastContextUsage = identity;
    return [
      this.output(
        {
          type: 'context-window.updated',
          usedTokens: used,
          capacityTokens: this.contextWindowCapacityTokens,
          ...(this.currentModelID ? { modelId: this.currentModelID } : {}),
        },
        timestamp,
        options,
        options.nativeEvent ?? record,
        { promptId: turnID, turnId: turnID },
      ),
    ];
  }

  private sessionStatus(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const status = isRecord(record.properties.status) ? record.properties.status : undefined;
    if (!status || typeof status.type !== 'string') return [this.native(record, timestamp, options)];
    if (status.type === 'idle') return this.completeTurn(record, timestamp, options, 'idle');
    if (status.type === 'retry') return [this.native(record, timestamp, options)];
    return status.type === 'busy' ? [] : [this.native(record, timestamp, options)];
  }

  private completeTurn(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
    stopReason: string,
    confidence: AgentEventConfidence = 'authoritative',
  ): OpenCodeNormalizedEvent[] {
    const turnID = this.activeTurnID;
    if (!turnID || this.completedTurns.has(turnID)) return [];
    if (this.pendingFailure?.turnID === turnID) {
      return this.finalizeFailure(record, timestamp, options, this.pendingFailure.error);
    }
    this.pendingFailure = undefined;
    boundedAdd(this.completedTurns, turnID, this.maxCorrelationEntries);
    this.activeTurnID = undefined;
    return [
      this.output(
        {
          type: 'turn.completed',
          turnId: turnID,
          stopReason,
          ...(this.assistantText(turnID) ? { lastAssistantMessage: this.assistantText(turnID) } : {}),
        },
        timestamp,
        options,
        options.nativeEvent ?? record,
        { promptId: turnID, turnId: turnID },
        confidence,
      ),
    ];
  }

  private notePendingFailure(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const turnID = this.activeTurnID;
    if (!turnID || this.completedTurns.has(turnID)) return [this.native(record, timestamp, options)];
    this.pendingFailure = { turnID, error: errorMessage(record.properties.error) };
    return [this.native(record, timestamp, options)];
  }

  private finalizeFailure(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
    error?: string,
  ): OpenCodeNormalizedEvent[] {
    const turnID = this.activeTurnID;
    if (!turnID || this.completedTurns.has(turnID)) return [this.native(record, timestamp, options)];
    this.pendingFailure = undefined;
    boundedAdd(this.completedTurns, turnID, this.maxCorrelationEntries);
    this.activeTurnID = undefined;
    return [
      this.output({ type: 'turn.failed', turnId: turnID, error }, timestamp, options, options.nativeEvent ?? record, {
        promptId: turnID,
        turnId: turnID,
      }),
    ];
  }

  private deleteSession(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    if (this.exited) return [];
    const events: OpenCodeNormalizedEvent[] = [];
    if (this.activeTurnID) {
      events.push(
        ...this.finalizeFailure(
          record,
          timestamp,
          options,
          this.pendingFailure?.error ?? errorMessage(record.properties.error),
        ),
      );
    }
    this.exited = true;
    events.push(
      this.output({ type: 'session.exited', reason: 'deleted' }, timestamp, options, options.nativeEvent ?? record),
    );
    return events;
  }

  private permissionAsked(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const requestID = text(record.properties.id);
    if (!requestID || this.permissionStates.has(requestID)) return [];
    boundedMapSet(this.permissionStates, requestID, 'requested', this.maxCorrelationEntries);
    const tool = isRecord(record.properties.tool) ? record.properties.tool : undefined;
    const toolCallID = text(tool?.callID);
    const permission = text(record.properties.permission);
    const turnID = text(tool?.messageID) ? this.messageTurns.get(text(tool?.messageID)!) : this.activeTurnID;
    return [
      this.output(
        {
          type: 'permission.requested',
          requestId: requestID,
          ...(toolCallID ? { toolCallId: toolCallID } : {}),
          ...(permission ? { tool: permission } : {}),
          input: {
            patterns: record.properties.patterns,
            metadata: record.properties.metadata,
            always: record.properties.always,
          },
          presentation: 'native-tui',
        },
        timestamp,
        options,
        options.nativeEvent ?? record,
        turnID ? { promptId: turnID, turnId: turnID } : {},
      ),
    ];
  }

  private permissionReplied(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const requestID = text(record.properties.requestID);
    if (!requestID || this.permissionStates.get(requestID) === 'resolved') return [];
    boundedMapSet(this.permissionStates, requestID, 'resolved', this.maxCorrelationEntries);
    const reply = text(record.properties.reply);
    const outcome = reply === 'once' || reply === 'always' ? 'allowed' : reply === 'reject' ? 'denied' : 'unknown';
    return [
      this.output(
        { type: 'permission.resolved', requestId: requestID, outcome },
        timestamp,
        options,
        options.nativeEvent ?? record,
        this.activeTurnID ? { promptId: this.activeTurnID, turnId: this.activeTurnID } : {},
      ),
    ];
  }

  private questionAsked(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const requestID = text(record.properties.id);
    const questions = openCodeStructuredQuestions(record.properties.questions);
    if (!requestID || !questions || this.questionStates.has(requestID)) return [];
    boundedMapSet(this.questionStates, requestID, 'requested', this.maxCorrelationEntries);
    const tool = isRecord(record.properties.tool) ? record.properties.tool : undefined;
    const messageID = text(tool?.messageID);
    const turnID = messageID ? this.messageTurns.get(messageID) : this.activeTurnID;
    return [
      this.output(
        { type: 'question.requested', requestId: requestID, questions },
        timestamp,
        options,
        options.nativeEvent ?? record,
        turnID ? { promptId: turnID, turnId: turnID } : {},
      ),
    ];
  }

  private questionResolved(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const requestID = text(record.properties.requestID);
    if (!requestID || this.questionStates.get(requestID) === 'resolved') return [];
    boundedMapSet(this.questionStates, requestID, 'resolved', this.maxCorrelationEntries);
    return [
      this.output(
        {
          type: 'question.resolved',
          requestId: requestID,
          outcome: record.type === 'question.replied' ? 'answered' : 'cancelled',
        },
        timestamp,
        options,
        options.nativeEvent ?? record,
        this.activeTurnID ? { promptId: this.activeTurnID, turnId: this.activeTurnID } : {},
      ),
    ];
  }

  private assistantText(turnID: string): string | undefined {
    const messages = this.assistantMessagesByTurn.get(turnID) ?? [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const parts = this.textPartsByMessage.get(messages[index]!);
      const value = parts ? [...parts.values()].join('') : '';
      if (value.length > 0) return value;
    }
    return undefined;
  }

  private turnHasCompletedAssistant(turnID: string): boolean {
    return (this.assistantMessagesByTurn.get(turnID) ?? []).some((messageID) =>
      this.completedAssistantMessages.has(messageID),
    );
  }
}
