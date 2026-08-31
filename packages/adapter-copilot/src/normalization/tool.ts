import type { AgentEvent, ToolActivityKind, ToolPresentation } from '@vibecook/puppeteer-core';
import { copilotErrorText, copilotRecord, copilotString } from './types.js';

export interface CopilotToolFact {
  tool: string;
  input?: unknown;
  turnId?: string;
}
function presentation(tool: string, input: unknown, complete = false): ToolPresentation {
  const lower = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  if (['bash', 'shell'].includes(lower)) kind = 'command';
  else if (['view', 'read', 'grep', 'glob'].some((name) => lower.includes(name))) kind = 'file-read';
  else if (['edit', 'write', 'create', 'patch'].some((name) => lower.includes(name))) kind = 'file-edit';
  else if (lower.includes('search')) kind = 'web-search';
  else if (lower.includes('browser') || lower.includes('fetch')) kind = 'browser';
  else if (lower.includes('mcp')) kind = 'mcp';
  const body = copilotRecord(input);
  const detail =
    copilotString(body?.command) ??
    copilotString(body?.path) ??
    copilotString(body?.fileName) ??
    copilotString(body?.query);
  return { kind, title: `${complete ? 'Used' : 'Using'} ${tool}`, ...(detail ? { detail } : {}) };
}
export function copilotToolRequested(toolCallId: string, tool: string, input: unknown): AgentEvent {
  return {
    type: 'tool:requested',
    toolCallId,
    tool,
    ...(input !== undefined ? { input } : {}),
    presentation: presentation(tool, input),
  };
}
export function copilotToolStarted(toolCallId: string, fact: CopilotToolFact): AgentEvent {
  return {
    type: 'tool:started',
    toolCallId,
    tool: fact.tool,
    ...(fact.input !== undefined ? { input: fact.input } : {}),
    presentation: presentation(fact.tool, fact.input),
  };
}
export function copilotToolCompleted(
  toolCallId: string,
  data: Record<string, unknown>,
  fact?: CopilotToolFact,
): AgentEvent {
  const tool = fact?.tool;
  if (data.success === false || data.error !== undefined)
    return {
      type: 'tool:failed',
      toolCallId,
      ...(tool ? { tool } : {}),
      ...(copilotErrorText(data.error ?? data.result) ? { error: copilotErrorText(data.error ?? data.result) } : {}),
      ...(tool ? { presentation: presentation(tool, fact?.input, true) } : {}),
    };
  return {
    type: 'tool:completed',
    toolCallId,
    ...(tool ? { tool } : {}),
    ...(data.result !== undefined ? { output: data.result } : {}),
    ...(tool ? { presentation: presentation(tool, fact?.input, true) } : {}),
  };
}
