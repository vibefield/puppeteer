import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { approximateBloomMeasure } from './canvas-measure.js';
import type { BloomPoint } from './geometry.js';
import { commitBloom, isInstant, keyBloom, openBloom, pointBloom, type BloomEnv, type BloomState } from './model.js';
import { BLOOM_SCENARIOS, type BloomScenarioId } from './scenarios.js';
import { SpawnBloom, bloomTargetWord } from './SpawnBloom.js';

// The overlay's MARKUP in posed states from the core: what a screen reader, a
// host's pointer tests (VibeField mounts the real AgentSwarm under happy-dom)
// and the catalog reach. The motion is CSS and needs a document; these pin the
// classes and hooks that motion keys off.

const env = (now = 1000): BloomEnv => ({ field: { w: 1000, h: 600 }, measure: approximateBloomMeasure, now });
const P: BloomPoint = { x: 500, y: 350 };

function open(id: BloomScenarioId, mode: 'hold' | 'sticky' | 'keys' = 'hold'): BloomState {
  const opened = openBloom(env(), P, mode, BLOOM_SCENARIOS[id]);
  if (isInstant(opened)) throw new Error('expected a bloom');
  return opened;
}

function budOf(s: BloomState, device: string, profile?: string) {
  const bud = [...s.l1, ...s.l2].find(
    (b) =>
      b.item.device.id === device &&
      (profile === undefined ? b.kind === 'device' : b.kind === 'profile' && b.item.profile?.id === profile),
  );
  if (!bud) throw new Error(`no bud ${device}/${profile ?? ''}`);
  return bud;
}

/** Point just past a bud from where its ring grows (reaching a desktop opens it). */
function toward(s: BloomState, device: string, profile?: string, now = 1000): BloomState {
  const bud = budOf(s, device, profile);
  return pointBloom(env(now), s, { x: bud.hx + (bud.x - bud.hx) * 1.02, y: bud.hy + (bud.y - bud.hy) * 1.02 });
}

const html = (state: BloomState | null) => renderToStaticMarkup(<SpawnBloom state={state} posed />);
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

