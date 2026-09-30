import { describe, expect, it } from 'vitest';
import type { MonitorAgent } from '../../../monitor/types.js';
import { BLOOM, type BloomTextMeasure } from './constants.js';
import { polar, type BloomPoint } from './geometry.js';
import {
  bloomView,
  cancelBloom,
  commitBloom,
  isInstant,
  keyBloom,
  keysOrigin,
  litOf,
  openBloom,
  pointBloom,
  type BloomEnv,
  type BloomState,
} from './model.js';
import { BLOOM_SCENARIOS } from './scenarios.js';

// characters × font px × 0.6, as every bloom test measures
const measure: BloomTextMeasure = (text, font) => text.length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 0) * 0.6;
const env = (now = 1000, patch: Partial<BloomEnv> = {}): BloomEnv => ({
  field: { w: 1000, h: 600 },
  measure,
  now,
  ...patch,
});
const P: BloomPoint = { x: 500, y: 350 };
const at = (deg: number, r: number, from: BloomPoint = P) => polar(from.x, from.y, r, deg);
const text = (s: BloomState) => s.words?.parts.map((p) => p[0]).join('');

function open(id: keyof typeof BLOOM_SCENARIOS = 'two', mode: 'hold' | 'sticky' | 'keys' = 'hold'): BloomState {
  const opened = openBloom(env(), P, mode, BLOOM_SCENARIOS[id]);
  if (isInstant(opened)) throw new Error('expected a bloom');
  return opened;
}
const budOf = (s: BloomState, device: string, profile?: string) =>
  [...s.l1, ...s.l2].find(
    (b) =>
      b.item.device.id === device && (profile === undefined ? b.kind === 'device' : b.item.profile?.id === profile),
  );
/** Point at a bud's centre from the hub's side, `k` of the way. */
const toward = (s: BloomState, device: string, k = 1, profile?: string): BloomPoint => {
  const b = budOf(s, device, profile);
  if (!b) throw new Error('no bud');
  return { x: P.x + (b.x - P.x) * k, y: P.y + (b.y - P.y) * k };
};
/** Reach a desktop and let its ring settle. */
function reach(s: BloomState, device: string): BloomState {
  const b = budOf(s, device);
  if (!b) throw new Error('no bud');
  return pointBloom(env(), s, { x: P.x + (b.x - P.x) * 1.02, y: P.y + (b.y - P.y) * 1.02 });
}

