/** Stateful OpenCode HTTP/SSE -> Core event normalization. */

import type { AgentEvent, AgentEventConfidence, AgentEventSource } from '@vibecook/puppeteer-core';
import type { OpenCodeSessionInfo } from '../transport/client.js';
import type { OpenCodeSseRecord } from '../transport/event-stream.js';
import { isFilteredOpenCodeInfrastructure, normalizeOpenCodeNativeEvent } from './adapter.js';
import { normalizeOpenCodeAssistantMessage } from './conversation.js';
import { normalizeOpenCodeContextInvalidated, OpenCodeContextWindowNormalizer } from './context-window.js';
import { OpenCodeDelegationNormalizer } from './delegation.js';
import { OpenCodeEnvironmentNormalizer } from './environment.js';
import { OpenCodeModelNormalizer } from './model.js';
import { OpenCodeInteractionNormalizer } from './interaction.js';
import {
  normalizeOpenCodeReasoningCompleted,
  normalizeOpenCodeReasoningStarted,
  normalizeOpenCodeReasoningSummary,
} from './reasoning.js';
import { normalizeOpenCodeSessionExited, normalizeOpenCodeSessionStarted } from './session.js';
import { OpenCodeToolNormalizer } from './tool.js';
import { OpenCodeWorkspaceNormalizer } from './workspace.js';
import type {
  NormalizeOpenCodeOptions,
  OpenCodeNormalizedEvent,
  OpenCodeNormalizerOptions,
  OpenCodeTextPartState,
} from './types.js';
import { normalizeOpenCodeTurnCompleted, normalizeOpenCodeTurnFailed, normalizeOpenCodeTurnStarted } from './turn.js';
import {
  boundedOpenCodeAdd as boundedAdd,
  boundedOpenCodeMapSet as boundedMapSet,
  isOpenCodeRecord as isRecord,
  openCodeError as errorMessage,
  openCodeNumber as number,
  openCodeRecordTimestamp as nestedTimestamp,
  openCodeText as text,
  openCodeTimestamp as isoTimestamp,
} from './wire.js';

/**
 * Claim-addressable sources for every portable mapping in this file. Paths
 * point into the agent's sole canonical `groundtruth.json`, whose manifest
 * identifies the reviewed version.
 * The behavior-node ids carry the independently evidenced semantic ordering.
 */
export const OPENCODE_NORMALIZATION_EVIDENCE = {
  session: [
    'groundtruth.json#events/session.created',
    'groundtruth.json#events/session.updated',
    'groundtruth.json#behavior/nodes/session-created',
  ],
  turn: [
    'groundtruth.json#events/message.updated',
    'groundtruth.json#events/session.status',
    'groundtruth.json#behavior/nodes/user-message',
  ],
  assistant: [
    'groundtruth.json#events/message.part.updated',
    'groundtruth.json#events/message.part.delta',
    'groundtruth.json#behavior/nodes/assistant-message',
    'groundtruth.json#behavior/nodes/text-delta',
  ],
  reasoning: [
    'groundtruth.json#events/message.part.updated',
    'groundtruth.json#events/message.part.delta',
    'groundtruth.json#behavior/nodes/reasoning-part',
  ],
  tool: ['groundtruth.json#events/message.part.updated', 'groundtruth.json#behavior/nodes/tool-pending'],
  workspace: [
    'groundtruth.json#events/message.part.updated',
    'groundtruth.json#events/file.watcher.updated',
    'groundtruth.json#behavior/nodes/tool-pending',
  ],
  permission: [
    'groundtruth.json#events/permission.asked',
    'groundtruth.json#events/permission.replied',
    'groundtruth.json#behavior/nodes/permission-asked',
  ],
  question: [
    'groundtruth.json#events/question.asked',
    'groundtruth.json#events/question.replied',
    'groundtruth.json#events/question.rejected',
    'groundtruth.json#behavior/nodes/question-asked',
  ],
  failure: ['groundtruth.json#events/session.error', 'groundtruth.json#behavior/nodes/session-error'],
  context: [
    'groundtruth.json#events/message.part.updated',
    'groundtruth.json#events/session.compacted',
    'groundtruth.json#behavior/nodes/session-compacted-manual',
    'groundtruth.json#behavior/nodes/session-compacted-auto',
    'groundtruth.json#behavior/nodes/session-compacted-overflow',
  ],
  deletion: ['groundtruth.json#events/session.deleted', 'groundtruth.json#behavior/nodes/session-deleted'],
  subagent: [
    'groundtruth.json#events/session.created',
    'groundtruth.json#events/session.idle',
    'groundtruth.json#behavior/nodes/subagent-child-created',
    'groundtruth.json#behavior/nodes/subagent-child-idle',
    'groundtruth.json#behavior/nodes/subagent-background-task-completed',
  ],
} as const;

