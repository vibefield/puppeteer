import type { NormalizedHook, ClaudeHookPayload } from './types.js';
import { claudeEffortLevel } from './wire.js';

/** Deduplicates observed Claude effort facts for the Core effort service. */
export class ClaudeEffortNormalizer {
  private effort: string | undefined;

  append(result: NormalizedHook, body: ClaudeHookPayload): void {
    const effort = claudeEffortLevel(body.effort);
    if (effort === undefined || effort === this.effort) return;
    result.events.push({ type: 'effort:updated', intent: 'observed', effort });
    this.effort = effort;
  }

  reset(): void {
    this.effort = undefined;
  }
}