describe('openBloom', () => {
  it('creates at once when there is nothing to choose (today’s hold)', () => {
    const opened = openBloom(env(), P, 'hold', BLOOM_SCENARIOS['one-one']);
    expect(isInstant(opened)).toBe(true);
    if (!isInstant(opened)) return;
    expect(opened.instant).toMatchObject({
      deviceId: 'studio',
      profileSet: 'native',
      at: P,
      via: 'instant',
      from: null,
    });
    const bare = openBloom(env(), P, 'hold', { devices: [] });
    expect(isInstant(bare) && bare.instant.deviceId).toBeUndefined();
  });

  it('blooms the desktops up from the hub, centre first, the hub targeted', () => {
    const s = open();
    expect(s.theta).toBe(-90);
    expect(s.l1.map((b) => [b.item.device.id, b.face])).toEqual([
      ['studio', { kind: 'initial', text: 'S' }],
      ['mini', { kind: 'initial', text: 'M' }],
    ]);
    expect(s.l1.map((b) => [b.name, b.sub])).toEqual([
      ['STUDIO', 'HERE'],
      ['MINI', '2 RUNNING'],
    ]);
    // two buds tie for the centre: both leave at once, labels `reveal` behind
    expect(s.l1.map((b) => [b.delay, b.labelDelay])).toEqual([
      [0, BLOOM.reveal],
      [BLOOM.stagger, BLOOM.stagger + BLOOM.reveal],
    ]);
    expect(s.target).toEqual({ kind: 'hub' });
    expect(text(s)).toBe('New terminal');
    expect(s.say?.slate).toBe(1);
  });

  it('blooms one desktop’s profiles as glyphs, the default filled, the blocked one dotted', () => {
    const s = open('one-three');
    expect(s.l1.map((b) => [b.kind, b.face, b.dot, b.name])).toEqual([
      ['profile', { kind: 'glyph', glyph: 'laptop', filled: false }, false, 'THIS MAC'],
      ['profile', { kind: 'glyph', glyph: 'briefcase', filled: true }, true, 'WORK'],
      ['profile', { kind: 'glyph', glyph: 'flask', filled: false }, false, 'DEMO'],
    ]);
    // three buds: the middle one first
    expect(s.l1.map((b) => b.delay)).toEqual([BLOOM.stagger, 0, BLOOM.stagger * 2]);
  });

  it('scales its motion, and drops the stagger under reduced motion', () => {
    const slow = openBloom(env(1000, { motionScale: 2 }), P, 'hold', BLOOM_SCENARIOS['one-three']) as BloomState;
    expect(slow.l1.map((b) => b.delay)).toEqual([BLOOM.stagger * 2, 0, BLOOM.stagger * 4]);
    const still = openBloom(env(1000, { reduced: true }), P, 'hold', BLOOM_SCENARIOS['one-three']) as BloomState;
    expect(still.l1.map((b) => b.delay)).toEqual([0, 0, 0]);
  });
});

describe('pointBloom', () => {
  it('targets a desktop by direction, and changes the words only when the target changes', () => {
    const s0 = open();
    const s1 = pointBloom(env(), s0, toward(s0, 'mini', 0.5));
    expect(s1.target).toMatchObject({ kind: 'device' });
    expect(s1.open).toBeNull();
    expect(text(s1)).toBe('Open on mini');
    expect(s1.say?.slate).toBe(2);
    const s2 = pointBloom(env(), s1, toward(s0, 'mini', 0.6));
    expect(s2.say?.slate).toBe(2);
    expect(s2.say).toBe(s1.say);
    const s3 = pointBloom(env(), s2, P);
    expect(s3.target).toEqual({ kind: 'hub' });
    expect(s3.say?.slate).toBe(3);
    // the state it came from is untouched
    expect(s1.target).toMatchObject({ kind: 'device' });
  });

  it('opens a desktop’s profiles on reach, onward along its spoke', () => {
    const s = reach(open(), 'mini');
    expect(s.open?.item.device.id).toBe('mini');
    expect(s.open?.readyAt).toBe(1000 + BLOOM.settle);
    expect(s.l2.map((b) => [b.item.profile?.id, b.name, b.face])).toEqual([
      ['native', 'DEFAULT', { kind: 'glyph', glyph: 'laptop', filled: true }],
      ['personal', 'PERSONAL', { kind: 'glyph', glyph: 'house', filled: false }],
    ]);
    const mini = budOf(s, 'mini');
    for (const b of s.l2) {
      expect(Math.hypot(b.x - (mini?.x ?? 0), b.y - (mini?.y ?? 0))).toBeCloseTo(BLOOM.r2);
      expect([b.hx, b.hy]).toEqual([mini?.x, mini?.y]);
    }
    // still in the settle window: the desktop stays targeted
    expect(s.target).toMatchObject({ kind: 'device' });
  });

  it('takes a profile once the ring settles, and collapses back toward the hub', () => {
    const s1 = reach(open(), 'mini');
    const personal = budOf(s1, 'mini', 'personal');
    const early = pointBloom(env(1050), s1, { x: personal?.x ?? 0, y: personal?.y ?? 0 });
    expect(early.target).toMatchObject({ kind: 'device' });
    const s2 = pointBloom(env(1100), s1, { x: personal?.x ?? 0, y: personal?.y ?? 0 });
    expect(s2.target).toMatchObject({ kind: 'profile' });
    expect(text(s2)).toBe('Open as Personal');
    const s3 = pointBloom(env(1200), s2, P);
    expect(s3.open).toBeNull();
    expect(s3.l2).toEqual([]);
    expect(s3.target).toEqual({ kind: 'hub' });
    // every desktop's words are back where the first ring put them
    for (const b of s3.l1) expect([b.box, b.short, b.gone]).toEqual([b.home.box, b.home.short, false]);
  });

  it('switches to a sibling desktop reached at ring radius', () => {
    const s1 = reach(open('three'), 'mini');
    const studio = budOf(s1, 'studio');
    const s2 = pointBloom(env(1200), s1, { x: studio?.x ?? 0, y: studio?.y ?? 0 });
    expect(s2.open?.item.device.id).toBe('studio');
    expect(s2.l2.map((b) => b.item.profile?.id)).toEqual(['native', 'work', 'demo']);
  });

  it('leaves a closed bloom alone', () => {
    const closed = cancelBloom(env(), open());
    expect(pointBloom(env(), closed, P)).toBe(closed);
  });
});

