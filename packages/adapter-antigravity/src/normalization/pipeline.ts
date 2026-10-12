import type { AgentEvent } from '@vibefield/puppeteer-core';
import { normalizeAntigravityNative } from './adapter.js';
import { antigravityAssistantMessage } from './conversation.js';
import {
  antigravityToolFact,
  antigravityToolRequested,
  antigravityToolResult,
  type AntigravityToolFact,
} from './tool.js';
import { antigravityTurnCompleted, antigravityTurnFailed, antigravityTurnStarted } from './turn.js';
import {
  antigravityErrorText,
  antigravityPrompt,
  antigravityRecord,
  antigravityStep,
  antigravityString,
  type AntigravityNormalizedRecord,
} from './types.js';
import { antigravityWorkspaceOperation } from './workspace.js';

export class AntigravityTranscriptNormalizer {
  private currentTurnId: string | undefined;
  private readonly pending = new Map<string, AntigravityToolFact[]>();
  normalize(input: unknown): AntigravityNormalizedRecord {
    const body = antigravityRecord(input);
    const type = antigravityString(body?.type) ?? 'invalid-record';
    const step = antigravityStep(body?.step_index) ?? 'unknown';
    // The row itself is authoritative, but this adapter synthesizes turn and
    // tool correlation because the transcript exposes only step indexes and
    // result kinds. Understate the whole projection instead of laundering
    // those inferred joins into an authoritative normalized event.
    const base = {
      timestamp: antigravityString(body?.created_at),
      source: 'native-log' as const,
      confidence: 'derived' as const,
      nativeEvent: input,
    };
    const finish = (
      events: AgentEvent[],
      disposition: AntigravityNormalizedRecord['disposition'],
      turnId = this.currentTurnId,
    ): AntigravityNormalizedRecord => ({
      ...base,
      events,
      disposition,
      ...(turnId ? { promptId: turnId, turnId } : {}),
    });
    if (!body) return finish(normalizeAntigravityNative(type), 'retained-native');
    if (type === 'USER_INPUT') {
      const turnId = `turn:${step}`;
      this.currentTurnId = turnId;
      return finish([antigravityTurnStarted(turnId, antigravityPrompt(body.content))], 'mapped', turnId);
    }
    if (type === 'PLANNER_RESPONSE') {
      const turnId = this.currentTurnId ?? `turn:${step}`;
      const events: AgentEvent[] = [];
      if (Array.isArray(body.tool_calls)) {
        for (const [index, value] of body.tool_calls.entries()) {
          const fact = antigravityToolFact(step, index, turnId, value);
          if (!fact) continue;
          if (fact.expectedType) {
            const queue = this.pending.get(fact.expectedType) ?? [];
            queue.push(fact);
            this.pending.set(fact.expectedType, queue);
          }
          events.push(antigravityToolRequested(fact));
          const workspace = antigravityWorkspaceOperation(fact, 'proposed');
          if (workspace) events.push(workspace);
        }
      }
      if (typeof body.thinking === 'string')
        events.push(
          { type: 'reasoning:started', reasoningId: `step:${step}` },
          { type: 'reasoning:progress', reasoningId: `step:${step}` },
          { type: 'reasoning:completed', reasoningId: `step:${step}` },
        );
      if (typeof body.content === 'string') {
        events.push(
          antigravityAssistantMessage(step, turnId, body.content),
          antigravityTurnCompleted(turnId, body.content),
        );
        this.currentTurnId = undefined;
      }
      return finish(events, events.length ? 'mapped' : 'no-output', turnId);
    }
    // CHECKPOINT is persisted after ordinary turns in the captured journal.
    // Its name does not prove a context compaction or invalidation boundary.
    if (type === 'CHECKPOINT') return finish(normalizeAntigravityNative(type), 'retained-native');
    if (type === 'ERROR_MESSAGE') {
      const turnId = this.currentTurnId ?? `turn:${step}`;
      this.currentTurnId = undefined;
      return finish(
        [antigravityTurnFailed(turnId, antigravityErrorText(body.error ?? body.content))],
        'mapped',
        turnId,
      );
    }
    const queue = this.pending.get(type);
    const fact = queue?.shift();
    if (queue?.length === 0) this.pending.delete(type);
    if (fact) {
      const tool = antigravityToolResult(fact, body);
      const failed = tool.type === 'tool:failed';
      const workspace = antigravityWorkspaceOperation(fact, failed ? 'failed' : 'applied');
      return finish([tool, ...(workspace ? [workspace] : [])], 'mapped', fact.turnId);
    }
    return finish(normalizeAntigravityNative(type), 'retained-native');
  }
}
