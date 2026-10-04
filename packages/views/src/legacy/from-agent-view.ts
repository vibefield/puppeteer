import type { AgentView, MonitorModel } from '@vibecook/puppeteer-view-sdk';
import { formatUsd } from '../monitor/cost-format.js';
import type { MonitorAgent } from '../monitor/types.js';
import { USAGE_STEP_MS } from '../monitor/usage-ledger.js';

/**
 * THE LEGACY SHIM (L9): the contract's `AgentView` as the legacy `MonitorAgent`,
 * so a view that is not ported yet draws the new model unchanged through the
 * view host's bridge. It also feeds the status ledger (L10) until the timeline
 * slice. MV-8 deletes it.
 *
 * THE AUDIT (puppeteer `mv/land` 35887cf): every `MonitorAgent` field the four
 * shipping views read, plus the status ledger, with who reads it.
 *
 *   id                                   every view: keys, select, lanes, columns; the swarm's working shares
 *   visualId, read as `visualId ?? id`   swarm: bodies, physics, births (bloom/birth.ts)
 *   createdAtMs                          list (order) · timeline (birth) · ledger
 *   status                               every view · ledger
 *   project                              every view
 *   detail                               swarm (title) · list · rain (tooltip, controls)
 *   color                                swarm (accent) · list · rain (wash) · timeline (names, paint, pulse map)
 *   stale                                swarm · list
 *   active                               swarm · list · rain · timeline
 *   attachment                           list · rain · timeline (presence) · .color swarm, timeline ·
 *                                        .paneIds.length rain (one stripe per further pane)
 *   spawnHint                            swarm (physics) · bloom (the birth's row)
 *   unread                               swarm (light, state line) · timeline (unseen) · ledger
 *   receded                              swarm · list · rain · timeline (recede.ts)
 *   profileSet                           swarm (a terminal's profile line) · bloom (the rows it lights)
 *   remote                               swarm · list · rain · timeline · bloom (presence) · .deviceName swarm, list,
 *                                        rain, timeline · .hostWritable swarm, list, rain (remote-write.ts) ·
 *                                        .deviceId bloom
 *   session.activity.kind                swarm: a terminal's running clock, read only when there is no agent facet
 *   agent                                every view (presence: an agent, not a terminal) · ledger
 *   agent.provider.id                    swarm (watermark) · list (icon)
 *   agent.provider.label                 swarm · list · rain · timeline (where there is no model)
 *   agent.model                          swarm · list · rain · timeline
 *   agent.account                        list
 *   agent.branch                         swarm · list · rain · timeline
 *   agent.contextWindow.usedPercent      swarm · list · rain
 *   agent.usage.total                    swarm (bottom figure, working share)
 *   agent.usage.coverage                 swarm (`+` when partial)
 *   agent.monitor.usage.costCoverage     swarm (priced or not)
 *   agent.monitor.usage.costRatePerMin   swarm (flames, the rate in words)
 *   agent.monitor.effort                 swarm (model line: .value; .intent `configured` in italics)
 *   agent.monitor.lastAssistantMessage   swarm (.text: the blocked and unread lines)
 *   agent.monitor.blockers[0]            swarm: .kind, .questions[0].header/.prompt, .detail, .permission.tool,
 *                                        .failure.code · timeline, ledger: .kind, .detail, .questions[0].prompt
 *   agent.monitor.statusSince            timeline (a lane from the row alone) · ledger
 *   agent.monitor.activity.line          timeline (a lane from the row alone) · ledger: what a working stretch did
 *
 * HOW EACH IS SAID FROM THE MODEL. Most are the row's own fact under its old
 * name. Where they are not:
 *   - visualId is absent. The row's id already survives a terminal's promotion
 *     and a resume, so `visualId ?? id` is the id.
 *   - project is the folder's name. With no folder, an agent is named by its
 *     provider's label and a terminal reads `terminal`, as both hosts word it today.
 *   - attachment: the contract carries a pane COUNT, so the pane ids are opaque
 *     placeholders (`<id>:pane:<n>`). Their number and the colour are true;
 *     nothing may look a pane up by them.
 *   - remote is present for a row on another desktop. The contract carries no
 *     write policy, so `hostWritable` follows `attachable`. That is VibeField's
 *     rule (field-app godview/monitor/agents.ts:377-378, where both mean "the
 *     owner names its PTY"), ruled M2. Puppeteer's Godview has no peers.
 *   - agent.usage comes from `cost`: no total where nothing was priced; no steps
 *     where no series crosses. agent.monitor.usage.costRatePerMin is
 *     `cost.burnPerHour / 60`, restored to the per-minute rate it was multiplied from
 *     (`perMinute`: the round trip can miss it by an ulp, which flips a half cent
 *     in `formatUsd`).
 *   - agent.monitor.blockers holds the row's wait with every part the views word:
 *     its detail, a permission's tool, a question's header and prompt, a
 *     failure's code. Only the three kinds the views draw count; another word is
 *     no blocker, which they draw as a blocked body with no words of its own.
 *     The parts stay apart because the views word them in two orders: the
 *     swarm's (header or prompt, detail, tool, code, then the reply, then the
 *     word) and the ledger's (detail, then prompt). Only a design event may
 *     unify those (M2).
 *   - activity: an agent's is agent.monitor.activity ({kind, line, since}); a
 *     terminal's kind is its session's.
 *   - times are ISO strings again, from the row's epoch milliseconds.
 *
 * TWO HOST OPTIONS keep each host's rows exactly as they are until its views port.
 *   - `detail` (M4): the backend's `detail` is Core's headline, and the reply, the
 *     wait and the cost ride as their own fields. Each host composes the old line
 *     from those:
 *       'reply-first'   VibeField (field-app godview/monitor/agent-status.ts
 *                       agentDetail; a peer's mesh-rows.ts remoteDetail after its
 *                       desktop's name, which prefers the question it asks);
 *       'headline-cost' puppeteer's Godview (apps/godview/src/renderer/monitor/
 *                       agents.ts, monitorAgentFromSession): the headline, the
 *                       blockers beyond the first, the cost, the burn.
 *     A terminal's line is the backend's own; both hosts word it alike.
 *   - `peerMonitor` (M9): 'omit' gives a row on another desktop what VibeField's
 *     peers carry today (agents.ts monitorAgentFromMesh): no Core facts, no
 *     context window, no account, so wave 2 changes nothing a peer shows,
 *     including where its timeline lane starts. 'map' carries what the row has.
 *
 * ONE DELIBERATE WIDENING. The legacy type demands facts the model never
 * carries: a peer's own session id, Core's whole mirror, a terminal summary.
 * The shim builds only what it can say truly and widens once, at the end of
 * `legacyAgent`. A reader of anything outside the audit gets `undefined`, never
 * an invented value. So this is for the views and the status ledger alone, never
 * for the find sheet or other chrome: they read facts the model does not carry.
 *
 * Identity: an unchanged `AgentView` yields the same `MonitorAgent`, and an
 * unchanged model the same list, because every view caches on identity.
 */