describe('commitBloom', () => {
  it('the hub opens this desktop under its default, born at the hub', () => {
    const out = commitBloom(env(), open());
    expect(out.choice).toMatchObject({
      deviceId: 'studio',
      profileSet: 'work',
      at: P,
      via: 'hub',
      from: { d: BLOOM.hubR * 2, fill: 'surface' },
    });
    expect(out.state.closed).toMatchObject({ reason: 'commit', chosen: null, grow: null, sayHold: BLOOM.sayHold });
    expect(text(out.state)).toBe('Opening terminal');
  });

  it('a desktop opens under its default; a profile exactly; born where you let go (SB-D2)', () => {
    const s0 = open();
    const onMini = commitBloom(env(), pointBloom(env(), s0, toward(s0, 'mini', 0.5)));
    const miniBud = budOf(s0, 'mini');
    expect(onMini.choice).toMatchObject({ deviceId: 'mini', profileSet: 'native', via: 'device' });
    expect(onMini.choice?.at).toEqual({ x: miniBud?.x, y: miniBud?.y });

    const s1 = reach(s0, 'mini');
    const personal = budOf(s1, 'mini', 'personal');
    const s2 = pointBloom(env(1100), s1, { x: personal?.x ?? 0, y: personal?.y ?? 0 });
    const out = commitBloom(env(1100, { idleRadius: 50 }), s2);
    expect(out.choice).toMatchObject({
      deviceId: 'mini',
      profileSet: 'personal',
      via: 'profile',
      at: { x: personal?.x, y: personal?.y },
      from: { d: BLOOM.bud2 * BLOOM.hot, fill: 'ink' },
    });
    expect(out.state.closed?.chosen).toBe(personal?.id);
    expect(out.state.closed?.grow).toBeCloseTo(100 / BLOOM.bud2);
    expect(text(out.state)).toBe('Opening as Personal');
    // the rest go back along their spokes, the first few a little apart
    const view = bloomView(out.state);
    expect(view.buds.filter((b) => b.chosen).map((b) => b.id)).toEqual([personal?.id]);
    expect(view.buds.filter((b) => b.back)).toHaveLength(3);
    expect(view.buds.map((b) => b.exitDelay)).toEqual([0, 12, 24, 0]);
  });

  it('a faint desktop opens nothing, and says which', () => {
    const s0 = open('three');
    const s1 = pointBloom(env(), s0, toward(s0, 'air', 0.5));
    expect(text(s1)).toBe('Air is asleep');
    const out = commitBloom(env(), s1);
    expect(out.choice).toBeNull();
    expect(out.unready?.id).toBe('air');
    expect(out.state.closed?.reason).toBe('cancel');
  });

  it('open ground opens nothing', () => {
    const s0 = open();
    const s1 = pointBloom(env(), s0, at(90, 60));
    expect(s1.target).toEqual({ kind: 'none' });
    expect(text(s1)).toBe('Cancel');
    const out = commitBloom(env(), s1);
    expect(out.choice).toBeNull();
    expect(out.unready).toBeUndefined();
  });

  it('a closed bloom commits nothing more', () => {
    const done = commitBloom(env(), open()).state;
    expect(commitBloom(env(), done)).toEqual({ choice: null, state: done });
  });
});

