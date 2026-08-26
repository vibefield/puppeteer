/**
 * Freshness gate (the format:check pattern): registry.ts must be byte-identical
 * to a fresh render from the model. If this fails, run
 * `pnpm --filter @vibecook/puppeteer-adapter-claude generate:projections`
 * and commit the result.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModel } from '@vibecook/puppeteer-surface';
import { CLAUDE_SURFACE_VERSION } from './registry.js';
import { renderDetectionSurface, renderRegistry } from '../../scripts/registry-render.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const surfaceRoot = dirname(require.resolve('@vibecook/puppeteer-surface/package.json'));
const repoRoot = join(surfaceRoot, '..', '..');
const ledger = JSON.parse(readFileSync(join(repoRoot, 'support', 'agents.json'), 'utf8')) as {
  agents: Array<{ id: string; currentManifest?: string; candidateManifest?: string }>;
};
const claude = ledger.agents.find((agent) => agent.id === 'claude');
const manifestPath = claude?.candidateManifest ?? claude?.currentManifest;
if (!manifestPath) throw new Error('support ledger has no active Claude manifest');
const modelRoot = dirname(join(repoRoot, manifestPath));

describe('generated registry', () => {
  it('src/generated/registry.ts is byte-identical to a fresh render from the model', () => {
    const model = loadModel(modelRoot);
    const onDisk = readFileSync(join(here, 'registry.ts'), 'utf8');
    expect(onDisk).toBe(renderRegistry(model));
  });

  it('still exposes the registry surface settings.ts and tests rely on', () => {
    const model = loadModel(modelRoot);
    expect(CLAUDE_SURFACE_VERSION).toBe(model.manifest.vendorVersion);
    expect(model.events).toHaveLength(31);
    expect(model.events.filter((event) => event.confidence !== 'unverified')).toHaveLength(7);
  });

  it('keeps the runtime detection projection in sync with Surface', () => {
    const document = loadModel(modelRoot).detection;
    const onDisk = readFileSync(join(here, 'detection-surface.ts'), 'utf8');
    expect(onDisk).toBe(renderDetectionSurface(document));
  });
});
