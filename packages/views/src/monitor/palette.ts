import { type RefObject, useEffect, useState } from 'react';
import type { AgentVisualStatus } from './agent-status.js';
import type { ProjectTint } from '../colour/project-tint.js';

// The monitor's colors, READ FROM THE TOKENS — ported from vibe-field's
// monitor/monitor-palette.ts.
//
// Two of the three views paint into a canvas (the swarm's bodies are DOM but its
// physics is not; the rain is entirely 2D context), and a canvas cannot inherit
// a custom property. So the values are RESOLVED once at mount and re-resolved
// when the theme changes. Transcribing them here would put DESIGN.md's numbers
// in a second place and guarantee they drift the first time §2 moves.
//
// The mapping is §2.5's:
//   working → --vf-green    · the healthy, running state
//   blocked → --vf-orange   · "needs attention", and the Godview ring-1 color
//   idle    → the text ramp · muted, no hue — an agent doing nothing is not a
//                             state to alarm at
// and the per-agent relationship colour is the PROJECT's (record §02): main
// deals each project a sequence, `project-tint.ts` turns it into a hue, and
// the theme supplies the lightness and chroma through two tokens the skin
// defines until vibe-field's kit lands them. A bare terminal belongs to no
// project and wears the ramp. Identity never signals state.

export interface MonitorPalette {
  /** §02: the theme's lightness and chroma for every project tint (`--tint-l`, `--tint-c`). */
  tint: ProjectTint;
  /** The ramp a session with no project wears: a colour that is not a colour. */
  neutral: string;
  /** §2.5 + §2.4, as CSS colors. */
  status: Readonly<Record<AgentVisualStatus, string>>;
  /** The same three, as `"r, g, b"` for canvas `rgba()` composition. */
  statusRgb: Readonly<Record<AgentVisualStatus, string>>;
  /** The control-room stage's own ground, for a canvas that must clear itself. */
  stage: string;
  /** §2.4's ramp on a dark surface: primary, secondary, tertiary. */
  text: { primary: string; secondary: string; tertiary: string };
  /** The swarm's bodies, resolved from the theme-scoped Godview instrument
   * palette (§2.7). The swarm paints into a WebGPU canvas, which can inherit
   * no custom property at all. */
  swarm: SwarmPalette;
  /** Canvas-only colors from the Chopsticks rain view. DOM views consume the
   * scoped Godview CSS palette directly; canvas needs these resolved values. */
  rain: {
    stage: string;
    activeHead: string;
    hoverTailRgb: string;
    status: Readonly<Record<AgentVisualStatus, { head: string; tailRgb: string; speed?: number }>>;
  };
}

export interface SwarmPalette {
  /** Every agent body's surface. One value, because no state inverts the theme
   * (2026-09-18): the swarm reads the instrument's resting body colour and lets
   * marks, light and size say what a body is doing. */
  surface: string;
  /** The one ink. Importance is its WEIGHT, never a different grey — see
   * `weight.ts` for the ladder. */
  ink: string;
  /** The field's faint 24px grid. */
  gridLine: string;
  /** §2.5's orange: a body that waits on the user. */
  orange: string;
  /** The branch dot's green. */
  green: string;
  /** §2.5's select blue: a reply that arrived unseen. */
  blue: string;
}

/** DESIGN.md §2.4 — text is surface color + opacity, never a fixed gray. The
 * canvas views commit to dark in both themes, so the surface color here is
 * white and these are the ramp, not invented values. */
const TEXT_PRIMARY = 'rgba(255,255,255,1)';
const TEXT_SECONDARY = 'rgba(255,255,255,0.7)';
const TEXT_TERTIARY = 'rgba(255,255,255,0.4)';

function readToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/** The Godview root carries the theme class, so the §2.7 aliases (`--idle-bg`
 * and friends) resolve only there: the root a reader names, else the
 * document's first. Without a mounted root the document root is read, which
 * yields the fallbacks and therefore a visibly wrong swarm. */
function scopedRoot(root: Element | null | undefined): Element {
  return root ?? document.querySelector('.vf-godview') ?? document.documentElement;
}

function readScopedToken(name: string, fallback: string, root?: Element | null): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(scopedRoot(root)).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

function readScopedNumber(name: string, fallback: number, root?: Element | null): number {
  const value = Number.parseFloat(readScopedToken(name, '', root));
  return Number.isFinite(value) ? value : fallback;
}

function readSwarmPalette(root?: Element | null): SwarmPalette {
  return {
    // The instrument's resting body colour, which every body now wears; the
    // inverted working and blocked fills are no longer read.
    surface: readScopedToken('--idle-bg', '#000000', root),
    ink: readScopedToken('--text-main', '#000000', root),
    gridLine: readScopedToken('--grid-line', 'rgba(0, 0, 0, 0)', root),
    orange: readToken('--vf-orange', '#000000'),
    green: readToken('--vf-godview-rain-green', '#000000'),
    blue: readToken('--vf-select', '#000000'),
  };
}

