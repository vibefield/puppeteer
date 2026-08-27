import { describe, expect, it } from 'vitest';
import { resolveCodexExecutable } from './detection.js';

describe('resolveCodexExecutable', () => {
  it('prefers an explicit artifact, then the adapter environment, then the native command', () => {
    expect(resolveCodexExecutable('/exact/codex', { PUPPETEER_CODEX_BIN: '/env/codex' })).toBe('/exact/codex');
    expect(resolveCodexExecutable(undefined, { PUPPETEER_CODEX_BIN: '/env/codex' })).toBe('/env/codex');
    expect(resolveCodexExecutable(undefined, {})).toBe('codex');
  });
});
