import { describe, expect, it } from 'vitest';
import * as react from '@vibecook/puppeteer-view-sdk/react';
import * as toolkit from '@vibecook/puppeteer-view-sdk/toolkit';
import * as views from '../src/index.js';

// THE VIEWS INDEX FORWARDS NO SDK NAME (M54, MV-8). AgentIcon, ProfileGlyph and the mark tables moved into the SDK
// (M6) and were forwarded here for a while so hosts kept reaching them; a host imports them from the SDK now.

describe('the views package’s index', () => {
  it('re-exports nothing of the SDK’s /react or /toolkit (its own copies of a few helpers are its own)', () => {
    const sdk = new Map<string, unknown>([...Object.entries(react), ...Object.entries(toolkit)]);
    const forwarded = Object.entries(views).filter(([name, value]) =>
      typeof value === 'function' || (typeof value === 'object' && value !== null) ? sdk.get(name) === value : false,
    );
    expect(forwarded.map(([name]) => name)).toEqual([]);
  });

  it('in particular, none of the marks it used to forward', () => {
    for (const name of [
      'AgentIcon',
      'ProfileGlyph',
      'AGENT_MARK_ATLAS',
      'AGENT_MARK_CANDIDATES',
      'AGENT_MARK_PROVIDERS',
      'agentMark',
      'agentMarkSvg',
      'agentMarkTile',
      'PROFILE_GLYPH_SHAPES',
      'PROFILE_GLYPHS',
      'profileGlyphMarkup',
      'profileGlyphName',
      'profileMarkName',
    ]) {
      expect([name, name in views]).toEqual([name, false]);
    }
  });
});