/** `#rrggbb` (or `#rgb`) as the `"r, g, b"` channels a canvas `rgba()` wants. */
export function hexToRgb255(hex: string): string {
  const raw = hex.trim().replace(/^#/, '');
  const expanded = raw.length === 3 ? raw.replace(/./g, (char) => char + char) : raw;
  const value = Number.parseInt(expanded.slice(0, 6), 16);
  if (!Number.isFinite(value) || expanded.length < 6) return '0, 0, 0';
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

/**
 * Sample the live tokens.
 *
 * Fallbacks are BLACK-ish rather than plausible colors on purpose: an absent
 * token means the stylesheet is not in the document, and a monitor that quietly
 * paints a hardcoded green in that case would be hiding the fault it should be
 * showing. The tint falls back to no lightness for the same reason: every
 * project black, obviously wrong, cheap to notice.
 */
export function readMonitorPalette(root?: Element | null): MonitorPalette {
  const stage = readToken('--vf-card-deep', '#000000');
  const status = {
    working: readToken('--vf-green', '#000000'),
    blocked: readToken('--vf-orange', '#000000'),
    idle: TEXT_TERTIARY,
  } as const;
  return {
    tint: { l: readScopedNumber('--tint-l', 0, root), c: readScopedNumber('--tint-c', 0, root) },
    neutral: readScopedToken('--text-faint', '#000000', root),
    status,
    statusRgb: {
      working: hexToRgb255(status.working),
      blocked: hexToRgb255(status.blocked),
      // The ramp is already an rgba; its channels are white by construction.
      idle: '255, 255, 255',
    },
    stage,
    text: { primary: TEXT_PRIMARY, secondary: TEXT_SECONDARY, tertiary: TEXT_TERTIARY },
    swarm: readSwarmPalette(root),
    rain: {
      stage: readToken('--vf-card-deep', '#000000'),
      activeHead: readToken('--vf-godview-rain-working-head', '#ffffff'),
      hoverTailRgb: hexToRgb255(readToken('--vf-godview-rain-hover-tail', '#000000')),
      status: {
        working: {
          head: readToken('--vf-godview-rain-working-head', '#ffffff'),
          tailRgb: hexToRgb255(readToken('--vf-godview-rain-working-tail', '#000000')),
        },
        blocked: {
          head: readToken('--vf-godview-rain-waiting-head', '#ffffff'),
          tailRgb: hexToRgb255(readToken('--vf-godview-rain-waiting-tail', '#000000')),
          speed: 0.02,
        },
        idle: {
          head: readToken('--vf-godview-rain-idle-head', '#ffffff'),
          tailRgb: hexToRgb255(readToken('--vf-godview-rain-idle-tail', '#000000')),
          speed: 0.1,
        },
      },
    },
  };
}

/**
 * The palette, live.
 *
 * Re-sampled on a `data-theme` change, which is how this window stamps a theme.
 * The project tint has a lightness per theme, so every bubble's colour moves
 * with the switch; §2.5's states are theme-invariant today, and the observer
 * is what lets them gain a dark variant without anyone remembering it exists.
 *
 * A page with more than one Godview root (a catalog showing the bodies in
 * their own theme beside the stage in another) passes the ref of the root
 * its view sits in: the theme-scoped tokens are then read from, and watched
 * on, that root rather than the document's first.
 */
export function useMonitorPalette(root?: RefObject<Element | null>): MonitorPalette {
  const [palette, setPalette] = useState(() => readMonitorPalette(root?.current));
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const scoped = root?.current ?? null;
    // Diffed before it is published: the document root's class is watched, so
    // any host class toggle on <html> would otherwise re-render every palette
    // consumer and make the swarm re-resolve its theme and drop its colour cache.
    const read = (): void =>
      setPalette((current) => {
        const next = readMonitorPalette(scoped);
        return JSON.stringify(next) === JSON.stringify(current) ? current : next;
      });
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    // The swarm's tokens are theme-scoped on the Godview root, whose class is
    // what actually changes; watch it too so the swarm never reads a stale theme.
    const watched = scoped ?? document.querySelector('.vf-godview');
    if (watched) observer.observe(watched, { attributes: true, attributeFilter: ['class'] });
    // The first read happened during the initial state, which for the very first
    // mount can precede the stylesheet (and precedes the ref). Re-read once on
    // commit so a monitor that opened mid-load does not keep the fallbacks it
    // was born with.
    read();
    return () => observer.disconnect();
  }, [root]);
  return palette;
}
