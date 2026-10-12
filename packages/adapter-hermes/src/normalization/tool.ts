import type { AgentEvent, ToolActivityKind, ToolPresentation } from '@vibefield/puppeteer-core';
import { boundedHermesMapSet, hermesRecord, hermesString } from './types.js';

function presentation(tool: string, completed = false): ToolPresentation {
  const lower = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  let title = completed ? `Used ${tool}` : `Using ${tool}`;
  if (lower === 'terminal' || lower === 'process') {
    kind = 'command';
    title = completed ? 'Ran command' : 'Running command';
  }
  return { kind, title };
}

/** Hermes tool frames → normalized tool lifecycle events. */
export class HermesToolNormalizer {
  private readonly toolNames = new Map<string, string>();

  start(payload: Record<string, unknown>): AgentEvent[] {
    const tool = hermesString(payload.name) ?? 'unknown';
    const toolCallId = hermesString(payload.tool_id) ?? `hermes-tool-${this.toolNames.size + 1}`;
    boundedHermesMapSet(this.toolNames, toolCallId, tool);
    const shown = presentation(tool);
    return [
      { type: 'tool:requested', toolCallId, tool, presentation: shown },
      { type: 'tool:started', toolCallId, tool, presentation: shown },
    ];
  }

  complete(payload: Record<string, unknown>): AgentEvent[] {
    const toolCallId = hermesString(payload.tool_id) ?? 'hermes-tool-unknown';
    const tool = hermesString(payload.name) ?? this.toolNames.get(toolCallId) ?? 'unknown';
    const result = hermesRecord(payload.result);
    const resultStatus = hermesString(result?.status);
    const blocked =
      resultStatus === 'blocked' ||
      resultStatus === 'failed' ||
      (typeof result?.exit_code === 'number' && result.exit_code !== 0);
    const shown = presentation(tool, true);
    if (blocked) {
      return [
        {
          type: 'tool:failed',
          toolCallId,
          tool,
          error: hermesString(result?.error) ?? hermesString(result?.status) ?? 'tool failed',
          presentation: shown,
        },
      ];
    }
    const durationMs = typeof payload.duration_s === 'number' ? Math.round(payload.duration_s * 1000) : undefined;
    return [
      {
        type: 'tool:completed',
        toolCallId,
        tool,
        ...(result ? { output: result } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        presentation: shown,
      },
    ];
  }
}
