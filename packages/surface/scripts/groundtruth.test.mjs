import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGroundTruth } from '@vibecook/puppeteer-surface';
import { canonicalJson, checkGroundTruth, discoverGroundTruthRoots, renderGroundTruth } from './groundtruth.mjs';

describe('canonical Surface ground truth', () => {
  it('keeps exactly one canonical result at each agent root', () => {
    const roots = discoverGroundTruthRoots();
    expect(roots.map((root) => root.split('/').at(-1))).toEqual([
      'synthetic',
      'antigravity',
      'claude',
      'codex',
      'grok',
      'hermes',
      'kimi',
      'opencode',
    ]);
    expect(checkGroundTruth(roots)).toEqual([]);
    for (const root of roots) {
      expect(readFileSync(join(root, 'groundtruth.json'), 'utf8')).toBe(canonicalJson(root));
    }
  });

  it('renders a self-contained, searchable model explorer', () => {
    const root = discoverGroundTruthRoots()[0];
    const document = loadGroundTruth(join(root, 'groundtruth.json'));
    const html = renderGroundTruth(document);
    expect(html).toContain('Agent surface ground truth');
    expect(html).toContain('id="event-search"');
    expect(html).toContain('id="behavior"');
    expect(html).not.toMatch(/<link|https?:\/\//);
  });

  it('renders ASM v3 fidelity, refinements, and immutable source provenance', () => {
    const root = discoverGroundTruthRoots().find((candidate) => candidate.endsWith('/kimi'));
    const html = renderGroundTruth(loadGroundTruth(join(root, 'groundtruth.json')));
    expect(html).toContain('Schema fidelity');
    expect(html).toContain('evidence-bound payload refinements');
    expect(html).toContain('Immutable source references');
  });
});
