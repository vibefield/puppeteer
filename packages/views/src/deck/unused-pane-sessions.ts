/** Ownership receipt for shells born through this deck's new-pane door.
 * A restored/attached session is never inferred to be unused. Input history
 * must cover the session lifetime, including periods without a mounted pane. */
export class UnusedPaneSessions {
  readonly #born = new Set<string>();
  created(sessionId: string): void {
    this.#born.add(sessionId);
  }
  closed(sessionId: string, remainingSessionIds: readonly string[], used: boolean): boolean {
    if (!this.#born.has(sessionId)) return false;
    if (used) {
      this.#born.delete(sessionId);
      return false;
    }
    if (remainingSessionIds.includes(sessionId)) return false;
    this.#born.delete(sessionId);
    return true;
  }
}
