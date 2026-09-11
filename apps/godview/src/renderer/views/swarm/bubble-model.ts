import type { AgentVisualStatus } from '../../agent-status.js';
import type { MonitorAgent } from '../../monitor/types.js';
import { BURN_HOT, burnSeries, burnSides, type BurnSides } from './burn-series.js';
import { radiusForStatus, type SwarmParameters } from './swarm-parameters.js';
import type { CopyLine, TextStyle } from './text-layout.js';

// The complete, controller-free reading of one swarm body: which of the five
// drawn states it is in, how big it is, what it says, and which marks it
// carries. Physics, the GPU, accessibility copy, and any fixture all read this
// one projection, so they cannot develop four interpretations of the same row.
//
// The numbers are the decided swarm design (proposals record, pass 9): sizes by
// status, the unread dot before the name, model and effort always shown, the
// burn graph and the context ring on a working body, the outer light on a
// blocked one, and a hollow for a terminal no agent has claimed.

export type SwarmBodyState = 'terminal-empty' | 'terminal-running' | 'idle' | 'working' | 'blocked';

export interface SwarmFigure {
  text: string;
  hot: boolean;
  none: boolean;
}
export type SwarmBlockerKind = 'permission' | 'question' | 'failure';

export interface SwarmBubbleModel {
  id: string;
  state: SwarmBodyState;
  /** The three-way reading that picks the body's colours and size. */
  appearance: AgentVisualStatus;
  radius: number;
  /** §2.6 organizational accent (the pane's colour when mounted): the pane light, the flood, the centre light. */
  accent: string;
  copy: CopyLine[];
  copyMaxWidthRatio: number;
  /** The context figure on the top chord and the session's total tokens on the bottom one, working bodies only. */
  figures?: { top?: SwarmFigure; bottom?: SwarmFigure };
  /** The context ring on the rim in the ink, every agent body. */
  ring?: { percent: number; hot: boolean };
  /** The burn bars' two sides, forty intensities each, oldest first: output up, input down. */
  graph?: BurnSides;
  graphHot: boolean;
  /** Blocked: the accent floods the body from the centre. */
  flood: boolean;
  /** Transparent body with a rim: the unclaimed terminal. */
  hollow: boolean;
  /** The comet sweeping a hollow's rim: a foreground job. */
  running: boolean;
  unread: boolean;
  stale: boolean;
  active: boolean;
  /** The pane colour this session is mounted in, drawn as the outer light. */
  linked?: string;
  mirrors: readonly string[];
  /** The provider mark, watermarked behind the copy. */
  watermark?: { sprite: string; opacity: number };
  blockerKind?: SwarmBlockerKind;
  ariaLabel: string;
  title: string;
}

export interface BubbleModelInput {
  agent: MonitorAgent;
  parameters: SwarmParameters;
  nowMs: number;
  unread: boolean;
  /** When this terminal's foreground job was first seen, for the elapsed line. */
  runningSinceMs?: number;
  /** This working session's place among the working sessions by total tokens, 0 (the least) to 1 (the most). */
  workingShare?: number;
}

const TERMINAL_NAME: TextStyle = { size: 11, weight: 800, letterSpacing: -0.035 };
const SMALL_NAME: TextStyle = { size: 12, weight: 800, letterSpacing: -0.035 };
const WORKING_NAME: TextStyle = { size: 14, weight: 800, letterSpacing: -0.035 };
/** The small labels: 7px 800. The terminal's lines are uppercase; the model · effort
 * line is lowercase (2026-09-09), and italic while the effort is only launch intent. */
const LABEL_STACKED: TextStyle = { size: 7, weight: 800, transform: 'uppercase', letterSpacing: 0.1 };
const LABEL_INLINE: TextStyle = { size: 7, weight: 800, transform: 'lowercase', letterSpacing: 0.07 };
const LABEL_INLINE_ITALIC: TextStyle = { ...LABEL_INLINE, italic: true };
const COMMAND: TextStyle = { size: 8, weight: 600 };
const BRANCH: TextStyle = { size: 7, weight: 500 };
/** The latest reply, one line. */
const MESSAGE: TextStyle = { size: 8, weight: 500 };
const KIND: TextStyle = { size: 7, weight: 800, transform: 'uppercase', letterSpacing: 0.08 };

const BLOCKER_LINE: Record<SwarmBlockerKind, string> = {
  permission: 'permission',
  question: 'question',
  failure: 'failed',
};

