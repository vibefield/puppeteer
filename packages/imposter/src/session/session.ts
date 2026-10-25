/**
 * Session assembly: persona + vendor argv -> live channels + op timeline.
 *
 * This is the only module that knows what an "envelope" is. Every delivery
 * path uses the same wire builder, ASM validator, and recorder before reaching
 * its native channel, so there is exactly one policy boundary that can refuse
 * an off-model emission (docs/archive/IMPOSTER.md §7.3 item 3).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { OpChannel, OpInvocation, Persona } from '../persona/types.ts';
import { flagValue } from '../cli/argv.ts';
import {
  ControlError,
  REFUSED,
  type FaultRequest,
  type ScenarioControlAction,
  type ScenarioRunProgressView,
} from '../control/protocol.ts';
import { createHookEmitter, type HookSettings } from './channels/hook.ts';
import { createStatusLineInvoker } from './channels/statusline.ts';
import { createScenarioDriver, type ScenarioDriverSnapshot } from './scenario-driver.ts';
import { createTranscriptWriter, type TranscriptWriter } from './channels/transcript.ts';
import { createNativeSessionStore } from './channels/native-store.ts';
import {
  createScenarioGate,
  createScenarioRunner,
  scenarioSteps,
  type ScenarioGate,
  type ScenarioRunner,
} from './scenario.ts';
import { substitute } from './template.ts';
import { mintPersonaSessionId } from '../persona/session-id.ts';
import { createOpTimeline, type OpTimeline, type PresentationFrame } from './timeline.ts';

export interface BehaviorDocument {
  name?: string;
  reply?: string;
  statusLine?: {
    modelId?: string;
    modelDisplayName?: string;
    capacityTokens?: number;
    tokensPerTurn?: number;
    rateLimits?: Record<string, { used_percentage: number; resetsInSeconds?: number }>;
  };
  ops?: OpInvocation[];
}

export interface EmittedRecord {
  at: string;
  sequence: number;
  event: string;
  /** Exact vendor channel that carried this occurrence. */
  channel?: string;
  payload?: Record<string, unknown>;
  truncated?: boolean;
}

export interface ImposterSessionOptions {
  persona: Persona;
  /** Vendor argv, i.e. everything after persona selection. */
  argv: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
  behavior: BehaviorDocument;
  present?: (frame: PresentationFrame) => void;
  /** Pushed for every emission in order — the control channel's log stream (§5.1). */
  onEmitted?: (entry: EmittedRecord) => void;
  /** Pushed when a fault disconnects a channel, so the console never polls for liveness. */
  onChannels?: (channels: string[]) => void;
  /** Pushed on every portable scenario-intent transition. This is not vendor state. */
  onScenarioDriver?: (snapshot: ScenarioDriverSnapshot) => void;
  /** Pushed for automation lifecycle/progress. This is control metadata, not native evidence. */
  onScenarioRun?: (progress: ScenarioRunProgressView) => void;
  /**
   * Process-level fault effects. The session owns channel-level faults (flood,
   * channel-drop) but never reaches for `process` itself, so a test can drive
   * `crash` without taking the test runner with it.
   */
  halt?: (kind: 'crash' | 'exit' | 'hang', exitCode: number) => void;
  /**
   * The app-server sink, for personas that serve (§9.3). Late-bound by the
   * CLI because the channel needs the dispatcher, which needs this session.
   */
  jsonrpc?: {
    notify(method: string, params: Record<string, unknown>): void;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  /** Native SSE sink. Blockers are published here and resolved by later HTTP requests. */
  sse?: {
    publish(record: { id: string; type: string; properties: Record<string, unknown> }): void;
    request?(record: { id: string; type: string; properties: Record<string, unknown> }): Promise<unknown>;
  };
  log?: (message: string) => void;
}

export interface RunScenarioOptions {
  stimulus?: Record<string, unknown>;
  speed?: number;
  mode?: 'play' | 'pause' | 'step';
  scenario?: string;
  runflowId?: string;
}

export interface ImposterSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly transcriptRoot: string;
  readonly liveChannels: string[];
  readonly emitted: readonly EmittedRecord[];
  readonly timeline: OpTimeline;
  /** Session bindings; the serve table mints ids into these (§9.3 `bind`). */
  readonly bindings: Record<string, unknown>;
  readonly transcript: TranscriptWriter;
  /** Portable scenario intent; vendor-native behavior remains in persona.model.behavior. */
  readonly scenarioDriver: ScenarioDriverSnapshot;
  boot(): Promise<void>;
  /** Run one semantic op. The console's organic trigger, as opposed to a raw event. */
  runOp(op: string, argument?: Record<string, unknown>): Promise<void>;
  /** One organic turn, driven by the persona's behavior pack. */
  turn(text: string): Promise<void>;
  /** Emit a single raw native event, ASM-validated. */
  emit(event: string, payload: Record<string, unknown>, channel?: string): Promise<void>;
  /** Replay a native durable session to one ACP client without persisting it again. */
  restore(notify?: (method: string, params: Record<string, unknown>) => void): Promise<void>;
  statusPayload(): Record<string, unknown>;
  invokeStatusLine(payload?: Record<string, unknown>): Promise<void>;
  dropChannel(channel: string): void;
  /**
   * Run one scenario document. `play` resolves when the scenario finishes;
   * `pause`/`step` resolve as soon as the script is known to be valid, because
   * a reply that waited for the console to press resume would be useless.
   */
  runScenario(document: unknown, options?: RunScenarioOptions): Promise<void>;
  scenarioControl(action: ScenarioControlAction): void;
  applyFault(request: FaultRequest): Promise<void>;
  end(reason?: string): Promise<void>;
}

