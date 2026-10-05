import { describe, expect, it } from 'vitest';
import { PROFILE_GLYPHS } from '@vibecook/puppeteer-view-sdk/toolkit';
import { suggestProfileGlyph } from './profile-glyph-suggest.js';

describe('the glyph a new set is offered', () => {
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
