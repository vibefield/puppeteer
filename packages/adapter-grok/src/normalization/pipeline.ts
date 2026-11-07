import { AcpNotificationNormalizer } from '@vibefield/puppeteer-adapter-acp';
import type { AgentEvent } from '@vibefield/puppeteer-core';
import { normalizeGrokExtension } from './adapter.js';
import { GrokConversationNormalizer } from './conversation.js';
import { normalizeGrokDelegation } from './delegation.js';
import { GrokReasoningNormalizer } from './reasoning.js';
import { normalizeGrokSessionHook } from './session.js';
import { GrokTurnNormalizer } from './turn.js';
import {
  grokRecordTimestamp,
  type GrokObservedEvent,
  type GrokObservedFactory,
  type GrokUpdateRecord,
} from './types.js';

/** Native durable carriers this normalizer actually consumes. */
export const GROK_NORMALIZED_UPDATE_METHODS = ['session/update', '_x.ai/session/update'] as const;
const GROK_NORMALIZED_UPDATE_METHOD_SET = new Set<string>(GROK_NORMALIZED_UPDATE_METHODS);

/**
 * The tool events that end a thought stream: adapter-acp's driver closes reasoning at these (its
 * `CLOSES_REASONING` set), and at an assistant message, which this pipeline's own branch owns.
 */
const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool:requested',
  'tool:started',
  'tool:completed',
  'tool:failed',
]);

/** Session-scoped composition of category-focused Grok log normalizers. */
export class GrokUpdateNormalizer {
  private readonly acp = new AcpNotificationNormalizer();
  private readonly turn = new GrokTurnNormalizer();
  private readonly conversation = new GrokConversationNormalizer();
  private readonly reasoning = new GrokReasoningNormalizer();
  /** The open-work ledger's root tools and subagents, each with the prompt it opened under. */
  private readonly openTools = new Map<string, string | undefined>();
  private readonly openSubagents = new Map<string, string | undefined>();

  /** `replay`: the record is the log's history, written by a process that has gone. */
  normalize(input: unknown, { replay = false }: { replay?: boolean } = {}): GrokObservedEvent[] {
    const events = this.normalizeRecord(input, replay);
    for (const { event, promptId } of events) this.trackOpenWork(event, promptId);
    return events;
  }

  /**
   * The replay is over, and a launch or resume process is not in the middle of what the log last shows: this ends
   * everything the log left open. It never fails a turn: a resumed session is not a failed one, and a failure would
   * hold its queue. The closers are derived, and the observer publishes them before any live record.
   */
  settleReplay(): GrokObservedEvent[] {
    const settled: GrokObservedFactory = (event, promptId) => ({
      event,
      promptId,
      source: 'runtime',
      confidence: 'derived',
      nativeEvent: { code: 'grok-replay-settled' },
    });
    const events = [
      ...[...this.openTools].map(([toolCallId, promptId]) =>
        settled({ type: 'tool:failed', toolCallId, error: 'the session ended before this tool finished' }, promptId),
      ),
      ...[...this.openSubagents].map(([subagentId, promptId]) =>
        settled({ type: 'delegation:subagent-stopped', subagentId }, promptId),
      ),
      ...this.reasoning.openPrompts().flatMap((promptId) => this.reasoning.complete(promptId, settled)),
      ...this.turn
        .settleReplay()
        .map((promptId) => settled(this.turn.completionEvent(promptId, undefined, undefined), promptId)),
    ];
    this.openTools.clear();
    this.openSubagents.clear();
    this.conversation.clear();
    return events;
  }

  private trackOpenWork(event: AgentEvent, promptId: string | undefined): void {
    if (event.type === 'tool:requested' || event.type === 'tool:started') {
      this.openTools.set(event.toolCallId, promptId);
    } else if (event.type === 'tool:completed' || event.type === 'tool:failed') {
      this.openTools.delete(event.toolCallId);
    } else if (event.type === 'delegation:subagent-started') {
      this.openSubagents.set(event.subagentId, promptId);
    } else if (event.type === 'delegation:subagent-stopped') {
      this.openSubagents.delete(event.subagentId);
    }
  }

