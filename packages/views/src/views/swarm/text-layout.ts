import type { Picture } from '@vibefield/puppeteer-view-sdk';

// Fitting a body's copy inside its circle. Pure, so the ellipsis and the chord
// arithmetic are testable with a fake measurer; the renderer supplies the real
// one from its glyph atlas.

export interface TextStyle {
  /** CSS px. */
  size: number;
  weight: 500 | 600 | 800;
  italic?: boolean;
  /** In em, as CSS `letter-spacing`. */
  letterSpacing?: number;
  /** As CSS `text-transform`, applied before measuring. */
  transform?: 'uppercase' | 'lowercase';
}

/** Advance width of `text` in CSS px, letter spacing included. */
export type TextMeasure = (text: string, style: TextStyle) => number;

export type CopyTone = 'ink' | 'orange' | 'green' | 'blue' | 'accent';

export interface CopyLead {
  /** A dot is a state mark; an icon names a sprite in the atlas; a picture is the host's (`HostMark.lead`). */
  kind: 'dot' | 'icon' | 'picture';
  icon?: string;
  picture?: Picture;
  /** The sprite's height, and its width unless `width` narrows it. */
  size: number;
  /** The horizontal room the lead takes, for a mark narrower than it is tall. */
  width?: number;
  /** Space between the lead and the text. */
  gap: number;
  opacity?: number;
  tone?: CopyTone;
}

/** The room a lead takes along the line. */
export function leadAdvance(lead: CopyLead): number {
  return lead.width ?? lead.size;
}

export interface CopyLine {
  key: string;
  text: string;
  style: TextStyle;
  opacity: number;
  tone: CopyTone;
  /** Space above this line, CSS px. */
  gapBefore?: number;
  /** Line box height as a multiple of the size; the copy's `line-height: 1.05`. */
  lineHeight?: number;
  lead?: CopyLead;
  /**
   * How many rows the text may take where the layout wraps (`CopyLayoutOptions.wrap`): a sentence standing where a
   * label stood (a session's title in the name's place) takes two, broken between words. Absent: one.
   */
  maxLines?: number;
}

export interface PlacedLine extends CopyLine {
  /** The text after fitting, the transform applied. */
  text: string;
  /** Total width, lead included. */
  width: number;
  textWidth: number;
  /** Centre of the line box relative to the body centre, down positive. */
  y: number;
  height: number;
}

export interface CopyLayout {
  lines: PlacedLine[];
  top: number;
  bottom: number;
}

export interface CopyLayoutOptions {
  radius: number;
  measure: TextMeasure;
  /** The copy's `max-width` as a fraction of the diameter. */
  maxWidthRatio: number;
  /** Vertical centre of the block relative to the body centre. */
  centerY?: number;
  /** Breathing room between the text and the rim; the DOM let text touch it. */
  inset?: number;
  /**
   * Let a line that asks for rows (`CopyLine.maxLines`) take them when its words do not fit one. A body's layout
   * asks for it on every rung; without it every line is one row, cut as it always was.
   */
  wrap?: boolean;
}

const ELLIPSIS = '…';
const DEFAULT_LINE_HEIGHT = 1.05;

export function displayText(text: string, style: TextStyle): string {
  if (style.transform === 'uppercase') return text.toUpperCase();
  if (style.transform === 'lowercase') return text.toLowerCase();
  return text;
}

