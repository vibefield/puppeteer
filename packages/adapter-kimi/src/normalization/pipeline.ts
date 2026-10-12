import type { AgentEvent } from '@vibefield/puppeteer-core';
import { kimiAdapterDisposition } from './adapter.js';
import { KimiConversationNormalizer } from './conversation.js';
import { normalizeKimiContextWindow } from './context-window.js';
import { KimiDelegationNormalizer } from './delegation.js';
import { normalizeKimiEnvironment } from './environment.js';
import { normalizeKimiEffort } from './effort.js';
import { normalizeKimiModel } from './model.js';
import { KimiInteractionNormalizer } from './interaction.js';
import { KimiReasoningNormalizer } from './reasoning.js';
import { KimiToolNormalizer } from './tool.js';
import { KimiTurnNormalizer } from './turn.js';
import { KimiWorkspaceNormalizer } from './workspace.js';
import {
  kimiErrorText,
  kimiNativeEvent,
  kimiRecord,
  kimiString,
  kimiTimestamp,
  type KimiNormalizationContext,
  type KimiNormalizationDisposition,
  type KimiNormalizedFragment,
  type KimiNormalizedRecord,
} from './types.js';

/** One session-scoped composition of category-focused Kimi normalizers. */
export class KimiWireNormalizer {
  private readonly turn = new KimiTurnNormalizer();
  private readonly conversation = new KimiConversationNormalizer();
  private readonly reasoning = new KimiReasoningNormalizer();
  private readonly tool = new KimiToolNormalizer();
  private readonly workspace = new KimiWorkspaceNormalizer();
  private readonly interaction = new KimiInteractionNormalizer();
  private readonly delegation = new KimiDelegationNormalizer();

  normalize(input: unknown, context: KimiNormalizationContext = {}): KimiNormalizedRecord {
    const body = kimiRecord(input);
    const type = kimiString(body?.type) ?? 'invalid-record';
    const base = {
      timestamp: kimiTimestamp(body?.time ?? body?.created_at),
      source: 'native-log' as const,
      confidence: 'authoritative' as const,
      nativeEvent: input,
    };
    const result = (
      events: AgentEvent[],
      disposition: KimiNormalizationDisposition,
      fields: Pick<KimiNormalizedRecord, 'promptId' | 'turnId' | 'explanation'> = {},
    ): KimiNormalizedRecord => ({ ...base, events, disposition, ...fields });

    const agentId = context.agentId ?? 'main';
    if (agentId !== 'main') {
      return result([kimiNativeEvent(type)], 'retained-native', {
        explanation: `The ${agentId} journal is retained without projecting its private lifecycle onto the main session.`,
      });
    }
    if (!body) return result([kimiNativeEvent(type)], 'retained-native');

    if (type === 'turn.prompt') {
      this.turn.bufferPrompt(body);
      return result([], 'buffered', {
        explanation: 'Kimi persists the prompt before its native turn id; step.begin releases the correlation.',
      });
    }
    if (type === 'context.append_loop_event') return this.normalizeLoopEvent(body, input, base);
    if (type === 'turn.ended') return this.completeTurn(body, type, result);

    const environment = normalizeKimiEnvironment(type, body);
    const model = normalizeKimiModel(type, body);
    const effort = normalizeKimiEffort(type, body);
    if (environment || model || effort) {
      const events = [...(environment ?? []), ...(model ?? []), ...(effort ?? [])];
      return result(events, events.length > 0 ? 'mapped' : 'no-output');
    }
    const contextWindow = normalizeKimiContextWindow(type);
    if (contextWindow) return result(contextWindow, 'mapped');

    if (type === 'interaction.request') {
      const events = this.interaction.request(body);
      if (!events) {
        const kind = kimiString(body.kind) ?? 'unknown';
        return result([kimiNativeEvent(`interaction.request:${kind}`)], 'retained-native');
      }
      return result(events, 'mapped', { turnId: this.turn.currentTurnId() });
    }
    if (type === 'interaction.resolved') {
      const events = this.interaction.resolve(body);
      return events
        ? result(events, 'mapped', { turnId: this.turn.currentTurnId() })
        : result([kimiNativeEvent(type)], 'retained-native');
    }

    if (type === 'task.started') {
      const events = this.delegation.started(body);
      return events
        ? result(events, 'mapped', { turnId: this.turn.currentTurnId() })
        : result([kimiNativeEvent(type)], 'retained-native');
    }
    if (type === 'task.terminated') {
      const events = this.delegation.terminated(body);
      return events
        ? result(events, events.length > 0 ? 'mapped' : 'no-output', { turnId: this.turn.currentTurnId() })
        : result([kimiNativeEvent(type)], 'retained-native');
    }

    const disposition = kimiAdapterDisposition(type);
    return disposition === 'no-output'
      ? result([], disposition)
      : result([kimiNativeEvent(type)], disposition, { turnId: this.turn.currentTurnId() });
  }

