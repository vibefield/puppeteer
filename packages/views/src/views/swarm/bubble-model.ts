import type { AgentStatus, AgentView, MonitorWait } from '@vibecook/puppeteer-view-sdk';
import {
  detailLine,
  formatElapsed,
  formatEstimate,
  formatRatePerHour,
  hostWriteTitle,
  hostWriteWord,
  modelWord,
  openingWord,
  profileMarkName,
  projectName,
  STATE_WORDS,
  unreadSpoken,
  waitBodyLine,
  waitMark,
  waitWord,
} from '@vibecook/puppeteer-view-sdk/toolkit';
import { bodyIdOf } from './body-id.js';
import { radiusForStatus, type SwarmParameters } from './swarm-parameters.js';
import type { CopyLead, CopyLine, CopyTone, TextStyle } from './text-layout.js';
import { SWARM_WEIGHT } from './weight.js';

// The complete, controller-free reading of one swarm body: which of the five
// drawn states it is in, how big it is, what it says, and which marks it
// carries. Physics, the GPU, accessibility copy, and any fixture all read this
// one projection, so they cannot develop four interpretations of the same row.
//
// The numbers are the decided swarm design (proposals record, pass 9): sizes by
// status, the unread dot before the name, model and effort always shown, the
// burn ladder and the context ring on a working body, the outer light on a
// blocked one, and a hollow for a terminal no agent has claimed.
//
// On the SDK (MV-5) a body reads `AgentView` and nothing else: the backend's
// facts as the row carries them, and the toolkit's words for them — the line
// under the name by its one rule (M4, reply-first), a wait in the swarm body's
// own order (M14), a peer's host and write policy (M41). Every row's facts are
// drawn alike, a peer's included (M9).

export type SwarmBodyState = 'terminal-empty' | 'terminal-running' | 'idle' | 'working' | 'blocked';

/**
 * How long a birth on its way reads `empty` and holds still before it says it
 * is opening and its dashes turn: a wait drawn inside 320 ms shows no indicator
 * at all (DESIGN §8, QL-2), so a fast birth never flashes one.
 */
export const OPENING_QUIET_MS = 320;

/** The colour of the light inside a body, which is the STATE's and never the
 * project's (2026-09-16): the theme's own ink while working, orange while
 * blocked, blue for a reply that arrived unseen. One light, three colours — a
 * flood in the state's colour would leave the state's own words nowhere to sit. */
export type SwarmLightTone = 'ink' | 'orange' | 'blue';

/**
 * The burn ladder (2026-09-17): estimated USD per minute, about three times the
 * spend per step, so the four flames are even steps on a log scale. Absolute, not
 * relative to the swarm, so one body's reading means the same as another's — the
 * chart it replaces was scaled to its own tallest column and could only say
 * "busier than it was", never "hot".
 */
export const BURN_LADDER: readonly number[] = [0.05, 0.15, 0.4, 1];

/** How many of the four flames a rate lights. */
export function burnFlames(costPerMin: number): number {
  let lit = 0;
  for (const step of BURN_LADDER) if (costPerMin >= step) lit += 1;
  return lit;
}

export interface SwarmBurn {
  /** 0–4 against the ladder. Zero with a price is a calm session. */
  lit: number;
  /** False where the provider has no pricing lane: the ladder is drawn unread,
   * never as calm (RFC 008 — a missing lane is unavailable, not zero dollars). */
  priced: boolean;
}

export interface SwarmFigure {
  text: string;
  hot: boolean;
  none: boolean;
}
export type SwarmBlockerKind = 'permission' | 'question' | 'failure';