/** `text-overflow: ellipsis` for one line: the longest prefix plus `…` that fits. */
export function fitText(text: string, style: TextStyle, maxWidth: number, measure: TextMeasure): string {
  const shown = displayText(text, style);
  if (maxWidth <= 0 || shown.length === 0) return '';
  if (measure(shown, style) <= maxWidth) return shown;
  const characters = [...shown];
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    const candidate = characters.slice(0, middle).join('') + ELLIPSIS;
    if (measure(candidate, style) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return low === 0
    ? measure(ELLIPSIS, style) <= maxWidth
      ? ELLIPSIS
      : ''
    : characters.slice(0, low).join('') + ELLIPSIS;
}

/** The widest horizontal span the circle offers to a box spanning `yTop..yBottom`. */
export function chordWidth(radius: number, yTop: number, yBottom: number): number {
  const reach = Math.max(Math.abs(yTop), Math.abs(yBottom));
  if (reach >= radius) return 0;
  return 2 * Math.sqrt(radius * radius - reach * reach);
}

/** Where each line's box stands and the room its text has, which depend on the stack and never on the words. */
function copyGeometry(
  lines: readonly CopyLine[],
  options: CopyLayoutOptions,
): { rows: { y: number; height: number; leadWidth: number; room: number }[]; top: number; total: number } {
  const { radius, maxWidthRatio } = options;
  const centerY = options.centerY ?? 0;
  const inset = options.inset ?? 2;
  const heights = lines.map((line) => line.style.size * (line.lineHeight ?? DEFAULT_LINE_HEIGHT));
  const total = lines.reduce((sum, line, index) => sum + (line.gapBefore ?? 0) + heights[index]!, 0);
  const top = centerY - total / 2;
  let cursor = top;
  const rows = lines.map((line, index) => {
    const height = heights[index]!;
    cursor += line.gapBefore ?? 0;
    const y = cursor + height / 2;
    cursor += height;
    const leadWidth = line.lead ? leadAdvance(line.lead) + line.lead.gap : 0;
    const available = Math.min(
      maxWidthRatio * radius * 2,
      chordWidth(radius, y - height / 2, y + height / 2) - inset * 2,
    );
    return { y, height, leadWidth, room: available - leadWidth };
  });
  return { rows, top, total };
}

/** One row a line: each fitted to its own chord. */
function placeCopy(lines: readonly CopyLine[], options: CopyLayoutOptions): CopyLayout {
  const { measure } = options;
  const { rows, top, total } = copyGeometry(lines, options);
  const placed: PlacedLine[] = lines.map((line, index) => {
    const { y, height, leadWidth, room } = rows[index]!;
    const text = fitText(line.text, line.style, room, measure);
    const textWidth = text.length === 0 ? 0 : measure(text, line.style);
    return {
      ...line,
      text,
      textWidth,
      width: textWidth + (text.length === 0 && line.lead ? leadAdvance(line.lead) : leadWidth),
      y,
      height,
    };
  });
  return { lines: placed, top, bottom: top + total };
}

/** The key of a wrapped line's second row: its line's own, marked, so a reader of keys still finds the first. */
export function secondRowKey(key: string): string {
  return `${key}:2`;
}

/**
 * The first line that asks for two rows and is cut in one, split between words: its first row keeps the lead and as
 * many whole words as its chord holds, its second the rest (cut by the ellipsis rule if they still run over).
 * Undefined where nothing asks, the words fit, or no whole word fits the first row: then the line is cut as it was.
 */
function wrapCopy(
  lines: readonly CopyLine[],
  single: CopyLayout,
  options: CopyLayoutOptions,
): readonly CopyLine[] | undefined {
  const index = lines.findIndex(
    (line, at) => (line.maxLines ?? 1) > 1 && single.lines[at]!.text !== displayText(line.text, line.style),
  );
  if (index === -1) return undefined;
  const line = lines[index]!;
  const words = line.text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return undefined;
  const { lead: _lead, gapBefore: _gapBefore, maxLines: _maxLines, ...bare } = line;
  const second = (text: string): CopyLine => ({ ...bare, key: secondRowKey(line.key), text });
  const stack = (first: string, rest: string): CopyLine[] => [
    ...lines.slice(0, index),
    { ...line, text: first },
    second(rest),
    ...lines.slice(index + 1),
  ];
  // The rows' places do not depend on their words: the stack with two rows says how much room the first has.
  const room = copyGeometry(stack('', ''), options).rows[index]!.room;
  let count = 0;
  for (let taken = 1; taken < words.length; taken += 1) {
    const candidate = displayText(words.slice(0, taken).join(' '), line.style);
    if (options.measure(candidate, line.style) > room) break;
    count = taken;
  }
  if (count === 0) return undefined;
  return stack(words.slice(0, count).join(' '), words.slice(count).join(' '));
}

export function layoutCopy(lines: readonly CopyLine[], options: CopyLayoutOptions): CopyLayout {
  const single = placeCopy(lines, options);
  if (!options.wrap) return single;
  const wrapped = wrapCopy(lines, single, options);
  return wrapped ? placeCopy(wrapped, options) : single;
}

/**
 * The shortest a cut line may be and still say something: this many glyphs
 * before its ellipsis ("pup…"), or the whole of a line shorter than that. A cut
 * to fewer is a mark, not a word.
 */
export const LEGIBLE_GLYPHS = 3;

/** Whether a placed line still reads: whole, or cut to at least `LEGIBLE_GLYPHS` glyphs before its ellipsis. */
export function legible(placed: PlacedLine, line: CopyLine): boolean {
  const whole = displayText(line.text, line.style);
  if (placed.text === whole) return true;
  if (!placed.text.endsWith(ELLIPSIS)) return false;
  return [...placed.text].length - 1 >= Math.min(LEGIBLE_GLYPHS, [...whole].length);
}

export interface CopyLadderOptions extends CopyLayoutOptions {
  /** The order lines leave a body that cannot hold them all, by key, first to go first. A line whose key is not
   * here (the name) is never dropped. */
  order: readonly string[];
}

/**
 * The copy ladder (SWF, "the words step down as bodies shrink"): lay the
 * lines out, and while any of them is cut below a legible stub, or has no
 * chord left at all, drop the one first in `order` and lay the rest out again
 * around the centre. Ends when every kept line reads, or when only lines
 * outside `order` are left (those are kept whatever the radius). A body whose
 * copy fits loses nothing and is laid out exactly as `layoutCopy` lays it.
 */
export function ladderCopy(lines: readonly CopyLine[], options: CopyLadderOptions): CopyLayout {
  const pinned = (line: CopyLine): boolean => !options.order.includes(line.key);
  // The lines of `source` the layout cut below a legible stub. A line that took a second row (`wrap`) reads by
  // its rows: the first holds whole words, and the second is its own stub.
  const unread = (layout: CopyLayout, source: readonly CopyLine[]): CopyLine[] =>
    source.filter((line) => {
      const first = layout.lines.find((placed) => placed.key === line.key);
      const second = layout.lines.find((placed) => placed.key === secondRowKey(line.key));
      if (first === undefined) return true;
      if (second === undefined) return !legible(first, line);
      const glyphs = [...second.text];
      return second.text.endsWith(ELLIPSIS) && glyphs.length - 1 < LEGIBLE_GLYPHS;
    });
  let kept = lines;
  for (;;) {
    const layout = layoutCopy(kept, options);
    const failing = unread(layout, kept);
    if (failing.length === 0) return layout;
    // A line the ladder never drops (the name) that no drop could rescue costs the others nothing: with every
    // droppable line gone it would still be cut short, so they stay.
    if (failing.every(pinned)) {
      const alone = kept.filter(pinned);
      if (unread(layoutCopy(alone, options), alone).length > 0) return layout;
    }
    let victim = -1;
    let rank = options.order.length;
    kept.forEach((line, index) => {
      const at = options.order.indexOf(line.key);
      if (at !== -1 && at < rank) {
        rank = at;
        victim = index;
      }
    });
    if (victim === -1) return layout;
    kept = kept.filter((_, index) => index !== victim);
  }
}