export type { NormalizeOpenCodeOptions, OpenCodeNormalizedEvent, OpenCodeNormalizerOptions } from './types.js';

export class OpenCodeNormalizer {
  readonly sessionID: string;
  private readonly maxSeenEventIds: number;
  private readonly maxCorrelationEntries: number;
  private readonly environment = new OpenCodeEnvironmentNormalizer();
  private readonly model = new OpenCodeModelNormalizer();
  private readonly contextWindow: OpenCodeContextWindowNormalizer;
  private readonly delegation: OpenCodeDelegationNormalizer;
  private readonly interaction: OpenCodeInteractionNormalizer;
  private readonly tool: OpenCodeToolNormalizer;
  private readonly workspace: OpenCodeWorkspaceNormalizer;
  private readonly seenEventIds = new Set<string>();
  private readonly seenUserMessages = new Set<string>();
  private readonly completedTurns = new Set<string>();
  private readonly messageRoles = new Map<string, 'user' | 'assistant'>();
  private readonly messageTurns = new Map<string, string>();
  private readonly assistantMessagesByTurn = new Map<string, string[]>();
  private readonly completedAssistantMessages = new Set<string>();
  private readonly partStates = new Map<string, OpenCodeTextPartState>();
  private readonly textPartsByMessage = new Map<string, Map<string, string>>();
  private readonly pendingParts = new Map<string, OpenCodeSseRecord[]>();
  private activeTurnID: string | undefined;
  private pendingFailure: { turnID: string; error?: string } | undefined;
  private sessionStarted = false;
  private exited = false;

  constructor(options: OpenCodeNormalizerOptions) {
    this.sessionID = options.sessionID;
    this.maxSeenEventIds = options.maxSeenEventIds ?? 4096;
    this.maxCorrelationEntries = options.maxCorrelationEntries ?? 1024;
    this.contextWindow = new OpenCodeContextWindowNormalizer(options.contextWindowCapacityTokens);
    this.delegation = new OpenCodeDelegationNormalizer(this.maxCorrelationEntries);
    this.interaction = new OpenCodeInteractionNormalizer(this.maxCorrelationEntries);
    this.tool = new OpenCodeToolNormalizer(this.maxCorrelationEntries);
    this.workspace = new OpenCodeWorkspaceNormalizer(this.maxCorrelationEntries);
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
      events.push(this.output(normalizeOpenCodeSessionStarted(info, this.sessionID), timestamp, options, nativeEvent));
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
        return [this.output(normalizeOpenCodeContextInvalidated(), timestamp, options, options.nativeEvent ?? record)];
      case 'question.asked':
        return this.questionAsked(record, timestamp, options);
      case 'question.replied':
      case 'question.rejected':
        return this.questionResolved(record, timestamp, options);
      case 'file.watcher.updated': {
        const workspace = this.workspace.normalizeFileWatcher(record);
        return workspace
          ? [this.output(workspace, timestamp, options, options.nativeEvent ?? record, this.correlationFor(record))]
          : [this.native(record, timestamp, options)];
      }
      case 'file.edited':
      case 'message.part.removed':
      case 'message.removed':
        return [this.native(record, timestamp, options)];
      default:
        return isFilteredOpenCodeInfrastructure(record.type) ? [] : [this.native(record, timestamp, options)];
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
    if (this.delegation.knows(sessionID)) return sessionID;
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
    return this.delegation
      .start(childID, agentType)
      .map((event) =>
        this.output(
          event,
          timestamp,
          options,
          nativeEvent,
          this.activeTurnID ? { promptId: this.activeTurnID, turnId: this.activeTurnID } : {},
        ),
      );
  }

