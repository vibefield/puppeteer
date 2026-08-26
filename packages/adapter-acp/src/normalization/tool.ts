import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { ToolActivityKind, ToolPresentation } from '@vibecook/puppeteer-core';
import type { AcpEventOfType } from './types.js';

type AcpToolEvent = AcpEventOfType<'tool:started' | 'tool:completed' | 'tool:failed'>;

function detailOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 237)}…` : text;
  } catch {
    return undefined;
  }
}

function toolPresentation(kind: string | undefined, title: string | undefined, input: unknown): ToolPresentation {
  const normalized = (kind ?? title ?? '').toLowerCase();
  let activity: ToolActivityKind = 'other';
  let fallback = 'Using tool';
  if (normalized === 'execute') {
    activity = 'command';
    fallback = 'Running command';
  } else if (normalized === 'read') {
    activity = 'file-read';
    fallback = 'Reading files';
  } else if (['edit', 'delete', 'move'].includes(normalized)) {
    activity = 'file-edit';
    fallback = 'Editing files';
  } else if (['fetch', 'search'].includes(normalized)) {
    activity = 'web-search';
    fallback = normalized === 'search' ? 'Searching the web' : 'Fetching from the web';
  }
  return { kind: activity, title: title || fallback, detail: detailOf(input) };
}

/** ACP tool call/update → tool lifecycle event adapter. */
export function normalizeAcpTool(update: SessionUpdate): AcpToolEvent[] {
  if (update.sessionUpdate === 'tool_call') {
    const toolCallId = update.toolCallId;
    const tool = update.kind ?? update.title ?? 'tool';
    const presentation = toolPresentation(update.kind ?? undefined, update.title ?? undefined, update.rawInput);
    const events: AcpToolEvent[] = [{ type: 'tool:started', toolCallId, tool, input: update.rawInput, presentation }];
    if (update.status === 'completed') {
      events.push({
        type: 'tool:completed',
        toolCallId,
        tool,
        output: update.rawOutput ?? update.content,
        presentation,
      });
    } else if (update.status === 'failed') {
      events.push({ type: 'tool:failed', toolCallId, tool });
    }
    return events;
  }

  if (update.sessionUpdate !== 'tool_call_update') return [];
  const toolCallId = update.toolCallId;
  const tool = update.kind ?? update.title ?? undefined;
  const presentation = toolPresentation(update.kind ?? undefined, update.title ?? undefined, update.rawInput);
  if (update.status === 'completed') {
    return [
      {
        type: 'tool:completed',
        toolCallId,
        tool,
        output: update.rawOutput ?? update.content,
        presentation,
      },
    ];
  }
  if (update.status === 'failed') return [{ type: 'tool:failed', toolCallId, tool, presentation }];
  return [];
}