describe('keyBloom', () => {
  it('the keyboard door opens focused on the first bud, without a tether', () => {
    const s = open('two', 'keys');
    expect(s.focus).toBe(0);
    expect(s.target).toMatchObject({ kind: 'device', item: { device: { id: 'studio' } } });
    expect(bloomView(s).activeDescendant).toBe(s.l1[0]?.id);
    expect(keysOrigin({ w: 1000, h: 600 })).toEqual({ x: 500, y: 372 });
  });

  it('arrows cycle, ↵ opens a desktop at its default profile, ↵ again commits it', () => {
    const s0 = open('two', 'keys');
    const s1 = keyBloom(env(), s0, 'ArrowRight').state;
    expect(s1.focus).toBe(1);
    const s2 = keyBloom(env(), s1, 'ArrowRight').state;
    expect(s2.focus).toBe(0);
    const s3 = keyBloom(env(), s2, 'ArrowLeft').state;
    expect(s3.focus).toBe(1);
    const opened = keyBloom(env(), s3, 'Enter');
    expect(opened.commit).toBeUndefined();
    expect(opened.state.open?.item.device.id).toBe('mini');
    expect(opened.state.target).toMatchObject({ kind: 'profile', item: { profile: { id: 'native' } } });
    expect(text(opened.state)).toBe('Open on mini');
    expect(opened.state.words?.detail).toBe('UNDER DEFAULT · ALPHA · BETA · GAMMA · DELTA SIGNED IN');
    const done = keyBloom(env(), keyBloom(env(), opened.state, 'ArrowRight').state, ' ');
    expect(done.commit?.choice).toMatchObject({ deviceId: 'mini', profileSet: 'personal', via: 'profile' });
  });

  it('Esc backs out of an open desktop, then cancels', () => {
    const opened = keyBloom(env(), keyBloom(env(), open('two', 'sticky'), '2').state, 'Escape');
    expect(opened.state.open).toBeNull();
    expect(opened.state.focus).toBe(1);
    expect(opened.cancel).toBeUndefined();
    const gone = keyBloom(env(), opened.state, 'Escape');
    expect(gone.cancel).toBe(true);
    expect(gone.state.closed?.reason).toBe('cancel');
  });

  it('digits pick, 0 is the hub, and with no focus ↵ is the hub', () => {
    const picked = keyBloom(env(), open('one-three', 'sticky'), '3');
    expect(picked.commit?.choice).toMatchObject({ deviceId: 'studio', profileSet: 'demo' });
    expect(keyBloom(env(), open('two', 'sticky'), '0').commit?.choice).toMatchObject({
      via: 'hub',
      profileSet: 'work',
    });
    expect(keyBloom(env(), open('two', 'sticky'), 'Enter').commit?.choice).toMatchObject({ via: 'hub' });
    const none = keyBloom(env(), open('two', 'sticky'), '9');
    expect(none.handled).toBe(true);
    expect(none.commit).toBeUndefined();
  });

  it('a hold takes only Esc', () => {
    const s = open('two', 'hold');
    expect(keyBloom(env(), s, 'ArrowRight')).toEqual({ state: s, handled: false });
    expect(keyBloom(env(), s, 'Escape').cancel).toBe(true);
  });
});

