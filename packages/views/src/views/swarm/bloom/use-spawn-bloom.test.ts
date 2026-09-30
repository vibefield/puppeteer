import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorSpawnMenu, MonitorSpawnTarget } from '../../../monitor/types.js';
import { BLOOM } from './constants.js';
import type { BloomPoint } from './geometry.js';
import type { BloomState } from './model.js';
import { BLOOM_SCENARIOS } from './scenarios.js';
import { bloomExitMs, createSpawnBloomEngine, spawnTarget, type SpawnBloomHost } from './use-spawn-bloom.js';

// AgentSwarm's routing into the bloom, driven without a document: the events
// are the least each method reads, and the clock is vitest's. What this cannot
// see — pointer capture, focus moving, the transitions — is VibeField's
// happy-dom lane and the live witness.

const P: BloomPoint = { x: 500, y: 350 };

interface Harness {
  engine: ReturnType<typeof createSpawnBloomEngine>;
  created: Array<[BloomPoint | undefined, MonitorSpawnTarget | undefined, number]>;
  renders: Array<BloomState | null>;
}

function harness(menu: MonitorSpawnMenu | undefined): Harness {
  const created: Harness['created'] = [];
  const renders: Harness['renders'] = [];
  const host: SpawnBloomHost = {
    container: { current: { clientWidth: 1000, clientHeight: 600 } as HTMLElement },
    readChrome: () => [],
    bodies: () => [],
    idleRadius: () => 50,
    motion: () => true,
    createAt: (...args: [BloomPoint?, MonitorSpawnTarget?]) => {
      created.push([args[0], args[1], args.length]);
    },
  };
  const engine = createSpawnBloomEngine({ current: host }, { current: menu }, { current: null }, (state) =>
    renders.push(state),
  );
  return { engine, created, renders };
}

const pointer = (pointerId = 1, button = 0) =>
  ({ pointerId, button, preventDefault: vi.fn() }) as unknown as ReactPointerEvent<HTMLElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
const mouse = () =>
  ({ preventDefault: vi.fn() }) as unknown as ReactMouseEvent<HTMLElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
const key = (k: string, mods: Partial<Record<'metaKey' | 'altKey' | 'ctrlKey', boolean>> = {}) =>
  ({
    key: k,
    ...mods,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }) as unknown as ReactKeyboardEvent<HTMLDivElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };

