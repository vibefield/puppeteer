import type { AgentEvent } from '@vibefield/puppeteer-core';
import { normalizeAntigravityNative } from './adapter.js';
import { antigravityAssistantMessage } from './conversation.js';
import { antigravityJournalShape, type AntigravityJournalShape } from './journal.js';
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
  // The latest planner step's requested tools in request order, for 1.4.12's
  // GENERIC results. A GENERIC step names no tool, so it joins only the oldest
  // outstanding call, and only when that call is a command (the captured
  // link). The writer records a step's results before the next planner step or
  // prompt, so either one closes the window.
  private readonly outstanding: AntigravityToolFact[] = [];
  private shape: AntigravityJournalShape | undefined;
  /** The journal shape proven so far; undefined until a record proves 1.4.12. */
  journalShape(): AntigravityJournalShape | undefined {
    return this.shape;
  }
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
      // A new prompt ends the previous turn: its unresolved calls can no
      // longer receive a GENERIC result. A 1.4.12 journal drops them from the
      // typed queues too; 1.1.x keeps its original late-result behaviour.
      this.outstanding.length = 0;
      if (this.shape === '1.4.12') this.pending.clear();
      return finish([antigravityTurnStarted(turnId, antigravityPrompt(body.content))], 'mapped', turnId);
    }
    if (type === 'PLANNER_RESPONSE') {
      const turnId = this.currentTurnId ?? `turn:${step}`;
      const events: AgentEvent[] = [];
      const shape = antigravityJournalShape(body);
      if (shape) this.shape = shape;
      // Calls an earlier planner step left unanswered keep their typed queues
      // but can no longer receive a GENERIC result.
      if (this.shape === '1.4.12') this.outstanding.length = 0;
      if (Array.isArray(body.tool_calls)) {
        for (const [index, value] of body.tool_calls.entries()) {
          const fact = antigravityToolFact(step, index, turnId, value, this.shape === '1.4.12');
          if (!fact) continue;
          this.outstanding.push(fact);
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
    let fact = queue?.shift();
    if (queue?.length === 0) this.pending.delete(type);
    if (fact) this.resolveOutstanding(fact);
    else if (type === 'GENERIC' && this.shape === '1.4.12') fact = this.genericResult();
    if (fact) {
      const tool = antigravityToolResult(fact, body);
      const failed = tool.type === 'tool:failed';
      const workspace = antigravityWorkspaceOperation(fact, failed ? 'failed' : 'applied');
      return finish([tool, ...(workspace ? [workspace] : [])], 'mapped', fact.turnId);
    }
    return finish(normalizeAntigravityNative(type), 'retained-native');
  }
  private resolveOutstanding(fact: AntigravityToolFact): void {
    const index = this.outstanding.indexOf(fact);
    if (index >= 0) this.outstanding.splice(index, 1);
  }
  private genericResult(): AntigravityToolFact | undefined {
    const fact = this.outstanding[0];
    if (fact?.expectedType !== 'RUN_COMMAND') return undefined;
    this.outstanding.shift();
    const queue = this.pending.get(fact.expectedType);
    const index = queue?.indexOf(fact) ?? -1;
    if (queue && index >= 0) queue.splice(index, 1);
    if (queue?.length === 0) this.pending.delete(fact.expectedType);
    return fact;
  }
}
