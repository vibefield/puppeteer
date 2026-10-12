import type { ToolActivityKind, ToolPresentation } from '@vibefield/puppeteer-core';
import type { PendingPermission, RecentToolRequest } from './types.js';
import { claudeRecord, claudeString } from './wire.js';

export function sameClaudeTool(
  left: Pick<PendingPermission, 'promptId' | 'toolName' | 'inputKey'>,
  right: Pick<RecentToolRequest, 'promptId' | 'toolName' | 'inputKey'>,
): boolean {
  return left.promptId === right.promptId && left.toolName === right.toolName && left.inputKey === right.inputKey;
}

export function claudeToolPresentation(tool: string, input: unknown, completed = false): ToolPresentation {
  const name = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  let title = completed ? `Used ${tool}` : `Using ${tool}`;
  if (['bash', 'shell', 'command', 'execute'].includes(name)) {
    kind = 'command';
    title = completed ? 'Ran command' : 'Running command';
  } else if (['websearch', 'web_search', 'search'].includes(name)) {
    kind = 'web-search';
    title = completed ? 'Searched the web' : 'Searching the web';
  } else if (['webfetch', 'fetch', 'browser'].includes(name)) {
    kind = 'browser';
    title = completed ? 'Fetched web content' : 'Fetching web content';
  } else if (['read', 'glob', 'grep'].includes(name)) {
    kind = 'file-read';
    title = completed ? 'Read files' : 'Reading files';
  } else if (['write', 'edit', 'multiedit', 'apply_patch', 'notebookedit'].includes(name)) {
    kind = 'file-edit';
    title = completed ? 'Edited files' : 'Editing files';
  } else if (name.startsWith('mcp__') || name.startsWith('mcp_')) {
    kind = 'mcp';
  }
  const data = claudeRecord(input);
  const detail =
    claudeString(data?.command) ??
    claudeString(data?.query) ??
    claudeString(data?.url) ??
    claudeString(data?.file_path) ??
    claudeString(data?.path) ??
    claudeString(data?.pattern) ??
    claudeString(data?.prompt);
  return { kind, title, detail };
}

export function normalizeClaudeToolRequested(
  toolCallId: string,
  tool: string,
  input: unknown,
): import('@vibefield/puppeteer-core').AgentEvent {
  return { type: 'tool:requested', toolCallId, tool, input, presentation: claudeToolPresentation(tool, input) };
}

export function normalizeClaudeToolCompleted(
  toolCallId: string,
  tool: string | undefined,
  output: unknown,
  durationMs: number | undefined,
): import('@vibefield/puppeteer-core').AgentEvent {
  return {
    type: 'tool:completed',
    toolCallId,
    tool,
    output,
    durationMs,
    presentation: claudeToolPresentation(tool ?? 'tool', undefined, true),
  };
}

export function normalizeClaudeToolFailed(
  toolCallId: string,
  tool: string | undefined,
  error: string | undefined,
): import('@vibefield/puppeteer-core').AgentEvent {
  return {
    type: 'tool:failed',
    toolCallId,
    tool,
    error,
    presentation: claudeToolPresentation(tool ?? 'tool', undefined, true),
  };
}