/** The centre of the bud offering `profile` (on `device`), from the bloom now. */
function budAt(state: BloomState | null, device: string, profile?: string): BloomPoint {
  const bud = [...(state?.l1 ?? []), ...(state?.l2 ?? [])].find(
    (b) =>
      b.item.device.id === device &&
      (profile === undefined ? b.kind === 'device' : b.kind === 'profile' && b.item.profile?.id === profile),
  );
  if (!bud) throw new Error(`no bud ${device}/${profile ?? ''}`);
  return { x: bud.x, y: bud.y };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.stubGlobal('document', { activeElement: null, body: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a completed hold', () => {
  it('without a spawn menu creates at once, exactly today’s call', () => {
    const h = harness(undefined);
    h.engine.held(P, 1);
    expect(h.created).toEqual([[P, undefined, 1]]);
    expect(h.engine.current()).toBeNull();
    expect(h.renders).toEqual([]);
  });

  it('with nothing to choose creates at once under the one choice', () => {
    const h = harness(BLOOM_SCENARIOS['one-one']);
    h.engine.held(P, 1);
    expect(h.created).toEqual([[P, { deviceId: 'studio', profileSet: 'native' }, 2]]);
    expect(h.engine.current()).toBeNull();
  });

  it('with a choice blooms, follows only its own pointer, and commits where it is let go', () => {
    const h = harness(BLOOM_SCENARIOS['one-three']);
    h.engine.held(P, 7);
    const opened = h.engine.current();
    expect(opened?.mode).toBe('hold');
    expect(h.engine.isOpen()).toBe(true);
    expect(h.engine.hub(performance.now())).toMatchObject({ x: P.x, y: P.y, progress: 1, frozen: true, opacity: 1 });
    const demo = budAt(opened, 'studio', 'demo');
    // another pointer changes nothing
    expect(h.engine.pointerMove(pointer(8), demo)).toBe(true);
    expect(h.engine.current()).toBe(opened);
    expect(h.engine.pointerMove(pointer(7), demo)).toBe(true);
    expect(h.engine.current()?.target).toMatchObject({ kind: 'profile' });
    expect(h.engine.pointerUp(pointer(7), demo)).toBe(true);
    expect(h.created).toEqual([[demo, { deviceId: 'studio', profileSet: 'demo' }, 2]]);
    const closed = h.engine.current();
    expect(closed?.closed?.reason).toBe('commit');
    expect(h.engine.isOpen()).toBe(false);
    // the hub fades over the retract, then the bloom is dropped once its exit has run
    const half = h.engine.hub(performance.now() + BLOOM.retract / 2);
    expect(half?.opacity).toBeCloseTo(0.5, 1);
    expect(h.engine.hub(performance.now() + BLOOM.retract + 1)).toBeUndefined();
    vi.advanceTimersByTime(bloomExitMs(closed as BloomState) - 1);
    expect(h.engine.current()).toBe(closed);
    vi.advanceTimersByTime(1);
    expect(h.engine.current()).toBeNull();
    expect(h.renders.at(-1)).toBeNull();
  });

  it('let go on open ground opens nothing', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.held(P, 1);
    h.engine.pointerUp(pointer(1), { x: P.x, y: P.y + 250 });
    expect(h.created).toEqual([]);
    expect(h.engine.current()?.closed?.reason).toBe('cancel');
  });

  it('let go on the hub opens this desktop under its default', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.held(P, 1);
    h.engine.pointerUp(pointer(1), { x: P.x + 3, y: P.y - 2 });
    expect(h.created).toEqual([[P, { deviceId: 'studio', profileSet: 'work' }, 2]]);
  });

  it('let go on a faint desktop opens nothing', () => {
    const h = harness(BLOOM_SCENARIOS.three);
    h.engine.held(P, 1);
    const air = budAt(h.engine.current(), 'air');
    h.engine.pointerMove(pointer(1), air);
    h.engine.pointerUp(pointer(1), air);
    expect(h.created).toEqual([]);
  });

  it('a cancelled pointer puts it away, and only the hold’s own', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.held(P, 1);
    expect(h.engine.pointerCancel(pointer(2))).toBe(false);
    expect(h.engine.pointerCancel(pointer(1))).toBe(true);
    expect(h.engine.current()?.closed?.reason).toBe('cancel');
    expect(h.created).toEqual([]);
  });

  it('while a hold blooms, a second press changes nothing', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.held(P, 1);
    const opened = h.engine.current();
    expect(h.engine.pointerDown(pointer(2), { x: 10, y: 10 })).toBe(true);
    expect(h.engine.current()).toBe(opened);
  });
});

describe('held open by a secondary click (SB-D12)', () => {
  it('opens on empty ground, retargets on moves, and a primary click commits what it points at', () => {
    const h = harness(BLOOM_SCENARIOS['one-three']);
    const opening = mouse();
    h.engine.contextMenu(opening, P, false);
    expect(opening.preventDefault).toHaveBeenCalled();
    expect(h.engine.current()?.mode).toBe('sticky');
    const work = budAt(h.engine.current(), 'studio', 'work');
    h.engine.pointerMove(pointer(1), work);
    const press = pointer(1, 0);
    expect(h.engine.pointerDown(press, work)).toBe(true);
    expect(press.preventDefault).toHaveBeenCalled();
    expect(h.created).toEqual([[work, { deviceId: 'studio', profileSet: 'work' }, 2]]);
    // the click's release finds nothing open
    expect(h.engine.pointerUp(pointer(1), work)).toBe(false);
  });

  it('a secondary press puts it away, and its own contextmenu does not open another', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.contextMenu(mouse(), P, false);
    expect(h.engine.pointerDown(pointer(1, 2), { x: 700, y: 200 })).toBe(true);
    expect(h.engine.current()?.closed?.reason).toBe('cancel');
    const next = mouse();
    h.engine.contextMenu(next, { x: 700, y: 200 }, false);
    expect(next.preventDefault).toHaveBeenCalled();
    expect(h.engine.isOpen()).toBe(false);
    // the next secondary click, on its own press, opens one again
    h.engine.pointerDown(pointer(1, 2), { x: 700, y: 200 });
    h.engine.contextMenu(mouse(), { x: 700, y: 200 }, false);
    expect(h.engine.current()?.mode).toBe('sticky');
    expect(h.engine.isOpen()).toBe(true);
  });

  it('a contextmenu on an open bloom puts it away; on a body it opens nothing', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.contextMenu(mouse(), P, false);
    h.engine.contextMenu(mouse(), P, false);
    expect(h.engine.current()?.closed?.reason).toBe('cancel');
    const g = harness(BLOOM_SCENARIOS.two);
    const onBody = mouse();
    g.engine.contextMenu(onBody, P, true);
    expect(onBody.preventDefault).toHaveBeenCalled();
    expect(g.engine.current()).toBeNull();
  });

  it('without a spawn menu the contextmenu is left alone', () => {
    const h = harness(undefined);
    const event = mouse();
    h.engine.contextMenu(event, P, false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(h.engine.current()).toBeNull();
  });
});

