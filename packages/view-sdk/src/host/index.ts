/**
 * `@vibecook/puppeteer-view-sdk/host`: the shared view host (L6). Only hosts
 * import it; a view never does (L16, MV-W1).
 *
 * - `createViewSlot`: the framework-free core. One view in a host-owned
 *   element, its input built from a replica and the host's parts, `update` at
 *   most once per frame and only on change, `report` mirrored on the slot.
 * - `MonitorViewHost`: the same, as a React component. Both mount
 *   `MonitorView`s only: every view is on the SDK since MV-6, and the legacy
 *   bridge that mounted an old component went with MV-8 (L9).
 * - `frameScheduler` / `createFrameScheduler`: the contract's `FrameScheduler`
 *   (M7). Pass the same instance to the replica and the slot.
 * - `keepStage`: the slot's own rule for an equal stage, for a host's state.
 *   A host that measures its chrome on every resize tick keeps the stage it
 *   holds when nothing moved, so an equal tick renders nothing (M176 item 1).
 * - `viewWantsHistory` / `keepPast` / `lendHistory`: the record's past as
 *   `capabilities.history` — read while a mounted view declares it, kept as
 *   the same object while nothing moved, built once per snapshot.
 */

export type { FrameScheduler } from '../model.js';
export { createFrameScheduler, frameScheduler, type RequestFrame } from './frame-scheduler.js';
export { MonitorViewHost, type MonitorViewHostProps } from './MonitorViewHost.js';
export { HISTORY_WINDOW_MS, keepPast, lendHistory, viewWantsHistory, type LendHistoryOptions } from './history.js';
export { keepStage } from './parts.js';
export {
  createViewSlot,
  VIEW_ROOT_ATTRIBUTE,
  VIEW_SLOT_ATTRIBUTES,
  type MonitorReplicaLike,
  type ViewSlot,
  type ViewSlotCommands,
  type ViewSlotInput,
  type ViewSlotOptions,
  type ViewSlotPhase,
} from './slot.js';
