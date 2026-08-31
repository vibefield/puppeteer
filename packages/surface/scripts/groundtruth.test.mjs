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
      'copilot',
      'grok',
      'hermes',
      'kimi',
      'opencode',
      'pi',
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

  it('does not promote Rosetta writer-only contracts into runtime verification', () => {
    const roots = new Map(discoverGroundTruthRoots().map((root) => [root.split('/').at(-1), root]));
    const event = (vendor, name) =>
      loadGroundTruth(join(roots.get(vendor), 'groundtruth.json')).events.find((candidate) => candidate.event === name);

    expect(event('antigravity', 'USER_INPUT')?.confidence).toBe('verified-headless');
    expect(event('antigravity', 'logs:artifact')?.confidence).toBe('unverified');
    expect(event('copilot', 'user.message')?.confidence).toBe('verified-headless');
    expect(event('copilot', 'session.compaction_start')?.confidence).toBe('unverified');
    expect(event('pi', 'message')?.confidence).toBe('verified-headless');
    expect(event('pi', 'branch_summary')?.confidence).toBe('unverified');
  });
});
