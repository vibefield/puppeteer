/**
 * The op timeline — one truth, two projections (docs/archive/IMPOSTER.md §2).
 *
 * A turn is a sequence of semantic ops. Each op fans out to BOTH a semantic
 * projection (hook / transcript / statusline / JSON-RPC, per the persona's
 * ops.json) and a presentation projection (the frame sink). They cannot
 * disagree, because there is only one source: an op either happened or it did
 * not, and both projections are derived from that single fact.
 *
 * That property is the reason a real TUI is safe to add at all. The screen is
 * a projection of the same ops that produced the wire traffic, so it can never
 * describe a turn the adapter did not observe — and it is still never read
 * back for semantics (§1.1).
 */

import type { OpInvocation, Persona } from '../persona/types.ts';
import type { TranscriptWriter } from './channels/transcript.ts';
import { substitute } from './template.ts';

/**
 * The presentation projection of one op. Human-facing only: formatting lives
 * in the sink, and NOTHING may parse these back into semantics (§1.1).
 */
export interface PresentationFrame {
  at: string;
  op: string;
  with: Record<string, unknown>;
  /** The persona binds no channel for this op: it happened, and said nothing. */
  silent?: boolean;
}

export interface OpTimelineOptions {
  persona: Persona;
  /**
   * Hook delivery. The session owns envelope merging and ASM validation at
   * this boundary, so the timeline never has to know what an envelope is —
   * and there is exactly one place that decides what hits the wire.
   */
  emitHook: (event: string, payload: Record<string, unknown>) => Promise<void>;
  transcript: TranscriptWriter;
  statusline?: (payload: Record<string, unknown>) => Promise<void>;
  emitJsonRpc?: (method: string, params: Record<string, unknown>) => Promise<void>;
  /** Publish one native server-sent event. */
  emitSse?: (event: string, properties: Record<string, unknown>) => Promise<void>;
  /** Append one vendor-native durable update envelope. */
  emitNativeLog?: (method: string, params: Record<string, unknown>) => Promise<void>;
  /** Replace one vendor-native JSON state file. */
  emitNativeState?: (name: string, payload: Record<string, unknown>) => Promise<void>;
  /** Append one record to a vendor-native global session index. */
  emitNativeIndex?: (event: string, payload: Record<string, unknown>) => Promise<void>;
  /** Server-initiated request; resolves with the client's reply (§9.3). */
  requestJsonRpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Publish a blocker over SSE and await its later HTTP reply. */
  requestSse?: (event: string, properties: Record<string, unknown>) => Promise<unknown>;
  /** Presentation sink: the headless log, or the Ink TUI once it lands. */
  present?: ((frame: PresentationFrame) => void) | undefined;
  /**
   * Every op invocation, bound or not, before any channel work.
   *
   * `bound` is false when the persona gives this op no wire representation —
   * codex has no `session.ready` — and the distinction is the point: the
   * scenario driver advances on the op because the authored flow reached that
   * phase, while the emitted log stays empty because nothing native was said.
   */
  observe?: (invocation: OpInvocation, bound: boolean) => void;
  /** Session-scoped bindings ($sessionId, $cwd, $permissionMode, …). */
  bindings?: Record<string, unknown>;
  /** Payload for a `usage.refresh` op whose binding carries no template. */
  statusPayload?: () => Record<string, unknown>;
  log?: (message: string) => void;
}

export interface OpTimeline {
  /** Run one op, fanning it out to every channel its persona binds. */
  run(invocation: OpInvocation): Promise<void>;
  runAll(invocations: readonly OpInvocation[]): Promise<void>;
  /**
   * Start a new turn's uuid scope. `$uuid:prompt` must be stable across the
   * ops OF ONE TURN — that is what correlates a prompt_id from
   * UserPromptSubmit through PreToolUse to Stop — and must differ between
   * turns. Everything before the first call shares the boot scope.
   */
  beginTurn(): void;
}

