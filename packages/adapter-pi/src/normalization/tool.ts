import type { AgentEvent, ToolActivityKind, ToolPresentation } from '@vibecook/puppeteer-core';
import { piErrorText, piRecord, piString } from './types.js';

export interface PiToolFact {
  id: string;
  tool: string;
  input?: unknown;
  turnId?: string;
}

function presentation(tool: string, input: unknown, complete = false): ToolPresentation {
  const lower = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  if (['bash', 'shell'].includes(lower)) kind = 'command';
  else if (['read', 'grep', 'find', 'ls'].includes(lower)) kind = 'file-read';
  else if (['write', 'edit', 'apply_patch'].includes(lower)) kind = 'file-edit';
  else if (lower.includes('search')) kind = 'web-search';
  else if (lower.startsWith('mcp')) kind = 'mcp';
  const inputBody = piRecord(input);
  const detail = piString(inputBody?.command) ?? piString(inputBody?.path) ?? piString(inputBody?.query);
  return { kind, title: `${complete ? 'Used' : 'Using'} ${tool}`, ...(detail ? { detail } : {}) };
}

export function piToolRequests(
  message: Record<string, unknown>,
  turnId?: string,
): { events: AgentEvent[]; facts: PiToolFact[] } {
  const events: AgentEvent[] = [];
  const facts: PiToolFact[] = [];
  if (!Array.isArray(message.content)) return { events, facts };
  for (const partValue of message.content) {
    const part = piRecord(partValue);
    if (part?.type !== 'toolCall') continue;
    const id = piString(part.id);
    const tool = piString(part.name);
    if (!id || !tool) continue;
    const fact = {
      id,
      tool,
      ...(part.arguments !== undefined ? { input: part.arguments } : {}),
      ...(turnId ? { turnId } : {}),
    };
    facts.push(fact);
    events.push({
      type: 'tool:requested',
      toolCallId: id,
      tool,
      ...(part.arguments !== undefined ? { input: part.arguments } : {}),
      presentation: presentation(tool, part.arguments),
    });
  }
  return { events, facts };
}

export function piToolResult(message: Record<string, unknown>, fact?: PiToolFact): AgentEvent | undefined {
  const id = piString(message.toolCallId);
  if (!id) return undefined;
  const tool = piString(message.toolName) ?? fact?.tool;
  const output = message.content;
  if (message.isError === true) {
    return {
      type: 'tool:failed',
      toolCallId: id,
      ...(tool ? { tool } : {}),
      ...(piErrorText(message.errorMessage ?? output) ? { error: piErrorText(message.errorMessage ?? output) } : {}),
      ...(tool ? { presentation: presentation(tool, fact?.input, true) } : {}),
    };
  }
  return {
    type: 'tool:completed',
    toolCallId: id,
    ...(tool ? { tool } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(tool ? { presentation: presentation(tool, fact?.input, true) } : {}),
  };
}
