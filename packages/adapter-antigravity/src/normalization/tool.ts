import type { AgentEvent, ToolActivityKind, ToolPresentation } from '@vibefield/puppeteer-core';
import { antigravityErrorText, antigravityRecord, antigravityString } from './types.js';
export interface AntigravityToolFact {
  id: string;
  tool: string;
  input?: unknown;
  turnId: string;
  expectedType?: 'RUN_COMMAND' | 'LIST_DIRECTORY' | 'VIEW_FILE';
}
function expectedType(tool: string): AntigravityToolFact['expectedType'] {
  const value = tool.toLowerCase();
  if (value.includes('command') || value === 'shell' || value === 'bash') return 'RUN_COMMAND';
  if (value.includes('list') && value.includes('director')) return 'LIST_DIRECTORY';
  if (value.includes('view') || value.includes('read')) return 'VIEW_FILE';
  return undefined;
}
function presentation(tool: string, input: unknown, complete = false): ToolPresentation {
  const lower = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  if (lower.includes('command') || ['bash', 'shell'].includes(lower)) kind = 'command';
  else if (lower.includes('view') || lower.includes('read') || lower.includes('list')) kind = 'file-read';
  else if (lower.includes('write') || lower.includes('replace') || lower.includes('edit') || lower.includes('patch'))
    kind = 'file-edit';
  else if (lower.includes('search')) kind = 'web-search';
  const body = antigravityRecord(input);
  const detail =
    antigravityString(body?.commandLine) ??
    antigravityString(body?.AbsolutePath) ??
    antigravityString(body?.DirectoryPath) ??
    antigravityString(body?.path);
  return { kind, title: `${complete ? 'Used' : 'Using'} ${tool}`, ...(detail ? { detail } : {}) };
}
export function antigravityToolFact(
  step: string,
  index: number,
  turnId: string,
  value: unknown,
): AntigravityToolFact | undefined {
  const body = antigravityRecord(value);
  const tool = antigravityString(body?.name);
  if (!tool) return undefined;
  const resultType = expectedType(tool);
  return {
    id: `step:${step}:tool:${index}`,
    tool,
    ...(body?.args !== undefined ? { input: body.args } : {}),
    turnId,
    ...(resultType ? { expectedType: resultType } : {}),
  };
}
export function antigravityToolRequested(fact: AntigravityToolFact): AgentEvent {
  return {
    type: 'tool:requested',
    toolCallId: fact.id,
    tool: fact.tool,
    ...(fact.input !== undefined ? { input: fact.input } : {}),
    presentation: presentation(fact.tool, fact.input),
  };
}
export function antigravityToolResult(fact: AntigravityToolFact, body: Record<string, unknown>): AgentEvent {
  const failed =
    body.status === 'ERROR' ||
    body.status === 'FAILED' ||
    (typeof body.exit_code === 'number' && body.exit_code !== 0) ||
    body.error !== undefined;
  if (failed)
    return {
      type: 'tool:failed',
      toolCallId: fact.id,
      tool: fact.tool,
      ...(antigravityErrorText(body.error ?? body.content)
        ? { error: antigravityErrorText(body.error ?? body.content) }
        : {}),
      presentation: presentation(fact.tool, fact.input, true),
    };
  return {
    type: 'tool:completed',
    toolCallId: fact.id,
    tool: fact.tool,
    ...(body.content !== undefined ? { output: body.content } : {}),
    presentation: presentation(fact.tool, fact.input, true),
  };
}