export function createOpTimeline(options: OpTimelineOptions): OpTimeline {
  const log = options.log ?? (() => {});
  let uuids = new Map<string, string>();

  const run = async (invocation: OpInvocation): Promise<void> => {
    const bindings = options.persona.ops[invocation.op];
    options.observe?.(invocation, bindings !== undefined);
    // Presented before the binding check, so an op with no wire representation
    // is still visible as something that happened. The screen showing more than
    // the wire is the correct direction: it is a projection of the same ops, and
    // nothing ever reads it back (§1.1).
    options.present?.({
      at: new Date().toISOString(),
      op: invocation.op,
      with: invocation.with ?? {},
      ...(bindings ? {} : { silent: true }),
    });
    if (!bindings) {
      // An op the persona does not bind is a persona gap, not a crash: the
      // vendor may genuinely have no wire representation for it.
      log(`op ${invocation.op} is unbound for persona ${options.persona.vendor}`);
      return;
    }
    const context = {
      scopes: { op: invocation.with ?? {} },
      bindings: options.bindings,
      uuids,
    };

    for (const binding of bindings) {
      const payload =
        binding.with === undefined ? undefined : (substitute(binding.with, context) as Record<string, unknown>);
      switch (binding.channel) {
        case 'hook': {
          if (!binding.event) throw new Error(`op ${invocation.op} binds the hook channel without an event name`);
          await options.emitHook(binding.event, payload ?? {});
          break;
        }
        case 'transcript': {
          if (!payload) throw new Error(`op ${invocation.op} binds the transcript channel without a record`);
          options.transcript.append(payload);
          break;
        }
        case 'statusline': {
          if (!options.statusline) {
            log(`op ${invocation.op} wants the statusline channel, which is not configured`);
            break;
          }
          await options.statusline(payload ?? options.statusPayload?.() ?? {});
          break;
        }
        case 'jsonrpc': {
          if (!binding.event) throw new Error(`op ${invocation.op} binds the jsonrpc channel without a method`);
          if (binding.await) {
            if (!options.requestJsonRpc) {
              log(`op ${invocation.op} wants a server request, which is not configured`);
              break;
            }
            // A server request suspends the op until the client answers, and
            // binds the reply as `$response` for the ops that follow — which is
            // how `permission.ask` resolves into an allow or a deny (§9.3).
            // `runAll` already awaits sequentially, so no timeline surgery was
            // needed for this: only somewhere to put the answer.
            const response = await options.requestJsonRpc(binding.event, payload ?? {});
            if (options.bindings) options.bindings.$response = response;
            break;
          }
          if (!options.emitJsonRpc) {
            log(`op ${invocation.op} wants the jsonrpc channel, which is not configured`);
            break;
          }
          await options.emitJsonRpc(binding.event, payload ?? {});
          break;
        }
        case 'sse': {
          if (!binding.event) throw new Error(`op ${invocation.op} binds the sse channel without an event name`);
          if (binding.await) {
            if (!options.requestSse) {
              log(`op ${invocation.op} wants an HTTP-resolved SSE blocker, which is not configured`);
              break;
            }
            const response = await options.requestSse(binding.event, payload ?? {});
            if (options.bindings) options.bindings.$response = response;
            break;
          }
          if (!options.emitSse) {
            log(`op ${invocation.op} wants the sse channel, which is not configured`);
            break;
          }
          await options.emitSse(binding.event, payload ?? {});
          break;
        }
        case 'native-log': {
          if (!binding.event) throw new Error(`op ${invocation.op} binds native-log without an event name`);
          if (!options.emitNativeLog) {
            log(`op ${invocation.op} wants native-log, which is not configured`);
            break;
          }
          await options.emitNativeLog(binding.event, payload ?? {});
          break;
        }
        case 'native-state': {
          if (!binding.event) throw new Error(`op ${invocation.op} binds native-state without a file name`);
          if (!options.emitNativeState) {
            log(`op ${invocation.op} wants native-state, which is not configured`);
            break;
          }
          await options.emitNativeState(binding.event, payload ?? {});
          break;
        }
        case 'native-index': {
          if (!binding.event) throw new Error(`op ${invocation.op} binds native-index without an event name`);
          if (!options.emitNativeIndex) {
            log(`op ${invocation.op} wants native-index, which is not configured`);
            break;
          }
          await options.emitNativeIndex(binding.event, payload ?? {});
          break;
        }
      }
    }
  };

  return {
    run,
    async runAll(invocations) {
      for (const invocation of invocations) await run(invocation);
    },
    beginTurn() {
      uuids = new Map();
    },
  };
}
