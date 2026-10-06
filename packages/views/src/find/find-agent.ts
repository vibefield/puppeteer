import type { AgentVisualStatus } from '../monitor/agent-status.js';

/**
 * The live facts Find reads. A host may supply its richer chrome row, but a
 * terminal summary and Core's full state are not part of this contract.
 * Optional mirror clocks stay optional, including before the first state.
 */
export interface FindAgent {
  readonly id: string;
  readonly createdAtMs: number;
  readonly status: AgentVisualStatus;
  readonly project: string;
  readonly detail: string;
  readonly color: string;
  readonly agent?:
    | {
        readonly provider: { readonly id: string; readonly label: string };
        readonly model?: string | undefined;
        readonly account?: string | undefined;
        readonly branch?: string | undefined;
        readonly nativeSessionId?: string | undefined;
        readonly monitor?:
          | {
              readonly statusSince?: string | undefined;
              readonly session?:
                | {
                    readonly nativeSessionId?: string | undefined;
                    readonly startedAt?: string | undefined;
                  }
                | undefined;
              readonly freshness?: { readonly lastEvidenceAt?: string | undefined } | undefined;
            }
          | undefined;
      }
    | undefined;
}
