import { describe, expect, it } from 'vitest';
import {
  KIMI_ADAPTER_CAPABILITIES,
  KIMI_SURFACE_VERSION,
  parseKimiVersion,
  resolveKimiExecutable,
} from './detection.js';

describe('Kimi detection contract', () => {
  it('parses exact semantic version output without accepting unrelated numbers', () => {
    expect(parseKimiVersion('0.34.0\n')).toBe('0.34.0');
    expect(parseKimiVersion('kimi v0.34.0-beta.1')).toBe('0.34.0-beta.1');
    expect(parseKimiVersion('build 34')).toBeUndefined();
  });

  it('keeps executable selection inside the adapter with explicit, environment, then default precedence', () => {
    expect(resolveKimiExecutable('/exact/kimi', { PUPPETEER_KIMI_BIN: '/env/kimi' })).toBe('/exact/kimi');
    expect(resolveKimiExecutable(undefined, { PUPPETEER_KIMI_BIN: '/env/kimi' })).toBe('/env/kimi');
    expect(resolveKimiExecutable(undefined, {})).toBe('kimi');
  });

  it('reports the candidate boundary without overstating approval or hook control', () => {
    expect(KIMI_SURFACE_VERSION).toBe('0.34.0');
    expect(KIMI_ADAPTER_CAPABILITIES).toMatchObject({
      executionMode: 'native-tui',
      observationLevel: 'native-log',
      durableWireProtocol: '1.5',
      structuredApprovalControl: false,
      launchScopedHooks: false,
    });
  });
});
