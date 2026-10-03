/**
 * The host's parts of a view's input keep their identity when their values
 * did not change.
 *
 * A host builds its stage, theme and parameters in its own render, often as
 * fresh literals. Left alone, every host render would hand the view new
 * objects that mean nothing new, and a view that keys its caches on identity
 * (MV-D21) would redo its work: re-resolve the palette, reset the rain canvas,
 * re-post every agent. The slot compares by value here and keeps the object it
 * already gave the view.
 */

import type { Insets, MonitorTheme, Rect, StageGeometry } from '../view.js';

function sameInsets(a: Insets, b: Insets): boolean {
  return a === b || (a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left);
}

function sameRects(a: readonly Rect[], b: readonly Rect[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((rect, index) => {
    const other = b[index]!;
    return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height;
  });
}

export function keepStage(current: StageGeometry, next: StageGeometry): StageGeometry {
  const same =
    current === next ||
    (current.width === next.width &&
      current.height === next.height &&
      sameInsets(current.insets, next.insets) &&
      sameRects(current.obstacles, next.obstacles));
  return same ? current : next;
}

/** The tokens compare by identity: the host's palette reader already keeps an unchanged palette's object. */
export function keepTheme(current: MonitorTheme, next: MonitorTheme): MonitorTheme {
  const same =
    current === next ||
    (current.scheme === next.scheme &&
      current.tokens === next.tokens &&
      current.reducedMotion === next.reducedMotion &&
      current.animations === next.animations);
  return same ? current : next;
}

/** A flat record (parameters, capabilities): the same keys holding the same values. */
export function keepRecord<T extends object>(current: T, next: T): T {
  if (current === next) return current;
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) return next;
  for (const key of nextKeys) {
    if (!Object.hasOwn(current, key)) return next;
    if ((current as Record<string, unknown>)[key] !== (next as Record<string, unknown>)[key]) return next;
  }
  return current;
}
