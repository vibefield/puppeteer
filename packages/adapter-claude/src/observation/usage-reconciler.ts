import type { AgentEventConfidence, AgentEventSource, TokensUsedEvent } from '@vibecook/puppeteer-core';

export interface ClaudeUsagePublication {
  source: AgentEventSource;
  timestamp: string;
  promptId?: string;
  turnId?: string;
  agentId?: string;
  agentType?: string;
  actorKey?: string;
  actorRole?: 'child' | 'auxiliary' | 'unknown';
  providerVersion?: string;
  confidence?: AgentEventConfidence;
  native?: unknown;
  replay?: boolean;
}

export interface ClaudeUsageEvidence {
  event: TokensUsedEvent;
  publication: ClaudeUsagePublication;
}

export type ReconciledClaudeUsage = ClaudeUsageEvidence;

interface UsageClaim {
  otel?: ClaudeUsageEvidence;
  transcript?: ClaudeUsageEvidence;
  publishedFingerprint?: string;
}

const DEFAULT_MAX_USAGE_CLAIMS = 20_000;

function attributionRank(evidence: ClaudeUsageEvidence): number {
  return evidence.publication.agentId ? 3 : evidence.publication.actorKey ? 2 : 1;
}

/** Reconciles request totals and actor identity as independent evidence axes. */
export class ClaudeUsageReconciler {
  readonly #claims = new Map<string, UsageClaim>();
  readonly #maxClaims: number;

  constructor(options: { maxClaims?: number } = {}) {
    this.#maxClaims = options.maxClaims ?? DEFAULT_MAX_USAGE_CLAIMS;
    if (!Number.isSafeInteger(this.#maxClaims) || this.#maxClaims < 1) {
      throw new RangeError('Claude usage maxClaims must be a positive safe integer');
    }
  }

  accept(kind: 'otel' | 'transcript', evidence: ClaudeUsageEvidence): ReconciledClaudeUsage | undefined {
    const usageId = evidence.event.usageId;
    const current = this.#claims.get(usageId) ?? {};
    current[kind] = evidence;
    const primary = current.otel ?? current.transcript!;
    const attribution = [current.transcript, current.otel]
      .filter((value): value is ClaudeUsageEvidence => value !== undefined)
      .sort((left, right) => attributionRank(right) - attributionRank(left))[0]!;
    const publication: ClaudeUsagePublication = {
      ...primary.publication,
      agentId: attribution.publication.agentId,
      agentType: attribution.publication.agentType,
      actorKey: attribution.publication.actorKey,
      actorRole: attribution.publication.actorRole,
    };
    const fingerprint = JSON.stringify([
      primary.event,
      publication.agentId ?? null,
      publication.agentType ?? null,
      publication.actorKey ?? null,
      publication.actorRole ?? null,
      publication.source,
      publication.replay ?? false,
    ]);
    // Refresh insertion order so a live request is not evicted while older
    // one-sided claims remain. The cap bounds sessions that run indefinitely.
    this.#claims.delete(usageId);
    this.#claims.set(usageId, current);
    while (this.#claims.size > this.#maxClaims) {
      const oldest = this.#claims.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#claims.delete(oldest);
    }
    if (current.publishedFingerprint === fingerprint) return undefined;
    current.publishedFingerprint = fingerprint;
    return { event: primary.event, publication };
  }
}
