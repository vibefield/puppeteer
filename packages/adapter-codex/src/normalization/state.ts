import type { StateEvent } from '@vibecook/puppeteer-core';
import {
  type CategoryNormalization,
  type CodexNormalizationInput,
  itemText,
  rec,
  str,
  toolPresentation,
} from './types.js';

export interface StateNormalization extends CategoryNormalization<StateEvent> {
  turnId?: string;
  userMessageClientId?: string | null;
}

/** Codex lifecycle, turn, reasoning, tool, and interaction normalization. */
export class CodexStateNormalizer {
  private readonly reasoningSummaries = new Map<string, string>();
  private pendingTurn: { turnId?: string; emitted: boolean } | undefined;

  currentTurnId(): string | undefined {
    return this.pendingTurn?.turnId;
  }

  normalize(input: CodexNormalizationInput): StateNormalization {
    const events: StateEvent[] = [];
    const result: StateNormalization = { handled: false, events };
    const { method, params } = input;

    const flushTurnStarted = (prompt?: string): void => {
      if (!this.pendingTurn || this.pendingTurn.emitted) return;
      events.push({ type: 'turn.started', turnId: this.pendingTurn.turnId, prompt });
      this.pendingTurn.emitted = true;
    };

    if (method === 'item/started' || method === 'item/completed') {
      const item = rec(params.item);
      if (!item) return result;
      const phase = method === 'item/started' ? 'started' : 'completed';
      const itemType = str(item.type);
      const itemId = str(item.id) ?? 'unknown-item';

      switch (itemType) {
        case 'userMessage':
          result.handled = true;
          if (phase === 'completed') {
            result.userMessageClientId = str(item.clientId) ?? null;
            flushTurnStarted(itemText(item));
          }
          return result;

        case 'reasoning':
          result.handled = true;
          if (phase === 'started') {
            events.push({ type: 'reasoning.started', reasoningId: itemId });
          } else {
            const summary = Array.isArray(item.summary)
              ? item.summary.filter((part): part is string => typeof part === 'string').join('\n\n')
              : undefined;
            if (summary && summary !== this.reasoningSummaries.get(itemId)) {
              events.push({ type: 'reasoning.summary', reasoningId: itemId, text: summary, final: true });
            }
            this.reasoningSummaries.delete(itemId);
            events.push({ type: 'reasoning.completed', reasoningId: itemId });
          }
          return result;

        case 'commandExecution': {
          result.handled = true;
          const command = item.command;
          if (phase === 'started') {
            events.push({
              type: 'tool.started',
              toolCallId: itemId,
              tool: 'command',
              input: command,
              presentation: toolPresentation('command', 'Running command', command),
            });
          } else {
            const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
            if (failed) {
              events.push({
                type: 'tool.failed',
                toolCallId: itemId,
                tool: 'command',
                error: `command exited with status ${String(item.status ?? item.exitCode)}`,
                presentation: toolPresentation('command', 'Command failed', command),
              });
            } else {
              events.push({
                type: 'tool.completed',
                toolCallId: itemId,
                tool: 'command',
                output: item.aggregatedOutput,
                presentation: toolPresentation('command', 'Ran command', command),
              });
            }
          }
          return result;
        }

        case 'fileChange':
          result.handled = true;
          events.push({
            type: phase === 'started' ? 'tool.started' : 'tool.completed',
            toolCallId: itemId,
            tool: 'apply_patch',
            presentation: toolPresentation(
              'file-edit',
              phase === 'started' ? 'Editing files' : 'Edited files',
              item.changes ?? item.path,
            ),
          });
          return result;

        case 'webSearch':
          result.handled = true;
          events.push({
            type: phase === 'started' ? 'tool.started' : 'tool.completed',
            toolCallId: itemId,
            tool: 'web_search',
            ...(phase === 'started' ? { input: item.query } : { output: item.results }),
            presentation: toolPresentation(
              'web-search',
              phase === 'started' ? 'Searching the web' : 'Searched the web',
              item.query,
            ),
          });
          return result;

        case 'mcpToolCall': {
          result.handled = true;
          const tool = str(item.tool) ?? str(item.name) ?? 'mcp';
          events.push({
            type: phase === 'started' ? 'tool.started' : 'tool.completed',
            toolCallId: itemId,
            tool,
            ...(phase === 'started' ? { input: item.arguments } : { output: item.result }),
            presentation: toolPresentation(
              'mcp',
              str(item.name) ?? (phase === 'started' ? 'Using MCP tool' : 'Used MCP tool'),
              item.arguments,
            ),
          });
          return result;
        }

        default:
          return result;
      }
    }

    switch (method) {
      case 'thread/started': {
        result.handled = true;
        const thread = rec(params.thread);
        events.push({
          type: 'session.started',
          nativeSessionId: str(thread?.id) ?? input.threadId,
          title: str(thread?.name) ?? (str(thread?.preview) || undefined),
        });
        break;
      }

      case 'thread/closed':
        result.handled = true;
        events.push({ type: 'session.exited', reason: 'thread-closed' });
        break;

      case 'turn/started':
        result.handled = true;
        this.pendingTurn = { turnId: str(rec(params.turn)?.id), emitted: false };
        result.turnId = this.pendingTurn.turnId;
        break;

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryPartAdded':
        result.handled = true;
        events.push({ type: 'reasoning.progress', reasoningId: str(params.itemId) });
        break;

      case 'item/reasoning/summaryTextDelta': {
        result.handled = true;
        const itemId = str(params.itemId) ?? 'reasoning';
        const summary = (this.reasoningSummaries.get(itemId) ?? '') + (str(params.delta) ?? '');
        this.reasoningSummaries.set(itemId, summary);
        events.push({ type: 'reasoning.summary', reasoningId: itemId, text: summary, final: false });
        break;
      }

      case 'turn/completed': {
        result.handled = true;
        const turn = rec(params.turn);
        const turnId = str(turn?.id) ?? this.pendingTurn?.turnId;
        flushTurnStarted();
        const status = str(turn?.status);
        const nativeError = turn?.error;
        if (status === 'failed' || (nativeError !== null && nativeError !== undefined)) {
          const error = typeof nativeError === 'string' ? nativeError : str(rec(nativeError)?.message);
          events.push({ type: 'turn.failed', turnId, error });
        } else {
          events.push({ type: 'turn.completed', turnId });
        }
        this.pendingTurn = undefined;
        break;
      }
    }

    return result;
  }
}
