import type { AgentEvent } from '@vibecook/puppeteer-core';
import { normalizePiNative } from './adapter.js';
import { normalizePiCompaction } from './compaction.js';
import { normalizePiAssistantMessage } from './conversation.js';
import { normalizePiEffort } from './effort.js';
import { normalizePiModel } from './model.js';
import { normalizePiSession } from './session.js';
import { piToolRequests, piToolResult, type PiToolFact } from './tool.js';
import { piTurnStarted, piTurnTerminal } from './turn.js';
import { normalizePiSummaryUsage, normalizePiUsage } from './usage.js';
import { piWorkspaceOperation } from './workspace.js';
import { piRecord, piString, piTextContent, type PiNormalizedRecord } from './types.js';

const MAX_CORRELATIONS = 1_024;

export class PiSessionNormalizer {
  private currentTurnId: string | undefined;
  private readonly tools = new Map<string, PiToolFact>();

  normalize(input: unknown): PiNormalizedRecord {
    const body = piRecord(input);
    const type = piString(body?.type) ?? 'invalid-record';
    const base = {
      timestamp: piString(body?.timestamp),
      source: 'native-log' as const,
      confidence: 'authoritative' as const,
      nativeEvent: input,
    };
    const finish = (
      events: AgentEvent[],
      disposition: PiNormalizedRecord['disposition'],
      turnId = this.currentTurnId,
    ): PiNormalizedRecord => ({
      ...base,
      events,
      disposition,
      ...(turnId ? { promptId: turnId, turnId } : {}),
    });
    if (!body) return finish(normalizePiNative(type), 'retained-native');

    const direct =
      normalizePiSession(body) ??
      normalizePiModel(body) ??
      normalizePiEffort(body) ??
      normalizePiCompaction(body) ??
      normalizePiSummaryUsage(body);
    if (direct) return finish(direct, direct.length > 0 ? 'mapped' : 'no-output');
    if (type !== 'message') return finish(normalizePiNative(type), 'retained-native');

    const entryId = piString(body.id);
    const message = piRecord(body.message);
    const role = piString(message?.role);
    if (!entryId || !message || !role) return finish(normalizePiNative('message:invalid'), 'retained-native');

    if (role === 'user') {
      this.currentTurnId = entryId;
      return finish([piTurnStarted(entryId, message)], 'mapped', entryId);
    }
    if (role === 'assistant') {
      const turnId = this.currentTurnId ?? entryId;
      const conversation = normalizePiAssistantMessage(entryId, message, turnId);
      const requested = piToolRequests(message, turnId);
      const workspace: AgentEvent[] = [];
      for (const fact of requested.facts) {
        if (!this.tools.has(fact.id) && this.tools.size >= MAX_CORRELATIONS)
          this.tools.delete(this.tools.keys().next().value!);
        this.tools.set(fact.id, fact);
        const operation = piWorkspaceOperation(fact.id, fact, 'proposed');
        if (operation) workspace.push(operation);
      }
      const usage = normalizePiUsage(`pi:${entryId}`, message.usage);
      const terminal = piTurnTerminal(turnId, message, piTextContent(message.content));
      if (terminal) this.currentTurnId = undefined;
      return finish(
        [...conversation, ...requested.events, ...workspace, ...usage, ...(terminal ? [terminal] : [])],
        'mapped',
        turnId,
      );
    }
    if (role === 'toolResult') {
      const id = piString(message.toolCallId);
      const fact = id ? this.tools.get(id) : undefined;
      if (id) this.tools.delete(id);
      const tool = piToolResult(message, fact);
      const workspace =
        id && fact ? piWorkspaceOperation(id, fact, message.isError === true ? 'failed' : 'applied') : undefined;
      return finish(
        [...(tool ? [tool] : []), ...(workspace ? [workspace] : [])],
        tool || workspace ? 'mapped' : 'retained-native',
        fact?.turnId,
      );
    }
    return finish(normalizePiNative(`message:${role}`), 'retained-native');
  }
}