  private normalizeRecord(input: unknown, replay: boolean): GrokObservedEvent[] {
    const record = input as GrokUpdateRecord;
    const params = record?.params;
    const update = params?.update;
    if (
      !params ||
      !update ||
      typeof update.sessionUpdate !== 'string' ||
      typeof record.method !== 'string' ||
      !GROK_NORMALIZED_UPDATE_METHOD_SET.has(record.method)
    ) {
      return [];
    }

    const timestamp = grokRecordTimestamp(record);
    const observed: GrokObservedFactory = (
      event,
      promptId = this.turn.promptId(update, params._meta),
      source = 'native-transcript',
      confidence = 'authoritative',
    ) => ({ event, promptId, timestamp, source, confidence, nativeEvent: input });

    if (update.sessionUpdate === 'hook_execution') {
      return [...normalizeGrokSessionHook(update, params.sessionId, observed), ...this.turn.normalizeHook(update)];
    }
    if (update.sessionUpdate === 'user_message_chunk') {
      return this.turn.normalizeUser(update, params._meta, timestamp, input, observed);
    }

    const promptId = this.turn.correlatedPromptId(update, params._meta);
    if (update.sessionUpdate === 'agent_thought_chunk') {
      if (!promptId) return [];
      this.turn.reopenSettled(promptId);
      // The prompt's next message record starts a new message.
      this.conversation.interrupt(promptId);
      return [...this.turn.materializePendingUser(promptId), this.reasoning.progress(promptId, observed)];
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (!promptId) return [];
      this.turn.reopenSettled(promptId);
      const events = this.turn.materializePendingUser(promptId);
      this.turn.setActive(promptId);
      // A thought stream ends where the answer starts; a later thought starts it again.
      events.push(...this.reasoning.complete(promptId, observed));
      events.push(this.conversation.append(update, promptId, observed, params._meta));
      return events;
    }
    if (update.sessionUpdate === 'turn_completed') {
      const completedPromptId = this.turn.beginCompletion(update, params._meta);
      if (!completedPromptId) return [];
      const events = this.turn.materializePendingUser(completedPromptId);
      events.push(...this.reasoning.complete(completedPromptId, observed));
      const assistant = this.conversation.complete(completedPromptId, observed);
      events.push(...assistant.events);
      // A live, named error_kind fails the turn whatever its stop_reason says; null, empty or absent completes it. So
      // does a replayed one: what it refused has gone, and the failure would hold a resumed row's queue.
      const errorKind = !replay && typeof update.error_kind === 'string' ? update.error_kind : '';
      events.push(
        observed(
          errorKind
            ? this.turn.failureEvent(completedPromptId, errorKind)
            : this.turn.completionEvent(
                completedPromptId,
                typeof update.stop_reason === 'string' ? update.stop_reason : undefined,
                assistant.text,
              ),
          completedPromptId,
        ),
      );
      this.turn.finishCompletion(completedPromptId);
      return events;
    }

    const delegation = normalizeGrokDelegation(update, promptId, observed);
    if (delegation) return delegation;
    const extension = normalizeGrokExtension(record.method, update, promptId, observed);
    if (extension) return extension;

    // Standard ACP tools/context/config reuse ACP category normalization while
    // the surrounding Grok observation retains durable prompt correlation.
    const notification = params as unknown as Parameters<AcpNotificationNormalizer['normalize']>[0];
    const { events } = this.acp.normalize(notification);
    const normalized = events.map((event) =>
      observed(event, promptId, event.type.startsWith('context-window:') ? 'native-log' : 'native-transcript'),
    );
    if (!promptId || !events.some(({ type }) => TOOL_EVENT_TYPES.has(type))) return normalized;
    this.turn.reopenSettled(promptId);
    // A tool record ends the prompt's thought stream and its current message: a later thought starts
    // reasoning again, and the next message record starts a new message.
    this.conversation.interrupt(promptId);
    return [...this.reasoning.complete(promptId, observed), ...normalized];
  }
}