  private completeTurn(
    body: Record<string, unknown>,
    nativeType: string,
    result: (
      events: AgentEvent[],
      disposition: KimiNormalizationDisposition,
      fields?: Pick<KimiNormalizedRecord, 'promptId' | 'turnId' | 'explanation'>,
    ) => KimiNormalizedRecord,
  ): KimiNormalizedRecord {
    const turnId = this.turn.resolveTurnId(body.turnId);
    if (!turnId) return result([kimiNativeEvent(nativeType)], 'retained-native');
    if (this.turn.isTerminal(turnId)) return result([], 'no-output', { turnId });
    const events = this.turn.startIfNeeded(turnId);
    events.push(...this.reasoning.complete(turnId));
    const assistant = this.conversation.complete(turnId);
    events.push(...assistant.events);
    const reason = kimiString(body.reason) ?? 'unknown';
    if (reason === 'failed' || reason === 'blocked') {
      events.push(this.turn.failed(turnId, kimiErrorText(body.error) ?? reason));
    } else {
      events.push(this.turn.completed(turnId, reason, assistant.text));
    }
    this.turn.settle(turnId);
    return result(events, 'mapped', { promptId: turnId, turnId });
  }

  private normalizeLoopEvent(
    body: Record<string, unknown>,
    input: unknown,
    base: Pick<KimiNormalizedRecord, 'timestamp' | 'source' | 'confidence' | 'nativeEvent'>,
  ): KimiNormalizedRecord {
    const loop = kimiRecord(body.event);
    const loopType = kimiString(loop?.type) ?? 'unknown';
    const turnId = this.turn.resolveTurnId(loop?.turnId);
    const finish = (fragment: KimiNormalizedFragment): KimiNormalizedRecord => {
      const correlatedTurnId = fragment.turnId ?? turnId;
      return {
        ...base,
        nativeEvent: input,
        events: fragment.events,
        disposition: fragment.disposition,
        ...(correlatedTurnId ? { promptId: correlatedTurnId, turnId: correlatedTurnId } : {}),
        ...(fragment.explanation ? { explanation: fragment.explanation } : {}),
      };
    };

    if (loopType === 'step.begin') {
      if (!turnId) return finish(this.retainedLoop(loopType));
      const begun = this.turn.beginStep(turnId);
      if (begun.restarted) {
        this.reasoning.reset(turnId);
        this.conversation.reset(turnId);
      }
      return finish({ events: begun.events, disposition: begun.events.length > 0 ? 'mapped' : 'no-output' });
    }

    if (loopType === 'content.part') {
      if (!turnId) return finish(this.retainedLoop(loopType));
      if (this.turn.isTerminal(turnId)) {
        return finish({
          events: [kimiNativeEvent(`late:context.append_loop_event:${loopType}`)],
          disposition: 'retained-native',
          explanation: 'Content after a terminal turn is retained but cannot mutate portable conversation state.',
        });
      }
      const events = this.turn.startIfNeeded(turnId);
      const part = kimiRecord(loop?.part);
      if (part?.type === 'think') {
        events.push(this.reasoning.progress(turnId));
        return finish({ events, disposition: 'mapped' });
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        events.push(this.conversation.append(turnId, part.text));
        return finish({ events, disposition: 'mapped' });
      }
      events.push(kimiNativeEvent(`context.append_loop_event:content.part:${kimiString(part?.type) ?? 'unknown'}`));
      return finish({ events, disposition: 'retained-native' });
    }

    if (loopType === 'tool.call') {
      const tool = this.tool.call(loop ?? {}, turnId);
      const workspace = tool.disposition === 'mapped' ? this.workspace.call(loop ?? {}) : undefined;
      return finish({ ...tool, events: [...tool.events, ...(workspace ? [workspace] : [])] });
    }
    if (loopType === 'tool.result') {
      const tool = this.tool.result(loop ?? {}, turnId, (candidate) => this.turn.isTerminal(candidate));
      const workspace = this.workspace.result(loop ?? {}, tool.disposition === 'mapped');
      return finish({ ...tool, events: [...tool.events, ...(workspace ? [workspace] : [])] });
    }
    if (loopType === 'step.end') return finish({ events: [], disposition: 'no-output' });
    return finish(this.retainedLoop(loopType));
  }

  private retainedLoop(loopType: string): KimiNormalizedFragment {
    return {
      events: [kimiNativeEvent(`context.append_loop_event:${loopType}`)],
      disposition: 'retained-native',
    };
  }
}
