import type { AgentEvent, AssistantMessageEvent } from '@vibecook/puppeteer-core';
import type { SemanticObservationEvent } from '../semantic-provider.js';
import {
  safeTranscriptEvidence,
  transcriptContent,
  transcriptObject,
  transcriptRecordId,
  transcriptText,
  type ClaudeTranscriptRecord,
} from './wire.js';

const SYNTHETIC_USER_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<task-notification>',
  '<system-reminder>',
  '<ide_opened_file>',
  '<ide_selection>',
] as const;

const SYNTHETIC_USER_TEXT_PREFIXES = ['this session is being continued from a previous conversation'] as const;

function stripSyntheticUserPreamble(value: string): string | undefined {
  let remaining = value.trim();
  for (;;) {
    const lower = remaining.toLowerCase();
    if (SYNTHETIC_USER_TEXT_PREFIXES.some((candidate) => lower.startsWith(candidate))) return undefined;
    const prefix = SYNTHETIC_USER_PREFIXES.find((candidate) => lower.startsWith(candidate));
    if (!prefix) return remaining || undefined;
    const closing = `</${prefix.slice(1, -1)}>`;
    const closingIndex = lower.indexOf(closing, prefix.length);
    if (closingIndex < 0) return undefined;
    remaining = remaining.slice(closingIndex + closing.length).trimStart();
    if (!remaining) return undefined;
  }
}

function userPrompt(record: ClaudeTranscriptRecord): string | undefined {
  if (
    transcriptContent(record).some((value) => {
      const block = transcriptObject(value);
      return block?.type === 'tool_result';
    })
  ) {
    return undefined;
  }
  return stripSyntheticUserPreamble(transcriptText(record));
}

function observation(
  event: AgentEvent,
  source: ClaudeTranscriptRecord,
  options: { turnId?: string; replay?: boolean } = {},
): SemanticObservationEvent {
  return {
    event,
    timestamp: source.timestamp,
    ...(options.turnId ? { promptId: options.turnId, turnId: options.turnId } : {}),
    ...(source.agentId ? { agentId: source.agentId } : {}),
    ...(source.agentType ? { agentType: source.agentType } : {}),
    ...(options.replay ? { replay: true } : {}),
    nativeEvent: safeTranscriptEvidence(source),
  };
}

function assistant(record: ClaudeTranscriptRecord, turnId?: string): SemanticObservationEvent | undefined {
  const text = transcriptText(record);
  if (!text) return undefined;
  const event: AssistantMessageEvent = {
    type: 'assistant.message',
    messageId: transcriptRecordId(record),
    ...(turnId ? { turnId } : {}),
    text,
    final: true,
    displayOnly: false,
  };
  return observation(event, record, { turnId });
}

export interface ClaudeTranscriptConversationProjection {
  history: readonly SemanticObservationEvent[];
  assistants: ReadonlyMap<string, SemanticObservationEvent>;
}

/** Project only the root human conversation; sidechains remain usage/workflow evidence, not chat messages. */
export function projectClaudeTranscriptConversation(
  records: readonly ClaudeTranscriptRecord[],
): ClaudeTranscriptConversationProjection {
  const history: SemanticObservationEvent[] = [];
  const assistants = new Map<string, SemanticObservationEvent>();
  let current:
    | {
        turnId: string;
        prompt: string;
        source: ClaudeTranscriptRecord;
        assistants: Array<{ key: string; observation: SemanticObservationEvent; source: ClaudeTranscriptRecord }>;
      }
    | undefined;

  const flush = (boundary: 'next-prompt' | 'snapshot-end'): void => {
    if (!current) return;
    history.push(
      observation({ type: 'turn.started', turnId: current.turnId, prompt: current.prompt }, current.source, {
        turnId: current.turnId,
        replay: true,
      }),
    );
    for (const item of current.assistants) history.push({ ...item.observation, replay: true });
    const last = current.assistants.at(-1);
    history.push(
      observation(
        last
          ? {
              type: 'turn.completed',
              turnId: current.turnId,
              ...(last?.observation.event.type === 'assistant.message'
                ? { lastAssistantMessage: last.observation.event.text }
                : {}),
            }
          : {
              type: 'turn.failed',
              turnId: current.turnId,
              error:
                boundary === 'next-prompt'
                  ? 'superseded by a newer user prompt before an assistant response'
                  : 'interrupted before an assistant response',
            },
        last?.source ?? current.source,
        { turnId: current.turnId, replay: true },
      ),
    );
    current = undefined;
  };

  for (const record of records) {
    if (record.isSidechain) continue;
    const role = record.message?.role;
    if (record.type === 'user' || role === 'user') {
      const prompt = userPrompt(record);
      if (!prompt) continue;
      flush('next-prompt');
      current = { turnId: transcriptRecordId(record), prompt, source: record, assistants: [] };
      continue;
    }
    if (record.type !== 'assistant' && role !== 'assistant') continue;
    const projected = assistant(record, current?.turnId);
    if (!projected) continue;
    const key = transcriptRecordId(record);
    assistants.set(key, projected);
    if (current) current.assistants.push({ key, observation: projected, source: record });
  }
  flush('snapshot-end');
  return { history, assistants };
}

export function claudeTranscriptConversationFingerprint(value: SemanticObservationEvent): string {
  return JSON.stringify([value.turnId ?? null, value.event]);
}
