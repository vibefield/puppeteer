import { AcpNotificationNormalizer } from '@vibefield/puppeteer-adapter-acp';
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
 * `closesReasoning` set), and at an assistant message, which this pipeline's own branch owns.
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

  normalize(input: unknown): GrokObservedEvent[] {
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
      return [...this.turn.materializePendingUser(promptId), this.reasoning.progress(promptId, observed)];
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (!promptId) return [];
      const events = this.turn.materializePendingUser(promptId);
      this.turn.setActive(promptId);
      // A thought stream ends where the answer starts; a later thought starts it again.
      events.push(...this.reasoning.complete(promptId, observed));
      events.push(this.conversation.append(update, promptId, observed));
      return events;
    }
    if (update.sessionUpdate === 'turn_completed') {
      const completedPromptId = this.turn.beginCompletion(update, params._meta);
      if (!completedPromptId) return [];
      const events = this.turn.materializePendingUser(completedPromptId);
      events.push(...this.reasoning.complete(completedPromptId, observed));
      const assistant = this.conversation.complete(completedPromptId, observed);
      events.push(...assistant.events);
      events.push(
        observed(
          this.turn.completionEvent(
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
    // A tool record ends the prompt's thought stream; a later thought starts it again.
    return [...this.reasoning.complete(promptId, observed), ...normalized];
  }
}
