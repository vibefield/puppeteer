import { describe, expect, it } from 'vitest';
import { bindReleaseCapture } from './release-evidence.mjs';

describe('Pi release capture provenance', () => {
  const evidence = {
    vendor: 'pi',
    vendorVersion: '1.5.0',
    artifacts: [{ id: 'original-corpus' }],
    claims: [
      { id: 'runtime', kind: 'runtime-capture', artifact: 'original-corpus', capturedAt: '2026-11-03T00:00:00Z' },
      { id: 'source', kind: 'generated-schema', artifact: 'original-corpus', capturedAt: '2026-11-03T00:00:00Z' },
    ],
  };
  const receipt = {
    vendor: 'pi',
    version: '1.5.0',
    platform: 'linux-x64',
    artifactSha256: `sha256:${'a'.repeat(64)}`,
    entrySha256: `sha256:${'b'.repeat(64)}`,
    startedAt: '2026-11-04T00:00:00Z',
    capturedAt: '2026-11-04T00:01:00Z',
    harness: 'test harness',
    sandbox: { kind: 'docker-network-none', nonLoopbackRoutes: 0, publicDestinationErrno: 101 },
  };
  it('binds only fresh runtime evidence to the acquired artifact', () => {
    const result = bindReleaseCapture(evidence, receipt);
    expect(result.claims[0]).toMatchObject({ artifact: 'pi-1.5.0-linux-x64', capturedAt: receipt.capturedAt });
    expect(result.claims[1]).toEqual(evidence.claims[1]);
    expect(result.artifacts[0]).toEqual(evidence.artifacts[0]);
    expect(result.artifacts[1].integrity.sha256).toBe(receipt.artifactSha256);
    expect(bindReleaseCapture(evidence)).toBe(evidence);
  });
  it('refuses an unbound, non-isolated or different-version receipt', () => {
    for (const changes of [
      { artifactSha256: null },
      { version: '1.5.1' },
      { sandbox: {} },
      { capturedAt: '2026-11-02T00:00:00Z' },
    ]) {
      expect(() => bindReleaseCapture(evidence, { ...receipt, ...changes })).toThrow(/provenance/);
    }
  });
});
