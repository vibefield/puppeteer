/** Ownership receipt for shells born through this deck's new-pane door.
 * A restored/attached session is never inferred to be unused. Input history
 * must cover the session lifetime, including periods without a mounted pane. */
export class UnusedPaneSessions<Session extends { id: string } = { id: string }> {
  #attached = new Map<string, Session>();
  readonly #pending = new Map<string, Session>();
  readonly #receipts = new Set<string>();
  readonly #born = new Set<string>();
  created(sessionId: string): void {
    if (this.#receipts.has(sessionId)) return;
    this.#receipts.add(sessionId);
    this.#born.add(sessionId);
  }
  /** Follow committed attachments, including replacements that never close a pane.
   * Do not call with an empty list on host unmount: hiding a deck is not detaching it.
   * A receipt is consumed by input/agent use, never by a transient startup job. */
  update(
    sessions: readonly Session[],
    used: (session: Session) => boolean,
    busy: (session: Session) => boolean = () => false,
  ): readonly Session[] {
    const next = new Map(sessions.map((session) => [session.id, session]));
    for (const session of next.values()) {
      this.#pending.delete(session.id);
      if (used(session)) this.release(session.id);
    }
    const detached: Session[] = [];
    for (const session of this.#attached.values()) {
      if (next.has(session.id) || !this.#born.has(session.id)) continue;
      if (used(session)) this.release(session.id);
      else if (busy(session)) this.#pending.set(session.id, session);
      else if (this.closed(session.id, [], false)) detached.push(session);
    }
    this.#attached = next;
    return detached;
  }
  /** Startup jobs temporarily protect an unattached shell, without consuming its receipt.
   * The host follows native metadata after detach until the shell becomes idle. */
  observe(session: Session, used: boolean, busy: boolean): readonly Session[] {
    if (this.#attached.has(session.id)) this.#attached.set(session.id, session);
    if (used) this.release(session.id);
    if (!this.#pending.has(session.id)) return [];
    if (busy) return [];
    this.release(session.id);
    return [session];
  }
  /** An explicit launcher handoff owns disposal now; don't also reap its shell. */
  release(sessionId: string): void {
    this.#born.delete(sessionId);
    this.#pending.delete(sessionId);
  }
  /** Whether the birth receipt is still held: detached while unused, this shell will be reaped. */
  holds(sessionId: string): boolean {
    return this.#born.has(sessionId);
  }
  closed(sessionId: string, remainingSessionIds: readonly string[], used: boolean): boolean {
    if (!this.#born.has(sessionId)) return false;
    if (used) {
      this.release(sessionId);
      return false;
    }
    if (remainingSessionIds.includes(sessionId)) return false;
    this.release(sessionId);
    return true;
  }
}