/** How a host's rows go through the shim until its views port (M4, M9). */
export interface LegacyShimOptions {
  /** The line under the name: VibeField's 'reply-first', puppeteer Godview's 'headline-cost'. */
  readonly detail: 'reply-first' | 'headline-cost';
  /** A peer's Core facts: VibeField 'omit's them, as its peers carry none today; 'map' carries the row's. */
  readonly peerMonitor: 'omit' | 'map';
}

/** What both hosts name a terminal in no folder (`folderName(path, 'terminal')`). */
const TERMINAL_NAME = 'terminal';

/** M4's words, the backend's too: a run nothing drives yet, and one the runtime has not reported. */
const PENDING_LINE = 'unobserved · resumes when idle';
const STARTING_LINE = 'starting';

/** The views draw these blockers; any other word in the row's wait is none to them. */
const DRAWN_WAITS = new Set(['permission', 'question', 'failure']);

/** An instant as Core's ISO string; undefined when it is not one. */
function isoTime(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}

function legacyAttachment(view: AgentView, attachment: NonNullable<AgentView['attachment']>) {
  const count = Number.isFinite(attachment.panes) && attachment.panes >= 1 ? Math.trunc(attachment.panes) : 1;
  const paneIds = Object.freeze(Array.from({ length: count }, (_, index) => `${view.id}:pane:${index}`));
  return Object.freeze({
    primaryPaneId: paneIds[0]!,
    paneIds,
    ...(attachment.colour === undefined ? {} : { color: attachment.colour }),
  });
}

