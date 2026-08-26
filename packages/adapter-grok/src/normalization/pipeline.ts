import { AcpNotificationNormalizer } from '@vibecook/puppeteer-adapter-acp';
import { normalizeGrokExtension } from './adapter.js';
import { GrokConversationNormalizer } from './conversation.js';
import { normalizeGrokDelegation } from './delegation.js';
import { GrokReasoningNormalizer } from './reasoning.js';
import { GrokStateNormalizer } from './state.js';
import {
  grokRecordTimestamp,
  type GrokObservedEvent,
  type GrokObservedFactory,
  type GrokUpdateRecord,
} from './types.js';

/** Session-scoped composition of category-focused Grok log normalizers. */
export class GrokUpdateNormalizer {
  private readonly acp = new AcpNotificationNormalizer();
  private readonly state = new GrokStateNormalizer();
  private readonly conversation = new GrokConversationNormalizer();
  private readonly reasoning = new GrokReasoningNormalizer();

  normalize(input: unknown): GrokObservedEvent[] {
    const record = input as GrokUpdateRecord;
    const params = record?.params;
    const update = params?.update;
    if (!params || !update || typeof update.sessionUpdate !== 'string') return [];

    const timestamp = grokRecordTimestamp(record);
    const observed: GrokObservedFactory = (
      event,
      promptId = this.state.promptId(update, params._meta),
      source = 'native-transcript',
      confidence = 'authoritative',
    ) => ({ event, promptId, timestamp, source, confidence, nativeEvent: input });

    if (update.sessionUpdate === 'hook_execution') {
      return this.state.normalizeHook(update, params.sessionId, observed);
    }
    if (update.sessionUpdate === 'user_message_chunk') {
      return this.state.normalizeUser(update, params._meta, timestamp, input, observed);
    }

    const promptId = this.state.correlatedPromptId(update, params._meta);
    if (update.sessionUpdate === 'agent_thought_chunk') {
      if (!promptId) return [];
      return [...this.state.materializePendingUser(promptId), this.reasoning.progress(promptId, observed)];
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (!promptId) return [];
      const events = this.state.materializePendingUser(promptId);
      this.state.setActive(promptId);
      events.push(this.conversation.append(update, promptId, observed));
      return events;
    }
    if (update.sessionUpdate === 'turn_completed') {
      const completedPromptId = this.state.beginCompletion(update, params._meta);
      if (!completedPromptId) return [];
      const events = this.state.materializePendingUser(completedPromptId);
      events.push(...this.reasoning.complete(completedPromptId, observed));
      const assistant = this.conversation.complete(completedPromptId, observed);
      events.push(...assistant.events);
      events.push(
        observed(
          this.state.completionEvent(
            completedPromptId,
            typeof update.stop_reason === 'string' ? update.stop_reason : undefined,
            assistant.text,
          ),
          completedPromptId,
        ),
      );
      this.state.finishCompletion(completedPromptId);
      return events;
    }

    const delegation = normalizeGrokDelegation(update, promptId, observed);
    if (delegation) return delegation;
    const extension = normalizeGrokExtension(update, promptId, observed);
    if (extension) return extension;

    // Standard ACP tools/context/config reuse ACP category normalization while
    // the surrounding Grok observation retains durable prompt correlation.
    const notification = params as unknown as Parameters<AcpNotificationNormalizer['normalize']>[0];
    return this.acp
      .normalize(notification)
      .events.map((event) =>
        observed(event, promptId, event.type.startsWith('context-window.') ? 'native-log' : 'native-transcript'),
      );
  }
}
