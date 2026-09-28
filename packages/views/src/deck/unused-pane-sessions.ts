/** Ownership receipt for shells born through this deck's new-pane door.
 * A restored/attached session is never inferred to be unused. Input history
 * must cover the session lifetime, including periods without a mounted pane. */
export class UnusedPaneSessions<Session extends { id: string } = { id: string }> {
  #attached = new Map<string, Session>();
  readonly #receipts = new Set<string>();
  readonly #born = new Set<string>();
  created(sessionId: string): void {
    if (this.#receipts.has(sessionId)) return;
    this.#receipts.add(sessionId);
    this.#born.add(sessionId);
  }
  /** Follow committed attachments, including replacements that never close a pane.
   * Do not call with an empty list on host unmount: hiding a deck is not detaching it.
   * A receipt is consumed when use is observed, even if that work later finishes. */
  update(sessions: readonly Session[], used: (session: Session) => boolean): readonly Session[] {
    const next = new Map(sessions.map((session) => [session.id, session]));
    for (const session of next.values()) {
      if (this.#born.has(session.id) && used(session)) this.#born.delete(session.id);
    }
    const detached: Session[] = [];
    for (const session of this.#attached.values()) {
      if (!next.has(session.id) && this.#born.has(session.id) && this.closed(session.id, [], used(session))) {
        detached.push(session);
      }
    }
    this.#attached = next;
    return detached;
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
