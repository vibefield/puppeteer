#!/usr/bin/env node
/**
 * Registry generation (docs/archive/EMULATOR.md §2, ADAPTING-AN-AGENT step 4):
 * Adapter runtime projections are GENERATED from the Surface-owned Claude
 * model. The evidence is canonical; these files are disposable projections.
 *
 * Usage: node scripts/generate-registry.mjs
 * Requires node >= 22.18 (type stripping; on older 22.x use
 * `node --experimental-strip-types scripts/generate-registry.mjs`).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel } from '@vibecook/puppeteer-surface';
import { resolveAgentModel } from '../../../scripts/agent-model-selection.mjs';
import { renderDetectionSurface, renderRegistry } from './registry-render.ts';

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modelRoot = resolveAgentModel({ vendor: 'claude' }).modelRoot;
const registryTarget = join(adapterRoot, 'src', 'generated', 'registry.ts');
const detectionTarget = join(adapterRoot, 'src', 'generated', 'detection-surface.ts');

const model = loadModel(modelRoot);
writeFileSync(registryTarget, renderRegistry(model));
writeFileSync(detectionTarget, renderDetectionSurface(model.detection));
console.log(`generated ${registryTarget}`);
console.log(`generated ${detectionTarget}`);
