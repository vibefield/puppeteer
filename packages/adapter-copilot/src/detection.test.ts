import { describe, expect, it } from 'vitest';
import { COPILOT_SURFACE_VERSION, parseCopilotVersion, resolveCopilotExecutable } from './detection.js';

describe('Copilot detection', () => {
  it('resolves explicit, environment, and installed command precedence', () => {
    expect(resolveCopilotExecutable('/opt/copilot', { PUPPETEER_COPILOT_BIN: '/env/copilot' })).toBe('/opt/copilot');
    expect(resolveCopilotExecutable(undefined, { PUPPETEER_COPILOT_BIN: '/env/copilot' })).toBe('/env/copilot');
    expect(resolveCopilotExecutable(undefined, {})).toBe('copilot');
  });

  it('parses only a complete semantic version token', () => {
    expect(parseCopilotVersion(`GitHub Copilot CLI ${COPILOT_SURFACE_VERSION}`)).toBe(COPILOT_SURFACE_VERSION);
    expect(parseCopilotVersion('copilot development')).toBeUndefined();
    expect(parseCopilotVersion('1.0.80.5')).toBeUndefined();
  });

  it('parses the native sentence-terminated output observed on 1.0.80', () => {
    expect(parseCopilotVersion("GitHub Copilot CLI 1.0.80.\nRun 'copilot update' to check for updates.\n")).toBe(
      '1.0.80',
    );
  });
});
