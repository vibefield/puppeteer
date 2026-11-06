import type { ActorRunRef } from './types.js';
import type { MonitorFamilyValue, MonitorStoredEntry } from './internal-types.js';

// Which claim wins: the one authority every reader of stored entries selects by. Each claim has a logical
// identity per family and key, and among the claims that share one, a preference decides.

const QUALITY_PRIORITY = {
  exact: 6,
  strong: 5,
  derived: 4,
  estimated: 3,
  inferred: 2,
  unknown: 1,
} as const;

export function time(value: string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function planePriority(entry: MonitorStoredEntry): number {
  if (entry.family === 'environment') return entry.plane === 'workspace' ? 3 : entry.plane === 'runtime' ? 2 : 1;
  if (entry.family === 'status' && entry.value.kind === 'run') return entry.plane === 'runtime' ? 3 : 2;
  if (entry.family === 'mode') return entry.plane === 'runtime' ? 3 : entry.plane === 'semantic' ? 2 : 1;
  return entry.plane === 'semantic' ? 3 : entry.plane === 'runtime' ? 2 : 1;
}

export function compareEntryPreference(a: MonitorStoredEntry, b: MonitorStoredEntry): number {
  const provisional = Number(!b.provisional) - Number(!a.provisional);
  if (provisional !== 0) return provisional;
  // Metrics and child state have complementary owners: provider
  // samples give the first live boundary and semantic responses make it
  // durable. Equal-quality claims therefore advance by evidence time instead
  // of allowing an older plane to mask a newer transition.
  if (
    a.family === b.family &&
    (['model', 'effort', 'context'].includes(a.family) || (a.value.kind === 'actor' && b.value.kind === 'actor'))
  ) {
    return (
      QUALITY_PRIORITY[b.quality] - QUALITY_PRIORITY[a.quality] ||
      time(b.effectiveAt ?? b.observedAt) - time(a.effectiveAt ?? a.observedAt) ||
      planePriority(b) - planePriority(a) ||
      b.storageKey.localeCompare(a.storageKey)
    );
  }
  return (
    planePriority(b) - planePriority(a) ||
    QUALITY_PRIORITY[b.quality] - QUALITY_PRIORITY[a.quality] ||
    time(b.effectiveAt ?? b.observedAt) - time(a.effectiveAt ?? a.observedAt) ||
    b.storageKey.localeCompare(a.storageKey)
  );
}

export function actorOf(value: MonitorFamilyValue): ActorRunRef | undefined {
  switch (value.kind) {
    case 'activity':
    case 'interaction':
    case 'failure':
    case 'usage':
    case 'context':
    case 'model':
    case 'effort':
    case 'mode':
    case 'environment':
    case 'compaction':
    case 'message':
      return value.actor;
    case 'actor':
      return value.actor;
    case 'run':
      return undefined;
  }
}

function actorLocalSourceKey(entry: MonitorStoredEntry, actorRunKey: string): string {
  try {
    const encoded = JSON.parse(entry.key) as unknown;
    if (
      Array.isArray(encoded) &&
      encoded.length === 2 &&
      typeof encoded[0] === 'string' &&
      encoded[1] === actorRunKey
    ) {
      return encoded[0];
    }
  } catch {
    // Semantic producers use their own readable keys; only runtime actor keys
    // are tuple-encoded by translateAgentEventEnvelope.
  }
  return entry.key;
}

export function logicalEntryKey(entry: MonitorStoredEntry): string {
  const actor = actorOf(entry.value)?.runKey ?? '';
  switch (entry.value.kind) {
    case 'run':
      return JSON.stringify([entry.family, 'run']);
    case 'interaction':
      return JSON.stringify([entry.family, 'interaction', entry.value.interactionId, actor]);
    case 'failure':
      return JSON.stringify([entry.family, 'failure', entry.value.failureId, actor]);
    case 'usage':
      // One usage identity may gain better actor attribution on a later rail.
      // Attribution is evidence, not part of the token observation identity.
      return JSON.stringify([entry.family, entry.value.usageId]);
    case 'context':
      return JSON.stringify([entry.family, actor || 'root']);
    case 'model':
    case 'effort':
      return JSON.stringify([entry.family, entry.value.intent, actor || 'root']);
    case 'mode':
      return JSON.stringify([entry.family, entry.value.modeKind, entry.value.intent ?? 'observed', actor || 'root']);
    case 'actor':
      return JSON.stringify([entry.family, 'actor', entry.value.actor.runKey]);
    case 'activity':
    case 'compaction':
      return JSON.stringify([entry.family, actor ? actorLocalSourceKey(entry, actor) : entry.key, actor]);
    case 'environment':
      return JSON.stringify([entry.family, actor || 'root']);
    case 'message':
      return JSON.stringify([entry.family, 'message', actor || 'root']);
  }
}

/**
 * Select one current source-owned claim for every provider-neutral family/key identity, in family then key order.
 * A group's claims are ranked in the order given, so callers pass the planes in order: runtime, semantic, workspace.
 */
export function selectClaims(entries: Iterable<MonitorStoredEntry>): MonitorStoredEntry[] {
  const grouped = new Map<string, MonitorStoredEntry[]>();
  for (const entry of entries) {
    const key = logicalEntryKey(entry);
    const group = grouped.get(key);
    if (group) group.push(entry);
    else grouped.set(key, [entry]);
  }
  return [...grouped.values()]
    .map((group) => group.sort(compareEntryPreference)[0]!)
    .sort((a, b) => a.family.localeCompare(b.family) || a.key.localeCompare(b.key));
}
