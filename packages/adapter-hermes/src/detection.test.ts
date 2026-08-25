import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HERMES_ADAPTER_CAPABILITIES,
  HERMES_SURFACE_VERSION,
  buildHermesTuiArgs,
  parseHermesVersion,
} from './detection.js';
import { HERMES_LAUNCH_FLAGS } from './generated/detection.js';

const surfaceDetection = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../surface/vendors/hermes/model/hermes@0.20.0/detection.json'),
    'utf8',
  ),
) as { launchFlags: Record<string, string>; versionPattern: string };

describe('Hermes detection contract', () => {
  it('parses the captured --version line and rejects unrelated text', () => {
    expect(parseHermesVersion('Hermes Agent v0.20.0 (2026.8.3)\nInstall directory: /tmp\n')).toEqual({
      version: '0.20.0',
      releaseTag: '2026.8.3',
    });
    expect(parseHermesVersion('hermes 0.20.0')).toBeUndefined();
  });

  it('projects Surface launch flags without inventing ACP as the TUI attach path', () => {
    expect(HERMES_SURFACE_VERSION).toBe('0.20.0');
    expect(HERMES_LAUNCH_FLAGS.tui).toBe(surfaceDetection.launchFlags.tui);
    expect(HERMES_LAUNCH_FLAGS.resume).toBe(surfaceDetection.launchFlags.resume);
    expect(buildHermesTuiArgs({ resume: '20260812_132919_ae981b' })).toEqual([
      '--tui',
      '--resume',
      '20260812_132919_ae981b',
    ]);
    expect(buildHermesTuiArgs()).not.toContain('acp');
    expect(HERMES_ADAPTER_CAPABILITIES).toMatchObject({
      executionMode: 'native-tui',
      observationLevel: 'structured',
      structuredApprovalControl: false,
    });
  });
});
