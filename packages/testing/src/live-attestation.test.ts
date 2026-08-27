import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attestLiveAdapter } from './live-attestation.js';

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'puppeteer-live-attestation-'));
  roots.add(root);
  const artifact = join(root, 'agent');
  const receipt = join(root, 'receipts', 'adapter-real.json');
  writeFileSync(artifact, 'exact artifact bytes');
  return { root, artifact, receipt };
}

describe('attestLiveAdapter', () => {
  it('does nothing outside a protected receipt-bearing run', async () => {
    const { artifact } = fixture();
    await expect(attestLiveAdapter({ vendor: 'fake', artifact, testId: 'fake:real' }, {})).resolves.toBeUndefined();
  });

  it('binds an executed live test to the exact workflow artifact', async () => {
    const { root, artifact, receipt } = fixture();
    const result = await attestLiveAdapter(
      { vendor: 'fake', artifact, testId: 'fake:real' },
      {
        GITHUB_WORKSPACE: root,
        PUPPETEER_LIVE_RECEIPT: receipt,
        PUPPETEER_LIVE_VENDOR: 'fake',
        PUPPETEER_LIVE_PLATFORM: 'linux-x64',
        PUPPETEER_LIVE_ARTIFACT: artifact,
      },
    );
    expect(result).toMatchObject({ vendor: 'fake', platform: 'linux-x64', testId: 'fake:real' });
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual(result);
    expect(result?.artifactSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects a test that did not use the workflow artifact', async () => {
    const { root, artifact, receipt } = fixture();
    const other = join(root, 'other-agent');
    writeFileSync(other, 'other bytes');
    await expect(
      attestLiveAdapter(
        { vendor: 'fake', artifact: other, testId: 'fake:real' },
        {
          GITHUB_WORKSPACE: root,
          PUPPETEER_LIVE_RECEIPT: receipt,
          PUPPETEER_LIVE_VENDOR: 'fake',
          PUPPETEER_LIVE_PLATFORM: 'linux-x64',
          PUPPETEER_LIVE_ARTIFACT: artifact,
        },
      ),
    ).rejects.toThrow(/differs from the protected workflow identity/);
  });

  it('requires a workspace-confined, write-once receipt', async () => {
    const { root, artifact, receipt } = fixture();
    const environment = {
      GITHUB_WORKSPACE: root,
      PUPPETEER_LIVE_RECEIPT: receipt,
      PUPPETEER_LIVE_VENDOR: 'fake',
      PUPPETEER_LIVE_PLATFORM: 'linux-x64',
      PUPPETEER_LIVE_ARTIFACT: artifact,
    };
    const attestation = { vendor: 'fake', artifact, testId: 'fake:real' };
    await attestLiveAdapter(attestation, environment);
    await expect(attestLiveAdapter(attestation, environment)).rejects.toMatchObject({ code: 'EEXIST' });

    await expect(
      attestLiveAdapter(attestation, {
        ...environment,
        PUPPETEER_LIVE_RECEIPT: join(root, '..', 'outside.json'),
      }),
    ).rejects.toThrow(/must stay inside the workspace/);
  });
});
