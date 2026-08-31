import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_SURFACE_VERSION, parseAntigravityVersion, resolveAntigravityExecutable } from './detection.js';

describe('Antigravity detection', () => {
  it('resolves explicit, environment, and installed command precedence', () => {
    expect(resolveAntigravityExecutable('/opt/agy', { PUPPETEER_ANTIGRAVITY_BIN: '/env/agy' })).toBe('/opt/agy');
    expect(resolveAntigravityExecutable(undefined, { PUPPETEER_ANTIGRAVITY_BIN: '/env/agy' })).toBe('/env/agy');
    expect(resolveAntigravityExecutable(undefined, {})).toBe('agy');
  });

  it('parses only a complete semantic version token', () => {
    expect(parseAntigravityVersion(`Antigravity CLI v${ANTIGRAVITY_SURFACE_VERSION}\n`)).toBe(
      ANTIGRAVITY_SURFACE_VERSION,
    );
    expect(parseAntigravityVersion('build 1.1')).toBeUndefined();
  });
});