function legacyQuestions(wait: NonNullable<AgentView['wait']>) {
  if (wait.question === undefined && wait.header === undefined) return Object.freeze([]);
  // A header with no prompt still needs one: the swarm reads `prompt.trim()` when the header says nothing.
  const question = { ...(wait.header === undefined ? {} : { header: wait.header }), prompt: wait.question ?? '' };
  return Object.freeze([Object.freeze(question)]);
}

function legacyBlockers(view: AgentView) {
  const wait = view.wait;
  if (!wait || !DRAWN_WAITS.has(wait.kind)) return Object.freeze([]);
  const since = isoTime(wait.since);
  const base = {
    kind: wait.kind,
    ...(since === undefined ? {} : { since }),
    ...(wait.detail === undefined ? {} : { detail: wait.detail }),
  };
  const blocker =
    wait.kind === 'permission'
      ? { ...base, ...(wait.tool === undefined ? {} : { permission: Object.freeze({ tool: wait.tool }) }) }
      : wait.kind === 'question'
        ? { ...base, questions: legacyQuestions(wait) }
        : { ...base, ...(wait.code === undefined ? {} : { failure: Object.freeze({ code: wait.code }) }) };
  return Object.freeze([Object.freeze(blocker)]);
}

function legacyActivity(activity: NonNullable<AgentView['activity']>) {
  const since = isoTime(activity.since);
  return Object.freeze({
    kind: activity.kind,
    ...(activity.line === undefined ? {} : { line: activity.line }),
    ...(since === undefined ? {} : { since }),
  });
}

/** A wait in VibeField's words: its kind, and the permission's tool (agent-status.ts blockerTool). */
function waitWords(wait: NonNullable<AgentView['wait']>): string {
  return wait.tool ? `${wait.kind} · ${wait.tool}` : wait.kind;
}

/** VibeField's line: agent-status.ts agentDetail, or for a peer its desktop's name, then mesh-rows.ts remoteDetail. */
function replyFirstLine(view: AgentView): string {
  const reply = view.reply?.text.trim() || undefined;
  if (!view.device.self) {
    const question = view.wait?.question?.trim() || undefined;
    const line = view.pending
      ? PENDING_LINE
      : view.status === 'blocked'
        ? view.wait
          ? (question ?? waitWords(view.wait))
          : 'blocked'
        : (reply ?? view.status);
    return `${view.device.name} · ${line}`;
  }
  if (view.pending) return PENDING_LINE;
  if (!view.observed) return STARTING_LINE;
  if (view.status === 'blocked') return view.wait ? waitWords(view.wait) : 'blocked';
  return reply ?? view.status;
}

/**
 * The views' per-minute rate from the row's per-hour burn. The backend multiplies
 * Core's per-minute rate by 60; dividing back can land an ulp away (0.015 comes
 * back as 0.014999999999999998), and `formatUsd` would print a half cent the other
 * way ("$0.01/min" for today's "$0.02/min"). Fifteen significant digits restore it.
 */
function perMinute(burnPerHour: number): number {
  return Number((burnPerHour / 60).toPrecision(15));
}

