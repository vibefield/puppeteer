import type { SessionActivity } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorStatus } from '@vibecook/puppeteer-core';
import type { AgentSessionInfo } from '../protocol.js';
import { folderName } from './folder-name.js';

/**
 * What a session is doing, derived only from reduced runtime state — never from
 * terminal text (DESIGN ADR-003/-005). How a status is then drawn is each
 * monitor view's own business.
 */
export type AgentVisualStatus = AgentMonitorStatus;

export function classifyTerminalStatus(
  activity: Pick<SessionActivity, 'kind'> | undefined,
): Exclude<AgentVisualStatus, 'blocked'> {
  return activity?.kind === 'foreground-job' ? 'working' : 'idle';
}

export function projectLabel(info: AgentSessionInfo, currentCwd?: string): string {
  const path = currentCwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || '';
  return folderName(path, info.provider.label);
}

/**
 * The stable per-session relationship color, as an INDEX into DESIGN.md §2.6's
 * organizational accents rather than a color.
 *
 * Hashing an id into a free hue wheel was a fine trick and the wrong one: §2.6
 * is a CURATED set, and the whole point of an organizational accent is that it
 * groups and labels without ever signalling state — which a free wheel cannot
 * promise, since it can always land on something a viewer reads as
 * green-means-working. So the hash chooses a SLOT, and `monitor-palette.ts`
 * resolves that slot from the live `--vf-accent-*` tokens. The hash itself is
 * FNV-1a: same id ⇒ same slot, across ticks, reloads and restarts.
 */
export function agentAccentSlot(id: string, slots: number): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % slots;
}

/** The accent itself. With no palette mounted the answer is `currentColor` — a
 * rendering with no colour rather than an invented one. */
export function agentAccent(id: string, accents: readonly string[]): string {
  if (accents.length === 0) return 'currentColor';
  return accents[agentAccentSlot(id, accents.length)] as string;
}
