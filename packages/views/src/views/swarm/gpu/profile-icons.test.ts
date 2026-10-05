import { describe, expect, it } from 'vitest';
import { PROFILE_GLYPH_SHAPES, profileGlyphMarkup, type ProfileMarkName } from '@vibecook/puppeteer-view-sdk/toolkit';
import { profileIcon } from '../bubble-model.js';
import { PROFILE_ICON_PREFIX, profileIconSvg } from './profile-icons.js';

// The profile marks in the swarm's atlas are ProfileGlyph's own shapes, scaled
// from its 20-unit grid into the atlas's 24 box: never a second copy.

describe('the profile marks in the atlas', () => {
  const marks = Object.keys(PROFILE_GLYPH_SHAPES) as ProfileMarkName[];

  it('draws all eleven tokens and the laptop, outlined and filled, from ProfileGlyph’s shapes', () => {
    expect(marks).toHaveLength(12);
    expect(marks).toContain('laptop');
    for (const mark of marks) {
      const outline = profileIconSvg(mark)!;
      const filled = profileIconSvg(`${mark}:filled`)!;
      for (const svg of [outline, filled]) {
        expect(svg).toContain('viewBox="0 0 24 24"');
        expect(svg).toContain('transform="scale(1.2)"');
        expect(svg).toContain(profileGlyphMarkup(mark));
      }
      expect(outline).toContain('fill="none"');
      expect(outline).toContain('stroke-width="1.7"');
      expect(filled).toContain('fill="currentColor"');
      expect(filled).toContain('stroke-width="1.3"');
    }
  });

  it('keeps a rounded box a rect, as the DOM draws it', () => {
    expect(profileIconSvg('laptop')).toContain('<rect x="4" y="4.5" width="12" height="8.5" rx="1.6"/>');
    expect(profileIconSvg('briefcase')).toContain('<rect x="3" y="7" width="14" height="9" rx="2"/>');
  });

  it('draws nothing for a mark this build does not know', () => {
    expect(profileIconSvg('telescope')).toBeUndefined();
    expect(profileIconSvg('')).toBeUndefined();
    expect(profileIconSvg('toString')).toBeUndefined();
  });

  it('answers every name the model gives a profile', () => {
    const names = [
      profileIcon({ label: 'Work', glyph: 'briefcase', isDefault: true }),
      profileIcon({ label: 'Personal', glyph: 'house' }),
      profileIcon({ label: 'This Mac', kind: 'native' }),
      profileIcon({ label: 'Odd', glyph: 'telescope' }),
    ];
    expect(names).toEqual(['profile:briefcase:filled', 'profile:house', 'profile:laptop', 'profile:star']);
    for (const name of names) {
      expect(name.startsWith(PROFILE_ICON_PREFIX)).toBe(true);
      expect(profileIconSvg(name.slice(PROFILE_ICON_PREFIX.length))).toBeDefined();
    }
  });
});
