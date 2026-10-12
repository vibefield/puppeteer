import type { AgentEvent, ToolPresentation } from '@vibefield/puppeteer-core';
import { boundedOpenCodeMapSet, isOpenCodeRecord, openCodeError, openCodeNumber, openCodeText } from './wire.js';

export interface OpenCodeToolResult {
  event?: AgentEvent | undefined;
  join?: { childId: string; agentType?: string | undefined } | undefined;
  retainNative?: boolean | undefined;
}

function presentation(tool: string, input: unknown): ToolPresentation {
  const lower = tool.toLowerCase();
  const record = isOpenCodeRecord(input) ? input : undefined;
  const detail =
    openCodeText(record?.command) ??
    openCodeText(record?.filePath) ??
    openCodeText(record?.path) ??
    openCodeText(record?.url);
  const kind: ToolPresentation['kind'] =
    lower === 'bash' || lower.includes('shell')
      ? 'command'
      : lower === 'read'
        ? 'file-read'
        : ['write', 'edit', 'apply_patch', 'patch'].includes(lower)
          ? 'file-edit'
          : lower.includes('web')
            ? 'web-search'
            : lower.includes('browser')
              ? 'browser'
              : lower.includes('mcp')
                ? 'mcp'
                : 'other';
  return { kind, title: tool, ...(detail ? { detail } : {}) };
}

/** OpenCode tool part state machine → normalized tool lifecycle events. */
export class OpenCodeToolNormalizer {
  private readonly states = new Map<string, 'requested' | 'running' | 'completed' | 'failed'>();

  constructor(private readonly maximum: number) {}

  normalize(part: Record<string, unknown>, sessionId: string): OpenCodeToolResult {
    const callId = openCodeText(part.callID);
    const tool = openCodeText(part.tool);
    const state = isOpenCodeRecord(part.state) ? part.state : undefined;
    const status = openCodeText(state?.status);
    if (!callId || !tool || !state || !status) return { retainNative: true };
    const previous = this.states.get(callId);
    const metadata = isOpenCodeRecord(state.metadata) ? state.metadata : undefined;
    const childId = tool === 'task' ? openCodeText(metadata?.sessionId) : undefined;
    const parentId = openCodeText(metadata?.parentSessionId);
    const input = isOpenCodeRecord(state.input) ? state.input : undefined;
    const join =
      childId && (!parentId || parentId === sessionId)
        ? { childId, ...(openCodeText(input?.subagent_type) ? { agentType: openCodeText(input?.subagent_type) } : {}) }
        : undefined;
    if (previous === 'completed' || previous === 'failed') return { join };

    const shown = presentation(tool, state.input);
    if (status === 'pending') {
      if (previous) return { join };
      boundedOpenCodeMapSet(this.states, callId, 'requested', this.maximum);
      return {
        join,
        event: { type: 'tool:requested', toolCallId: callId, tool, input: state.input, presentation: shown },
      };
    }
    if (status === 'running') {
      if (previous === 'running') return { join };
      boundedOpenCodeMapSet(this.states, callId, 'running', this.maximum);
      return {
        join,
        event: { type: 'tool:started', toolCallId: callId, tool, input: state.input, presentation: shown },
      };
    }
    if (status === 'completed') {
      boundedOpenCodeMapSet(this.states, callId, 'completed', this.maximum);
      const time = isOpenCodeRecord(state.time) ? state.time : undefined;
      const start = openCodeNumber(time?.start);
      const end = openCodeNumber(time?.end);
      return {
        join,
        event: {
          type: 'tool:completed',
          toolCallId: callId,
          tool,
          output: state.output,
          ...(start !== undefined && end !== undefined && end >= start ? { durationMs: end - start } : {}),
          presentation: shown,
        },
      };
    }
    if (status === 'error') {
      boundedOpenCodeMapSet(this.states, callId, 'failed', this.maximum);
      return {
        join,
        event: {
          type: 'tool:failed',
          toolCallId: callId,
          tool,
          error: openCodeError(state.error),
          presentation: shown,
        },
      };
    }
    return { join, retainNative: true };
  }
}
