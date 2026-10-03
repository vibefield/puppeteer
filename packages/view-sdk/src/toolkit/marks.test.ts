import { describe, expect, it } from 'vitest';
import {
  AGENT_MARK_PROVIDERS,
  agentMark,
  agentMarkSvg,
  agentMarkTile,
  PROFILE_GLYPH_SHAPES,
  profileGlyphMarkup,
  profileGlyphSvg,
  profileMarkName,
} from './marks.js';

describe('agent marks', () => {
  it('draws a known provider as paths and anyone else as a letter', () => {
    expect(agentMark('opencode')).toEqual({ kind: 'path', paths: ['M16 6H8v12h8V6zm4 16H4V2h16v20z'], evenOdd: false });
    expect(agentMark('acp')).toEqual({ kind: 'letter', letter: 'A' });
    expect(agentMark('zed')).toEqual({ kind: 'letter', letter: 'Z' });
    expect(agentMark('')).toEqual({ kind: 'letter', letter: '?' });
  });

  it('writes a standalone SVG in currentColor for an atlas', () => {
    expect(agentMarkSvg('opencode')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/></svg>',
    );
    expect(agentMarkSvg('pi')).toContain('fill-rule="evenodd"');
  });

  it("finds each chosen provider's tile, and none for a letter", () => {
    for (const provider of AGENT_MARK_PROVIDERS) expect(agentMarkTile(provider)).toBeDefined();
    expect(agentMarkTile('claude')).toEqual({ x: 0, y: 0 });
    expect(agentMarkTile('acp')).toBeUndefined();
  });
});

describe('profile glyphs', () => {
  it('draws the laptop for the native set, the token for a managed one, the star for an unknown token', () => {
    expect(profileMarkName('flask', 'native')).toBe('laptop');
    expect(profileMarkName('flask', 'managed')).toBe('flask');
    expect(profileMarkName('teapot', 'managed')).toBe('star');
  });

  it('writes the shapes as SVG elements', () => {
    expect(profileGlyphMarkup('laptop')).toBe(
      '<rect x="4" y="4.5" width="12" height="8.5" rx="1.6"/><path d="M2.5 15.5h15"/>',
    );
    expect(Object.keys(PROFILE_GLYPH_SHAPES)).toHaveLength(12);
  });

  it('writes a decorative glyph stroked, and the default set filled', () => {
    expect(profileGlyphSvg('bolt')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16" fill="none"' +
        ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"' +
        ' data-profile-glyph="bolt" aria-hidden="true"><path d="M11 3 4.5 11.5H9.5L9 17l6.5-8.5h-5z"/></svg>',
    );
    const filled = profileGlyphSvg('bolt', { filled: true, size: 12 });
    expect(filled).toContain('fill="currentColor"');
    expect(filled).toContain('stroke-width="1.1"');
    expect(filled).toContain('width="12" height="12"');
  });

  it('names a glyph that stands alone, escaping what it is told', () => {
    const titled = profileGlyphSvg('house', { title: 'Home "main" <set>', className: 'a&b' });
    expect(titled).toContain('role="img" aria-label="Home &quot;main&quot; &lt;set&gt;"');
    expect(titled).toContain('class="a&amp;b"');
    expect(titled).not.toContain('aria-hidden');
  });
});
