import type { AgentEvent, ToolActivityKind, ToolPresentation } from '@vibecook/puppeteer-core';
import {
  boundedKimiMapSet,
  boundedKimiSetAdd,
  kimiErrorText,
  kimiNativeEvent,
  kimiRecord,
  kimiString,
  type KimiNormalizedFragment,
  type KimiToolFact,
} from './types.js';

function presentation(tool: string, input: unknown, completed = false): ToolPresentation {
  const lower = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  let title = completed ? `Used ${tool}` : `Using ${tool}`;
  if (['bash', 'shell', 'command', 'execute'].includes(lower)) {
    kind = 'command';
    title = completed ? 'Ran command' : 'Running command';
  } else if (['websearch', 'web_search', 'search'].includes(lower)) {
    kind = 'web-search';
    title = completed ? 'Searched the web' : 'Searching the web';
  } else if (['fetchurl', 'webfetch', 'fetch', 'browser'].includes(lower)) {
    kind = 'browser';
    title = completed ? 'Fetched web content' : 'Fetching web content';
  } else if (['read', 'grep', 'glob', 'readmediafile'].includes(lower)) {
    kind = 'file-read';
    title = completed ? 'Read files' : 'Reading files';
  } else if (['write', 'edit', 'apply_patch', 'notebookedit'].includes(lower)) {
    kind = 'file-edit';
    title = completed ? 'Edited files' : 'Editing files';
  } else if (lower.startsWith('mcp__') || lower.startsWith('mcp_')) {
    kind = 'mcp';
  }
  const details = kimiRecord(input);
  const detail =
    kimiString(details?.command) ??
    kimiString(details?.query) ??
    kimiString(details?.url) ??
    kimiString(details?.path) ??
    kimiString(details?.file_path) ??
    kimiString(details?.pattern) ??
    kimiString(details?.description);
  return { kind, title, ...(detail ? { detail } : {}) };
}

/** Kimi loop tool.call/tool.result → normalized tool lifecycle. */
export class KimiToolNormalizer {
  private readonly tools = new Map<string, KimiToolFact>();
  private readonly settledTools = new Set<string>();

  call(loop: Record<string, unknown>, turnId: string | undefined): KimiNormalizedFragment {
    const id = kimiString(loop.toolCallId);
    const tool = kimiString(loop.name);
    if (!id || !tool)
      return { events: [kimiNativeEvent('context.append_loop_event:tool.call')], disposition: 'retained-native' };
    if (this.settledTools.has(id)) return { events: [], disposition: 'no-output' };
    const shown = presentation(tool, loop.args);
    boundedKimiMapSet(this.tools, id, {
      tool,
      ...(turnId ? { turnId } : {}),
      input: loop.args,
      presentation: shown,
    });
    return {
      events: [
        {
          type: 'tool.requested',
          toolCallId: id,
          tool,
          ...(loop.args !== undefined ? { input: loop.args } : {}),
          presentation: shown,
        },
      ],
      disposition: 'mapped',
      turnId,
    };
  }

  result(
    loop: Record<string, unknown>,
    fallbackTurnId: string | undefined,
    isTerminal: (turnId: string) => boolean,
  ): KimiNormalizedFragment {
    const id = kimiString(loop.toolCallId);
    if (!id)
      return { events: [kimiNativeEvent('context.append_loop_event:tool.result')], disposition: 'retained-native' };
    if (this.settledTools.has(id)) return { events: [], disposition: 'no-output' };
    const fact = this.tools.get(id);
    boundedKimiSetAdd(this.settledTools, id);
    this.tools.delete(id);
    const turnId = fact?.turnId ?? fallbackTurnId;
    if (fact?.turnId && isTerminal(fact.turnId)) {
      return {
        events: [kimiNativeEvent('late:context.append_loop_event:tool.result')],
        disposition: 'retained-native',
        explanation: 'A tool result after its terminal turn is retained but cannot mutate portable tool state.',
        turnId: fact.turnId,
      };
    }
    const output = kimiRecord(loop.result)?.output;
    const failed = kimiRecord(loop.result)?.isError === true;
    const shown = fact ? presentation(fact.tool, fact.input, true) : undefined;
    let event: AgentEvent;
    if (failed) {
      const error = kimiErrorText(output ?? loop.result);
      event = {
        type: 'tool.failed',
        toolCallId: id,
        ...(fact?.tool ? { tool: fact.tool } : {}),
        ...(error ? { error } : {}),
        ...(shown ? { presentation: shown } : {}),
      };
    } else {
      event = {
        type: 'tool.completed',
        toolCallId: id,
        ...(fact?.tool ? { tool: fact.tool } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(shown ? { presentation: shown } : {}),
      };
    }
    return { events: [event], disposition: 'mapped', turnId };
  }
}