/** Compact token counts: 820, 8.1k, 24k, 384k, 1.2M, 24M. */
export function formatTokens(count: number): string {
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Each working session's place among the working sessions by total tokens:
 * 0 for the least, 1 for the most, everything else in between; all 0 when
 * they tie or there is only one. Terminals without an agent do not count. */
export function workingShares(agents: readonly MonitorAgent[]): Map<string, number> {
  const totals: [string, number][] = [];
  for (const agent of agents) {
    if (agent.status !== 'working' || !agent.agent) continue;
    totals.push([agent.id, agent.agent.monitor.usage.cumulativeTokens ?? 0]);
  }
  const shares = new Map<string, number>();
  if (totals.length === 0) return shares;
  const values = totals.map(([, total]) => total);
  const least = Math.min(...values);
  const most = Math.max(...values);
  for (const [id, total] of totals) shares.set(id, most > least ? (total - least) / (most - least) : 0);
  return shares;
}

/** The first line of the root agent's latest reply, whitespace collapsed. */
function latestMessage(agent: MonitorAgent): string | undefined {
  const text = agent.agent?.monitor.lastAssistantMessage?.text;
  if (!text) return undefined;
  return text
    .split(/\r?\n/u)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .find((part) => part.length > 0);
}

function formatElapsed(sinceMs: number | undefined, nowMs: number): string | undefined {
  if (sinceMs === undefined) return undefined;
  const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${(minutes % 60).toString().padStart(2, '0')}m`;
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function effortLines(agent: MonitorAgent): { text: string; configured: boolean } | undefined {
  const effort = agent.agent?.monitor.effort;
  if (!effort?.value) return undefined;
  // Launch intent is set in italics so a reading never mistakes it for
  // provider evidence; an older producer that omits the intent is read as observed.
  return { text: effort.value, configured: effort.intent === 'configured' };
}

function contextPercent(agent: MonitorAgent): number | undefined {
  const usedPercent = agent.agent?.contextWindow?.usedPercent;
  return usedPercent === undefined || !Number.isFinite(usedPercent) ? undefined : Math.floor(usedPercent);
}

function blockerKind(agent: MonitorAgent): SwarmBlockerKind | undefined {
  const first = agent.agent?.monitor.blockers[0];
  return first?.kind;
}

function modelName(agent: MonitorAgent): string | undefined {
  const facet = agent.agent;
  return facet ? (facet.model ?? facet.provider.label) : undefined;
}

export function bubbleModel(input: BubbleModelInput): SwarmBubbleModel {
  const { agent, parameters, nowMs } = input;
  const facet = agent.agent;
  const percent = contextPercent(agent);
  const contextLabel = percent === undefined ? 'CTX:--%' : `CTX:${percent.toString().padStart(2, '0')}%`;
  const linked = agent.attachment?.primary;
  const mirrors = agent.attachment?.mirrors ?? [];
  const base = {
    id: agent.id,
    accent: linked ?? agent.color,
    mirrors,
    stale: agent.stale === true,
    active: agent.active,
    ...(linked ? { linked } : {}),
  };

  if (!facet) {
    const running = agent.status === 'working';
    const elapsed = running ? formatElapsed(input.runningSinceMs, nowMs) : undefined;
    const copy: CopyLine[] = [
      {
        key: 'folder',
        text: '',
        style: TERMINAL_NAME,
        opacity: 0.6,
        tone: 'ink',
        lead: { kind: 'icon', icon: 'folder', size: 14, gap: 0 },
      },
      { key: 'name', text: agent.project, style: TERMINAL_NAME, opacity: 1, tone: 'ink', gapBefore: 3 },
      running
        ? { key: 'command', text: 'running', style: COMMAND, opacity: 0.85, tone: 'ink', gapBefore: 3 }
        : { key: 'sub', text: 'empty', style: LABEL_STACKED, opacity: 0.55, tone: 'ink', gapBefore: 3 },
      ...(elapsed
        ? [{ key: 'elapsed', text: elapsed, style: LABEL_STACKED, opacity: 0.55, tone: 'ink' as const, gapBefore: 3 }]
        : []),
    ];
    return {
      ...base,
      state: running ? 'terminal-running' : 'terminal-empty',
      appearance: 'idle',
      radius: radiusForStatus(parameters, 'idle'),
      copy,
      copyMaxWidthRatio: 0.9,
      graphHot: false,
      flood: false,
      hollow: true,
      running,
      unread: false,
      ariaLabel: `${agent.project}, unassigned terminal, ${agent.status}`,
      title: agent.detail,
    };
  }

  const appearance: AgentVisualStatus = agent.status;
  // A working body grows with its share of the working sessions' tokens, from
  // the working size for the least to the largest size for the most.
  const share = Math.max(0, Math.min(1, input.workingShare ?? 0));
  const radius =
    appearance === 'working'
      ? parameters.radiusWorking + (parameters.radiusWorkingMax - parameters.radiusWorking) * share
      : radiusForStatus(parameters, appearance);
  const model = modelName(agent) ?? facet.provider.label;
  const effort = effortLines(agent);
  const ring = percent === undefined ? undefined : { percent: Math.max(0, Math.min(100, percent)), hot: percent >= 80 };
  const ariaLabel = `${agent.project}, ${model}, ${agent.status}: ${agent.detail}, ${contextLabel}`;
  const title = `${agent.project} · ${model} · ${agent.detail}`;
  const modelLine: CopyLine = {
    key: 'model',
    text: effort ? `${model} · ${effort.text}` : model,
    style: effort?.configured ? LABEL_INLINE_ITALIC : LABEL_INLINE,
    opacity: 0.58,
    tone: 'ink',
    gapBefore: 3,
  };
  const message = latestMessage(agent);

  if (appearance === 'working') {
    const burnInput = {
      samples: facet.monitor.usage.samples,
      nowMs,
      ...(facet.monitor.usage.burnRatePerMin === undefined
        ? {}
        : { burnRatePerMin: facet.monitor.usage.burnRatePerMin }),
    };
    const series = burnSeries(burnInput);
    const total = facet.monitor.usage.cumulativeTokens;
    const hot = (series[series.length - 1] ?? 0) >= BURN_HOT;
    const copy: CopyLine[] = [
      ...(facet.branch
        ? [
            {
              key: 'branch',
              text: facet.branch,
              style: BRANCH,
              opacity: 0.67,
              tone: 'ink' as const,
              lead: { kind: 'dot' as const, size: 5, gap: 4, tone: 'green' as const },
            },
          ]
        : []),
      {
        key: 'name',
        text: agent.project,
        style: WORKING_NAME,
        opacity: 1,
        tone: 'ink',
        ...(facet.branch ? { gapBefore: 1 } : {}),
      },
      modelLine,
    ];
    return {
      ...base,
      state: 'working',
      appearance,
      radius,
      copy,
      copyMaxWidthRatio: 0.8,
      figures: {
        top: {
          text: percent === undefined ? '--' : `${percent}%`,
          hot: percent !== undefined && percent >= 80,
          none: percent === undefined,
        },
        bottom: { text: total === undefined ? '--' : formatTokens(total), hot: false, none: total === undefined },
      },
      ...(ring ? { ring } : {}),
      graph: burnSides(burnInput),
      graphHot: hot,
      flood: false,
      hollow: false,
      running: false,
      unread: input.unread,
      watermark: { sprite: facet.provider.id, opacity: 0.16 },
      ariaLabel,
      title,
    };
  }

  const kind = appearance === 'blocked' ? blockerKind(agent) : undefined;
  // The latest reply, one line, led by a dot: orange for a body that waits on
  // the user, blue for a reply the user has not looked at. Without a reply the
  // blocked body names its blocker instead.
  const reply = (tone: 'orange' | 'blue', text: string): CopyLine => ({
    key: 'message',
    text,
    style: MESSAGE,
    opacity: 0.85,
    tone: 'ink',
    gapBefore: 3,
    lineHeight: 1.2,
    lead: { kind: 'dot', size: 5, gap: 4, tone },
  });
  const messageLine: CopyLine[] =
    appearance === 'blocked'
      ? [
          message
            ? reply('orange', message)
            : {
                key: 'kind',
                text: kind ? BLOCKER_LINE[kind] : 'blocked',
                style: KIND,
                opacity: 1,
                tone: 'orange',
                gapBefore: 3,
              },
        ]
      : input.unread && message
        ? [reply('blue', message)]
        : [];
  const copy: CopyLine[] = [
    {
      key: 'name',
      text: agent.project,
      style: SMALL_NAME,
      opacity: 1,
      tone: 'ink',
      ...(input.unread && !message ? { lead: { kind: 'dot' as const, size: 5, gap: 4, tone: 'blue' as const } } : {}),
    },
    modelLine,
    ...messageLine,
  ];
  return {
    ...base,
    state: appearance,
    appearance,
    radius,
    copy,
    copyMaxWidthRatio: 0.84,
    ...(ring ? { ring } : {}),
    graphHot: false,
    flood: appearance === 'blocked',
    hollow: false,
    running: false,
    unread: input.unread,
    watermark: { sprite: facet.provider.id, opacity: appearance === 'blocked' ? 0.12 : 0.055 },
    ...(kind ? { blockerKind: kind } : {}),
    ariaLabel,
    title,
  };
}
