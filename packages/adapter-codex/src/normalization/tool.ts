import type { ToolEvent } from '@vibefield/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str, toolPresentation } from './types.js';

/** Codex tool items -> Core tool lifecycle events. */
export class CodexToolNormalizer {
  normalize(input: CodexNormalizationInput): CategoryNormalization<ToolEvent> {
    const events: ToolEvent[] = [];
    if (input.method !== 'item/started' && input.method !== 'item/completed') return { handled: false, events };
    const item = rec(input.params.item);
    if (!item) return { handled: false, events };
    const phase = input.method === 'item/started' ? 'started' : 'completed';
    const itemId = str(item.id) ?? 'unknown-item';

    switch (str(item.type)) {
      case 'commandExecution': {
        const command = item.command;
        if (phase === 'started') {
          events.push({
            type: 'tool:started',
            toolCallId: itemId,
            tool: 'command',
            input: command,
            presentation: toolPresentation('command', 'Running command', command),
          });
        } else {
          // A command the person declined never ran: Codex completes it with status `declined` and a
          // null exit code (census approval-decline, 0.150.0 and 0.164.0), so it is a failure, not a run.
          const declined = item.status === 'declined';
          const failed =
            declined || item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
          events.push(
            failed
              ? {
                  type: 'tool:failed',
                  toolCallId: itemId,
                  tool: 'command',
                  error: declined
                    ? 'command was declined'
                    : `command exited with status ${String(item.status ?? item.exitCode)}`,
                  presentation: toolPresentation('command', declined ? 'Command declined' : 'Command failed', command),
                }
              : {
                  type: 'tool:completed',
                  toolCallId: itemId,
                  tool: 'command',
                  output: item.aggregatedOutput,
                  presentation: toolPresentation('command', 'Ran command', command),
                },
          );
        }
        return { handled: true, events };
      }
      case 'fileChange': {
        const failed = phase === 'completed' && (item.status === 'failed' || item.status === 'declined');
        events.push(
          failed
            ? {
                type: 'tool:failed',
                toolCallId: itemId,
                tool: 'apply_patch',
                error: `file change ended with status ${String(item.status)}`,
                presentation: toolPresentation('file-edit', 'File edit failed', item.changes ?? item.path),
              }
            : {
                type: phase === 'started' ? 'tool:started' : 'tool:completed',
                toolCallId: itemId,
                tool: 'apply_patch',
                presentation: toolPresentation(
                  'file-edit',
                  phase === 'started' ? 'Editing files' : 'Edited files',
                  item.changes ?? item.path,
                ),
              },
        );
        return { handled: true, events };
      }
      case 'webSearch':
        events.push({
          type: phase === 'started' ? 'tool:started' : 'tool:completed',
          toolCallId: itemId,
          tool: 'web_search',
          ...(phase === 'started' ? { input: item.query } : { output: item.results }),
          presentation: toolPresentation(
            'web-search',
            phase === 'started' ? 'Searching the web' : 'Searched the web',
            item.query,
          ),
        });
        return { handled: true, events };
      case 'mcpToolCall': {
        const tool = str(item.tool) ?? str(item.name) ?? 'mcp';
        events.push({
          type: phase === 'started' ? 'tool:started' : 'tool:completed',
          toolCallId: itemId,
          tool,
          ...(phase === 'started' ? { input: item.arguments } : { output: item.result }),
          presentation: toolPresentation(
            'mcp',
            str(item.name) ?? (phase === 'started' ? 'Using MCP tool' : 'Used MCP tool'),
            item.arguments,
          ),
        });
        return { handled: true, events };
      }
      default:
        return { handled: false, events };
    }
  }
}
