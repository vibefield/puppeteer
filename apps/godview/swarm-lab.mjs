#!/usr/bin/env node

// The swarm design lab: one self-contained HTML page that runs the production
// WebGPU swarm renderer over fixture agents (packages/views/src/views/swarm/lab).
// It bundles the lab entry — the view's own stylesheets ride with it (L18) — inlines
// the Godview skin so the palette resolves as in the app, and writes dist/swarm-lab.html
// plus a body-only variant for publishing as an artifact.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dist, labBundle, labEntry, labStyles } from './lab-page.mjs';

const { script, css } = await labBundle(labEntry('swarm'));

const body = `<title>Swarm Lab</title>
<style>
${await labStyles()}
${css}
</style>
<div id="lab" class="lab-root swarm-lab vf-godview theme-light platform-darwin" data-godview-animations="on">
  <canvas class="lab-canvas" aria-hidden="true"></canvas>
  <div class="lab-controls"></div>
  <header class="lab-header">
    <h1>Swarm Lab</h1>
    <p>The production WebGPU swarm renderer over fixture agents: every state, the light's variants, and a settled field. What is drawn here is what Godview draws. The panel on the right holds the view's own tunables and follows you down the page.</p>
  </header>
  <section class="lab-part lab-view-head">
    <h2>The view</h2>
    <p class="lab-lede">The swarm as the SDK view Godview mounts, on the inline physics, over the seeded world in Godview’s stage at its three sizes: ?n= sets the rows, ?size= one stage.</p>
  </section>
  <div class="lab-view"></div>
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
