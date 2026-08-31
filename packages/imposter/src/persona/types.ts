/**
 * The persona contract (docs/archive/IMPOSTER.md §3.2).
 *
 * A persona is deliberately thin, because most of what the imposter needs is
 * already captured truth: canonical `groundtruth.json` supplies binary names,
 * argv surface, channels, event names, and payload schemas. The split source
 * documents stay Surface-owned authoring inputs and are never read here.
 *
 * What a persona adds is only what the ASM cannot know: which semantic ops map
 * to which channel emissions, and what a session emits at boot.
 */

import type { PayloadSchema, SurfaceModel } from '@vibecook/puppeteer-surface';
import type { ServeDocument } from '../session/serve.ts';

/**
 * The vendor-neutral op vocabulary (§2). Deliberately small and semantic: it
 * is NOT a superset of every vendor's events. Anything not expressible as an
 * op — faults, duplicates, out-of-order arrival, unknown native events — is
 * written as a raw emission in a scenario instead.
 */
export const OP_NAMES = [
  // Protocol/bootstrap traffic that precedes creation of a vendor session.
  'session.initialize',
  // Portable scenario lifecycle. `session.ready` expresses boot-finished
  // authoring intent; it does not claim a vendor emitted a readiness event.
  'session.start',
  'session.ready',
  'session.end',
  // Turn ops.
  'turn.start',
  'assistant.delta',
  'tool.start',
  'tool.end',
  'permission.ask',
  'turn.end',
  'usage.refresh',
] as const;

export type OpName = (typeof OP_NAMES)[number];

export type OpChannel =
  'hook' | 'transcript' | 'statusline' | 'jsonrpc' | 'http' | 'sse' | 'native-log' | 'native-state' | 'native-index';

/**
 * A declarative REST route served by an HTTP/SSE persona.
 *
 * `event`, `method`, and `path` are vendor vocabulary and therefore live in
 * persona data. `action` is the small transport-neutral store operation the
 * shared server performs after the ASM accepts the request.
 */
export interface HttpServeRoute {
  event: string;
  method: string;
  path: string;
  action:
    | 'event.subscribe'
    | 'session.create'
    | 'session.list'
    | 'session.get'
    | 'session.messages'
    | 'session.status'
    | 'session.prompt'
    | 'session.abort'
    | 'session.children'
    | 'session.diff'
    | 'session.delete'
    | 'session.update'
    | 'session.fork'
    | 'permission.list'
    | 'permission.reply'
    | 'question.list'
    | 'question.reply'
    | 'question.reject'
    | 'vcs.diff';
}

export interface HttpServeDocument {
  $server: {
    command: string;
    hostnameFlag: string;
    portFlag: string;
    defaultHostname: string;
    defaultPort: number;
    directoryQuery: string;
    directoryHeader: string;
    auth: {
      usernameEnv: string;
      passwordEnv: string;
      defaultUsername: string;
    };
    attach: {
      command: string;
      sessionFlag: string;
      directoryFlag: string;
    };
  };
  routes: HttpServeRoute[];
}

/**
 * A vendor-owned durable session layout.
 *
 * This is intentionally a persona projection rather than shared truth. The
 * Surface model says that the channels/files exist; the persona says how an
 * emulated session materializes them. Path components are substituted one at
 * a time, so a dynamic `$encodeURIComponent:$threadCwd` component and
 * `$sessionId` never need string interpolation.
 */
