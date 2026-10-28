/**
 * The attach half of stable ingress, as an adapter speaks it: what a host does after an attach that failed, and how
 * an attach's first reading of its process reaches the monitor. Zero I/O, like the rest of core.
 */

import type { AgentEvent } from '../events/index.js';

/**
 * What a host does after an attach that failed, in the adapter's words. The host maps each word without knowing the
 * vendor:
 * - `retry`: something transient (a port still held, a helper still starting). The same attach may succeed later.
 * - `respawn`: the helper the process depends on is gone, and one reborn on its recorded endpoint would be rejoined
 *   by the process's own reconnect. The turn in flight is lost.
 * - `native-log`: the live rail cannot be rebuilt, but the durable log can still be read by id, at `native-log`.
 * - `resume`: nothing can be observed in place. The conversation continues only by a resume into a new process.
 */
export type AgentAttachNext = 'retry' | 'respawn' | 'native-log' | 'resume';

export const AGENT_ATTACH_NEXT: readonly AgentAttachNext[] = ['retry', 'respawn', 'native-log', 'resume'];

// A registered symbol: every copy of this package that an adapter or a runtime loads reads the same one.
const AGENT_ATTACH_REFUSED = Symbol.for('@vibefield/puppeteer-core/agent-attach-refused');

/**
 * The error an adapter's `attachSession` throws when it knows what the host should do instead: a record whose
 * version it does not know, a helper that is gone, an endpoint that answers as someone else. The runtime carries
 * `next` to the attach's failure. Anything else an attach throws fails it with no next step.
 */
export class AgentAttachRefusedError extends Error {
  constructor(
    readonly next: AgentAttachNext,
    message: string,
  ) {
    super(message);
    this.name = 'AgentAttachRefusedError';
  }

  static {
    // The brand sits on the prototype: every instance of every subclass carries it, and none of their data shows it.
    Object.defineProperty(this.prototype, AGENT_ATTACH_REFUSED, { value: true });
  }
}

/**
 * Whether `value` is an adapter's attach refusal ({@link AgentAttachRefusedError}), read by its brand and never by
 * `instanceof`: an adapter that loads its own copy of this package throws another copy's class. One whose `next` is
 * not a word this copy knows is not a refusal.
 */
export function isAgentAttachRefusedError(value: unknown): value is AgentAttachRefusedError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { [AGENT_ATTACH_REFUSED]?: unknown; next?: unknown; message?: unknown };
  return (
    candidate[AGENT_ATTACH_REFUSED] === true &&
    typeof candidate.next === 'string' &&
    (AGENT_ATTACH_NEXT as readonly string[]).includes(candidate.next) &&
    typeof candidate.message === 'string'
  );
}

/** What an attach publishes from its first reading of the process, in the order it read it. */
export interface AttachBootstrap {
  /** The state the agent was in, published as replay: the monitor shows it, and nobody is notified of it. */
  readonly replay: AgentEvent[];
  /**
   * The permissions and questions still open at the end, published live once each, after `replay`. A person is
   * told what the agent is waiting on, even though the request was raised before the host came back.
   */
  readonly announce: AgentEvent[];
}

function interactionRequest(event: AgentEvent): { key: string; resolved: boolean } | undefined {
  switch (event.type) {
    case 'interaction:permission-requested':
      return { key: `permission:${event.requestId}`, resolved: false };
    case 'interaction:permission-resolved':
      return { key: `permission:${event.requestId}`, resolved: true };
    case 'interaction:question-requested':
      return { key: `question:${event.requestId}`, resolved: false };
    case 'interaction:question-resolved':
      return { key: `question:${event.requestId}`, resolved: true };
    default:
      return undefined;
  }
}

/**
 * Split an attach's bootstrap for the monitor. A bootstrap is replay, and replay notifies nobody, so a request the
 * agent raised before the host restarted, and still waits on, would show as blocked without anyone being told. Each
 * request still open at the end of `events` leaves the replay from the moment it was last raised, and is announced
 * live once, as its latest word: a raising left in the replay would make the announcement a repeat, which the
 * monitor does not notify. A request resolved within `events` stays in the replay with its resolution.
 */
export function partitionAttachBootstrap(events: readonly AgentEvent[]): AttachBootstrap {
  // per open request: the index of its first raising since its last resolution, and of its latest
  const open = new Map<string, { since: number; latest: number }>();
  events.forEach((event, index) => {
    const request = interactionRequest(event);
    if (request === undefined) return;
    if (request.resolved) open.delete(request.key);
    else open.set(request.key, { since: open.get(request.key)?.since ?? index, latest: index });
  });
  return {
    replay: events.filter((event, index) => {
      const request = interactionRequest(event);
      const held = request === undefined ? undefined : open.get(request.key);
      return held === undefined || index < held.since;
    }),
    announce: [...open.values()].sort((a, b) => a.latest - b.latest).map(({ latest }) => events[latest]!),
  };
}
