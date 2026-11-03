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

const groundTruth = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../surface/vendors/hermes/groundtruth.json'), 'utf8'),
) as {
  manifest: { vendorVersion: string };
  detection: { launchFlags: Record<string, string>; versionPattern: string; versionOutput: string };
};
const surfaceDetection = groundTruth.detection;

describe('Hermes detection contract', () => {
  it('parses the captured --version line and rejects unrelated text', () => {
    expect(parseHermesVersion(`${surfaceDetection.versionOutput}\nInstall directory: /tmp\n`)).toEqual({
      version: '0.21.5',
      releaseTag: '2026.9.24',
    });
    expect(parseHermesVersion('Hermes Agent v0.20.0 (2026.8.3)\nInstall directory: /tmp\n')).toEqual({
      version: '0.20.0',
      releaseTag: '2026.8.3',
    });
    expect(parseHermesVersion('hermes 0.20.0')).toBeUndefined();
  });

  it('projects Surface launch flags without inventing ACP as the TUI attach path', () => {
    expect(HERMES_SURFACE_VERSION).toBe(groundTruth.manifest.vendorVersion);
    expect(HERMES_SURFACE_VERSION).toBe('0.21.5');
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

describe('parseHermesVersion banner tolerance', () => {
  it('reads the 0.20.0 banner recorded in Surface and the 0.20.5 banner with an upstream suffix', () => {
    expect(parseHermesVersion('Hermes Agent v0.20.0 (2026.8.3)')).toEqual({
      version: '0.20.0',
      releaseTag: '2026.8.3',
    });
    expect(
      parseHermesVersion('Hermes Agent v0.20.5 (2026.8.19) · upstream 79b8703d\nInstall directory: /x/hermes-agent'),
    ).toEqual({ version: '0.20.5', releaseTag: '2026.8.19' });
    expect(parseHermesVersion('hermes 1.2.3')).toBeUndefined();
  });
});
