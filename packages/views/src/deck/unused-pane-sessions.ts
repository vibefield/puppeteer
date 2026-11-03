/** Delivery receipt for shells eligible for owner-side conditional release.
 * Eligibility comes from the terminal owner's lifetime input fact. Keep the
 * receipt through detach and RPC failure; release it only after acknowledgement. */
export class UnusedPaneSessions<Session extends { id: string } = { id: string }> {
  #attached = new Map<string, Session>();
  readonly #pending = new Map<string, Session>();
  readonly #born = new Set<string>();
  /** Register only when the terminal owner currently declares the shell unused. */
  created(sessionId: string): void {
    this.#born.add(sessionId);
  }
  /** A host's atomic placement succeeded. Record it before a render: a close
   * batched with that replacement may be the next attachment list we see.
   * This never grants ownership to a restored or previously used session. */
  placed(session: Session): void {
    if (!this.#born.has(session.id)) return;
    this.#pending.delete(session.id);
    this.#attached.set(session.id, session);
  }
  /** Follow committed attachments, including replacements that never close a pane.
   * Do not call with an empty list on host unmount: hiding a deck is not detaching it.
   * A receipt is consumed by input/agent use, never by a transient startup job. */
  update(
    sessions: readonly Session[],
    used: (session: Session) => boolean,
    _busy: (session: Session) => boolean = () => false,
  ): readonly Session[] {
    const next = new Map(sessions.map((session) => [session.id, session]));
    for (const session of next.values()) {
      this.#pending.delete(session.id);
      if (used(session)) this.release(session.id);
    }
    for (const session of this.#attached.values()) {
      if (next.has(session.id) || !this.#born.has(session.id)) continue;
      if (used(session)) this.release(session.id);
      else this.#pending.set(session.id, session);
    }
    this.#attached = next;
    return [...this.#pending.values()];
  }
  /** Accepted input discharges local delivery; startup/attachment safety belongs
   * to the native conditional release, which can inspect every client. */
  observe(session: Session, used: boolean, _busy: boolean): readonly Session[] {
    if (this.#attached.has(session.id)) this.#attached.set(session.id, session);
    if (used) this.release(session.id);
    if (!this.#pending.has(session.id)) return [];
    return [session];
  }
  /** Acknowledged owner adoption (or authoritative use) discharges this receipt. */
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
    const session = this.#attached.get(sessionId);
    if (session !== undefined) this.#pending.set(sessionId, session);
    return true;
  }
}
