export function missingManagedSessionIds(
  managedSessionIds: Iterable<string>,
  liveSessionIds: Iterable<string>,
): string[] {
  const live = new Set(liveSessionIds);
  return [...managedSessionIds].filter((sessionId) => !live.has(sessionId));
}

/** Resolve an old pane id through any completed recovery aliases. */
export function resolveRestoredSessionAlias(aliases: ReadonlyMap<string, string>, sessionId: string): string {
  let current = sessionId;
  const seen = new Set([current]);
  while (true) {
    const target = aliases.get(current);
    if (!target) return current;
    // Aliases are internal state, but refusing to follow a cycle keeps a bad
    // entry from hanging recovery or redirecting an unrelated pane forever.
    if (seen.has(target)) return sessionId;
    seen.add(target);
    current = target;
  }
}

/**
 * Point one restored id at its replacement and flatten every predecessor.
 * A -> B followed by B -> C therefore becomes A -> C and B -> C.
 */
export function setRestoredSessionAlias(
  aliases: Map<string, string>,
  originSessionId: string,
  targetSessionId: string,
): void {
  const predecessors = [
    originSessionId,
    ...[...aliases.keys()].filter(
      (candidate) =>
        candidate !== originSessionId && resolveRestoredSessionAlias(aliases, candidate) === originSessionId,
    ),
  ];
  const target = resolveRestoredSessionAlias(aliases, targetSessionId);
  for (const predecessor of predecessors) {
    if (predecessor === target) aliases.delete(predecessor);
    else aliases.set(predecessor, target);
  }
}

/** Return every older id that currently resolves to this runtime id. */
export function restoredSessionAliasOrigins(aliases: ReadonlyMap<string, string>, targetSessionId: string): string[] {
  return [...aliases.keys()].filter(
    (originSessionId) => resolveRestoredSessionAlias(aliases, originSessionId) === targetSessionId,
  );
}
