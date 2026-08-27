import { describe, expect, it } from 'vitest';
import {
  GROK_ADAPTER_CAPABILITIES,
  GROK_SURFACE_REVISION,
  GROK_SURFACE_VERSION,
  parseGrokVersion,
  resolveGrokExecutable,
} from './detection.js';

describe('Grok detection contract', () => {
  it('accepts only the complete native version identity', () => {
    expect(parseGrokVersion('grok 1.0.0 (3cd0d0cbcebe) [stable]\n')).toEqual({
      version: '1.0.0',
      revision: '3cd0d0cbcebe',
      channel: 'stable',
    });
    expect(parseGrokVersion('grok 1.0.0 (3cd0d0cbcebe)')).toEqual({
      version: '1.0.0',
      revision: '3cd0d0cbcebe',
    });
    expect(parseGrokVersion('grok 1.0.0')).toBeUndefined();
    expect(parseGrokVersion('1.0.0 (3cd0d0cbcebe) [stable]')).toBeUndefined();
  });

  it('keeps executable precedence and native capability facts inside the adapter', () => {
    expect(resolveGrokExecutable('/exact/grok', { PUPPETEER_GROK_BIN: '/env/grok' })).toBe('/exact/grok');
    expect(resolveGrokExecutable(undefined, { PUPPETEER_GROK_BIN: '/env/grok' })).toBe('/env/grok');
    expect(resolveGrokExecutable(undefined, {})).toBe('grok');
    expect(GROK_SURFACE_VERSION).toBe('1.0.0');
    expect(GROK_SURFACE_REVISION).toBe('3cd0d0cbcebe');
    expect(GROK_ADAPTER_CAPABILITIES).toMatchObject({
      executionMode: 'native-tui',
      observationLevel: 'native-log',
      controlProtocol: 'acp',
      sharedLeader: true,
    });
  });
});
