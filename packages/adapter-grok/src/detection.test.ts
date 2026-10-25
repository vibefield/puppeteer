import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GROK_ADAPTER_CAPABILITIES,
  GROK_EXECUTABLE_ENV,
  GROK_SURFACE_REVISION,
  GROK_SURFACE_VERSION,
  GROK_VERSION_FLAG,
  GROK_VERSION_PATTERN,
  parseGrokVersion,
  resolveGrokExecutable,
} from './detection.js';

// The stable vendor-root ground truth is the one runtime authority; the pin
// must follow whichever version it currently embeds.
const groundTruth = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../surface/vendors/grok/groundtruth.json'), 'utf8'),
) as {
  manifest: { vendorVersion: string };
  detection: { envVar: string; versionFlag: string; versionOutput: string; versionPattern: string };
};

describe('Grok detection contract', () => {
  it('accepts only the complete native version identity', () => {
    expect(parseGrokVersion('grok 1.0.70 (f50904eaee6c)\n')).toEqual({
      version: '1.0.70',
      revision: 'f50904eaee6c',
    });
    expect(parseGrokVersion('grok 1.0.0 (3cd0d0cbcebe) [stable]\n')).toEqual({
      version: '1.0.0',
      revision: '3cd0d0cbcebe',
      channel: 'stable',
    });
    expect(parseGrokVersion('grok 1.0.0')).toBeUndefined();
    expect(parseGrokVersion('1.0.0 (3cd0d0cbcebe) [stable]')).toBeUndefined();
  });

  it('pins the version, revision, and version grammar of the selected ground truth', () => {
    expect(GROK_SURFACE_VERSION).toBe(groundTruth.manifest.vendorVersion);
    expect(parseGrokVersion(groundTruth.detection.versionOutput)).toEqual({
      version: GROK_SURFACE_VERSION,
      revision: GROK_SURFACE_REVISION,
    });
    expect(GROK_VERSION_PATTERN.source).toBe(groundTruth.detection.versionPattern);
    expect(GROK_VERSION_FLAG).toBe(groundTruth.detection.versionFlag);
    expect(GROK_EXECUTABLE_ENV).toBe(groundTruth.detection.envVar);
  });

  it('keeps executable precedence and native capability facts inside the adapter', () => {
    expect(resolveGrokExecutable('/exact/grok', { PUPPETEER_GROK_BIN: '/env/grok' })).toBe('/exact/grok');
    expect(resolveGrokExecutable(undefined, { PUPPETEER_GROK_BIN: '/env/grok' })).toBe('/env/grok');
    expect(resolveGrokExecutable(undefined, {})).toBe('grok');
    expect(GROK_SURFACE_VERSION).toBe('1.0.70');
    expect(GROK_SURFACE_REVISION).toBe('f50904eaee6c');
    expect(GROK_ADAPTER_CAPABILITIES).toMatchObject({
      executionMode: 'native-tui',
      observationLevel: 'native-log',
      controlProtocol: 'acp',
      sharedLeader: true,
    });
  });
});
