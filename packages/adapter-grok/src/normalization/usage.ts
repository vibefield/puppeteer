import { createHash } from 'node:crypto';
import type { MonitorFamilyUpdate } from '@vibecook/puppeteer-core/monitor-spi';

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  deltaTokens: number;
}

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

function contribution(usageId: string, usage: Usage): MonitorFamilyUpdate {
  return {
    family: 'usage',
    operation: 'upsert',
    key: usageId,
    value: { kind: 'usage', usageId, boundary: 'response', canonical: true, ...usage },
  };
}

/** Response notifications are live; durable turn totals reconcile missed responses. */
export class GrokUsageEvidence {
  private readonly responses = new Map<string, Map<string, Usage>>();
  private readonly completed = new Set<string>();

  normalize(
    sessionId: string,
    promptId: string | undefined,
    update: Record<string, unknown>,
    responseId?: string,
  ): MonitorFamilyUpdate[] {
    const usage = readUsage(update.usage);
    if (!usage || !promptId) return [];
    const turnKey = `grok-turn:${sessionId}:${promptId}`;
    const responses = this.responses.get(promptId) ?? new Map<string, Usage>();
    if (update.sessionUpdate === 'response_completed') {
      if (!responseId || this.completed.has(promptId)) return [];
      // Signatures identify repeated notifications but never belong in public state.
      const digest = createHash('sha256').update(responseId).digest('hex');
      const key = `${turnKey}:response:${digest}`;
      if (responses.has(key)) return [];
      responses.set(key, usage);
      this.responses.set(promptId, responses);
      return [contribution(key, usage)];
    }
    if (update.sessionUpdate !== 'turn_completed') return [];
    this.completed.add(promptId);
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
      return [...removed, contribution(turnKey, usage)];
    }
    return [contribution(turnKey, remainder)];
  }
}
