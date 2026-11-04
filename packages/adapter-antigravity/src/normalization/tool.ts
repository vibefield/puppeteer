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
    antigravityString(body?.CommandLine) ??
    antigravityString(body?.AbsolutePath) ??
    antigravityString(body?.DirectoryPath) ??
    antigravityString(body?.path);
  return { kind, title: `${complete ? 'Used' : 'Using'} ${tool}`, ...(detail ? { detail } : {}) };
}
// Arguments whose native value is always a string. In the encoded form each
// is a quoted JSON string.
const STRING_ARGUMENTS = new Set([
  'CommandLine',
  'commandLine',
  'AbsolutePath',
  'DirectoryPath',
  'path',
  'toolSummary',
]);
// 1.4.12 writes every tool argument in transcript.jsonl as a JSON-encoded
// string ("\"echo x\"", "5000"); transcript_full.jsonl keeps the real types.
// Decode only when every value is a string that parses, at least one decodes
// to a string, and no string-typed argument decodes to anything else. Real-typed
// arguments, plain strings, and a real `CommandLine: 'true'` pass through.
function decodeEncodedArgs(args: unknown): unknown {
  const body = antigravityRecord(args);
  if (!body) return args;
  const entries = Object.entries(body);
  if (!entries.length || !entries.every(([, value]) => typeof value === 'string')) return args;
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    try {
      decoded[key] = JSON.parse(value as string);
    } catch {
      return args;
    }
    if (STRING_ARGUMENTS.has(key) && typeof decoded[key] !== 'string') return args;
  }
  return Object.values(decoded).some((value) => typeof value === 'string') ? decoded : args;
}
export function antigravityToolFact(
  step: string,
  index: number,
  turnId: string,
  value: unknown,
  encodedArgs = false,
): AntigravityToolFact | undefined {
  const body = antigravityRecord(value);
  const tool = antigravityString(body?.name);
  if (!tool) return undefined;
  const resultType = expectedType(tool);
  const input = encodedArgs ? decodeEncodedArgs(body?.args) : body?.args;
  return {
    id: `step:${step}:tool:${index}`,
    tool,
    ...(input !== undefined ? { input } : {}),
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
