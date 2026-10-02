import { describe, expect, it } from 'vitest';
import {
  SPAN_MAX_MS,
  SPAN_MIN_MS,
  earliestEnd,
  followNow,
  glideTween,
  headAt,
  initialScale,
  islandEase,
  panBy,
  tickStep,
  ticksBetween,
  tweenAt,
  zoomAt,
  zoomTween,
} from './timeline-scale.js';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 2, 15, 0, 0);

describe('the scale', () => {
  it('opens on the last hour, following now', () => {
    const scale = initialScale(NOW);
    expect(scale).toEqual({ spanMs: 60 * MIN, endMs: NOW, live: true });
    expect(followNow(scale, NOW + 1000).endMs).toBe(NOW + 1000);
  });

  it('holds a head that was put back while now runs on', () => {
    const back = panBy(initialScale(NOW), -30 * MIN, NOW, 0);
    expect(back.live).toBe(false);
    expect(followNow(back, NOW + 5 * MIN).endMs).toBe(NOW - 30 * MIN);
  });

  it('clamps the head between the earliest and now, and snaps to now within 400 ms', () => {
    const earliest = NOW - 120 * MIN;
    expect(headAt(initialScale(NOW), NOW - 500 * MIN, NOW, earliest).endMs).toBe(earliest);
    expect(headAt(initialScale(NOW), NOW + 10 * MIN, NOW, earliest)).toEqual({
      spanMs: 60 * MIN,
      endMs: NOW,
      live: true,
    });
    expect(headAt(initialScale(NOW), NOW - 300, NOW, earliest).live).toBe(true);
    expect(earliestEnd(NOW - 60 * MIN, 60 * MIN, NOW)).toBe(NOW - 120 * MIN + 15 * MIN);
  });

  it('zooms at the pointer: the moment under it stays put', () => {
    const held = { spanMs: 60 * MIN, endMs: NOW - 30 * MIN, live: false };
    const width = 600;
    const anchorPx = 200; // 200 px left of the head
    const before = held.endMs - anchorPx * (held.spanMs / width);
    const zoomed = zoomAt(held, 30 * MIN, anchorPx, width, NOW);
    expect(zoomed.endMs - anchorPx * (zoomed.spanMs / width)).toBeCloseTo(before, 6);
    expect(zoomAt(held, 1, anchorPx, width, NOW).spanMs).toBe(SPAN_MIN_MS);
    expect(zoomAt(held, 1e12, anchorPx, width, NOW).spanMs).toBe(SPAN_MAX_MS);
  });

  it('a following head keeps following through a zoom', () => {
    const zoomed = zoomAt(initialScale(NOW), 15 * MIN, 100, 600, NOW + 10);
    expect(zoomed).toEqual({ spanMs: 15 * MIN, endMs: NOW + 10, live: true });
  });
});

describe('tweens', () => {
  it('eases on the island curve: 0 → 1, ahead of linear early', () => {
    expect(islandEase(0)).toBe(0);
    expect(islandEase(1)).toBe(1);
    expect(islandEase(0.25)).toBeGreaterThan(0.5);
  });

  it('a zoom preset runs 240 ms and lands following now', () => {
    const tween = zoomTween(initialScale(NOW), 4 * 60 * MIN, 0);
    const mid = tweenAt(tween, 120, NOW, false);
    expect(mid.done).toBe(false);
    expect(mid.scale.spanMs).toBeGreaterThan(60 * MIN);
    const end = tweenAt(tween, 240, NOW + 240, false);
    expect(end).toEqual({ scale: { spanMs: 240 * MIN, endMs: NOW + 240, live: true }, done: true });
  });

  it('NOW glides back over 600 ms, chasing now; reduced motion lands at once', () => {
    const held = { spanMs: 60 * MIN, endMs: NOW - 50 * MIN, live: false };
    const tween = glideTween(held, 0);
    expect(tweenAt(tween, 300, NOW, false).scale.live).toBe(false);
    expect(tweenAt(tween, 600, NOW + 600, false).scale).toEqual({ spanMs: 60 * MIN, endMs: NOW + 600, live: true });
    expect(tweenAt(tween, 1, NOW, true)).toEqual({ scale: { spanMs: 60 * MIN, endMs: NOW, live: true }, done: true });
  });
});

describe('ticks', () => {
  it('picks the finest step at least 76 px apart', () => {
    const pxPerMs = 1000 / (60 * MIN); // an hour across 1000 px
    expect(tickStep(pxPerMs)).toBe(5 * MIN);
  });

  it('lands on wall-clock multiples and marks the hours', () => {
    const start = new Date(2026, 9, 2, 14, 3).getTime();
    const ticks = ticksBetween(start, start + 60 * MIN, 15 * MIN);
    expect(ticks.map((tick) => new Date(tick.t).getMinutes())).toEqual([15, 30, 45, 0]);
    expect(ticks.filter((tick) => tick.hour)).toHaveLength(1);
  });
});
