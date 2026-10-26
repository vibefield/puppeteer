/**
 * Freshness gate (the format:check pattern): registry.ts must be byte-identical
 * to a fresh render from the model. If this fails, run
 * `pnpm --filter @vibefield/puppeteer-adapter-claude generate:projections`
 * and commit the result.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModel } from '@vibefield/puppeteer-surface';
import { CLAUDE_SURFACE_VERSION, verifiedHookEvents } from './registry.js';
import { renderDetectionSurface, renderRegistry } from '../../scripts/registry-render.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const surfaceRoot = dirname(require.resolve('@vibefield/puppeteer-surface/package.json'));
const repoRoot = join(surfaceRoot, '..', '..');
const ledger = JSON.parse(readFileSync(join(repoRoot, 'support', 'agents.json'), 'utf8')) as {
  agents: Array<{ id: string; groundTruth?: string }>;
};
const claude = ledger.agents.find((agent) => agent.id === 'claude');
const groundTruthPath = claude?.groundTruth;
if (!groundTruthPath) throw new Error('support ledger has no canonical Claude ground truth');
const vendorRoot = dirname(join(repoRoot, groundTruthPath));

describe('generated registry', () => {
  it('src/generated/registry.ts is byte-identical to a fresh render from the model', () => {
    const model = loadModel(vendorRoot);
    const onDisk = readFileSync(join(here, 'registry.ts'), 'utf8');
    expect(onDisk).toBe(renderRegistry(model));
  });

  it('still exposes the registry surface settings.ts and tests rely on', () => {
    const model = loadModel(vendorRoot);
    expect(CLAUDE_SURFACE_VERSION).toBe(model.manifest.vendorVersion);
    expect(model.events).toHaveLength(33);
    expect(model.events.filter((event) => event.evidence?.existence.includes('claude-runtime-headless'))).toHaveLength(
      7,
    );
    expect(
      model.events.filter((event) => event.evidence?.existence.includes('claude-runtime-interactive')),
    ).toHaveLength(22);
    // 7 headless (5 of them also in the TUI lanes) and 17 seen only in the TUI lanes.
    expect(verifiedHookEvents()).toHaveLength(24);
  });

  it('keeps the runtime detection projection in sync with Surface', () => {
    const document = loadModel(vendorRoot).detection;
    const onDisk = readFileSync(join(here, 'detection-surface.ts'), 'utf8');
    expect(onDisk).toBe(renderDetectionSurface(document));
  });
});
