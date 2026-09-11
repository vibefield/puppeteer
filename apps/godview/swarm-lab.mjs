#!/usr/bin/env node

// The swarm design lab: one self-contained HTML page that runs the production
// WebGPU swarm renderer over fixture agents (src/renderer/views/swarm/lab). It
// bundles the lab entry, inlines the Godview tokens and stylesheet so the
// palette resolves as in the app, and writes dist/swarm-lab.html plus a body-only
// variant for publishing as an artifact.

import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const renderer = join(root, 'src/renderer');

const bundle = await build({
  entryPoints: [join(renderer, 'views/swarm/lab/main.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  loader: { '.wgsl': 'text', '.png': 'dataurl' },
  logLevel: 'info',
});
const script = bundle.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = [
  await readFile(join(renderer, 'styles/tokens.css'), 'utf8'),
  await readFile(join(renderer, 'styles/godview.css'), 'utf8'),
  await readFile(join(renderer, 'views/swarm/lab/lab.css'), 'utf8'),
].join('\n');

const body = `<title>Swarm Lab</title>
<style>
${css}
</style>
<div id="lab" class="swarm-lab vf-godview theme-light platform-darwin" data-godview-animations="on">
  <canvas class="lab-canvas" aria-hidden="true"></canvas>
  <header class="lab-header">
    <h1>Swarm Lab</h1>
    <p>The production WebGPU swarm renderer over fixture agents: every state, the light's variants, and a settled field. What is drawn here is what Godview draws. Sliders are the view's own tunables.</p>
    <div class="lab-controls"></div>
  </header>
  <p class="lab-notice" hidden></p>
  <div class="lab-parts"></div>
</div>
<script>
${script}
</script>
`;

await mkdir(dist, { recursive: true });
await writeFile(join(dist, 'swarm-lab.body.html'), body);
await writeFile(
  join(dist, 'swarm-lab.html'),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n</head>\n<body>\n${body}</body>\n</html>\n`,
);
console.log(`swarm lab written to ${join(dist, 'swarm-lab.html')}`);
