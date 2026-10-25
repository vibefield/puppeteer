import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditEvidence, digestTree, validateSourceReference } from './check-evidence.mjs';

describe('Surface evidence indexes', () => {
  it('match every immutable model and capture tree', () => {
    expect(auditEvidence()).toEqual([]);
  });

  it('rewrite only an index whose digests changed, keeping a formatted index byte-identical', () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-evidence-write-'));
    const modelPath = 'packages/surface/vendors/fake/model/fake@1.0.0';
    const model = join(root, modelPath);
    mkdirSync(model, { recursive: true });
    writeFileSync(
      join(model, 'manifest.json'),
      '{"vendor":"fake","vendorVersion":"1.0.0","evidence":"evidence.json"}\n',
    );
    writeFileSync(join(model, 'event.json'), '{}\n');
    const index = {
      evidenceVersion: 1,
      vendor: 'fake',
      vendorVersion: '1.0.0',
      artifacts: [{ id: 'fake', integrity: { status: 'legacy-missing-digest' } }],
      records: [
        {
          id: 'model',
          path: modelPath,
          exclude: ['evidence.json'],
          digestAlgorithm: 'sha256-path-content-v1',
          sha256: digestTree(model, ['evidence.json']),
        },
      ],
    };
    // Prettier keeps short arrays inline; JSON.stringify(…, null, 2) does not.
    const formatted = `${JSON.stringify(index, null, 2).replace(/\[\n\s+"evidence\.json"\n\s+\]/, '["evidence.json"]')}\n`;
    writeFileSync(join(model, 'evidence.json'), formatted);
    auditEvidence({ write: true, root });
    expect(readFileSync(join(model, 'evidence.json'), 'utf8')).toBe(formatted);

    writeFileSync(join(model, 'event.json'), '{"changed":true}\n');
    auditEvidence({ write: true, root });
    const rewritten = JSON.parse(readFileSync(join(model, 'evidence.json'), 'utf8'));
    expect(rewritten.records[0].sha256).toBe(digestTree(model, ['evidence.json']));
  });

  it('bind paths and bytes into deterministic tree digests', () => {
    const directory = mkdtempSync(join(tmpdir(), 'puppeteer-evidence-'));
    writeFileSync(join(directory, 'a.txt'), 'same');
    const first = digestTree(directory);
    writeFileSync(join(directory, 'a.txt'), 'changed');
    expect(digestTree(directory)).not.toBe(first);
  });

  it('does not confuse an upstream SOURCE_REV with the public mirror commit', () => {
    expect(
      validateSourceReference({
        repository: 'https://github.com/xai-org/grok-build',
        revision: '27b3c666',
        relation: 'public-mirror-commit',
      }),
    ).toEqual([
      'source reference: public mirror revision must be a full 40-character commit',
      'source reference: public mirror sourceRevision must be the full upstream SOURCE_REV',
    ]);
    expect(
      validateSourceReference({
        repository: 'https://github.com/xai-org/grok-build',
        revision: '8a14c91d88875a831a38b3a066b1683116bcb31c',
        relation: 'public-mirror-commit',
        sourceRevision: '27b3c66635e2c0bf213429a36ab916f25d59df20',
      }),
    ).toEqual([]);
  });
});
