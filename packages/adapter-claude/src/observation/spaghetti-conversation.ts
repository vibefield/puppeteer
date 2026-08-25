import type { AgentEvent, AssistantMessageEvent } from '@vibecook/chopsticks-core';
import type { SemanticObserverEvent } from '@vibecook/spaghetti-sdk';
import type { SemanticObservationEvent } from './semantic-provider.js';

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

const SYNTHETIC_USER_TEXT_PREFIXES = [
  'this session is being continued from a previous conversation',
] as const;

interface MessageEntry {
  factId: string;
  event: SemanticObserverEvent;
  value: Extract<NonNullable<SemanticObserverEvent['value']>, { MessageRevision: unknown }>['MessageRevision'];
}

interface ContentBlockEntry {
  event: SemanticObserverEvent;
  value: Extract<
    NonNullable<SemanticObserverEvent['value']>,
    { ContentBlockRevision: unknown }
  >['ContentBlockRevision'];
}

export interface SpaghettiConversationProjection {
  /** Full root conversation, used only for an explicit resume bootstrap. */
  history: readonly SemanticObservationEvent[];
  /** Complete root assistant messages keyed by the canonical message fact. */
  assistants: ReadonlyMap<string, SemanticObservationEvent>;
}

function nonEmptyString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Remove only complete, known synthetic blocks at the beginning of a user message. */
function stripSyntheticUserPreamble(value: string): string | undefined {
  let remaining = value.trim();
  for (;;) {
    const lower = remaining.toLowerCase();
    if (SYNTHETIC_USER_TEXT_PREFIXES.some((candidate) => lower.startsWith(candidate))) return undefined;
    const prefix = SYNTHETIC_USER_PREFIXES.find((candidate) => lower.startsWith(candidate));
    if (!prefix) return nonEmptyString(remaining);

    const closing = `</${prefix.slice(1, -1)}>`;
    const closingIndex = lower.indexOf(closing, prefix.length);
    if (closingIndex < 0) return undefined;
    remaining = remaining.slice(closingIndex + closing.length).trimStart();
    if (!remaining) return undefined;
  }
}

function eventTimestamp(event: SemanticObserverEvent): string {
  return new Date(event.native_time ?? event.observed_at).toISOString();
}

function sourceOrder(left: SemanticObserverEvent, right: SemanticObserverEvent): number {
  return (
    left.source.object_path.localeCompare(right.source.object_path) ||
    left.source.generation - right.source.generation ||
    (left.source.byte_start ?? Number.MAX_SAFE_INTEGER) -
      (right.source.byte_start ?? Number.MAX_SAFE_INTEGER) ||
    left.sequence - right.sequence
  );
}

function observation(
  event: AgentEvent,
  source: SemanticObserverEvent,
  options: { turnId?: string; replay?: boolean } = {},
): SemanticObservationEvent {
  return {
    event,
    timestamp: eventTimestamp(source),
    ...(options.turnId ? { promptId: options.turnId, turnId: options.turnId } : {}),
    ...(options.replay ? { replay: true } : {}),
  };
}

function completeBlocks(
  message: MessageEntry,
  blocksByMessage: ReadonlyMap<string, readonly ContentBlockEntry[]>,
): readonly ContentBlockEntry[] | undefined {
  if (message.value.operation !== 'upsert' || message.value.completeness !== 'complete') return undefined;
  const blocks = [...(blocksByMessage.get(message.factId) ?? [])]
    .filter(({ value }) => value.operation === 'upsert')
    .sort((left, right) => left.value.ordinal - right.value.ordinal || sourceOrder(left.event, right.event));
  if (blocks.length !== message.value.ordered_content_block_keys.length) return undefined;
  if (new Set(blocks.map(({ value }) => value.ordinal)).size !== blocks.length) return undefined;
  return blocks;
}