export interface NativeStoreDocument {
  /** Vendor environment variable used by its real binary (for example GROK_HOME). */
  rootEnv?: string;
  /** Relative directory components below the isolated Imposter root. */
  sessionPath: string[];
  /** Append-only JSONL filename used by `native-log` bindings or protocol mirroring. */
  updatesFile?: string;
  /** Nested append-only path below the session directory (for example agents/main/wire.jsonl). */
  updatesPath?: string[];
  /** Append-only JSONL index path below the native root (for example session_index.jsonl). */
  indexPath?: string[];
  /** Native JSONL carrier. Omitted preserves the legacy timestamp/method/params envelope. */
  recordFormat?: 'method-params' | 'flat-record';
  /** Discriminator field for a flat record. Defaults to `type`. */
  recordTypeField?: string;
  /** Optional field that contains the event payload inside the flat carrier. */
  recordPayloadField?: string;
  /** Optional per-record native clock synthesized only when the op did not supply one. */
  recordTimestamp?: {
    field: string;
    format: 'epoch-ms' | 'iso';
    omitFor?: string[];
  };
  /** Optional append-order ordinal synthesized only when the op did not supply one. */
  recordSequence?: {
    field: string;
    start?: number;
  };
  /** Optional fresh record id and previous-record correlation for append-only journals. */
  recordIdentity?: {
    idField: string;
    parentField?: string;
    omitParentFor?: string[];
  };
  /** Event types that can occur at most once in one append-only journal. */
  singletonEvents?: string[];
  /** Persist validated JSON-RPC notifications so a served thread can replay them on resume. */
  mirrorJsonRpc?: boolean;
}

/**
 * One channel emission produced by an op.
 *
 * `event` plus `with` rather than a bare name lookup, because the two adapter
 * families discriminate differently (§2.1): claude gives each op a distinct
 * hook name, while codex routes several ops through one JSON-RPC method and
 * discriminates by item type inside the payload. A payload template covers
 * both. Templates may reference `$op.<field>` for the op's own arguments, plus
 * the usual `$uuid:name` / `$now` / binding substitutions.
 */
export interface OpBinding {
  channel: OpChannel;
  /**
   * Send as a SERVER request and suspend the op until the client replies,
   * binding the reply as `$response` for the ops that follow. Only meaningful
   * on the jsonrpc channel; this is how an approval resolves (§9.3).
   */
  await?: boolean;
  /** Hook event name, or JSON-RPC method. Absent for pure transcript writes. */
  event?: string;
  with?: Record<string, unknown>;
}

/** One op may fan out to several channels; order within an op is preserved. */
export type OpsDocument = Record<string, OpBinding[]>;

/** Curated developer-facing scenario catalog, kept separate from native truth. */
export const RUNFLOW_KINDS = ['typical', 'lifecycle', 'vendor', 'adversarial', 'fault'] as const;
export type RunflowKind = (typeof RUNFLOW_KINDS)[number];

export const RUNFLOW_DANGERS = ['safe', 'disruptive', 'terminal'] as const;
export type RunflowDanger = (typeof RUNFLOW_DANGERS)[number];

/**
 * One persona-owned runflow exposed by the adaptation devkit.
 *
 * A runflow does not introduce another workflow language: `scenario` points at
 * a normal, validated scenario document. Counts, native names, channels, and
 * request requirements are derived by the persona loader so catalog prose
 * cannot drift away from the executable script.
 */
export interface RunflowDescriptor {
  id: string;
  /** Cross-persona semantic intent used to compare equivalent native flows. */
  intent: string;
  scenario: string;
  title: string;
  summary: string;
  kind: RunflowKind;
  danger: RunflowDanger;
  tags: string[];
  defaultStimulus: Record<string, unknown>;
  defaultSpeed: number;
  /** Derived executable metadata. */
  steps: number;
  events: string[];
  channels: string[];
  requiresClient: boolean;
}

export interface OpInvocation {
  op: string;
  with?: Record<string, unknown>;
}

