import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGroundTruth } from '@vibecook/puppeteer-surface';
import { canonicalJson, checkGroundTruth, discoverGroundTruthRoots, renderGroundTruth } from './groundtruth.mjs';

describe('canonical Surface ground truth', () => {
  it('keeps exactly one canonical result at each agent root', () => {
    const roots = discoverGroundTruthRoots();
    expect(roots).toHaveLength(7);
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
});