function userPrompt(blocks: readonly ContentBlockEntry[]): string | undefined {
  if (blocks.some(({ value }) => value.content.kind === 'tool_result')) return undefined;
  const text = blocks
    .flatMap(({ value }) => (value.content.kind === 'text' ? [value.content.text] : []))
    .join('\n');
  return stripSyntheticUserPreamble(text);
}

function assistantMessage(
  message: MessageEntry,
  blocks: readonly ContentBlockEntry[],
  turnId?: string,
): SemanticObservationEvent | undefined {
  const text = blocks
    .flatMap(({ value }) => (value.content.kind === 'text' ? [value.content.text] : []))
    .join('');
  if (!text) return undefined;
  const event: AssistantMessageEvent = {
    type: 'assistant.message',
    messageId: message.value.native_message_id,
    ...(turnId ? { turnId } : {}),
    text,
    final: true,
    displayOnly: false,
  };
  return observation(event, message.event, { turnId });
}

/**
 * Project application conversation events exclusively from RFC-012C typed
 * facts. Child actors stay out of the root conversation; their text remains
 * available to actor-specific monitor projections without being flattened.
 * MessageRevision does not yet carry Claude's native `isMeta` visibility bit,
 * so resume user prompts remain a degraded projection until that bit becomes
 * typed evidence; known synthetic forms are excluded conservatively here.
 */
export function projectSpaghettiConversation(
  facts: Iterable<SemanticObserverEvent>,
): SpaghettiConversationProjection {
  const events = [...facts];
  const rootRuns = new Set<string>();
  const messages: MessageEntry[] = [];
  const blocksByMessage = new Map<string, ContentBlockEntry[]>();

  for (const event of events) {
    const value = event.value;
    if (!value) continue;
    if ('ActorRunRevision' in value && value.ActorRunRevision.role === 'root') {
      rootRuns.add(value.ActorRunRevision.actor_run);
    } else if ('MessageRevision' in value) {
      messages.push({ factId: event.fact_id, event, value: value.MessageRevision });
    } else if ('ContentBlockRevision' in value) {
      const key = value.ContentBlockRevision.message;
      const group = blocksByMessage.get(key) ?? [];
      group.push({ event, value: value.ContentBlockRevision });
      blocksByMessage.set(key, group);
    }
  }

  const ordered = messages
    .filter(({ value }) => rootRuns.has(value.actor_run))
    .sort((left, right) => sourceOrder(left.event, right.event));
  const history: SemanticObservationEvent[] = [];
  const assistants = new Map<string, SemanticObservationEvent>();
  let current:
    | {
        turnId: string;
        prompt: string;
        source: SemanticObserverEvent;
        assistants: Array<{
          key: string;
          observation: SemanticObservationEvent;
          source: SemanticObserverEvent;
        }>;
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
    for (const assistant of current.assistants) {
      history.push({ ...assistant.observation, replay: true });
      assistants.set(assistant.key, assistant.observation);
    }
    const last = current.assistants.at(-1);
    history.push(
      observation(
        last || boundary === 'next-prompt'
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
              error: 'interrupted before an assistant response',
            },
        last?.source ?? current.source,
        { turnId: current.turnId, replay: true },
      ),
    );
    current = undefined;
  };

  for (const message of ordered) {
    const blocks = completeBlocks(message, blocksByMessage);
    if (!blocks) continue;
    if (message.value.role === 'user') {
      const prompt = userPrompt(blocks);
      if (!prompt) continue;
      flush('next-prompt');
      current = {
        turnId: message.value.native_message_id,
        prompt,
        source: message.event,
        assistants: [],
      };
      continue;
    }
    if (message.value.role !== 'assistant') continue;
    const projected = assistantMessage(message, blocks, current?.turnId);
    if (!projected) continue;
    assistants.set(message.factId, projected);
    if (current) current.assistants.push({ key: message.factId, observation: projected, source: message.event });
  }
  flush('snapshot-end');

  return { history, assistants };
}

export function spaghettiConversationFingerprint(value: SemanticObservationEvent): string {
  return JSON.stringify([value.turnId ?? null, value.event]);
}
