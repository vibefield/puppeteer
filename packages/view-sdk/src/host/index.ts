/**
 * `@vibecook/puppeteer-view-sdk/host`: the shared view host (L6). Only hosts
 * import it; a view never does (L16, MV-W1).
 *
 * - `createViewSlot`: the framework-free core. One view in a host-owned
 *   element, its input built from a replica and the host's parts, `update` at
 *   most once per frame and only on change, `report` mirrored on the slot.
 * - `MonitorViewHost`: the same, as a React component.
 * - `legacyView`: an old `AgentMonitorView` component mounted through the slot
 *   until its view is ported.
 * - `frameScheduler` / `createFrameScheduler`: the contract's `FrameScheduler`
 *   (M7). Pass the same instance to the replica and the slot.
 */

export type { FrameScheduler } from '../model.js';
export { createFrameScheduler, frameScheduler, type RequestFrame } from './frame-scheduler.js';
export { isLegacyMonitorView, legacyView, type LegacyManifestLike, type LegacyMonitorView } from './legacy.js';
export { MonitorViewHost, type MonitorViewHostProps } from './MonitorViewHost.js';
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
