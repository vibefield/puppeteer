// The spawn bloom's one table of numbers (thinking-spawn-bloom §2; the
// prototype's `SB.BLOOM`, draft/spawn-bloom/bloom.js). Every value was audited
// with the prototype over ~800 hold points in every scenario; they are ported
// as they are, never tuned here. Lengths are CSS px, angles degrees, times ms.

export const BLOOM = {
  /** The hold, unchanged: AgentSwarm's LONG_PRESS_DURATION_MS. */
  holdMs: 520,
  /** Moving further than this before the hold completes cancels it (LONG_PRESS_MOVE_TOLERANCE). */
  holdSlop: 8,
  /** The hub: the hold ring's own final radius (field.wgsl), kept on screen. */
  hubR: 16,
  /** Letting go inside this commits the hub (this desktop, its default profile). */
  deadR: 22,
  /** Hub centre to a first-ring bud's centre (Pinterest, measured: ~82 pt on a phone). */
  r1: 92,
  /** A first-ring bud's diameter (Pinterest: ~49 pt; an idle body is 100). */
  bud1: 48,
  /** Degrees between first-ring buds (Pinterest: 42–43°), narrowed when there are many (220° at most). */
  step1: 42,
  /** A desktop bud's centre to its profile buds' centres. */
  r2: 80,
  /** A second-ring (profile) bud's diameter. */
  bud2: 42,
  /** Degrees between second-ring buds. */
  step2: 40,
  /** A ring that has just opened ignores the pointer this long: the hand is still moving (Kurtenbach). */
  settle: 90,
  /** A desktop opens once the pointer is this close to its ring (r1 − reach). */
  reach: 12,
  /** …and closes when the pointer comes back inside r1 − this. */
  backOut: 34,
  /** A direction sector is at most ±this many degrees either side of its bud. */
  sectorMax: 26,
  /** Past a ring by more than this is open ground: letting go there cancels. */
  slack: 64,
  /** A bud's words sit this far off its rim… */
  labelGap: 8,
  /** …and keep this far from every other bud (at its hot size) and the hub, */
  clearBud: 8,
  /** …from other words and the chrome, */
  clearWord: 4,
  /** …and from every spoke, where the tether runs. */
  clearSpoke: 6,
  /** Kept clear of the field's edges and of the chrome. */
  inset: 14,
  /** The targeted bud's scale (on --vf-ease-lift). */
  hot: 1.16,
  /** The nearest bud leans in before it is targeted: scale 1 + lean × this (lean 0..1). */
  near: 0.06,
  /** First-ring siblings' scale while a desktop is open. */
  dim: 0.86,
  /** …and their opacity. */
  dimAlpha: 0.42,
  /** A bud's flight out, on --vf-ease-pop. */
  pop: 280,
  /** Between buds leaving the hub, centre first (DESIGN §6's choreography constant). */
  stagger: 26,
  /** A bud growing hot or leaning in, on --vf-ease-lift. */
  lift: 180,
  /** A bud's way back along its spoke (M4). */
  retract: 180,
  /** A label follows its bud this far behind (§6: content 140–200 ms behind its container). */
  reveal: 140,
  /** The field's quiet: its own ground at this alpha over every body while the bloom is open. */
  veil: 0.8,
  /** Solid ground this far past every bud and every word… */
  clearPad: 16,
  /** …then the clearing fades to the veil over this. */
  feather: 44,
  /** The words' largest size, px (6.6% of the field's longer side, at most this). */
  sayMax: 72,
  /** The smallest they shrink to before they take the least-covered place. */
  sayMin: 22,
  /** The words keep this far from every bud, label and the hub. */
  sayGap: 40,
  /** After letting go, the words say "Opening …" this long, then leave with the veil. */
  sayHold: 460,
} as const;

export type BloomConstants = typeof BLOOM;

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace';
const SAY_FAMILY = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif';

/** The CSS fonts the bloom measures its words in (the prototype's canvas fonts),
 * handed to the injected {@link BloomTextMeasure} so a renderer's own measure
 * sees the same size and weight its CSS draws. */
export const BLOOM_FONT = {
  /** A bud's name (styles.css `.sb-label`: 9.5 px at 0.06 em). */
  label: `700 9.5px ${MONO}`,
  /** A desktop bud's state line (7.5 px at 0.1 em). */
  sub: `800 7.5px ${MONO}`,
  /** The words' one small line under the verb and noun. */
  detail: `700 11px ${MONO}`,
  /** The words themselves, at `size` px (the swarm's title type: 800, −0.04 em). */
  say: (size: number): string => `800 ${size}px ${SAY_FAMILY}`,
} as const;

/** Advance width of `text` in CSS px drawn in `font` (a CSS font shorthand, as
 * a canvas `ctx.font` takes it). Injected: the bloom's logic never touches a
 * canvas. Letter spacing is NOT included — the bloom adds its own per-font share. */
export type BloomTextMeasure = (text: string, font: string) => number;
