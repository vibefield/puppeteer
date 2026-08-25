/**
 * Hermes tui_gateway JSON-RPC events -> Core.
 *
 * thinking.delta is a UI spinner, not model reasoning. reasoning.available in
 * the 0.20.0 census echoed assistant text, so it is retained rather than
 * mapped to a reasoning summary. Approval decisions stay native-TUI: this
 * normalizer emits permission.requested and does not invent permission.resolved
 * from a later tool.complete.
 */

import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventSource,
  ToolActivityKind,
  ToolPresentation,
} from '@vibecook/puppeteer-core';
import { hermesStructuredQuestions } from './questions.js';

export type HermesNormalizationDisposition = 'mapped' | 'retained-native' | 'buffered' | 'no-output';

export interface HermesNormalizedRecord {
  events: AgentEvent[];
  nativeSessionId?: string;
  liveSessionId?: string;
  turnId?: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  nativeEvent: unknown;
  disposition: HermesNormalizationDisposition;
}

export interface HermesGatewayEvent {
  type?: unknown;
  session_id?: unknown;
  payload?: unknown;
  [key: string]: unknown;
}

const MAX_CORRELATIONS = 1_024;
const ADAPTER = 'hermes';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

function boundedMapSet<K, V>(target: Map<K, V>, key: K, value: V): void {
  if (!target.has(key) && target.size >= MAX_CORRELATIONS) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest !== undefined) target.delete(oldest);
  }
  target.set(key, value);
}

function presentation(tool: string, completed = false): ToolPresentation {
  const lower = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  let title = completed ? `Used ${tool}` : `Using ${tool}`;
  if (lower === 'terminal' || lower === 'process') {
    kind = 'command';
    title = completed ? 'Ran command' : 'Running command';
  }
  return { kind, title };
}

function eventType(frame: unknown): string | undefined {
  const body = record(frame);
  if (!body) return undefined;
  if (body.method === 'event') return string(record(body.params)?.type);
  return string(body.type);
}

function eventSessionId(frame: unknown): string | undefined {
  const body = record(frame);
  if (!body) return undefined;
  if (body.method === 'event') return string(record(body.params)?.session_id);
  return string(body.session_id);
}

function eventPayload(frame: unknown): Record<string, unknown> {
  const body = record(frame);
  if (!body) return {};
  if (body.method === 'event') return record(record(body.params)?.payload) ?? {};
  return record(body.payload) ?? {};
}

function native(nativeType: string): AgentEvent {
  return { type: 'adapter.native-event', adapter: ADAPTER, nativeType };
}

/** One stateful instance per live Hermes session. */
export class HermesGatewayNormalizer {
  private started = false;
  private ready = false;
  private turnCount = 0;
  private currentTurnId?: string;
  private assistantText = '';
  private readonly storedByLive = new Map<string, string>();
  private readonly toolNames = new Map<string, string>();
  private readonly questionStates = new Map<string, 'requested' | 'resolved'>();

  bindStoredSession(liveSessionId: string, storedSessionId: string): void {
    boundedMapSet(this.storedByLive, liveSessionId, storedSessionId);
  }

  /**
   * session.create/resume already minted the native ids. Imposter emits
   * session.info from the serve follow-up, which can land after the RPC
   * result; native tui_gateway usually sends it immediately. Either way the
   * session exists the moment the RPC returns.
   */
  acknowledgeSession(nativeSessionId: string): HermesNormalizedRecord {
    const events: AgentEvent[] = [];
    if (!this.started && nativeSessionId) {
      this.started = true;
      events.push({ type: 'session.started', nativeSessionId });
    }
    if (!this.ready) {
      this.ready = true;
      events.push({ type: 'session.ready' });
    }
    return {
      events,
      nativeSessionId,
      source: 'native-protocol',
      confidence: 'authoritative',
      nativeEvent: { reason: 'session.create/resume result' },
      disposition: events.length > 0 ? 'mapped' : 'no-output',
    };
  }