  private stopChild(
    childID: string,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
    nativeEvent: unknown,
  ): OpenCodeNormalizedEvent[] {
    return this.delegation
      .stop(childID)
      .map((event) =>
        this.output(
          event,
          timestamp,
          options,
          nativeEvent,
          this.activeTurnID ? { promptId: this.activeTurnID, turnId: this.activeTurnID } : {},
        ),
      );
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
      normalizeOpenCodeNativeEvent(record.type),
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
    return [...this.environment.normalize(info), ...this.model.normalize(info)].map((event) =>
      this.output(event, timestamp, options, nativeEvent),
    );
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
    this.model.observeModel(text(model?.modelID));
    events.push(
      this.output(normalizeOpenCodeTurnStarted(messageID), timestamp, options, options.nativeEvent ?? record, {
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
          normalizeOpenCodeAssistantMessage(messageID, turnID, [...parts.values()].join(''), final),
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
        this.output(normalizeOpenCodeReasoningStarted(partID), timestamp, options, options.nativeEvent ?? record, {
          promptId: turnID,
          turnId: turnID,
        }),
      );
    }
    if ((changed || newlyFinal) && nextText.length > 0) {
      events.push(
        this.output(
          normalizeOpenCodeReasoningSummary(partID, nextText, final),
          timestamp,
          options,
          options.nativeEvent ?? record,
          { promptId: turnID, turnId: turnID },
        ),
      );
    }
    if (newlyFinal) {
      events.push(
        this.output(normalizeOpenCodeReasoningCompleted(partID), timestamp, options, options.nativeEvent ?? record, {
          promptId: turnID,
          turnId: turnID,
        }),
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
          normalizeOpenCodeReasoningSummary(partID, nextText, false),
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
        normalizeOpenCodeAssistantMessage(messageID, turnID, [...parts.values()].join(''), false),
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
    const normalized = this.tool.normalize(part, this.sessionID);
    const nativeEvent = options.nativeEvent ?? record;
    const events = normalized.join
      ? this.startChild(normalized.join.childId, normalized.join.agentType, timestamp, options, nativeEvent)
      : [];
    if (normalized.event) {
      events.push(
        this.output(normalized.event, timestamp, options, nativeEvent, {
          promptId: turnID,
          turnId: turnID,
        }),
      );
    }
    const workspace = this.workspace.normalizeToolPart(part);
    if (workspace) {
      events.push(
        this.output(workspace, timestamp, options, nativeEvent, {
          promptId: turnID,
          turnId: turnID,
        }),
      );
    }
    if (normalized.retainNative) events.push(this.native(record, timestamp, options));
    return events;
  }

  private stepFinish(
    record: OpenCodeSseRecord,
    part: Record<string, unknown>,
    turnID: string,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    return this.contextWindow.normalize(part, this.model.modelId()).map((event) =>
      this.output(event, timestamp, options, options.nativeEvent ?? record, {
        promptId: turnID,
        turnId: turnID,
      }),
    );
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
        normalizeOpenCodeTurnCompleted(turnID, stopReason, this.assistantText(turnID)),
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
      this.output(normalizeOpenCodeTurnFailed(turnID, error), timestamp, options, options.nativeEvent ?? record, {
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
    events.push(this.output(normalizeOpenCodeSessionExited(), timestamp, options, options.nativeEvent ?? record));
    return events;
  }

  private permissionAsked(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const normalized = this.interaction.permissionAsked(record);
    if (!normalized) return [];
    const turnID = normalized.messageId ? this.messageTurns.get(normalized.messageId) : this.activeTurnID;
    return [
      this.output(
        normalized.event,
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
    const normalized = this.interaction.permissionReplied(record);
    return normalized
      ? [
          this.output(
            normalized.event,
            timestamp,
            options,
            options.nativeEvent ?? record,
            this.activeTurnID ? { promptId: this.activeTurnID, turnId: this.activeTurnID } : {},
          ),
        ]
      : [];
  }

  private questionAsked(
    record: OpenCodeSseRecord,
    timestamp: string,
    options: NormalizeOpenCodeOptions,
  ): OpenCodeNormalizedEvent[] {
    const normalized = this.interaction.questionAsked(record);
    if (!normalized) return [];
    const turnID = normalized.messageId ? this.messageTurns.get(normalized.messageId) : this.activeTurnID;
    return [
      this.output(
        normalized.event,
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
    const normalized = this.interaction.questionResolved(record);
    return normalized
      ? [
          this.output(
            normalized.event,
            timestamp,
            options,
            options.nativeEvent ?? record,
            this.activeTurnID ? { promptId: this.activeTurnID, turnId: this.activeTurnID } : {},
          ),
        ]
      : [];
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