export interface SwarmBubbleModel {
  /** Spatial body identity: render order and pointer gestures address physics with this. */
  id: string;
  state: SwarmBodyState;
  /** The three-way reading that picks the body's colours and size. */
  appearance: AgentStatus;
  radius: number;
  /** The project's colour (record §02). It shows in ONE place: the folder before
   * the project's name. Nothing else on the body wears it (2026-09-16). */
  accent: string;
  copy: CopyLine[];
  copyMaxWidthRatio: number;
  /** Context on the top chord and observed estimated USD on the bottom, working bodies only. */
  figures?: { top?: SwarmFigure; bottom?: SwarmFigure };
  /** The context ring on the rim in the ink, every agent body. */
  ring?: { percent: number; hot: boolean };
  /** How hard this session is burning, as a count on the fixed ladder. Working bodies only. */
  burn?: SwarmBurn;
  /** The light inside the body, in the state's colour. */
  light?: SwarmLightTone;
  /** Transparent body with a rim: the unclaimed terminal. */
  hollow: boolean;
  /** A birth on its way (the spawn bloom's pending body): hollow and dashed like
   * an empty terminal, its rim heavier; `turning` once it has waited past
   * `OPENING_QUIET_MS`, when its dashes turn on the renderer's own clock. */
  pending?: { turning: boolean };
  /** The comet sweeping a hollow's rim: a foreground job. */
  running: boolean;
  unread: boolean;
  stale: boolean;
  active: boolean;
  /** A mounted body's band, in the colour of the pane it is worked in (revised 2026-09-12: a pane owns its
   * colour); the outer light joins it only while `active`, that is, while its pane is the selected one. */
  linked?: string;
  /** The provider mark, watermarked behind the copy. */
  watermark?: { sprite: string; opacity: number };
  blockerKind?: SwarmBlockerKind;
  ariaLabel: string;
  title: string;
}