describe('the spawn bloom, posed', () => {
  it('keeps only its live region between blooms', () => {
    const idle = html(null);
    expect(idle).toContain('data-bloom-state="idle"');
    expect(idle).toContain('aria-live="polite"');
    expect(idle).not.toContain('role="menu"');
  });

  it('level one: one desktop blooms its profiles around the hub, the default filled and dotted', () => {
    const markup = html(open('one-three'));
    expect(markup).toContain('role="menu" aria-label="New terminal"');
    expect(markup).toContain('data-bloom-state="open"');
    expect(markup).toContain('data-bloom-level="1"');
    expect(markup).toContain('data-bloom-mode="hold"');
    expect(markup).toContain('data-bloom-target="hub"');
    expect(count(markup, /role="menuitem"/g)).toBe(3);
    expect(count(markup, /data-bloom-bud-kind="profile"/g)).toBe(3);
    expect(count(markup, /class="vf-bloom-bud is-out/g)).toBe(3);
    // This Mac is the laptop; Work (the default) is filled and waits on the person
    expect(markup).toContain('data-profile-glyph="laptop"');
    expect(markup).toMatch(
      /data-bloom-bud-id="work"[^>]*>.*?<svg[^>]*fill="currentColor"[^>]*data-profile-glyph="briefcase"/,
    );
    expect(count(markup, /class="vf-bloom-dot"/g)).toBe(1);
    // labels are seated, and hidden from the accessibility tree (the bud names itself)
    expect(count(markup, /class="vf-bloom-label is-out/g)).toBe(3);
    expect(markup).toContain('aria-label="Work, default"');
  });

  it('the words: a slate with the verb stepped back, the noun at full ink and the detail line', () => {
    const markup = html(open('one-three'));
    expect(markup).toContain('data-bloom-words="New terminal"');
    expect(markup).toContain('<span class="v">New </span><span class="n">terminal</span>');
    expect(markup).toContain('<div class="vf-bloom-say-detail">UNDER WORK · THE DEFAULT</div>');
    expect(markup).toMatch(/class="vf-bloom-say"[^>]*data-tone="go"/);
  });

  it('level two: reaching a desktop lifts it, dims its siblings and blooms its profiles from it', () => {
    const s = toward(open('two'), 'mini');
    expect(s.open?.item.device.id).toBe('mini');
    const markup = html(s);
    expect(markup).toContain('data-bloom-level="2"');
    expect(markup).toContain('data-bloom-target="device:mini"');
    expect(markup).toMatch(/class="vf-bloom-bud is-out is-hot is-path"[^>]*data-bloom-bud-id="mini"/);
    expect(markup).toMatch(/class="vf-bloom-bud is-out is-dim"[^>]*data-bloom-bud-id="studio"/);
    expect(count(markup, /data-bloom-ring="2"/g)).toBe(2);
    // a peer's native set reads DEFAULT (SB-D10)
    expect(markup).toContain('aria-label="DEFAULT, default, on mini"');
    expect(markup).toContain('data-bloom-words="Open on mini"');
    expect(markup).toContain('>UNDER DEFAULT</div>');
    // the tether runs from the hub's rim through the open desktop to the pointer
    expect(markup).toMatch(/<path class="vf-bloom-tether" d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+"/);
  });

  it('a profile on the second ring, once the ring has settled', () => {
    const s = toward(toward(open('two'), 'mini'), 'mini', 'personal', 2000);
    const markup = html(s);
    expect(markup).toContain('data-bloom-target="profile:personal"');
    expect(markup).toMatch(/class="vf-bloom-bud is-out is-hot"[^>]*data-bloom-bud-id="personal"/);
    expect(markup).toContain('data-bloom-words="Open as Personal"');
    expect(bloomTargetWord(s.target)).toBe('profile:personal');
  });

  it('a faint desktop is disabled, dashed, and the words say why nothing opens', () => {
    const s = toward(open('three'), 'air');
    const markup = html(s);
    expect(markup).toContain('data-bloom-target="device:air"');
    expect(markup).toMatch(
      /class="vf-bloom-bud is-out is-hot is-off"[^>]*aria-disabled="true"[^>]*data-bloom-bud-id="air"/,
    );
    expect(markup).toContain('<small>ASLEEP · 2 H</small>');
    expect(markup).toMatch(/data-tone="off"[^>]*data-bloom-words="Air is asleep"/);
    expect(markup).toContain('NOTHING OPENS · ASLEEP · 2 H');
  });

  it('keys: the first bud is focused and named as the active descendant, the menu holds the keys', () => {
    const s = open('three', 'keys');
    const markup = html(s);
    expect(markup).toContain('data-bloom-mode="keys"');
    expect(markup).toContain('data-bloom-holds-keys="true"');
    const active = /aria-activedescendant="([^"]+)"/.exec(markup)?.[1];
    expect(active).toBeTruthy();
    expect(markup).toMatch(new RegExp(`id="${active}" class="vf-bloom-bud is-out is-hot is-focus"`));
    expect(markup).toContain('data-bloom-words="Open on studio"');
    // no tether from the keyboard
    expect(markup).not.toContain('vf-bloom-tether');
    // ↵ on a desktop that blooms opens it, focusing its default
    const opened = keyBloom(env(1100), s, 'Enter').state;
    const next = html(opened);
    expect(next).toContain('data-bloom-level="2"');
    expect(next).toContain('data-bloom-target="profile:work"');
  });

  it('a hold never holds the keys (the pointer does); a secondary click does', () => {
    expect(html(open('two'))).not.toContain('data-bloom-holds-keys');
    expect(html(open('two', 'sticky'))).toContain('data-bloom-holds-keys="true"');
  });

  it('after letting go: the chosen bud grows into the body, the rest go home, the words say Opening', () => {
    const s = toward(open('one-three'), 'studio', 'demo');
    const done = commitBloom({ ...env(1200), idleRadius: 50 }, s);
    expect(done.choice?.profileSet).toBe('demo');
    const markup = html(done.state);
    expect(markup).toContain('data-bloom-state="committed"');
    expect(markup).toMatch(
      /class="vf-bloom-bud is-out is-chosen is-hot"[^>]*data-bloom-bud-id="demo"[^>]*--vf-bloom-grow:2\.08/,
    );
    expect(count(markup, /class="vf-bloom-bud is-back/g)).toBe(2);
    // every label leaves at once, the chosen one's too
    expect(markup).not.toContain('vf-bloom-label is-out');
    expect(markup).toContain('data-bloom-words="Opening as Demo"');
    expect(markup).not.toContain('aria-activedescendant');
  });

  it('a cancel closes without a chosen bud', () => {
    const s = pointBloom(env(), open('two'), { x: P.x, y: P.y + 200 });
    const done = commitBloom(env(1200), s);
    expect(done.choice).toBeNull();
    const markup = html(done.state);
    expect(markup).toContain('data-bloom-state="cancelled"');
    expect(markup).not.toContain('is-chosen');
  });
});
