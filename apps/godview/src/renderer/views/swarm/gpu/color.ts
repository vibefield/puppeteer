// CSS colour strings into the straight-alpha floats a shader wants.
//
// The tokens the swarm reads are `#hex`, `rgb()`/`rgba()`, or occasionally a
// value only the engine can resolve (`color-mix()`, a name). The parser takes
// the first two; `resolveCssColor` hands anything else to the engine through a
// probe element so the number here is always the number the DOM would paint.

export type Rgba = readonly [number, number, number, number];

export const TRANSPARENT: Rgba = [0, 0, 0, 0];

function channel(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return Math.max(0, Math.min(1, Number.parseFloat(trimmed) / 100));
  const number = Number.parseFloat(trimmed);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number / 255)) : 0;
}

function alpha(value: string | undefined): number {
  if (value === undefined) return 1;
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return Math.max(0, Math.min(1, Number.parseFloat(trimmed) / 100));
  const number = Number.parseFloat(trimmed);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1;
}

export function parseCssColor(value: string): Rgba | undefined {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(text);
  if (hex) {
    const raw = hex[1]!;
    const digits =
      raw.length === 3 || raw.length === 4 ? [...raw].map((character) => character + character).join('') : raw;
    if (digits.length !== 6 && digits.length !== 8) return undefined;
    const number = Number.parseInt(digits, 16);
    if (!Number.isFinite(number)) return undefined;
    if (digits.length === 6)
      return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255, 1];
    return [
      ((number >>> 24) & 255) / 255,
      ((number >> 16) & 255) / 255,
      ((number >> 8) & 255) / 255,
      (number & 255) / 255,
    ];
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/iu.exec(text);
  if (rgb) {
    const inner = rgb[1]!;
    const [colour, slashAlpha] = inner.split('/');
    const parts = colour!.split(/[\s,]+/u).filter(Boolean);
    if (parts.length < 3) return undefined;
    const alphaPart = slashAlpha ?? parts[3];
    return [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha(alphaPart)];
  }
  const srgb = /^color\(srgb\s+([^)]+)\)$/iu.exec(text);
  if (srgb) {
    const [colour, slashAlpha] = srgb[1]!.split('/');
    const parts = colour!.split(/\s+/u).filter(Boolean);
    if (parts.length < 3) return undefined;
    return [
      Math.max(0, Math.min(1, Number.parseFloat(parts[0]!))),
      Math.max(0, Math.min(1, Number.parseFloat(parts[1]!))),
      Math.max(0, Math.min(1, Number.parseFloat(parts[2]!))),
      alpha(slashAlpha),
    ];
  }
  if (text === 'transparent') return TRANSPARENT;
  return undefined;
}

/** Parse, or let the engine resolve it in `context` and parse that. */
export function resolveCssColor(value: string, context: Element | undefined): Rgba {
  const parsed = parseCssColor(value);
  if (parsed) return parsed;
  if (!context || typeof getComputedStyle !== 'function') return TRANSPARENT;
  const probe = context.ownerDocument.createElement('i');
  probe.style.color = value;
  probe.style.display = 'none';
  context.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return parseCssColor(resolved) ?? TRANSPARENT;
}

export function withAlpha(colour: Rgba, value: number): Rgba {
  return [colour[0], colour[1], colour[2], colour[3] * value];
}

/** Relative luminance, enough to tell a light ground from a dark one. */
export function luminance(colour: Rgba): number {
  return 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
}
