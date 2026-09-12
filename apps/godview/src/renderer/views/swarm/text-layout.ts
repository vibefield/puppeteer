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
  /** A dot is the unread mark; an icon names a sprite in the atlas; a bar is the project's tag before the name. */
  kind: 'dot' | 'icon' | 'bar';
  icon?: string;
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
  /** A mark before the lead: the project's bar stands ahead of the unread dot. */
  tag?: CopyLead;
  lead?: CopyLead;
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

export function layoutCopy(lines: readonly CopyLine[], options: CopyLayoutOptions): CopyLayout {
  const { radius, measure, maxWidthRatio } = options;
  const centerY = options.centerY ?? 0;
  const inset = options.inset ?? 2;
  const heights = lines.map((line) => line.style.size * (line.lineHeight ?? DEFAULT_LINE_HEIGHT));
  const total = lines.reduce((sum, line, index) => sum + (line.gapBefore ?? 0) + heights[index]!, 0);
  const top = centerY - total / 2;
  let cursor = top;
  const placed: PlacedLine[] = lines.map((line, index) => {
    const height = heights[index]!;
    cursor += line.gapBefore ?? 0;
    const y = cursor + height / 2;
    cursor += height;
    const leadWidth =
      (line.tag ? leadAdvance(line.tag) + line.tag.gap : 0) + (line.lead ? leadAdvance(line.lead) + line.lead.gap : 0);
    const available = Math.min(
      maxWidthRatio * radius * 2,
      chordWidth(radius, y - height / 2, y + height / 2) - inset * 2,
    );
    const text = fitText(line.text, line.style, available - leadWidth, measure);
    const textWidth = text.length === 0 ? 0 : measure(text, line.style);
    return {
      ...line,
      text,
      textWidth,
      width: textWidth + (text.length === 0 && line.lead && !line.tag ? leadAdvance(line.lead) : leadWidth),
      y,
      height,
    };
  });
  return { lines: placed, top, bottom: top + total };
}