describe('the keys door', () => {
  it('opens at the field’s middle, 62% down, and holds the keys while open', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.openKeys(null);
    const opened = h.engine.current();
    expect(opened?.mode).toBe('keys');
    expect(opened?.P).toEqual({ x: 500, y: 372 });
    const right = key('ArrowRight');
    h.engine.onKeyDown(right);
    expect(right.stopPropagation).toHaveBeenCalled();
    expect(right.preventDefault).toHaveBeenCalled();
    expect(h.engine.current()?.target).toMatchObject({ kind: 'device', item: { device: { id: 'mini' } } });
    // ↵ on a desktop with profiles opens it at its default; ↵ again commits
    h.engine.onKeyDown(key('Enter'));
    expect(h.engine.current()?.open?.item.device.id).toBe('mini');
    h.engine.onKeyDown(key('Enter'));
    expect(h.created).toEqual([
      [budAt(h.engine.current(), 'mini', 'native'), { deviceId: 'mini', profileSet: 'native' }, 2],
    ]);
  });

  it('a modified key is held but not read; Esc backs out of a desktop, then puts the bloom away', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.openKeys(null);
    const alt = key('¡', { altKey: true });
    h.engine.onKeyDown(alt);
    expect(alt.stopPropagation).toHaveBeenCalled();
    expect(alt.preventDefault).not.toHaveBeenCalled();
    h.engine.onKeyDown(key('Enter'));
    expect(h.engine.current()?.open).not.toBeNull();
    h.engine.onKeyDown(key('Escape'));
    expect(h.engine.current()?.open).toBeNull();
    expect(h.engine.isOpen()).toBe(true);
    h.engine.onKeyDown(key('Escape'));
    expect(h.engine.current()?.closed?.reason).toBe('cancel');
    expect(h.created).toEqual([]);
  });

  it('Tab puts it away and leaves the focus to move on', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.openKeys(null);
    const tab = key('Tab');
    h.engine.onKeyDown(tab);
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(h.engine.current()?.closed?.reason).toBe('cancel');
  });

  it('the focus leaving the menu puts it away', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.openKeys(null);
    vi.stubGlobal('Node', class {});
    h.engine.onBlur({
      relatedTarget: null,
      currentTarget: { contains: () => false },
    } as unknown as ReactFocusEvent<HTMLDivElement>);
    expect(h.engine.current()?.closed?.reason).toBe('cancel');
  });

  it('with nothing to choose creates at once where the bloom would have opened', () => {
    const h = harness(BLOOM_SCENARIOS['one-one']);
    h.engine.openKeys(null);
    expect(h.created).toEqual([[{ x: 500, y: 372 }, { deviceId: 'studio', profileSet: 'native' }, 2]]);
  });
});

describe('the host’s side', () => {
  it('asks for nothing it was not told', () => {
    expect(spawnTarget({ deviceId: undefined, profileSet: undefined })).toBeUndefined();
    expect(spawnTarget({ deviceId: 'mini', profileSet: undefined })).toEqual({
      deviceId: 'mini',
      profileSet: undefined,
    });
  });

  it('a host that stops offering a menu takes the bloom with it', () => {
    const h = harness(BLOOM_SCENARIOS.two);
    h.engine.held(P, 1);
    h.engine.drop();
    expect(h.engine.current()).toBeNull();
    expect(h.engine.hub(performance.now())).toBeUndefined();
  });
});
