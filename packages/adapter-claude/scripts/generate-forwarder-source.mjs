#!/usr/bin/env node
/**
 * Forwarder generation: src/generated/forwarder-source.ts is the text a launch stages for a host that lends no
 * forwarder runtime, transpiled from src/launch/forwarder.ts. Run after editing the forwarder; its freshness test
 * (src/generated/forwarder-source.test.ts) fails until the result is committed.
 *
 * Usage: node scripts/generate-forwarder-source.mjs
 * Requires node >= 22.18 (type stripping; on older 22.x use
 * `node --experimental-strip-types scripts/generate-forwarder-source.mjs`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderForwarderSource } from './forwarder-render.ts';

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(adapterRoot, 'src', 'launch', 'forwarder.ts');
const target = join(adapterRoot, 'src', 'generated', 'forwarder-source.ts');

writeFileSync(target, renderForwarderSource(readFileSync(source, 'utf8')));
console.log(`generated ${target}`);
