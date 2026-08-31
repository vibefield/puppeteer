import { describe, expect, it } from 'vitest';
import { PI_SURFACE_VERSION, parsePiVersion, resolvePiExecutable } from './detection.js';

describe('Pi detection', () => {
  it('resolves explicit, environment, and installed command precedence', () => {
    expect(resolvePiExecutable('/opt/pi', { PUPPETEER_PI_BIN: '/env/pi' })).toBe('/opt/pi');
    expect(resolvePiExecutable(undefined, { PUPPETEER_PI_BIN: '/env/pi' })).toBe('/env/pi');
    expect(resolvePiExecutable(undefined, {})).toBe('pi');
  });

  it('parses only a complete semantic version token', () => {
    expect(parsePiVersion(`pi v${PI_SURFACE_VERSION}`)).toBe(PI_SURFACE_VERSION);
    expect(parsePiVersion('pi unknown')).toBeUndefined();
  });
});