/** Puppeteer Godview's line (agents.ts monitorAgentFromSession): the headline, more blockers, the cost, the burn. */
function headlineCostLine(view: AgentView): string {
  const { cost, wait } = view;
  const blockers = wait ? (wait.count ?? 1) : 0;
  const priced = cost !== undefined && cost.coverage !== 'unavailable';
  return [
    view.detail,
    blockers > 1 ? `+${blockers - 1} blockers` : undefined,
    priced
      ? `~${formatUsd(cost.usd)} estimated API cost${cost.coverage === 'partial' ? ' (partial)' : ''}`
      : 'cost unavailable',
    cost?.burnPerHour === undefined ? undefined : `${formatUsd(perMinute(cost.burnPerHour))}/min`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function legacyDetail(view: AgentView, options: LegacyShimOptions): string {
  if (view.kind !== 'agent') return view.detail;
  return options.detail === 'reply-first' ? replyFirstLine(view) : headlineCostLine(view);
}

function legacyFacet(view: AgentView, options: LegacyShimOptions) {
  const { cost, reply } = view;
  // M9: what VibeField's peers carry today, and no more.
  const coreFacts = view.device.self || options.peerMonitor === 'map';
  const statusSince = isoTime(view.statusSince);
  const replyAt = isoTime(reply?.at);
  const monitor = Object.freeze({
    ...(statusSince === undefined ? {} : { statusSince }),
    blockers: legacyBlockers(view),
    ...(view.activity ? { activity: legacyActivity(view.activity) } : {}),
    ...(reply
      ? {
          lastAssistantMessage: Object.freeze({
            text: reply.text,
            ...(replyAt === undefined ? {} : { at: replyAt }),
            ...(reply.final === undefined ? {} : { final: reply.final }),
          }),
        }
      : {}),
    ...(view.effort
      ? {
          effort: Object.freeze({
            value: view.effort.value,
            ...(view.effort.intent === undefined ? {} : { intent: view.effort.intent }),
          }),
        }
      : {}),
    usage: Object.freeze({
      ...(cost ? { costCoverage: cost.coverage } : {}),
      ...(cost?.burnPerHour === undefined ? {} : { costRatePerMin: perMinute(cost.burnPerHour) }),
    }),
  });
  return Object.freeze({
    provider: Object.freeze({ id: view.provider?.id ?? '', label: view.provider?.label ?? '' }),
    ...(view.model ? { model: view.model } : {}),
    ...(coreFacts && view.account ? { account: view.account } : {}),
    ...(view.project.branch ? { branch: view.project.branch } : {}),
    ...(coreFacts && view.context ? { contextWindow: Object.freeze({ usedPercent: view.context.usedPercent }) } : {}),
    ...(cost
      ? {
          usage: Object.freeze({
            ...(cost.coverage === 'unavailable' ? {} : { total: cost.usd }),
            coverage: cost.coverage,
            steps: cost.series?.steps ?? Object.freeze([]),
            stepMs: cost.series?.stepMs ?? USAGE_STEP_MS,
          }),
        }
      : {}),
    ...(coreFacts ? { monitor } : {}),
  });
}

function legacyAgent(view: AgentView, options: LegacyShimOptions): MonitorAgent {
  const agent = view.kind === 'agent';
  const fallback = agent ? (view.provider?.label ?? '') : TERMINAL_NAME;
  const legacy = Object.freeze({
    id: view.id,
    createdAtMs: view.createdAt,
    status: view.status,
    project: view.project.name || fallback,
    detail: legacyDetail(view, options),
    color: view.colour,
    active: view.active,
    ...(view.stale ? { stale: true } : {}),
    ...(view.unread ? { unread: true } : {}),
    ...(view.receded ? { receded: true } : {}),
    ...(view.tier ? { tier: view.tier } : {}),
    ...(view.profileSet === undefined ? {} : { profileSet: view.profileSet }),
    ...(view.spawnHint ? { spawnHint: view.spawnHint } : {}),
    ...(view.attachment ? { attachment: legacyAttachment(view, view.attachment) } : {}),
    ...(view.device.self
      ? {}
      : {
          remote: Object.freeze({
            deviceId: view.device.id,
            deviceName: view.device.name,
            attachable: view.attachable,
            hostWritable: view.attachable,
            cwdLabel: view.project.name || null,
          }),
        }),
    ...(!agent && view.activity !== undefined
      ? { session: Object.freeze({ activity: Object.freeze({ kind: view.activity.kind }) }) }
      : {}),
    ...(agent ? { agent: legacyFacet(view, options) } : {}),
  });
  // The one widening (see the header): absent facts stay absent rather than invented.
  return legacy as unknown as MonitorAgent;
}

interface Memo {
  readonly agents: WeakMap<AgentView, MonitorAgent>;
  readonly lists: WeakMap<MonitorModel, readonly MonitorAgent[]>;
}

/** One memo per option VALUE, so a host that passes a fresh options object each time still keeps identity. */
const memos = new Map<string, Memo>();

function memoFor(options: LegacyShimOptions): Memo {
  const key = `${options.detail}:${options.peerMonitor}`;
  const held = memos.get(key);
  if (held) return held;
  const memo: Memo = { agents: new WeakMap(), lists: new WeakMap() };
  memos.set(key, memo);
  return memo;
}

/** The legacy row for one `AgentView`: the same object for as long as the view is. */
export function toMonitorAgent(view: AgentView, options: LegacyShimOptions): MonitorAgent {
  const { agents } = memoFor(options);
  const held = agents.get(view);
  if (held) return held;
  const legacy = legacyAgent(view, options);
  agents.set(view, legacy);
  return legacy;
}

/** The legacy rows for a model, in its order: the same list for as long as the model is. */
export function toMonitorAgents(model: MonitorModel, options: LegacyShimOptions): readonly MonitorAgent[] {
  const { lists } = memoFor(options);
  const held = lists.get(model);
  if (held) return held;
  const list = Object.freeze(model.agents.map((view) => toMonitorAgent(view, options)));
  lists.set(model, list);
  return list;
}

/** The first blocker, as far as any view reads it. */
export interface MonitorAgentViewReadsBlocker {
  readonly kind: string;
  readonly detail?: string;
  readonly permission?: { readonly tool?: string };
  readonly failure?: { readonly code?: string };
  readonly questions?: readonly { readonly header?: string; readonly prompt?: string }[];
}

/**
 * A `MonitorAgent` as the views read it: exactly the audit above, in the legacy
 * paths, as plain JSON. An absent fact is an absent key, and a container
 * nothing is read from is absent too.
 */
export interface MonitorAgentViewReads {
  readonly id: string;
  /** `visualId ?? id`, the only way it is read. */
  readonly visualId: string;
  readonly createdAtMs: number;
  readonly status: string;
  readonly project: string;
  readonly detail: string;
  readonly color: string;
  readonly stale: boolean;
  readonly active: boolean;
  readonly unread: boolean;
  readonly receded: boolean;
  /** Its colour and how many panes show it: `paneIds.length`, since the ids are never read. */
  readonly attachment?: { readonly color?: string; readonly panes: number };
  readonly spawnHint?: { readonly x: number; readonly y: number };
  readonly profileSet?: string;
  readonly remote?: { readonly deviceId: string; readonly deviceName: string; readonly hostWritable: boolean };
  /** Only for a row with no agent facet: the swarm reads it nowhere else. */
  readonly session?: { readonly activity: { readonly kind: string } };
  readonly agent?: {
    readonly provider: { readonly id: string; readonly label: string };
    readonly model?: string;
    readonly account?: string;
    readonly branch?: string;
    readonly contextWindow?: { readonly usedPercent: number };
    readonly usage?: { readonly total?: number; readonly coverage?: string };
    readonly monitor?: {
      /** Epoch milliseconds: what the views parse it to. */
      readonly statusSince?: number;
      /** The first blocker only. */
      readonly blockers?: readonly [MonitorAgentViewReadsBlocker];
      readonly activity?: { readonly line: string };
      readonly lastAssistantMessage?: { readonly text: string };
      /** `intent` only when configured: the views read an absent intent as observed. */
      readonly effort?: { readonly value: string; readonly intent?: 'configured' };
      readonly usage?: { readonly costCoverage?: string; readonly costRatePerMin?: number };
    };
  };
}

function isEmptyRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** JSON's own reading, then every object nothing is read from dropped. */
function plainReads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainReads);
  if (typeof value !== 'object' || value === null) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const plain = plainReads(nested);
    if (!isEmptyRecord(plain)) kept[key] = plain;
  }
  return kept;
}

