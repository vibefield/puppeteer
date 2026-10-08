#!/usr/bin/env node

// The spend lab: one self-contained HTML page that mounts the shipping spend view over a live
// afternoon's last ten minutes (packages/views/src/views/spend/lab), through the view host as Godview
// mounts it. It bundles the entry with the view's own stylesheet and inlines the Godview tokens and
// skin, so the palette resolves as in the app, and writes dist/spend-lab.html; `?capture=1` is the
// golden tool's page (goldens/README.md).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labBundle, labEntry, views } from './lab-page.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const renderer = join(root, 'src/renderer');
// The view brings its own stylesheet from its entry module (L18): the bundle emits it beside the script.
const bundle = await labBundle(labEntry('spend'));
const script = bundle.script;
const css = [
  await readFile(join(renderer, 'styles/tokens.css'), 'utf8'),
  await readFile(join(renderer, 'styles/godview.css'), 'utf8'),
  bundle.css,
  // The seeded world's stages (`?n=`, `?capture=1`), as the other view labs lay them out.
  await readFile(join(views, 'lab/view-lab.css'), 'utf8'),
].join('\n');

const lab = `
html, body { height: auto; overflow: auto; }
body { margin: 0; background: var(--monitor-bg); }
.spend-lab { min-height: 100vh; height: auto; padding: 24px 24px 48px; box-sizing: border-box; color: var(--text-main); font-family: var(--vf-font-mono); }
.spend-lab header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 18px; }
.spend-lab h1 { margin: 0; font-size: 15px; }
.spend-lab header p { margin: 0; color: var(--text-muted); font-size: 11px; max-width: 80ch; }
.spend-lab-theme { margin-left: auto; font: 700 10px var(--vf-font-mono); padding: 5px 9px; border: 1px solid var(--panel-border); border-radius: 5px; background: var(--panel-bg); color: var(--text-main); cursor: pointer; }
.spend-lab-stages { display: grid; gap: 28px; }
.spend-lab-stage { margin: 0; }
/* The frame stands in for Godview's stage, which paints the ground the (transparent) view sits on. */
.spend-lab-frame { position: relative; overflow: hidden; border: 1px solid var(--panel-border); border-radius: 8px; background: var(--monitor-bg); }
.spend-lab-stage figcaption { display: flex; gap: 10px; margin-top: 8px; font-size: 11px; color: var(--text-muted); }
.spend-lab-stage figcaption b { color: var(--text-main); }
`;

const body = `<title>Spend Lab</title>
<style>
${css}
${lab}
</style>
<div id="spend-lab" class="lab-root spend-lab vf-godview theme-light platform-darwin" data-godview-animations="on">
  <header>
    <h1>Spend Lab</h1>
    <p>The shipping spend view over a live afternoon's last ten minutes, at Godview's sizes: each line what its agent spent in the window, from $0; the list each run's total; the rows as the backend hands them over now, and nothing older. Point at the chart to read a moment, click empty chart to set it, point at a row to light its line.</p>
    <button type="button" class="spend-lab-theme">Theme</button>
  </header>
  <div class="spend-lab-mount"></div>
</div>
<script>
${script}
</script>
`;

await mkdir(dist, { recursive: true });
await writeFile(
  join(dist, 'spend-lab.html'),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n</head>\n<body>\n${body}</body>\n</html>\n`,
);
console.log(`spend lab written to ${join(dist, 'spend-lab.html')}`);