export interface BubbleModelInput {
  agent: AgentView;
  parameters: SwarmParameters;
  nowMs: number;
  unread: boolean;
  /** When this terminal's foreground job was first seen, for the elapsed line. */
  runningSinceMs?: number;
  /** This session's place among working sessions by estimated USD, 0 (least) to 1 (most). */
  workingShare?: number;
  /** The Agent Profile a terminal's shell was born under, when naming it tells
   * the person something (the desktop has more than one): one line in the
   * terminal's label style, the profile's glyph and name (SB §2.10), after the
   * empty or running line and before a peer's host line. The glyph is the
   * laptop for the native set, and drawn filled for the desktop's default. */
  profile?:
    | {
        label: string;
        glyph?: string | undefined;
        kind?: 'native' | 'managed' | undefined;
        isDefault?: boolean | undefined;
      }
    | undefined;
  /** A birth on its way (the spawn bloom's pending body, SB §2.6): drawn hollow
   * where the person let go until the host's row arrives. For its first
   * `OPENING_QUIET_MS` it reads EMPTY and holds still; then its dashes turn and
   * it reads OPENING (`on` names a peer: OPENING ON MINI). `nowMs − sinceMs`
   * decides, so a host rebuilds this one model as the quiet runs out. A
   * terminal's row only: an agent's row ignores it. */
  opening?: { sinceMs: number; on?: string | undefined } | undefined;
  /** The crowd's shared fit (`fit.ts`, SWF): the radius is the base size times this. 1, or absent, is the base. */
  scale?: number | undefined;
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
/** The project's name once the state has taken its place above it. */
const PROJECT_ABOVE: TextStyle = { size: 7.5, weight: 800, letterSpacing: 0.02 };
/** What the body waits on, in the name's place: a sentence, not a label, so it is
 * set lighter than a name and a size under it to hold as many of its words as
 * the chord allows. */
const STATE_LINE: TextStyle = { size: 9, weight: 600, letterSpacing: -0.02 };

/**
 * The copy ladder's order (SWF, James 2026-10-13: "the words step down as
 * bodies shrink: full → name + tool → name only"): which line leaves a body
 * first when its circle cannot hold them all (`ladderCopy`). The name is not
 * here: it is who the body is, and it stays down to the floor. The rest go in
 * the order the rest of the body already says them:
 *
 * - the branch first: a detail of where the work is, and the one line set
 *   above the name;
 * - a terminal's clock and its profile next: the job's age and the profile it
 *   was born under say how, not what;
 * - the model line: the watermark beside it already names the provider;
 * - a terminal's empty / running: its rim says that again, with dashes or the
 *   comet;
 * - a peer's host after that: nothing else on the body says it is another
 *   desktop's (M41);
 * - the state line last: what a blocked body waits on, or the reply an unread
 *   one brought. It is the "tool" of "name + tool", the line no other mark can
 *   say.
 */
export const COPY_LADDER: readonly string[] = [
  'branch',
  'elapsed',
  'profile',
  'model',
  'command',
  'sub',
  'host',
  'state',
];

/**
 * The project's folder before its name, in the project's colour: the one place
 * that colour is used. Drawn a little larger than the type so its 24-box ink
 * stands at about the name's cap height, with its advance narrowed to the ink it
 * actually covers.
 *
 * Where a state line has displaced the name, the folder turns SOLID and keeps
 * its full strength while the name steps back to a supporting rung: the project
 * is still which agent this is, but its name is no longer what the body is
 * telling you (2026-09-18).
 */
function projectFolder(style: TextStyle, options: { solid?: boolean; tone?: CopyTone } = {}): CopyLead {
  const size = Math.round(style.size * (options.solid ? 1.3 : 1.15));
  return {
    kind: 'icon',
    icon: options.solid ? 'folder-solid' : 'folder',
    size,
    width: Math.round(size * 0.75),
    gap: 4,
    tone: options.tone ?? 'accent',
    ...(options.solid ? { opacity: SWARM_WEIGHT.title } : {}),
  };
}

/** The atlas's name for a profile's mark: `profile:<mark>`, `:filled` for the desktop's default. */
export function profileIcon(profile: NonNullable<BubbleModelInput['profile']>): string {
  return `profile:${profileMarkName(profile.glyph, profile.kind)}${profile.isDefault ? ':filled' : ''}`;
}

/**
 * The profile a terminal was born under, in the terminal's own label style: its
 * glyph leads, as the folder leads the name, drawn at one and a half times the
 * line's size with a 3 px gap (the prototype's `lead = size × 1.5 + 3`).
 */
function profileLine(profile: NonNullable<BubbleModelInput['profile']>): CopyLine {
  return {
    key: 'profile',
    text: profile.label,
    style: LABEL_STACKED,
    opacity: SWARM_WEIGHT.supporting,
    tone: 'ink',
    gapBefore: 3,
    lead: { kind: 'icon', icon: profileIcon(profile), size: LABEL_STACKED.size * 1.5, gap: 3 },
  };
}

/** The views draw these waits; another word in the row's wait is none to them (the shim's rule, kept). */
const DRAWN_WAITS: ReadonlySet<string> = new Set<SwarmBlockerKind>(['permission', 'question', 'failure']);

/**
 * A fact the runtime has reported. Before a run's first state (starting, or
 * pending) it has no live facts to draw — the seam drew such a run from its
 * host record alone — so its reply, effort, wait and cost are read only once
 * the backend says it is observed.
 */
function observed<T>(agent: AgentView, fact: T | undefined): T | undefined {
  return agent.observed ? fact : undefined;
}

function drawnWait(agent: AgentView): (MonitorWait & { readonly kind: SwarmBlockerKind }) | undefined {
  const wait = observed(agent, agent.wait);
  return wait && DRAWN_WAITS.has(wait.kind) ? (wait as MonitorWait & { readonly kind: SwarmBlockerKind }) : undefined;
}

/** Observed, priced USD: none where nothing was priced (RFC 008: a missing lane is unavailable, never zero). */
function costTotal(agent: AgentView): number | undefined {
  const cost = observed(agent, agent.cost);
  return cost && cost.coverage !== 'unavailable' ? cost.usd : undefined;
}

/**
 * The per-minute rate the backend's per-hour burn was multiplied from, for the
 * ladder: dividing back can land an ulp away, and fifteen significant digits
 * restore it (M27), so the flames light exactly where they lit.
 */
function perMinute(burnPerHour: number): number {
  return Number((burnPerHour / 60).toPrecision(15));
}

/** Each working session's place among the working sessions by estimated USD:
 * 0 for the least, 1 for the most, everything else in between; all 0 when
 * they tie or there is only one. Terminals without an agent do not count. */
export function workingShares(agents: readonly AgentView[]): Map<string, number> {
  const totals: [string, number][] = [];
  for (const agent of agents) {
    if (agent.status !== 'working' || agent.kind !== 'agent') continue;
    totals.push([agent.id, costTotal(agent) ?? 0]);
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
function latestMessage(agent: AgentView): string | undefined {
  const text = observed(agent, agent.reply)?.text;
  if (!text) return undefined;
  return text
    .split(/\r?\n/u)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .find((part) => part.length > 0);
}

function effortLines(agent: AgentView): { text: string; configured: boolean } | undefined {
  const effort = observed(agent, agent.effort);
  if (!effort?.value) return undefined;
  // Launch intent is set in italics so a reading never mistakes it for
  // provider evidence; an older producer that omits the intent is read as observed.
  return { text: effort.value, configured: effort.intent === 'configured' };
}

function contextPercent(agent: AgentView): number | undefined {
  const usedPercent = agent.kind === 'agent' ? agent.context?.usedPercent : undefined;
  return usedPercent === undefined || !Number.isFinite(usedPercent) ? undefined : Math.floor(usedPercent);
}

/**
 * A body's size with room to spare, before the crowd's fit scales it: a
 * terminal at the idle size, a working agent from the working size for the
 * least of the working sessions' estimated USD to the largest size for the
 * most, the rest by status.
 */
export function baseRadius(
  agent: AgentView,
  parameters: Pick<SwarmParameters, 'radiusIdle' | 'radiusWorking' | 'radiusWorkingMax' | 'radiusBlocked'>,
  workingShare = 0,
): number {
  if (agent.kind !== 'agent') return radiusForStatus(parameters, 'idle');
  if (agent.status !== 'working') return radiusForStatus(parameters, agent.status);
  const share = Math.max(0, Math.min(1, workingShare));
  return parameters.radiusWorking + (parameters.radiusWorkingMax - parameters.radiusWorking) * share;
}

export function bubbleModel(input: BubbleModelInput): SwarmBubbleModel {
  const { agent, parameters, nowMs } = input;
  /** The crowd's shared fit (`fit.ts`): every body is its base size times this. */
  const scale = input.scale ?? 1;
  const project = projectName(agent);
  const percent = contextPercent(agent);
  const contextLabel = percent === undefined ? 'CTX:--%' : `CTX:${percent.toString().padStart(2, '0')}%`;
  const base = {
    id: bodyIdOf(agent),
    accent: agent.colour,
    stale: agent.stale,
    active: agent.active,
    ...(agent.attachment?.colour ? { linked: agent.attachment.colour } : {}),
  };

  if (agent.kind !== 'agent') {
    // A row from another desktop wears its host on the body (M41's write policy, said in both directions).
    const remote = agent.device.self ? undefined : agent.device;
    // A birth on its way is a terminal with no job yet, whatever its row says.
    const opening = input.opening;
    const running = !opening && agent.status === 'working';
    const elapsed =
      running && input.runningSinceMs !== undefined
        ? formatElapsed(nowMs - input.runningSinceMs, { days: false })
        : undefined;
    // It reads `empty` and holds still at first; past the quiet it says it is
    // opening, and where (a peer's name), and its dashes turn.
    const turning = opening !== undefined && nowMs - opening.sinceMs >= OPENING_QUIET_MS;
    const sub = opening && turning ? openingWord(opening.on) : STATE_WORDS.terminal.empty;
    const copy: CopyLine[] = [
      // One line, the folder then the name, as every other body reads. A terminal
      // belongs to no project, so its folder wears the ink rather than a colour.
      {
        key: 'name',
        text: project,
        style: TERMINAL_NAME,
        opacity: SWARM_WEIGHT.title,
        tone: 'ink',
        lead: projectFolder(TERMINAL_NAME, { tone: 'ink' }),
      },
      running
        ? {
            key: 'command',
            text: STATE_WORDS.terminal.running,
            style: COMMAND,
            opacity: SWARM_WEIGHT.supporting,
            tone: 'ink',
            gapBefore: 3,
          }
        : {
            key: 'sub',
            text: sub,
            style: LABEL_STACKED,
            opacity: SWARM_WEIGHT.supporting,
            tone: 'ink',
            gapBefore: 3,
          },
      ...(elapsed
        ? [
            {
              key: 'elapsed',
              text: elapsed,
              style: LABEL_STACKED,
              opacity: SWARM_WEIGHT.supporting,
              tone: 'ink' as const,
              gapBefore: 3,
            },
          ]
        : []),
      ...(input.profile ? [profileLine(input.profile)] : []),
      // A peer's session wears its host on the body — the name and the
      // host's write policy, in both directions — so it cannot be read as
      // one of this machine's terminals (the toolkit's `hostWriteWord`).
      ...(remote
        ? [
            {
              key: 'host',
              text: `${remote.name} · ${hostWriteWord(agent)}`,
              style: LABEL_STACKED,
              opacity: SWARM_WEIGHT.supporting,
              tone: 'ink' as const,
              gapBefore: 3,
            },
          ]
        : []),
    ];
    return {
      ...base,
      state: running ? 'terminal-running' : 'terminal-empty',
      appearance: 'idle',
      radius: baseRadius(agent, parameters) * scale,
      copy,
      copyMaxWidthRatio: 0.9,
      hollow: true,
      running,
      unread: false,
      ...(opening ? { pending: { turning } } : {}),
      ariaLabel:
        (opening
          ? `${project}, new terminal, opening${opening.on ? ` on ${opening.on}` : ''}`
          : remote
            ? `on ${remote.name}, ${project}, remote session, ${agent.status}, ${hostWriteWord(agent)}`
            : `${project}, unassigned terminal, ${agent.status}`) +
        (input.profile ? `, under ${input.profile.label}` : ''),
      title: remote ? `${remote.name} · ${hostWriteTitle(agent)} · ${agent.detail}` : agent.detail,
    };
  }

  const appearance: AgentStatus = agent.status;
  // A working body grows with its share of the working sessions' estimated USD, and the crowd's fit scales it.
  const radius = baseRadius(agent, parameters, input.workingShare) * scale;
  const model = modelWord(agent);
  const effort = effortLines(agent);
  const ring = percent === undefined ? undefined : { percent: Math.max(0, Math.min(100, percent)), hot: percent >= 80 };
  // The line under the name, by the toolkit's one rule (M4).
  const detail = detailLine(agent);
  const ariaLabel = `${project}, ${model}, ${agent.status}: ${detail}, ${contextLabel}`;
  const title = `${project} · ${model} · ${detail}`;
  const modelLine: CopyLine = {
    key: 'model',
    text: effort ? `${model} · ${effort.text}` : model,
    style: effort?.configured ? LABEL_INLINE_ITALIC : LABEL_INLINE,
    opacity: SWARM_WEIGHT.supporting,
    tone: 'ink',
    gapBefore: 3,
  };
  const message = latestMessage(agent);
  const branch = agent.project.branch;

  if (appearance === 'working') {
    // The total is the backend's ledger: corrected USD across a bubble's runs,
    // cached ones included. The RATE is Core's own live projection over its
    // rate-eligible window — never a difference of snapshots, which a
    // correction could otherwise turn into new spend.
    const cost = observed(agent, agent.cost);
    const total = costTotal(agent);
    const priced = cost?.coverage === 'complete' || cost?.coverage === 'partial';
    const perHour = priced ? (cost.burnPerHour ?? 0) : undefined;
    const copy: CopyLine[] = [
      ...(branch
        ? [
            {
              key: 'branch',
              text: branch,
              style: BRANCH,
              opacity: SWARM_WEIGHT.supporting,
              tone: 'ink' as const,
              lead: { kind: 'dot' as const, size: 5, gap: 4, tone: 'green' as const },
            },
          ]
        : []),
      {
        key: 'name',
        text: project,
        style: WORKING_NAME,
        opacity: SWARM_WEIGHT.title,
        tone: 'ink',
        lead: projectFolder(WORKING_NAME),
        ...(branch ? { gapBefore: 1 } : {}),
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
        bottom: {
          text: formatEstimate(cost),
          hot: false,
          none: total === undefined,
        },
      },
      ...(ring ? { ring } : {}),
      burn: { lit: perHour === undefined ? 0 : burnFlames(perMinute(perHour)), priced },
      light: 'ink',
      hollow: false,
      running: false,
      unread: input.unread,
      watermark: { sprite: agent.provider?.id ?? '', opacity: SWARM_WEIGHT.watermark },
      // The flames are the glance; the exact rate is a word away, for a pointer
      // and for a screen reader.
      ariaLabel: `${ariaLabel}, burning ${formatRatePerHour(perHour)}`,
      title: `${title} · ${formatRatePerHour(perHour)}`,
    };
  }

  const wait = appearance === 'blocked' ? drawnWait(agent) : undefined;
  // What the body needs from the user takes the name's place, in its own words
  // behind its own mark: what a blocker is waiting on (the swarm body's order,
  // M14), or the reply that arrived unseen. The project's name moves above it,
  // and nothing follows the model line (2026-09-16). The state's COLOUR is the
  // body's ground rather than its words, so those words stay the theme's ink
  // like every other body's (2026-09-18).
  const state: { text: string; icon: string; spoken: string } | undefined = wait
    ? {
        text: waitBodyLine(wait, message),
        icon: waitMark(wait.kind),
        spoken: `${waitWord(wait.kind)}: ${waitBodyLine(wait, message)}`,
      }
    : appearance === 'blocked'
      ? {
          text: message ?? STATE_WORDS.status.blocked,
          icon: 'failure',
          spoken: message ?? STATE_WORDS.status.blocked,
        }
      : input.unread
        ? {
            text: message ?? STATE_WORDS.unread.line,
            icon: 'message',
            spoken: unreadSpoken(message),
          }
        : undefined;
  const nameStyle = state ? PROJECT_ABOVE : SMALL_NAME;
  const copy: CopyLine[] = [
    {
      key: 'name',
      text: project,
      style: nameStyle,
      opacity: state ? SWARM_WEIGHT.supporting : SWARM_WEIGHT.title,
      tone: 'ink',
      lead: projectFolder(nameStyle, state ? { solid: true } : {}),
    },
    ...(state
      ? [
          {
            key: 'state',
            text: state.text,
            style: STATE_LINE,
            opacity: SWARM_WEIGHT.title,
            // The state's colour is the body's own ground now, so its words and
            // its mark are the theme's ink, like every other body's (2026-09-18).
            tone: 'ink' as const,
            gapBefore: 2,
            lineHeight: 1.15,
            lead: { kind: 'icon' as const, icon: state.icon, size: 11, width: 8, gap: 3 },
          },
        ]
      : []),
    modelLine,
  ];
  return {
    ...base,
    state: appearance,
    appearance,
    radius,
    copy,
    // The state line is the widest thing a small body carries; it gets a little
    // more of the chord than a name would.
    copyMaxWidthRatio: state ? 0.86 : 0.84,
    ...(ring ? { ring } : {}),
    ...(appearance === 'blocked' ? { light: 'orange' as const } : input.unread ? { light: 'blue' as const } : {}),
    hollow: false,
    running: false,
    unread: input.unread,
    watermark: { sprite: agent.provider?.id ?? '', opacity: SWARM_WEIGHT.watermark },
    ...(wait ? { blockerKind: wait.kind } : {}),
    ariaLabel: state ? `${ariaLabel}, ${state.spoken}` : ariaLabel,
    title,
  };
}
