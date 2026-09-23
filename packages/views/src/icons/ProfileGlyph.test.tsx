import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PROFILE_GLYPHS, ProfileGlyph, profileGlyphName, suggestProfileGlyph } from './ProfileGlyph.js';

describe('ProfileGlyph', () => {
  it('draws every glyph on the 20-grid as a line, and fills the default', () => {
    for (const glyph of PROFILE_GLYPHS) {
      const markup = renderToStaticMarkup(<ProfileGlyph glyph={glyph} />);
      expect(markup).toContain('viewBox="0 0 20 20"');
      expect(markup).toContain(`data-profile-glyph="${glyph}"`);
      expect(markup).toContain('fill="none"');
      expect(markup).toContain('aria-hidden="true"');
    }
    const filled = renderToStaticMarkup(<ProfileGlyph glyph="briefcase" filled size={28} />);
    expect(filled).toContain('fill="currentColor"');
    expect(filled).toContain('stroke-width="1.1"');
    expect(filled).toContain('width="28"');
  });

  it('draws the native set as the laptop whatever glyph it is handed, and names a lone glyph', () => {
    const markup = renderToStaticMarkup(<ProfileGlyph kind="native" glyph="rocket" title="This Mac" />);
    expect(markup).toContain('data-profile-glyph="laptop"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="This Mac"');
  });

  it('falls back to the star for a token this build does not draw', () => {
    expect(profileGlyphName('telescope')).toBe('star');
    expect(profileGlyphName(undefined)).toBe('star');
    expect(profileGlyphName('moon')).toBe('moon');
  });

  it('suggests a glyph from what a name is for, and steadily from the name otherwise', () => {
    expect(suggestProfileGlyph('Client demo')).toBe('flask');
    expect(suggestProfileGlyph('Work')).toBe('briefcase');
    expect(suggestProfileGlyph('Personal')).toBe('house');
    expect(suggestProfileGlyph('Side project')).toBe('rocket');
    expect(suggestProfileGlyph('Late night hacking')).toBe('moon');
    const unfamiliar = suggestProfileGlyph('Zyxwv');
    expect(PROFILE_GLYPHS).toContain(unfamiliar);
    expect(suggestProfileGlyph('Zyxwv')).toBe(unfamiliar);
  });
});