export interface PersonaDocument {
  vendor: string;
  /**
   * Where the ASM lives. With `package`, it is resolved through that package's
   * manifest — captured truth, Surface-owned. Without it, `path` is
   * relative to the persona directory, which is only legitimate for a vendor
   * that has no captures because it does not exist (see personas/synthetic).
   */
  asm: { package?: string; path: string };
  /** Vendor binary names this persona answers to, resolved via argv0 (§6). */
  shimNames: string[];
  /**
   * Fields merged into every emission on this persona's event channel, as a
   * substitution template (`$sessionId`, `$transcriptPath`, `$cwd`, …).
   *
   * This is persona-owned rather than hard-coded because the envelope is
   * vendor vocabulary: claude sends `session_id`/`transcript_path`, and a
   * vendor that sends something else must be describable without editing the
   * session. Hard-coding claude's shape here was the single most claude-shaped
   * thing left in the contract (found 2026-08-08 by writing a second persona).
   */
  envelope: Record<string, unknown>;
  /**
   * Field the event's own name is written into before delivery — claude's
   * `hook_event_name`. Omit when the vendor's transport carries the name out
   * of band and the payload must not gain a field the ASM has never seen.
   */
  eventNameField?: string;
  /**
   * When set (Hermes `event`), JSON-RPC notifications are wrapped as
   * `{ method, params: { type, session_id, payload } }` so the wire matches
   * tui_gateway rather than using the event name as the RPC method.
   */
  jsonrpcEventMethod?: string;
  /** Template used only when argv does not provide a native session id. */
  sessionIdTemplate?: string;
  /**
   * Session-scoped vocabulary this vendor mints at start, as templates resolved
   * once against the base bindings (`$uuid:thread`, `$cwd`, …).
   *
   * Codex needs it because its ids exist before any client does: a real `codex`
   * TUI owns a thread from launch, and only the SERVE fork mints one from
   * `thread/start`. Without this, interactive `session.start` templated
   * `$threadId` against nothing and substitution left the literal — so the
   * imposter recorded a `thread/started` whose id was the string "$threadId"
   * (caught 2026-08-09 by asserting on the emitted log, which the ASM cannot
   * catch: "$threadId" is a perfectly good string).
   *
   * It belongs to the persona and not to the session because `$threadId` is
   * codex's word. The session stays vendor-neutral, exactly as it does for the
   * envelope.
   */
  bindings?: Record<string, unknown>;
  /** Optional vendor-native durable session store. */
  nativeStore?: NativeStoreDocument;
  /** Ops emitted when a session starts, before any stimulus. */
  boot: OpInvocation[];
}

export interface Persona {
  vendor: string;
  /**
   * The JSON-RPC serve table, when this vendor is served rather than only
   * emitted (§9.3). REST-native vendors use `httpServe` beside it.
   */
  serve?: ServeDocument;
  /** Declarative HTTP/SSE server surface for REST-native vendors. */
  httpServe?: HttpServeDocument;
  version: string;
  document: PersonaDocument;
  model: SurfaceModel;
  ops: OpsDocument;
  /** Curated scenarios for one-click devkit execution; never native evidence. */
  runflows: RunflowDescriptor[];
  /** Declared channels, from the ASM, under the vendor's own names. */
  channels: string[];
  /**
   * The vendor's channel name for one delivery kind — `hook` is called `hook`
   * by claude and could be called anything by anyone else. Without this the
   * session would drop `hook` while the console showed the vendor's real name
   * still live, and a channel-drop fault would silently do nothing.
   */
  channelFor(kind: OpChannel): string | undefined;
  schemaFor(event: string): PayloadSchema | undefined;
  resultSchemaFor(event: string): PayloadSchema | undefined;
  recordSchemaFor(event: string): PayloadSchema | undefined;
  /** ASM validation for one wire payload; empty means valid. */
  validate(event: string, payload: Record<string, unknown>): string[];
  /** ASM validation for one served request result; empty means valid/unmodelled. */
  validateResult(event: string, result: unknown): string[];
  /** ASM validation for the complete native transport record. */
  validateRecord(event: string, record: unknown, channel?: string): string[];
  /**
   * Argv flag aliases for a launch-recipe key, from `detection.json`
   * (`probedFlags` + `launchFlags`), e.g. `name` -> ['-n', '--name'].
   */
  flagsFor(key: string, fallback: string): string[];
}
