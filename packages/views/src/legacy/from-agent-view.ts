import type { AgentView, MonitorModel } from '@vibecook/puppeteer-view-sdk';
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
 *   - remote is present for a row on another desktop. Its write policy follows
 *     `attachable`, VibeField's rule today (both are "the owner names its PTY").
 *   - agent.usage comes from `cost`: no total where nothing was priced; no steps
 *     where no series crosses. agent.monitor.usage.costRatePerMin is
 *     `cost.burnPerHour / 60`.
 *   - agent.monitor.blockers holds the row's wait, when it is one of the three
 *     kinds the views draw. Another word is no blocker, which those views draw as
 *     a blocked body with no words of its own.
 *   - times are ISO strings again, from the row's epoch milliseconds.
 *
 * WHAT IT CANNOT SAY. The model carries no blocker detail, question header or
 * failure code; no effort intent; no activity line for an agent (asked of the
 * lead, 2026-10-03). Those read as absent: a blocked body falls back to the
 * permission's tool, the question or the reply, and an effort reads as observed.
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

/** What both hosts name a terminal in no folder (`folderName(path, 'terminal')`). */
const TERMINAL_NAME = 'terminal';

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

function legacyBlockers(view: AgentView) {
  const wait = view.wait;
  if (!wait || !DRAWN_WAITS.has(wait.kind)) return Object.freeze([]);
  const since = isoTime(wait.since);
  const base = { kind: wait.kind, ...(since === undefined ? {} : { since }) };
  const blocker =
    wait.kind === 'permission'
      ? { ...base, ...(wait.tool ? { permission: Object.freeze({ tool: wait.tool }) } : {}) }
      : wait.kind === 'question'
        ? { ...base, questions: Object.freeze(wait.question ? [Object.freeze({ prompt: wait.question })] : []) }
        : base;
  return Object.freeze([Object.freeze(blocker)]);
}

function legacyFacet(view: AgentView) {
  const { cost, reply } = view;
  const statusSince = isoTime(view.statusSince);
  const replyAt = isoTime(reply?.at);
  const monitor = Object.freeze({
    ...(statusSince === undefined ? {} : { statusSince }),
    blockers: legacyBlockers(view),
    ...(reply
      ? {
          lastAssistantMessage: Object.freeze({
            text: reply.text,
            ...(replyAt === undefined ? {} : { at: replyAt }),
            ...(reply.final === undefined ? {} : { final: reply.final }),
          }),
        }
      : {}),
    ...(view.effort ? { effort: Object.freeze({ value: view.effort }) } : {}),
    usage: Object.freeze({
      ...(cost ? { costCoverage: cost.coverage } : {}),
      ...(cost?.burnPerHour === undefined ? {} : { costRatePerMin: cost.burnPerHour / 60 }),
    }),
  });
  return Object.freeze({
    provider: Object.freeze({ id: view.provider?.id ?? '', label: view.provider?.label ?? '' }),
    ...(view.model ? { model: view.model } : {}),
    ...(view.account ? { account: view.account } : {}),
    ...(view.project.branch ? { branch: view.project.branch } : {}),
    ...(view.context ? { contextWindow: Object.freeze({ usedPercent: view.context.usedPercent }) } : {}),
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
    monitor,
  });
}

function legacyAgent(view: AgentView): MonitorAgent {
  const agent = view.kind === 'agent';
  const fallback = agent ? (view.provider?.label ?? '') : TERMINAL_NAME;
  const legacy = Object.freeze({
    id: view.id,
    createdAtMs: view.createdAt,
    status: view.status,
    project: view.project.name || fallback,
    detail: view.detail,
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
      ? { session: Object.freeze({ activity: Object.freeze({ kind: view.activity }) }) }
      : {}),
    ...(agent ? { agent: legacyFacet(view) } : {}),
  });
  // The one widening (see the header): absent facts stay absent rather than invented.
  return legacy as unknown as MonitorAgent;
}

const agentsByView = new WeakMap<AgentView, MonitorAgent>();
const listsByModel = new WeakMap<MonitorModel, readonly MonitorAgent[]>();

/** The legacy row for one `AgentView`: the same object for as long as the view is. */
export function toMonitorAgent(view: AgentView): MonitorAgent {
  const held = agentsByView.get(view);
  if (held) return held;
  const legacy = legacyAgent(view);
  agentsByView.set(view, legacy);
  return legacy;
}

/** The legacy rows for a model, in its order: the same list for as long as the model is. */
export function toMonitorAgents(model: MonitorModel): readonly MonitorAgent[] {
  const held = listsByModel.get(model);
  if (held) return held;
  const list = Object.freeze(model.agents.map((view) => toMonitorAgent(view)));
  listsByModel.set(model, list);
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
