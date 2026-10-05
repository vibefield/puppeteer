// FROZEN (MV-6): the status history's types (monitor/status-history.ts) as it shipped before the timeline moved onto
// the SDK, runtime only, kept only as the "before" that `legacy/timeline-parity.test.tsx` renders beside the ported
// view over the same model. Only its imports changed (it moved folders). Never edit it to match the port; MV-8 deletes
// it with the shim. The package lost it in MV-6 (L10, MV-D13: runtime only); it lives on here only so the parity test
// can feed the frozen view the book its host fed it.

import type { MonitorAgent } from '../../../monitor/types.js';

/**
 * What a lane was doing over time — the record the timeline view draws
 * ("Where the Time Went", TL). Core keeps only the current status and when it
 * began; a HOST keeps the past (VibeField: a ledger in fieldd's fold, TL-D8;
 * any host: `status-ledger.ts`, which observes the rows it already projects),
 * and hands it to the views as a book. A view never infers a past it was not
 * given: before `recordedFromMs` a lane is drawn as unrecorded.
 *
 * `unseen` is idle with a reply the person has not opened (TL-D3, the swarm's
 * blue): the same rule as `unread.ts`, recorded over time.
 */
export type MonitorHistoryStatus = 'working' | 'idle' | 'blocked' | 'unseen';

/** What a blocked span waited on: Core's blocker kind, and its words when there were any. */
export interface MonitorHistoryBlocker {
  readonly kind: string;
  readonly detail?: string | undefined;
}

/** One stretch of one status. A lane's spans are ordered and contiguous; only the last may be open. */
export interface MonitorHistorySpan {
  readonly status: MonitorHistoryStatus;
  readonly fromMs: number;
  /** Absent while it is still going (the lane's current state). */
  readonly toMs?: number | undefined;
  readonly blocker?: MonitorHistoryBlocker | undefined;
  /** A working span's last activity line (Core's `activity.line`), bounded (TL-D12). */
  readonly did?: string | undefined;
}

export interface MonitorLaneHistory {
  /** Before this the lane's past was not recorded. */
  readonly recordedFromMs: number;
  readonly spans: readonly MonitorHistorySpan[];
  /** Set once the agent ended; its last span is then closed at this moment. */
  readonly endedAtMs?: number | undefined;
}

export interface MonitorHistoryBook {
  /** By `MonitorAgent.id`: every lane the host has a record for, live or ended. */
  readonly lanes: ReadonlyMap<string, MonitorLaneHistory>;
  /**
   * The last row of each agent that ended inside the book's horizon, so a view
   * that keeps an ended lane (the timeline, TL-D6) can still say whose it was.
   * Never also in `agents`.
   */
  readonly ended: readonly MonitorAgent[];
}

export const EMPTY_HISTORY_BOOK: MonitorHistoryBook = { lanes: new Map(), ended: [] };

/** A day: the most a host keeps, and the most the timeline's map shows. */
export const STATUS_HISTORY_HORIZON_MS = 24 * 60 * 60 * 1000;
/** Per lane; a lane that flips more often than this loses its oldest changes first. */
export const STATUS_HISTORY_MAX_CHANGES = 2000;
/** The longest `did` or blocker `detail` a record keeps, in UTF-16 units. */
export const STATUS_HISTORY_TEXT_MAX = 160;
