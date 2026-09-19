// The swarm's greyscale, as one ink at many weights.
//
// There is a single ink per theme — near-black on a light ground, near-white on
// a dark one — and every element takes it at the weight its IMPORTANCE earns.
// The centred title is the theme's own extreme; everything else steps back from
// it. Nothing inverts (2026-09-18): every agent body wears the same surface in
// both themes, and what a body is doing is said by its marks, its inner light
// and its size, never by flipping the theme underneath it.
//
// Two readings climb rather than sit still: the context gauge as it goes round,
// and the burn ladder as its flames light. Both run the same range, because both
// mean the same thing — the further along, the more this body matters.

export const SWARM_WEIGHT = {
  /** A body's edge, the context track, an unlit flame slot. */
  hairline: 0.14,
  /** The provider mark, watermarked behind the copy. */
  watermark: 0.1,
  /** A figure with nothing to report. */
  absent: 0.3,
  /** The dashed rim of a terminal no agent has claimed. */
  rim: 0.4,
  /** The border of a body that is working. */
  edge: 0.28,
  /** Model · effort, the branch, a terminal's own small labels. */
  supporting: 0.44,
  /** The figures on the chords, and a project name a state line has displaced. */
  secondary: 0.64,
  /** The centred title: the project's name, or what the body needs from you. */
  title: 1,
} as const;

/**
 * The climb the context gauge and the burn ladder share. A short arc or a lone
 * flame is barely above the track it sits on; a full ring or a fourth flame
 * reaches the title's own weight, because by then it is the most important thing
 * the body has to say.
 */
export const SWARM_CLIMB = { from: 0.34, to: 1 } as const;

/** The climb at `t`, 0 to 1. */
export function climb(t: number): number {
  return SWARM_CLIMB.from + (SWARM_CLIMB.to - SWARM_CLIMB.from) * Math.max(0, Math.min(1, t));
}

/**
 * The same rung on a body whose ground is a state's own colour rather than the
 * theme's surface. A coloured field gives the ink less room than a near-white or
 * near-black surface does, so the ladder is compressed upward: the order is
 * untouched, the bottom simply starts higher.
 */
export function onField(weight: number): number {
  return weight + (1 - weight) * 0.3;
}

/**
 * A working body's light is a density at its centre rather than a glow — on a
 * light theme it can only darken — so it is held well back. A state's light is
 * not a constant at all: the STATE GLOW parameters carry it.
 */
export const WORKING_CORE_STRENGTH = 0.5;