const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;

export function createImposterSession(options: ImposterSessionOptions): ImposterSession {
  const { persona, argv, env, cwd, behavior } = options;
  const log = options.log ?? (() => {});

  const resumedSessionId = flagValue(argv, persona.flagsFor('resume', '--resume'));
  const explicitSessionId = flagValue(argv, persona.flagsFor('sessionId', '--session-id')) ?? resumedSessionId;
  const generatedSessionId = mintPersonaSessionId(persona);
  const sessionId = explicitSessionId ?? generatedSessionId;
  const settingsPath = flagValue(argv, persona.flagsFor('settings', '--settings'));
  const sessionTitle = flagValue(argv, persona.flagsFor('name', '--name')) ?? 'imposter-session';
  const permissionMode = flagValue(argv, persona.flagsFor('permissionMode', '--permission-mode')) ?? 'default';

  // Default to an ephemeral Imposter root. An explicit shared override or the
  // persona's own native-root variable is authoritative; the Grok adapter sets
  // both to one isolated directory so every cooperating process sees one store.
  const declaredNativeRoot = persona.document.nativeStore?.rootEnv
    ? env[persona.document.nativeStore.rootEnv]
    : undefined;
  const configuredRoot = env.PUPPETEER_IMPOSTER_HOME ?? declaredNativeRoot;
  const transcriptRoot = configuredRoot ?? mkdtempSync(join(tmpdir(), `puppeteer-imposter-${persona.vendor}-`));
  if (!configuredRoot) {
    process.once('exit', () => rmSync(transcriptRoot, { recursive: true, force: true }));
  }
  if (
    env.PUPPETEER_IMPOSTER_HOME &&
    declaredNativeRoot &&
    resolve(env.PUPPETEER_IMPOSTER_HOME) !== resolve(declaredNativeRoot)
  ) {
    throw new Error(
      `imposter ${persona.vendor} requires PUPPETEER_IMPOSTER_HOME and ${persona.document.nativeStore?.rootEnv} to name the same isolated root`,
    );
  }
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const transcriptPath = join(transcriptRoot, 'projects', slug, `${sessionId}.jsonl`);

  const settings: HookSettings & { statusLine?: unknown } = settingsPath
    ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as HookSettings)
    : {};
  const hookEmitter = createHookEmitter({ settings, env, log });
  const transcript = createTranscriptWriter(transcriptPath);
  const statusLineInvoker = createStatusLineInvoker(settings.statusLine, { log });

  // Drops are keyed by the VENDOR's channel name — the same name `liveChannels`
  // reports and the console shows — so a channel-drop fault addresses the thing
  // the operator can see. `channelFor` translates delivery kind to that name.
  const droppedChannels = new Set<string>();
  const dropped = (kind: OpChannel): boolean => droppedChannels.has(persona.channelFor(kind) ?? kind);
  const emitted: EmittedRecord[] = [];
  let emittedBytes = 0;
  let sequence = 0;

  const record = (event: string, payload: Record<string, unknown>, kind?: Parameters<typeof dropped>[0]): void => {
    sequence += 1;
    const channel = kind === undefined ? undefined : (persona.channelFor(kind) ?? kind);
    let entry: EmittedRecord = {
      at: new Date().toISOString(),
      sequence,
      event,
      ...(channel === undefined ? {} : { channel }),
      payload,
    };
    let bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > MAX_ENTRY_BYTES) {
      entry = {
        at: entry.at,
        sequence: entry.sequence,
        event: entry.event,
        ...(entry.channel === undefined ? {} : { channel: entry.channel }),
        truncated: true,
      };
      bytes = Buffer.byteLength(JSON.stringify(entry));
    }
    emitted.push(entry);
    emittedBytes += bytes;
    while (emitted.length > MAX_LOG_ENTRIES || emittedBytes > MAX_LOG_BYTES) {
      emittedBytes -= Buffer.byteLength(JSON.stringify(emitted.shift()));
    }
    options.onEmitted?.(entry);
  };

  /**
   * The envelope is persona-owned vocabulary, not a constant: claude sends
   * `session_id`/`transcript_path`, and a vendor that names them differently
   * has to be describable without editing this file (§3.2). `bindings` is
   * declared below but only read when an op actually emits, which is always
   * after initialization.
   */
  const envelope = (fields: Record<string, unknown>): Record<string, unknown> => ({
    ...(substitute(persona.document.envelope, { bindings }) as Record<string, unknown>),
    ...fields,
  });

  /**
   * An unknown native name still has to reach the bridge for ADR-008 retention
   * to be testable end to end, but it has no handler of its own — route it
   * through any wired handler, exactly as the PoC did.
   */
  const fallbackRoute = persona.model.events.find((event) => (settings.hooks?.[event.event]?.length ?? 0) > 0)?.event;

  const wireFor = (event: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    ...envelope(payload),
    ...(persona.document.eventNameField ? { [persona.document.eventNameField]: event } : {}),
  });

  const emit = async (event: string, payload: Record<string, unknown>): Promise<void> => {
    const wire = wireFor(event, payload);
    const violations = persona.validate(event, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${event}: ${violations.join('; ')}`);
    }
    record(event, wire, 'hook');
    if (dropped('hook')) {
      log(`dropped ${event}: hook channel is disconnected`);
      return;
    }
    await hookEmitter.emit(event, wire, persona.schemaFor(event) ? event : fallbackRoute);
  };

  /**
   * The app-server emitters. They funnel through the SAME envelope + ASM
   * validation + record boundary as hooks do, because "exactly one place that
   * can refuse" (§7.3 item 3) is a property of the imposter, not of the hook
   * channel.
   */
  const notifyJsonRpc = (method: string, payload: Record<string, unknown>): void => {
    const envelopeMethod = persona.document.jsonrpcEventMethod;
    if (envelopeMethod) {
      const sessionId =
        (typeof bindings.$liveSessionId === 'string' && bindings.$liveSessionId) ||
        (typeof bindings.$sessionId === 'string' && bindings.$sessionId) ||
        '';
      options.jsonrpc?.notify(envelopeMethod, { type: method, session_id: sessionId, payload });
      return;
    }
    options.jsonrpc?.notify(method, payload);
  };

  const emitRpc = async (method: string, params: Record<string, unknown>): Promise<void> => {
    const wire = wireFor(method, params);
    const violations = persona.validate(method, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${method}: ${violations.join('; ')}`);
    }
    record(method, wire, 'jsonrpc');
    if (persona.document.nativeStore?.mirrorJsonRpc) {
      if (!nativeStore) throw new Error(`${method} needs a native session store, but none is configured`);
      nativeStore.append(method, wire);
    }
    if (dropped('jsonrpc')) return log(`dropped ${method}: app-server channel is disconnected`);
    notifyJsonRpc(method, wire);
  };

  const replayRpc = async (
    method: string,
    params: Record<string, unknown>,
    notify?: (method: string, params: Record<string, unknown>) => void,
  ): Promise<void> => {
    const wire = wireFor(method, params);
    const violations = persona.validate(method, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model replay for ${method}: ${violations.join('; ')}`);
    }
    record(method, wire, 'jsonrpc');
    if (dropped('jsonrpc')) return log(`dropped replay ${method}: app-server channel is disconnected`);
    if (notify) notify(method, wire);
    else notifyJsonRpc(method, wire);
  };

  const requestRpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const wire = wireFor(method, params);
    const violations = persona.validate(method, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${method}: ${violations.join('; ')}`);
    }
    record(method, wire, 'jsonrpc');
    if (!options.jsonrpc) throw new Error(`${method} needs a server request, but no app-server channel is wired`);
    return options.jsonrpc.request(method, wire);
  };

  const sseRecord = (event: string, properties: Record<string, unknown>) => ({
    id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
    type: event,
    properties,
  });

  const checkedSseRecord = (event: string, properties: Record<string, unknown>) => {
    const wire = wireFor(event, properties);
    const violations = persona.validate(event, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${event}: ${violations.join('; ')}`);
    }
    const carrier = sseRecord(event, wire);
    const carrierViolations = persona.validateRecord(event, carrier, persona.channelFor('sse'));
    if (carrierViolations.length > 0) {
      throw new Error(`imposter refused an off-model SSE carrier for ${event}: ${carrierViolations.join('; ')}`);
    }
    record(event, wire, 'sse');
    return carrier;
  };

  const emitSse = async (event: string, properties: Record<string, unknown>): Promise<void> => {
    const carrier = checkedSseRecord(event, properties);
    if (dropped('sse')) return log(`dropped ${event}: SSE channel is disconnected`);
    options.sse?.publish(carrier);
  };

  const requestSse = async (event: string, properties: Record<string, unknown>): Promise<unknown> => {
    const carrier = checkedSseRecord(event, properties);
    if (!options.sse?.request) throw new Error(`${event} needs an HTTP-resolved SSE blocker, but none is wired`);
    if (dropped('sse')) throw new Error(`${event} cannot ask while the SSE channel is disconnected`);
    return options.sse.request(carrier);
  };

  /**
   * Route a raw emission to the channel the ASM says the event belongs to.
   *
   * Scenarios and the control centre's trigger address events by NAME, never by
   * channel, so with two families in play something has to decide the wire. The
   * ASM already knows: every event declares its vendor channel, and
   * `channelFor` maps that to a delivery kind. Without this every codex
   * scenario would be posted to a hook channel codex does not have.
   */
  // Initialized after the session bindings exist. Emitters close over it but
  // cannot run before `createImposterSession` has completed assembly.
  let nativeStore: ReturnType<typeof createNativeSessionStore> | undefined;

  const emitNativeLog = async (method: string, params: Record<string, unknown>): Promise<void> => {
    const wire = wireFor(method, params);
    const violations = persona.validate(method, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${method}: ${violations.join('; ')}`);
    }
    record(method, wire, 'native-log');
    if (dropped('native-log')) return log(`dropped ${method}: native log channel is disconnected`);
    if (!nativeStore) throw new Error(`${method} needs a native session store, but none is configured`);
    nativeStore.append(method, wire);
    const update = params.update;
    if (
      method === '_x.ai/session/update' &&
      update !== null &&
      typeof update === 'object' &&
      !Array.isArray(update) &&
      (update as Record<string, unknown>).sessionUpdate === 'compaction_checkpoint'
    ) {
      compactionCount += 1;
      bindings.$compactionCount = compactionCount;
      if (persona.schemaFor('signals.json')) {
        await emitNativeState('signals.json', {
          contextTokensUsed: usedTokens,
          contextWindowTokens: capacityTokens,
          contextWindowUsage: capacityTokens > 0 ? usedTokens / capacityTokens : 0,
          primaryModelId: modelId,
          compactionCount,
          turnCount,
          toolCallCount,
        });
      }
    }
  };

  const emitNativeState = async (name: string, payload: Record<string, unknown>): Promise<void> => {
    const wire = wireFor(name, payload);
    const violations = persona.validate(name, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${name}: ${violations.join('; ')}`);
    }
    record(name, wire, 'native-state');
    if (dropped('native-state')) return log(`dropped ${name}: native state channel is disconnected`);
    if (!nativeStore) throw new Error(`${name} needs a native session store, but none is configured`);
    nativeStore.write(name, wire);
  };

  const emitNativeIndex = async (event: string, payload: Record<string, unknown>): Promise<void> => {
    const wire = wireFor(event, payload);
    const violations = persona.validate(event, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${event}: ${violations.join('; ')}`);
    }
    record(event, wire, 'native-index');
    if (dropped('native-index')) return log(`dropped ${event}: native index channel is disconnected`);
    if (!nativeStore) throw new Error(`${event} needs a native session store, but none is configured`);
    nativeStore.appendIndex(wire);
  };

  const routeFor = (
    event: string,
    selectedChannel?: string,
  ): 'hook' | 'jsonrpc' | 'http' | 'sse' | 'native-log' | 'native-state' | 'native-index' => {
    const descriptor = persona.model.events.find((entry) => entry.event === event);
    if (selectedChannel !== undefined && !persona.channels.includes(selectedChannel)) {
      throw new Error(`imposter refused ${event} on unknown channel ${selectedChannel}`);
    }
    if (selectedChannel !== undefined && descriptor !== undefined && !descriptor.channels.includes(selectedChannel)) {
      throw new Error(
        `imposter refused ${event} on ${selectedChannel}: declared rails are ${descriptor.channels.join(', ')}`,
      );
    }
    const declared = selectedChannel ?? descriptor?.channel;
    if (declared !== undefined) {
      if (declared === persona.channelFor('jsonrpc')) return 'jsonrpc';
      if (declared === persona.channelFor('http')) return 'http';
      if (declared === persona.channelFor('sse')) return 'sse';
      if (declared === persona.channelFor('hook')) return 'hook';
      if (declared === persona.channelFor('native-log')) return 'native-log';
      if (declared === persona.channelFor('native-state')) return 'native-state';
      if (declared === persona.channelFor('native-index')) return 'native-index';
    }
    // An event the model has never seen still has to reach a wire for ADR-008
    // retention to be testable; send it down whichever one this vendor has.
    if (persona.channelFor('hook') !== undefined) return 'hook';
    if (persona.channelFor('sse') !== undefined) return 'sse';
    return 'jsonrpc';
  };

  const emitAny = async (event: string, payload: Record<string, unknown>, channel?: string): Promise<void> => {
    const route = routeFor(event, channel);
    if (route === 'jsonrpc') return emitRpc(event, payload);
    if (route === 'sse') return emitSse(event, payload);
    if (route === 'http') throw new Error(`imposter cannot emit client HTTP request event ${event}`);
    if (route === 'native-log') return emitNativeLog(event, payload);
    if (route === 'native-state') return emitNativeState(event, payload);
    if (route === 'native-index') return emitNativeIndex(event, payload);
    return emit(event, payload);
  };

  const status = behavior.statusLine ?? {};
  const modelId =
    flagValue(argv, persona.flagsFor('model', '--model')) ?? status.modelId ?? `${persona.vendor}-imposter`;
  const capacityTokens = status.capacityTokens ?? 200_000;
  let usedTokens = 0;
  let turnCount = 0;
  let messageCount = 0;
  let toolCallCount = 0;
  let compactionCount = 0;
  let assistantMessageStarted = false;

  const statusPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      model: { id: modelId, display_name: status.modelDisplayName ?? modelId },
      workspace: { current_dir: cwd },
      context_window:
        usedTokens === 0
          ? { total_input_tokens: 0, context_window_size: capacityTokens, current_usage: null }
          : {
              total_input_tokens: usedTokens,
              context_window_size: capacityTokens,
              used_percentage: Math.round((usedTokens / capacityTokens) * 1000) / 10,
              current_usage: {
                input_tokens: usedTokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
    };
    if (status.rateLimits) {
      payload.rate_limits = Object.fromEntries(
        Object.entries(status.rateLimits).map(([id, window]) => [
          id,
          {
            used_percentage: window.used_percentage,
            resets_at: new Date(Date.now() + (window.resetsInSeconds ?? 3600) * 1000).toISOString(),
          },
        ]),
      );
    }
    return payload;
  };

  const invokeStatusLine = async (payload?: Record<string, unknown>): Promise<void> => {
    if (dropped('statusline')) {
      log('dropped statusline payload: channel is disconnected');
      return;
    }
    await statusLineInvoker?.invoke(payload ?? statusPayload());
  };

  const guardedTranscript: TranscriptWriter = {
    path: transcript.path,
    append: (entry) => {
      if (dropped('transcript')) return log('dropped transcript record: channel is disconnected');
      transcript.append(entry);
    },
    appendPartial: (fragment) => {
      if (dropped('transcript')) return log('dropped transcript fragment: channel is disconnected');
      transcript.appendPartial(fragment);
    },
  };

  const bindings: Record<string, unknown> = {
    $sessionId: sessionId,
    $sessionTitle: sessionTitle,
    $permissionMode: permissionMode,
    $transcriptPath: transcriptPath,
    $imposterHome: transcriptRoot,
    $cwd: cwd,
    $encodedCwd: encodeURIComponent(cwd),
    $vendorVersion: persona.version,
    $platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
    $platformOs: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform,
    $modelId: modelId,
    $capacityTokens: capacityTokens,
    $usedTokens: usedTokens,
    $contextUsage: 0,
    $turnCount: turnCount,
    $turnIndex: 0,
    $turnStep: '0.1',
    $messageCount: messageCount,
    $toolCallCount: toolCallCount,
    $compactionCount: compactionCount,
    $claudeMdPath: join(cwd, 'CLAUDE.md'),
    ...(behavior.reply === undefined ? {} : { $reply: behavior.reply }),
  };

  // Persona-owned session vocabulary, minted once and layered over the base so
  // it can reference it (`$threadCwd: "$cwd"`). The serve table's `bind` may
  // overwrite any of these later, which is the point: codex's thread id is
  // whatever the client's `thread/start` minted, and only interactively is it
  // this one (types.ts `PersonaDocument.bindings`).
  Object.assign(bindings, substitute(persona.document.bindings ?? {}, { bindings, uuids: new Map() }));
  nativeStore = persona.document.nativeStore
    ? createNativeSessionStore(
        transcriptRoot,
        persona.document.nativeStore,
        bindings,
        persona.document.nativeStore.mirrorJsonRpc
          ? {}
          : {
              validateRecord: (method, carrier) =>
                persona.validateRecord(method, carrier, persona.channelFor('native-log')),
            },
      )
    : undefined;
  if (nativeStore) bindings.$nativeSessionDir = nativeStore.directory;

  // One scenario driver per session, advanced by the portable op timeline. It
  // exists to author organic traffic; Surface's native behavior graph is the
  // separate source of truth for what the vendor actually exposes.
  const scenarioDriver = createScenarioDriver();

  const timeline = createOpTimeline({
    persona,
    // Advance FIRST, notify second, and never in one expression: `f?.(g())`
    // does not evaluate `g()` when `f` is nullish, so folding these together
    // left the driver frozen at `starting` for every caller that passed no
    // `onScenarioDriver` — scenario intent silently depending on whether
    // anyone happened to be watching it (found in review, 2026-08-08).
    observe: (invocation) => {
      if (nativeStore) bindings.$nativeSessionDir = nativeStore.directory;
      if (invocation.op === 'turn.start') {
        turnCount += 1;
        messageCount += 1;
        assistantMessageStarted = false;
      } else if (invocation.op === 'assistant.delta' && !assistantMessageStarted) {
        assistantMessageStarted = true;
        messageCount += 1;
      } else if (invocation.op === 'tool.start') {
        toolCallCount += 1;
      }
      if (invocation.op === 'usage.refresh') {
        const nextUsedTokens = invocation.with?.usedTokens;
        const addedTokens = invocation.with?.addedTokens;
        if (typeof addedTokens === 'number' && Number.isFinite(addedTokens) && addedTokens >= 0) {
          usedTokens += addedTokens;
        } else if (typeof nextUsedTokens === 'number' && Number.isFinite(nextUsedTokens) && nextUsedTokens >= 0) {
          usedTokens = nextUsedTokens;
        }
      }
      // Native-state templates are evaluated after this callback. Keeping the
      // aggregate values in session bindings lets a persona write faithful
      // cumulative summary/signals files without hard-coding a one-turn
      // snapshot into its behavior document.
      bindings.$usedTokens = usedTokens;
      bindings.$contextUsage = capacityTokens > 0 ? usedTokens / capacityTokens : 0;
      bindings.$turnCount = turnCount;
      bindings.$turnIndex = Math.max(0, turnCount - 1);
      bindings.$turnStep = `${Math.max(0, turnCount - 1)}.1`;
      bindings.$messageCount = messageCount;
      bindings.$toolCallCount = toolCallCount;
      bindings.$compactionCount = compactionCount;
      const { snapshot } = scenarioDriver.send(invocation.op);
      options.onScenarioDriver?.(snapshot);
    },
    emitHook: emit,
    emitJsonRpc: emitRpc,
    emitSse,
    requestJsonRpc: requestRpc,
    requestSse,
    emitNativeLog,
    emitNativeState,
    emitNativeIndex,
    transcript: guardedTranscript,
    statusline: async () => invokeStatusLine(),
    present: options.present,
    bindings,
    statusPayload,
    log,
  });

  const liveChannels = (): string[] => persona.channels.filter((channel) => !droppedChannels.has(channel));

  const endSession = async (reason = 'other'): Promise<void> => {
    await timeline.run({ op: 'session.end', with: { reason } }).catch((error: unknown) => {
      log(`session.end failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  /**
   * Process-level faults default to what a real vendor does when it dies.
   * `setImmediate` is load-bearing: the control reply has to flush before the
   * process goes away, or the console reports a fault as failed when it landed.
   */
  const halt =
    options.halt ??
    ((kind: 'crash' | 'exit' | 'hang', exitCode: number): void => {
      if (kind === 'hang') {
        process.stdin.pause();
        return;
      }
      setImmediate(() => {
        if (kind === 'crash') process.exit(exitCode);
        else void endSession('other').finally(() => process.exit(exitCode));
      });
    });

  const applyFault = async (request: FaultRequest): Promise<void> => {
    switch (request.kind) {
      case 'channel-drop': {
        const channel = request.channel ?? 'hook';
        droppedChannels.add(channel);
        options.onChannels?.(liveChannels());
        log(`fault: dropped the ${channel} channel`);
        return;
      }
      case 'flood': {
        // There is no vendor-neutral default payload, so the caller supplies
        // one and the ASM refuses it if it is off-model — the same gate every
        // trigger goes through (§7.3 item 3).
        const event = request.event ?? persona.model.events[0]?.event;
        if (!event) throw new ControlError(REFUSED, 'flood requires an event');
        for (let index = 0; index < (request.count ?? 100); index += 1) await emitAny(event, request.with ?? {});
        return;
      }
      case 'crash':
        halt('crash', request.exitCode ?? 137);
        return;
      case 'exit':
        halt('exit', request.exitCode ?? 0);
        return;
      case 'hang':
        halt('hang', 0);
        return;
    }
  };

  const runner: ScenarioRunner = createScenarioRunner({
    emit: emitAny,
    request: async (event, payload) => {
      const route = routeFor(event);
      if (route === 'jsonrpc') return requestRpc(event, payload);
      if (route === 'sse') return requestSse(event, payload);
      throw new Error(`scenario request ${event} is not carried by a reply-capable channel`);
    },
    transcript: guardedTranscript,
    statusline: (payload) => invokeStatusLine(payload),
    // Pre-flight validation sees exactly the wire payload `emit` will build,
    // envelope included, so a scenario cannot pass here and be refused there.
    validate: (event, payload) => persona.validate(event, wireFor(event, payload)),
    fault: applyFault,
    bindings,
    log,
  });

  let activeScenario:
    | {
        gate: ScenarioGate;
        progress: ScenarioRunProgressView;
      }
    | undefined;

  const pushScenarioRun = (progress: ScenarioRunProgressView): void => {
    try {
      options.onScenarioRun?.({ ...progress });
    } catch (error) {
      log(`scenario progress observer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    sessionId,
    transcriptPath,
    transcriptRoot,
    get liveChannels() {
      return liveChannels();
    },
    emitted,
    timeline,
    bindings,
    transcript: guardedTranscript,
    get scenarioDriver() {
      return scenarioDriver.snapshot();
    },
    emit: emitAny,
    async restore(notify) {
      if (!nativeStore || !nativeStore.exists()) {
        throw new Error(`native session ${String(bindings.$sessionId)} does not exist`);
      }
      const signals = nativeStore.read('signals.json');
      if (signals) {
        const restoredTokens = signals.contextTokensUsed;
        if (typeof restoredTokens === 'number' && Number.isFinite(restoredTokens) && restoredTokens >= 0) {
          usedTokens = restoredTokens;
        }
        const restoredTurns = signals.turnCount;
        if (typeof restoredTurns === 'number' && Number.isInteger(restoredTurns) && restoredTurns >= 0) {
          turnCount = restoredTurns;
        }
        const restoredToolCalls = signals.toolCallCount;
        if (typeof restoredToolCalls === 'number' && Number.isInteger(restoredToolCalls) && restoredToolCalls >= 0) {
          toolCallCount = restoredToolCalls;
        }
        const restoredCompactions = signals.compactionCount;
        if (
          typeof restoredCompactions === 'number' &&
          Number.isInteger(restoredCompactions) &&
          restoredCompactions >= 0
        ) {
          compactionCount = restoredCompactions;
        }
      }
      const summary = nativeStore.read('summary.json');
      const restoredMessages = [summary?.num_messages, summary?.num_chat_messages].find(
        (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0,
      );
      if (typeof restoredMessages === 'number' && Number.isInteger(restoredMessages) && restoredMessages >= 0) {
        messageCount = restoredMessages;
      }
      if (typeof summary?.created_at === 'string' || typeof summary?.created_at === 'number') {
        bindings.$sessionCreatedAt = summary.created_at;
      }
      bindings.$usedTokens = usedTokens;
      bindings.$contextUsage = capacityTokens > 0 ? usedTokens / capacityTokens : 0;
      bindings.$turnCount = turnCount;
      bindings.$turnIndex = Math.max(0, turnCount - 1);
      bindings.$turnStep = `${Math.max(0, turnCount - 1)}.1`;
      bindings.$messageCount = messageCount;
      bindings.$toolCallCount = toolCallCount;
      bindings.$compactionCount = compactionCount;
      for (const update of nativeStore.readUpdates()) {
        const durableUpdate = update.params.update;
        if (
          update.method === '_x.ai/session/update' &&
          durableUpdate !== null &&
          typeof durableUpdate === 'object' &&
          !Array.isArray(durableUpdate) &&
          (durableUpdate as Record<string, unknown>).sessionUpdate === 'compaction_checkpoint'
        ) {
          // Grok persists this checkpoint for its own reconstruction but does
          // not expose it on the live extension method. Replaying it would
          // fabricate a wire event the ASM intentionally marks persist-only.
          continue;
        }
        const method = update.method === '_x.ai/session/update' ? '_x.ai/session_notification' : update.method;
        await replayRpc(method, update.params, notify);
      }
    },
    async runOp(op, argument = {}) {
      // Resolved the same way a behavior pack's arguments are, so an op fired
      // by hand and an op fired by a turn reach the timeline identically.
      const resolved = substitute(argument, { bindings, uuids: new Map() }) as Record<string, unknown>;
      await timeline.run({ op, with: resolved });
    },
    statusPayload,
    invokeStatusLine,
    dropChannel(channel) {
      droppedChannels.add(channel);
      options.onChannels?.(liveChannels());
    },
    applyFault,
    async runScenario(document, runOptions = {}) {
      if (activeScenario) {
        throw new ControlError(
          REFUSED,
          `scenario ${activeScenario.progress.scenario ?? activeScenario.progress.runId} is already running`,
        );
      }
      const mode = runOptions.mode ?? 'play';
      const active = createScenarioGate(mode);
      const runId = crypto.randomUUID();
      let progress: ScenarioRunProgressView = {
        runId,
        ...(runOptions.scenario === undefined ? {} : { scenario: runOptions.scenario }),
        ...(runOptions.runflowId === undefined ? {} : { runflowId: runOptions.runflowId }),
        mode,
        status: active.paused ? 'paused' : 'running',
        step: 0,
        steps: 0,
        fromSequence: sequence + 1,
      };
      // prepare() validates the whole script and touches nothing, so a bad
      // scenario fails the caller before the gate is ever published.
      const prepared = runner.prepare(scenarioSteps(document), runOptions.stimulus ?? {}, {
        speed: runOptions.speed ?? 1,
        gate: active,
        onProgress: ({ step, steps }) => {
          if (activeScenario?.progress.runId !== runId) return;
          progress = { ...progress, step, steps, status: active.paused ? 'paused' : 'running' };
          activeScenario.progress = progress;
          pushScenarioRun(progress);
        },
      });
      progress = { ...progress, steps: prepared.steps };
      activeScenario = { gate: active, progress };
      pushScenarioRun(progress);

      const play = async (): Promise<void> => {
        try {
          await prepared.play();
          progress = { ...progress, status: 'completed', throughSequence: sequence };
          if (activeScenario?.progress.runId === runId) activeScenario.progress = progress;
          pushScenarioRun(progress);
        } catch (error) {
          const reason = (error instanceof Error ? error.message : String(error)) || 'scenario failed';
          progress = {
            ...progress,
            status: 'failed',
            throughSequence: sequence,
            error: reason.slice(0, 2048),
          };
          if (activeScenario?.progress.runId === runId) activeScenario.progress = progress;
          pushScenarioRun(progress);
          throw error;
        } finally {
          if (activeScenario?.progress.runId === runId) activeScenario = undefined;
        }
      };
      if (mode === 'play') {
        await play();
        return;
      }
      void play().catch((error: unknown) =>
        log(`scenario failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    },
    scenarioControl(action) {
      if (!activeScenario) throw new ControlError(REFUSED, 'no scenario is running');
      if (action === 'pause') activeScenario.gate.pause();
      else if (action === 'step') activeScenario.gate.step();
      else activeScenario.gate.resume();
      activeScenario.progress = {
        ...activeScenario.progress,
        status: activeScenario.gate.paused ? 'paused' : 'running',
      };
      pushScenarioRun(activeScenario.progress);
    },
    async boot() {
      const resumeBoot = resumedSessionId === undefined ? undefined : persona.document.resumeBoot;
      await timeline.runAll(resumeBoot ?? persona.document.boot);
    },
    async turn(text) {
      const ops = behavior.ops ?? [];
      if (ops.length === 0) {
        log(`persona ${persona.vendor} has no behavior ops; the turn is a no-op`);
        return;
      }
      timeline.beginTurn();
      // Behavior templates resolve against the stimulus FIRST, so the timeline
      // receives concrete op arguments and ops.json only ever sees `$op.*`.
      const uuids = new Map<string, string>();
      for (const invocation of ops) {
        const resolved = substitute(invocation.with ?? {}, {
          scopes: { stimulus: { text } },
          bindings,
          uuids,
        }) as Record<string, unknown>;
        await timeline.run({ op: invocation.op, with: resolved });
      }
      usedTokens += status.tokensPerTurn ?? 0;
      await invokeStatusLine();
    },
    end: endSession,
  };
}
