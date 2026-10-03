import type {
  MonitorAgentRow,
  MonitorSpawnDevice,
  MonitorSpawnMenu,
  MonitorSpawnProfile,
} from '@vibecook/puppeteer-view-sdk/model';
import type { MonitorHostFacts, MonitorHostProfileSet } from './ports.js';

// The spawn menu (SB-D9), ported from VibeField's `godview/monitor/spawn-menu.ts`
// + the blocked dot of `profile-tabs.ts`: this desktop, `reading` with no
// profiles until the host's feed first answers, then `ready` with its Agent
// Profiles in the feed's order; peers as the host words them (SB-6).

/**
 * Who is signed in under a profile, in the host's labels and the feed's order.
 * A managed profile's sign-ins count in any state (it holds them); the native
 * set's only where the agent's own folder is signed in (`signedInUnder`).
 */
export function signedInLabels(set: MonitorHostProfileSet): string[] {
  const labels: string[] = [];
  for (const persona of set.personas) {
    if (set.kind === 'native' && persona.loggedIn !== true) continue;
    if (!labels.includes(persona.providerLabel)) labels.push(persona.providerLabel);
  }
  return labels;
}

/** The profile sets with an agent waiting on the person under them: the tabs' orange dot. */
export function blockedProfileSets(rows: readonly MonitorAgentRow[]): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'agent' && row.status === 'blocked' && row.profileSet !== undefined) blocked.add(row.profileSet);
  }
  return blocked;
}

export function spawnMenuOf(
  facts: Pick<MonitorHostFacts, 'device' | 'profileSets' | 'spawnPeers'>,
  blocked: ReadonlySet<string>,
): MonitorSpawnMenu {
  const here = { id: facts.device.id, label: facts.device.name, self: true as const };
  const self: MonitorSpawnDevice =
    facts.profileSets === null
      ? { ...here, state: 'reading' }
      : {
          ...here,
          state: 'ready',
          profiles: facts.profileSets.map((set): MonitorSpawnProfile => ({
            id: set.id,
            label: set.label,
            ...(set.glyph === undefined ? {} : { glyph: set.glyph }),
            kind: set.kind,
            ...(set.isDefault === undefined ? {} : { isDefault: set.isDefault }),
            ...(blocked.has(set.id) ? { blocked: true } : {}),
            signedIn: signedInLabels(set),
          })),
        };
  return { devices: [self, ...(facts.spawnPeers ?? [])] };
}