  normalize(frame: unknown): HermesNormalizedRecord {
    const type = eventType(frame);
    const liveSessionId = eventSessionId(frame);
    const payload = eventPayload(frame);
    const stored =
      (liveSessionId ? this.storedByLive.get(liveSessionId) : undefined) ?? string(payload.stored_session_id);
    if (liveSessionId && stored) this.bindStoredSession(liveSessionId, stored);
    const nativeSessionId = stored ?? liveSessionId;
    const base = {
      nativeSessionId,
      liveSessionId,
      turnId: this.currentTurnId,
      source: 'native-protocol' as const,
      nativeEvent: frame,
    };

    if (!type) {
      return { ...base, events: [native('untyped')], confidence: 'authoritative', disposition: 'retained-native' };
    }

    switch (type) {
      case 'gateway.ready':
      case 'sessions.changed':
      case 'thinking.delta':
      case 'reasoning.available':
      case 'tool.generating':
        return { ...base, events: [native(type)], confidence: 'authoritative', disposition: 'retained-native' };

      case 'session.info': {
        const events: AgentEvent[] = [];
        if (!this.started && nativeSessionId) {
          this.started = true;
          events.push({ type: 'session.started', nativeSessionId });
        }
        if (!this.ready) {
          this.ready = true;
          events.push({ type: 'session.ready' });
        }
        const model = string(payload.model);
        const cwd = string(payload.cwd);
        if (model || cwd) {
          events.push({
            type: 'session.environment.updated',
            ...(cwd ? { currentCwd: cwd } : {}),
            ...(model
              ? { model: { id: model, ...(string(payload.provider) ? { provider: string(payload.provider) } : {}) } }
              : {}),
          });
        }
        const usage = record(payload.usage);
        const used = typeof usage?.context_used === 'number' ? usage.context_used : undefined;
        const capacity = typeof usage?.context_max === 'number' ? usage.context_max : undefined;
        const providerPercentage =
          typeof usage?.context_percent === 'number' &&
          Number.isFinite(usage.context_percent) &&
          usage.context_percent >= 0 &&
          usage.context_percent <= 100
            ? usage.context_percent
            : undefined;
        if (
          typeof used === 'number' &&
          Number.isFinite(used) &&
          used >= 0 &&
          typeof capacity === 'number' &&
          Number.isFinite(capacity) &&
          capacity > 0
        ) {
          events.push({
            type: 'context-window.updated',
            usedTokens: used,
            capacityTokens: capacity,
            ...(providerPercentage !== undefined
              ? { usedPercentage: providerPercentage, percentageSource: 'provider' as const }
              : { percentageSource: 'derived' as const }),
            ...(model ? { modelId: model } : {}),
          });
        }
        return {
          ...base,
          events,
          confidence: 'authoritative',
          disposition: events.length > 0 ? 'mapped' : 'no-output',
        };
      }

      case 'message.start': {
        this.turnCount += 1;
        this.currentTurnId = `hermes-turn-${this.turnCount}`;
        this.assistantText = '';
        return {
          ...base,
          turnId: this.currentTurnId,
          events: [{ type: 'turn.started', turnId: this.currentTurnId }],
          confidence: 'authoritative',
          disposition: 'mapped',
        };
      }

      case 'message.delta': {
        const chunk = string(payload.text);
        if (chunk) this.assistantText += chunk;
        const text = chunk ?? this.assistantText;
        if (!text) {
          return { ...base, events: [], confidence: 'authoritative', disposition: 'no-output' };
        }
        return {
          ...base,
          events: [{ type: 'assistant.message', turnId: this.currentTurnId, text: this.assistantText, final: false }],
          confidence: 'authoritative',
          disposition: 'mapped',
        };
      }

      case 'message.complete': {
        const finalText = string(payload.text) ?? this.assistantText;
        const status = string(payload.status) ?? 'complete';
        const turnId = this.currentTurnId;
        this.currentTurnId = undefined;
        this.assistantText = '';
        const events: AgentEvent[] = [];
        if (finalText) events.push({ type: 'assistant.message', turnId, text: finalText, final: true });
        if (status === 'interrupted' || status === 'error') {
          events.push({ type: 'turn.failed', turnId, error: status });
        } else {
          events.push({
            type: 'turn.completed',
            turnId,
            stopReason: status,
            ...(finalText ? { lastAssistantMessage: finalText } : {}),
          });
        }
        return { ...base, turnId, events, confidence: 'authoritative', disposition: 'mapped' };
      }

      case 'tool.start': {
        const tool = string(payload.name) ?? 'unknown';
        const toolCallId = string(payload.tool_id) ?? `hermes-tool-${this.toolNames.size + 1}`;
        boundedMapSet(this.toolNames, toolCallId, tool);
        const shown = presentation(tool);
        return {
          ...base,
          events: [
            { type: 'tool.requested', toolCallId, tool, presentation: shown },
            { type: 'tool.started', toolCallId, tool, presentation: shown },
          ],
          confidence: 'authoritative',
          disposition: 'mapped',
        };
      }

      case 'tool.complete': {
        const toolCallId = string(payload.tool_id) ?? 'hermes-tool-unknown';
        const tool = string(payload.name) ?? this.toolNames.get(toolCallId) ?? 'unknown';
        const result = record(payload.result);
        const blocked =
          string(result?.status) === 'blocked' || (typeof result?.exit_code === 'number' && result.exit_code !== 0);
        const shown = presentation(tool, true);
        const durationMs = typeof payload.duration_s === 'number' ? Math.round(payload.duration_s * 1000) : undefined;
        if (blocked) {
          return {
            ...base,
            events: [
              {
                type: 'tool.failed',
                toolCallId,
                tool,
                error: string(result?.error) ?? string(result?.status) ?? 'tool failed',
                presentation: shown,
              },
            ],
            confidence: 'authoritative',
            disposition: 'mapped',
          };
        }
        return {
          ...base,
          events: [
            {
              type: 'tool.completed',
              toolCallId,
              tool,
              ...(result ? { output: result } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
              presentation: shown,
            },
          ],
          confidence: 'authoritative',
          disposition: 'mapped',
        };
      }

      case 'approval.request': {
        const toolCallId = string(payload.tool_id);
        return {
          ...base,
          events: [
            {
              type: 'permission.requested',
              requestId: toolCallId ?? liveSessionId ?? 'hermes-approval',
              ...(toolCallId ? { toolCallId } : {}),
              tool: string(payload.name) ?? 'terminal',
              presentation: 'native-tui',
            },
          ],
          confidence: 'authoritative',
          disposition: 'mapped',
        };
      }

      case 'clarify.request': {
        const requestId = string(payload.request_id);
        const questions = hermesStructuredQuestions(payload);
        if (!requestId || !questions || this.questionStates.has(requestId)) {
          return { ...base, events: [], confidence: 'authoritative', disposition: 'no-output' };
        }
        boundedMapSet(this.questionStates, requestId, 'requested');
        return {
          ...base,
          events: [{ type: 'question.requested', requestId, questions }],
          confidence: 'authoritative',
          disposition: 'mapped',
        };
      }

      case 'clarify.expire': {
        const requestId = string(payload.request_id);
        if (!requestId || this.questionStates.get(requestId) === 'resolved') {
          return { ...base, events: [], confidence: 'authoritative', disposition: 'no-output' };
        }
        boundedMapSet(this.questionStates, requestId, 'resolved');
        return {
          ...base,
          events: [{ type: 'question.resolved', requestId, outcome: 'cancelled' }],
          confidence: 'authoritative',
          disposition: 'mapped',
        };
      }

      default:
        return { ...base, events: [native(type)], confidence: 'authoritative', disposition: 'retained-native' };
    }
  }
}
