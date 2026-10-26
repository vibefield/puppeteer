import { createHash } from 'node:crypto';
import type { ActorRunRef } from '@vibefield/puppeteer-core';
import type { MonitorFamilyUpdate } from '@vibefield/puppeteer-core/monitor-spi';

interface Usage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  deltaTokens: number;
}

/**
 * How a live `response_completed` is told apart from its siblings. A native
 * id (a signature or `_meta.eventId`) also deduplicates a repeated
 * notification. Grok 1.0.70 sends neither, so the response is instead the next
 * of its prompt's responses: the prompt is the session's running native prompt,
 * and the ordinal counts that prompt's unsigned responses in arrival order.
 */
export type GrokResponseIdentity = { kind: 'native'; id: string } | { kind: 'ordinal' };

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function readUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const usage = value as Record<string, unknown>;
  if (usage.usageIsIncomplete === true || usage.usage_is_incomplete === true) return;
  const total = finite(usage.totalTokens ?? usage.total_tokens);
  // Native response notifications split fresh input from cached input, while
  // durable camelCase turn summaries already include cached input in the total.
  const freshInput = finite(usage.input_tokens);
  const inputTokens =
    finite(usage.inputTokens) ??
    (freshInput === undefined
      ? undefined
      : freshInput + (finite(usage.cache_read_input_tokens) ?? 0) + (finite(usage.cache_creation_input_tokens) ?? 0));
  const outputTokens = finite(usage.outputTokens ?? usage.output_tokens);
  if (total === undefined && inputTokens === undefined && outputTokens === undefined) return;
  return { inputTokens, outputTokens, deltaTokens: total ?? (inputTokens ?? 0) + (outputTokens ?? 0) };
}

function contribution(usageId: string, usage: Usage, actor?: ActorRunRef): MonitorFamilyUpdate {
  return {
    family: 'usage',
    operation: 'upsert',
    key: usageId,
    value: {
      kind: 'usage',
      origin: 'protocol',
      usageId,
      boundary: 'response',
      canonical: true,
      ...(actor ? { actor } : {}),
      ...usage,
    },
  };
}

/** Live protocol response and turn notifications; never called for journal records. */
export class GrokUsageEvidence {
  /** Per turn (session and native prompt): its response contributions. */
  private readonly responses = new Map<string, Map<string, Usage>>();
  private readonly ordinals = new Map<string, number>();
  private readonly completed = new Set<string>();

  /**
   * `sessionId` is the session the notification names: the bound session, or
   * a subagent child the leader forwards (then `actor` names that child).
   */
  normalize(
    sessionId: string,
    promptId: string | undefined,
    update: Record<string, unknown>,
    identity?: GrokResponseIdentity,
    actor?: ActorRunRef,
  ): MonitorFamilyUpdate[] {
    if (!promptId) return [];
    const turnKey = `grok-turn:${sessionId}:${promptId}`;
    const usage = readUsage(update.usage);
    const responses = this.responses.get(turnKey) ?? new Map<string, Usage>();
    if (update.sessionUpdate === 'response_completed') {
      if (!usage || !identity || this.completed.has(turnKey)) return [];
      let key: string;
      if (identity.kind === 'native') {
        // Signatures identify repeated notifications but never belong in public state.
        key = `${turnKey}:response:${createHash('sha256').update(identity.id).digest('hex')}`;
        if (responses.has(key)) return [];
      } else {
        const ordinal = (this.ordinals.get(turnKey) ?? 0) + 1;
        this.ordinals.set(turnKey, ordinal);
        key = `${turnKey}:response:${ordinal}`;
      }
      responses.set(key, usage);
      this.responses.set(turnKey, responses);
      return [contribution(key, usage, actor)];
    }
    if (update.sessionUpdate !== 'turn_completed') return [];
    // The turn is over whether or not it reports a usable total. Without one
    // (a mid-turn abort, or a total Grok flags incomplete) its response
    // contributions stand as the turn's usage.
    this.completed.add(turnKey);
    if (!usage) return [];
    const remainder = { ...usage };
    for (const response of responses.values()) {
      remainder.deltaTokens -= response.deltaTokens;
      if (remainder.inputTokens !== undefined) remainder.inputTokens -= response.inputTokens ?? 0;
      if (remainder.outputTokens !== undefined) remainder.outputTokens -= response.outputTokens ?? 0;
    }
    // A corrected total can be smaller than the streamed contributions. In that
    // case the durable total replaces them instead of publishing negative burn.
    if (Object.values(remainder).some((value) => value !== undefined && value < 0)) {
      const removed: MonitorFamilyUpdate[] = [...responses.keys()].map((key) => ({
        family: 'usage',
        operation: 'retract',
        key,
      }));
      responses.clear();
      return [...removed, contribution(turnKey, usage, actor)];
    }
    return [contribution(turnKey, remainder, actor)];
  }
}