/**
 * Exactly what the four views and the status ledger read of a row (the audit
 * above), for the differential gates of MV-2 and MV-3: today's seam and the
 * new path, each through this, must agree. Each read is normalised only where
 * the view's own read normalises it: `visualId ?? id`, optional flags as
 * booleans, the pane count, `statusSince` parsed, the first blocker, an
 * effort's intent only when configured. A differential pairs rows by identity
 * (`id`, `visualId`) before it compares the rest: those are how each side
 * names a row, not facts.
 */
export function viewReadProjection(agent: MonitorAgent): MonitorAgentViewReads {
  const facet = agent.agent;
  const monitor = facet?.monitor;
  const first = monitor?.blockers?.[0];
  const question = first?.kind === 'question' ? first.questions?.[0] : undefined;
  const since = monitor?.statusSince === undefined ? Number.NaN : Date.parse(monitor.statusSince);
  const reads = {
    id: agent.id,
    visualId: agent.visualId ?? agent.id,
    createdAtMs: agent.createdAtMs,
    status: agent.status,
    project: agent.project,
    detail: agent.detail,
    color: agent.color,
    stale: agent.stale === true,
    active: agent.active === true,
    unread: agent.unread === true,
    receded: agent.receded === true,
    attachment: agent.attachment && { color: agent.attachment.color, panes: agent.attachment.paneIds.length },
    spawnHint: agent.spawnHint && { x: agent.spawnHint.x, y: agent.spawnHint.y },
    profileSet: agent.profileSet,
    remote: agent.remote && {
      deviceId: agent.remote.deviceId,
      deviceName: agent.remote.deviceName,
      hostWritable: agent.remote.hostWritable,
    },
    session: facet ? undefined : { activity: { kind: agent.session?.activity?.kind } },
    agent: facet && {
      provider: { id: facet.provider.id, label: facet.provider.label },
      model: facet.model,
      account: facet.account,
      branch: facet.branch,
      contextWindow: { usedPercent: facet.contextWindow?.usedPercent },
      usage: { total: facet.usage?.total, coverage: facet.usage?.coverage },
      monitor: {
        statusSince: Number.isFinite(since) ? since : undefined,
        blockers: first && [
          {
            kind: first.kind,
            detail: first.detail,
            permission: first.kind === 'permission' ? { tool: first.permission?.tool } : undefined,
            failure: first.kind === 'failure' ? { code: first.failure?.code } : undefined,
            questions: question && [{ header: question.header, prompt: question.prompt }],
          },
        ],
        activity: { line: monitor?.activity?.line },
        lastAssistantMessage: { text: monitor?.lastAssistantMessage?.text },
        effort: monitor?.effort && {
          value: monitor.effort.value,
          intent: monitor.effort.intent === 'configured' ? 'configured' : undefined,
        },
        usage: { costCoverage: monitor?.usage?.costCoverage, costRatePerMin: monitor?.usage?.costRatePerMin },
      },
    },
  };
  return plainReads(JSON.parse(JSON.stringify(reads))) as MonitorAgentViewReads;
}