describe('bloomView and litOf', () => {
  const row = (patch: Partial<MonitorAgent>): MonitorAgent => ({
    id: 'r',
    createdAtMs: 0,
    status: 'idle',
    project: '',
    detail: '',
    color: '',
    active: false,
    ...patch,
  });
  const local = row({ id: 'local', profileSet: 'work' });
  const localDemo = row({ id: 'demo', profileSet: 'demo' });
  const peer = (profileSet?: string) =>
    row({
      id: 'peer',
      profileSet,
      remote: {
        deviceId: 'mini',
        deviceName: 'mini',
        remoteSessionId: 'x',
        attachable: true,
        hostWritable: true,
        cwdLabel: null,
      },
    });

  it('draws the veil, the hub, ring one’s clearing and the words’ while open', () => {
    const view = bloomView(open());
    expect(view.open).toBe(true);
    expect(view.veil).toBe(BLOOM.veil);
    expect(view.hub).toEqual(P);
    expect(view.level).toBe(1);
    expect(view.tether).toBeNull();
    expect(view.clearings.map((c) => c.kind)).toEqual(['circle', 'rect']);
    const ring = view.clearings[0];
    expect(ring?.kind === 'circle' && ring.radius).toBeGreaterThan(BLOOM.r1 + BLOOM.clearPad);
  });

  it('adds ring two’s clearing, the path and the dimmed siblings when a desktop opens', () => {
    const s = reach(open(), 'mini');
    const view = bloomView(s);
    expect(view.level).toBe(2);
    expect(view.clearings.map((c) => c.kind)).toEqual(['circle', 'circle', 'rect']);
    expect(view.buds.filter((b) => b.path).map((b) => b.item.device.id)).toEqual(['mini']);
    expect(view.buds.filter((b) => b.dim).map((b) => b.item.device.id)).toEqual(['studio']);
    // the tether runs from the hub's rim through the open desktop to the pointer
    expect(view.tether).toHaveLength(3);
    expect(Math.hypot((view.tether?.[0]?.x ?? 0) - P.x, (view.tether?.[0]?.y ?? 0) - P.y)).toBeCloseTo(BLOOM.hubR);
  });

  it('marks the targeted bud hot and leans the near one', () => {
    const s0 = open();
    const view = bloomView(pointBloom(env(), s0, toward(s0, 'mini', 0.6)));
    const [studio, mini] = view.buds;
    expect(mini?.hot).toBe(true);
    expect(mini?.lean).toBe(0);
    expect(studio?.hot).toBe(false);
    expect(studio?.lean).toBeGreaterThan(0);
  });

  it('lights this desktop’s rows under the hub’s default, a peer’s rows, a profile’s rows', () => {
    const s0 = open();
    expect([local, localDemo, peer('personal')].map(litOf(s0))).toEqual([true, false, false]);
    const onMini = pointBloom(env(), s0, toward(s0, 'mini', 0.5));
    expect([local, peer(), peer('personal')].map(litOf(onMini))).toEqual([false, true, true]);
    const s1 = reach(s0, 'mini');
    const personal = budOf(s1, 'mini', 'personal');
    const onPersonal = pointBloom(env(1100), s1, { x: personal?.x ?? 0, y: personal?.y ?? 0 });
    expect([peer(), peer('personal'), local].map(litOf(onPersonal))).toEqual([false, true, false]);
    const ground = pointBloom(env(), s0, at(90, 60));
    expect([local, peer()].map(litOf(ground))).toEqual([false, false]);
    expect(litOf(cancelBloom(env(), s0))(local)).toBe(false);
  });

  it('keeps only the words’ clearing after a commit, and nothing after a cancel', () => {
    expect(bloomView(commitBloom(env(), open()).state).clearings.map((c) => c.kind)).toEqual(['rect']);
    const cancelled = bloomView(cancelBloom(env(), open()));
    expect(cancelled.clearings).toEqual([]);
    expect(cancelled.veil).toBe(0);
    expect(cancelled.open).toBe(false);
  });
});
