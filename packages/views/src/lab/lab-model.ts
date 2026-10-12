import { presentAgentMonitorHeadline } from '@vibefield/puppeteer-core';
import type {
  AgentView,
  MonitorCost,
  MonitorDeviceRef,
  MonitorModel,
  MonitorWait,
} from '@vibefield/puppeteer-view-sdk';
import type { MonitorAgent } from '../monitor/types.js';
import type { LabAgent } from '../views/swarm/lab/fixtures.js';
import { labWorld, type LabWorldOptions } from './lab-world.js';

// The seeded world as the SDK's model (MV-4): the same rows `labWorld` draws,
// said as `AgentView`, so a ported view's lab and goldens draw exactly the
// world its legacy lab drew. It was proved fact for fact against the world
// through the legacy shim until MV-8 deleted the shim; `lab-model.test.ts` now
// pins the model byte for byte, and the goldens recorded on it witness what it
// draws.
//
// Each fact is the backend's word for what the world's row says: the line
// under the name is Core's headline (M4), the cost is the fixture's total
// (what the backend's ledger would hold) with its burn by the hour, a wait is
// the first blocker's parts, and a peer's row is on its own desktop with its
// host's write policy (M41). The order is the
// world's own (agents, peers, bare terminals), because a view that places
// columns by order (the rain) must meet the rows in the order its legacy lab
// met them.

/** The desktop the lab's world is read on. */
export const LAB_DEVICE: MonitorDeviceRef = Object.freeze({ id: 'lab', name: 'lab', os: 'mac', self: true });

const parse = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

function labWait(agent: MonitorAgent): MonitorWait | undefined {
  const monitor = agent.agent?.monitor;
  const blocker = monitor?.blockers[0];
  if (!monitor || !blocker) return undefined;
  const count = presentAgentMonitorHeadline(monitor).blockerCount;
  const question = blocker.kind === 'question' ? blocker.questions?.[0] : undefined;
  return {
    kind: blocker.kind,
    since: parse(blocker.since) ?? agent.createdAtMs,
    ...(count > 1 ? { count } : {}),
    ...(blocker.kind === 'permission' && blocker.permission?.tool ? { tool: blocker.permission.tool } : {}),
    ...(blocker.kind === 'failure' && blocker.failure?.code ? { code: blocker.failure.code } : {}),
    ...(question?.header === undefined ? {} : { header: question.header }),
    ...(question?.prompt === undefined ? {} : { question: question.prompt }),
    ...(blocker.detail === undefined ? {} : { detail: blocker.detail }),
  };
}

function labCost(agent: LabAgent, nowMs: number): MonitorCost | undefined {
  const facet = agent.agent;
  const usage = facet?.monitor?.usage;
  if (!facet?.monitor || !usage) return undefined;
  const total = facet.usage?.total ?? usage.costUsd;
  const burnPerHour = usage.costRatePerMin === undefined ? undefined : usage.costRatePerMin * 60;
  if (total === undefined && burnPerHour === undefined) return undefined;
  const steps = facet.usage?.steps;
  return {
    usd: total ?? 0,
    coverage: total === undefined ? 'unavailable' : (usage.costCoverage ?? 'complete'),
    ...(burnPerHour === undefined ? {} : { burnPerHour }),
    ...(steps ? { series: { stepMs: facet.usage!.stepMs, steps, lastStepAt: nowMs } } : {}),
  };
}

/** One of the world's rows as the backend and this window's replica would hand it to a view. */
export function labAgentView(agent: LabAgent, nowMs: number): AgentView {
  const facet = agent.agent;
  const monitor = facet?.monitor;
  const remote = agent.remote;
  const wait = labWait(agent);
  const cost = labCost(agent, nowMs);
  const reply = monitor?.lastAssistantMessage;
  const replyAt = parse(reply?.at);
  const activity = facet ? monitor?.activity : agent.session?.activity;
  const activitySince = facet ? parse(monitor?.activity?.since) : undefined;
  const tokens = monitor?.usage.cumulativeTokens;
  return {
    id: agent.id,
    kind: facet ? 'agent' : 'terminal',
    createdAt: agent.createdAtMs,
    status: agent.status,
    statusSince: parse(monitor?.statusSince) ?? agent.createdAtMs,
    stale: agent.stale === true,
    alive: true,
    observed: facet ? monitor !== undefined : true,
    // A run not heard from says the backend's word for it, as the world's row does; a terminal its directory.
    detail: monitor ? presentAgentMonitorHeadline(monitor).detail : agent.detail,
    ...(activity
      ? {
          activity: {
            kind: activity.kind,
            ...(facet && monitor?.activity?.line !== undefined ? { line: monitor.activity.line } : {}),
            ...(activitySince === undefined ? {} : { since: activitySince }),
          },
        }
      : {}),
    project: { name: agent.project, ...(facet?.branch ? { branch: facet.branch } : {}) },
    ...(facet ? { provider: { id: facet.provider.id, label: facet.provider.label } } : {}),
    ...(facet?.model ? { model: facet.model } : {}),
    ...(monitor?.effort
      ? {
          effort: {
            value: monitor.effort.value,
            ...(monitor.effort.intent === undefined ? {} : { intent: monitor.effort.intent }),
          },
        }
      : {}),
    ...(facet?.account ? { account: facet.account } : {}),
    ...(facet?.contextWindow?.usedPercent === undefined
      ? {}
      : { context: { usedPercent: facet.contextWindow.usedPercent } }),
    ...(wait ? { wait } : {}),
    ...(reply
      ? {
          reply: {
            text: reply.text,
            ...(replyAt === undefined ? {} : { at: replyAt }),
            ...(reply.final === undefined ? {} : { final: reply.final }),
          },
        }
      : {}),
    ...(cost ? { cost } : {}),
    ...(tokens === undefined ? {} : { tokens: { total: tokens } }),
    unread: agent.unread === true,
    device: remote ? { id: remote.deviceId, name: remote.deviceName, self: false } : LAB_DEVICE,
    ...(agent.tier ? { tier: agent.tier } : {}),
    ...(agent.profileSet === undefined ? {} : { profileSet: agent.profileSet }),
    attachable: remote ? remote.attachable : true,
    writable: remote ? remote.hostWritable : true,
    colour: agent.color,
    active: agent.active,
    receded: agent.receded === true,
    ...(agent.attachment
      ? {
          attachment: {
            panes: agent.attachment.paneIds.length,
            ...(agent.attachment.color === undefined ? {} : { colour: agent.attachment.color }),
          },
        }
      : {}),
    ...(agent.spawnHint ? { spawnHint: agent.spawnHint } : {}),
  };
}

/** The world at `options` as a model, in the world's own order. */
export function labModel(options: LabWorldOptions): MonitorModel {
  const world = labWorld(options);
  const agents = world.agents.map((agent) => labAgentView(agent, world.nowMs));
  return { revision: 1, agents, byId: new Map(agents.map((agent) => [agent.id, agent])) };
}
