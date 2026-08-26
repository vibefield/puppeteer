import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGroundTruth } from '@vibecook/puppeteer-surface';
import { canonicalJson, checkGroundTruth, discoverModelRoots, renderGroundTruth } from './groundtruth.mjs';

describe('canonical Surface ground truth', () => {
  it('matches every split authoring model and generated visualization', () => {
    const roots = discoverModelRoots();
    expect(roots).toHaveLength(8);
    expect(checkGroundTruth(roots)).toEqual([]);
    for (const root of roots) {
      expect(readFileSync(join(root, 'groundtruth.json'), 'utf8')).toBe(canonicalJson(root));
    }
  });

  it('renders a self-contained, searchable model explorer', () => {
    const root = discoverModelRoots()[0];
    const document = loadGroundTruth(join(root, 'groundtruth.json'));
    const html = renderGroundTruth(document);
    expect(html).toContain('Agent surface ground truth');
    expect(html).toContain('id="event-search"');
    expect(html).toContain('id="behavior"');
    expect(html).not.toMatch(/<link|https?:\/\//);
  });
});
