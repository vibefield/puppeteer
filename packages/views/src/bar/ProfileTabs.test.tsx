import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InstrumentBar } from './InstrumentBar.js';
import { ProfileTabs, type ProfileTab } from './ProfileTabs.js';

// The strip's MARKUP: what a screen reader and a host's harness reach. The
// thumb's slide and the fit to a narrow bar need layout, and are the host's
// capture to witness.

const TABS: readonly ProfileTab[] = [
  { id: 'native', label: 'This Mac', kind: 'native' },
  { id: 'personal', label: 'Personal', glyph: 'house', isDefault: true },
  { id: 'work', label: 'Work', glyph: 'briefcase', blocked: true },
];
const NOOP = () => undefined;

function tabs(html: string): string[] {
  return [...html.matchAll(/data-profile-tab="([^"]+)"/g)].map((match) => match[1]!);
}

describe('ProfileTabs', () => {
  it('leads with All, then every profile in the host order, as one tablist', () => {
    const html = renderToStaticMarkup(<ProfileTabs tabs={TABS} selected={null} onSelect={NOOP} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Agent profiles"');
    expect(tabs(html)).toEqual(['all', 'native', 'personal', 'work']);
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toContain('>All</span>');
    expect(html).toContain('>This Mac</span>');
    // one thumb, drawn by the strip and read by no one
    expect(html.match(/vf-godview-profile-thumb/g)).toHaveLength(1);
  });

  it('marks the chosen tab, and lets only it take focus', () => {
    const html = renderToStaticMarkup(<ProfileTabs tabs={TABS} selected="work" onSelect={NOOP} />);
    const chosen = html.match(/<button[^>]*data-profile-tab="work"[^>]*>/)![0];
    expect(chosen).toContain('aria-selected="true"');
    expect(chosen).toContain('tabindex="0"');
    expect(chosen).toContain('is-on');
    const all = html.match(/<button[^>]*data-profile-tab="all"[^>]*>/)![0];
    expect(all).toContain('aria-selected="false"');
    expect(all).toContain('tabindex="-1"');
  });

  it('falls back to All for a profile it does not hold', () => {
    const html = renderToStaticMarkup(<ProfileTabs tabs={TABS} selected="deleted" onSelect={NOOP} />);
    expect(html.match(/<button[^>]*data-profile-tab="all"[^>]*>/)![0]).toContain('aria-selected="true"');
  });

  it('draws the laptop for This Mac, fills the default, and dots only a profile with a blocked session', () => {
    const html = renderToStaticMarkup(<ProfileTabs tabs={TABS} selected={null} onSelect={NOOP} />);
    expect(html).toContain('data-profile-glyph="laptop"');
    const personal = html.slice(html.indexOf('data-profile-tab="personal"'), html.indexOf('data-profile-tab="work"'));
    expect(personal).toContain('data-profile-glyph="house"');
    expect(personal).toContain('fill="currentColor"');
    const work = html.slice(html.indexOf('data-profile-tab="work"'));
    expect(work).toContain('aria-label="Work, a session is blocked"');
    expect(work).toContain('vf-godview-bar-dot is-blocked');
    expect(html.match(/vf-godview-bar-dot is-blocked/g)).toHaveLength(1);
    // All has no glyph of its own
    const all = html.slice(html.indexOf('data-profile-tab="all"'), html.indexOf('data-profile-tab="native"'));
    expect(all).not.toContain('data-profile-glyph');
  });

  it('starts with every name showing', () => {
    const html = renderToStaticMarkup(<ProfileTabs tabs={TABS} selected="work" onSelect={NOOP} />);
    expect(html).toContain('vf-godview-profile-tabs is-full');
    expect(html).not.toContain('hidden=""');
  });
});

describe('InstrumentBar centre', () => {
  const base = {
    counts: { blocked: 1, working: 2, idle: 3 },
    onSelectStatus: NOOP,
    views: [],
    viewId: 'swarm',
    onSelectView: NOOP,
    theme: 'light' as const,
    onThemeChange: NOOP,
  };

  it('centres a host slot between two spacers, and keeps one spacer without it', () => {
    const without = renderToStaticMarkup(<InstrumentBar {...base} />);
    expect(without.match(/vf-godview-bar-spacer/g)).toHaveLength(1);
    const html = renderToStaticMarkup(
      <InstrumentBar {...base} centre={<ProfileTabs tabs={TABS} selected={null} onSelect={NOOP} />} />,
    );
    expect(html.match(/vf-godview-bar-spacer/g)).toHaveLength(2);
    const first = html.indexOf('vf-godview-bar-spacer');
    const strip = html.indexOf('vf-godview-profile-tabs');
    const second = html.lastIndexOf('vf-godview-bar-spacer');
    expect(first).toBeLessThan(strip);
    expect(strip).toBeLessThan(second);
    expect(second).toBeLessThan(html.indexOf('aria-label="Monitor view"'));
  });
});
