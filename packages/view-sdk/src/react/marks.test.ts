import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PROFILE_GLYPHS, profileGlyphName } from '../toolkit/marks.js';
import { AgentIcon, ProfileGlyph, type ProfileGlyphProps } from './index.js';

// The React marks views share (M6), moved from the views package with byte-identical markup: the views' own copies
// were rendered beside these over every glyph × kind × fill × size × title × class and every provider (2,119
// renders) before they were deleted. The literals below are what those copies rendered.

const glyph = (props: ProfileGlyphProps): string => renderToStaticMarkup(createElement(ProfileGlyph, props));
const icon = (providerId: string): string => renderToStaticMarkup(createElement(AgentIcon, { providerId }));

describe('ProfileGlyph', () => {
  it('draws every glyph on the 20-grid as a line, and fills the default', () => {
    for (const name of PROFILE_GLYPHS) {
      const markup = glyph({ glyph: name });
      expect(markup).toContain('viewBox="0 0 20 20"');
      expect(markup).toContain(`data-profile-glyph="${name}"`);
      expect(markup).toContain('fill="none"');
      expect(markup).toContain('aria-hidden="true"');
    }
    const filled = glyph({ glyph: 'briefcase', filled: true, size: 28 });
    expect(filled).toContain('fill="currentColor"');
    expect(filled).toContain('stroke-width="1.1"');
    expect(filled).toContain('width="28"');
  });

  it('renders the markup the views’ copy rendered', () => {
    expect(glyph({ glyph: 'bolt' })).toBe(
      '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"' +
        ' stroke-linecap="round" stroke-linejoin="round" data-profile-glyph="bolt" aria-hidden="true">' +
        '<path d="M11 3 4.5 11.5H9.5L9 17l6.5-8.5h-5z"></path></svg>',
    );
    expect(glyph({ kind: 'native', glyph: 'rocket', title: 'This Mac', className: 'x', size: 12, filled: true })).toBe(
      '<svg viewBox="0 0 20 20" width="12" height="12" class="x" fill="currentColor" stroke="currentColor"' +
        ' stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" data-profile-glyph="laptop" role="img"' +
        ' aria-label="This Mac"><rect x="4" y="4.5" width="12" height="8.5" rx="1.6"></rect>' +
        '<path d="M2.5 15.5h15"></path></svg>',
    );
  });

  it('draws the native set as the laptop whatever glyph it is handed, and the star for a token it does not draw', () => {
    expect(glyph({ kind: 'native', glyph: 'rocket' })).toContain('data-profile-glyph="laptop"');
    expect(glyph({ glyph: 'telescope' })).toContain('data-profile-glyph="star"');
    expect(profileGlyphName('moon')).toBe('moon');
  });
});

describe('AgentIcon', () => {
  it('draws a provider’s paths at the text’s size in the ink it sits in, and a letter for anyone else', () => {
    expect(icon('opencode')).toBe(
      '<svg aria-hidden="true" fill="currentColor" height="1em" viewBox="0 0 24 24" width="1em"' +
        ' xmlns="http://www.w3.org/2000/svg"><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"></path></svg>',
    );
    expect(icon('pi')).toContain('fill-rule="evenodd" clip-rule="evenodd"');
    expect(icon('acp')).toBe('<span aria-hidden="true">A</span>');
    expect(icon('zed')).toBe('<span aria-hidden="true">Z</span>');
    expect(icon('')).toBe('<span aria-hidden="true">?</span>');
  });
});
