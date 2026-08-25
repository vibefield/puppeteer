import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditEvidence, digestTree, validateSourceReference } from './check-evidence.mjs';

describe('Surface evidence indexes', () => {
  it('match every immutable model and capture tree', () => {
    expect(auditEvidence()).toEqual([]);
  });

  it('bind paths and bytes into deterministic tree digests', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chopsticks-evidence-'));
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
