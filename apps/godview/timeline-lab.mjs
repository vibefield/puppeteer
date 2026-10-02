#!/usr/bin/env node

// The timeline lab: one self-contained HTML page that mounts the shipping timeline view over the
// example afternoon (packages/views/src/views/timeline/lab). Like the swarm lab it bundles the
// entry and inlines the Godview tokens and stylesheet, so the palette resolves as in the app, and
// writes dist/timeline-lab.html.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const renderer = join(root, 'src/renderer');
// The package exports its swarm lab entry; the views' source root is walked up from it, and the
// timeline lab sits beside the swarm's (`.ts` in-repo, `.js` once published).
const swarmLab = createRequire(import.meta.url).resolve('@vibecook/puppeteer-views/lab');
const views = join(dirname(swarmLab), '../../..');
const entry = ['ts', 'js'].map((ext) => join(views, `views/timeline/lab/main.${ext}`)).find((path) => existsSync(path));
if (!entry) throw new Error(`no timeline lab entry under ${views}`);

const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
const script = bundle.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = [
  await readFile(join(renderer, 'styles/tokens.css'), 'utf8'),
  await readFile(join(renderer, 'styles/godview.css'), 'utf8'),
  await readFile(join(views, 'views/timeline/timeline.css'), 'utf8'),
].join('\n');

const lab = `
html, body { height: auto; overflow: auto; }
body { margin: 0; background: var(--monitor-bg); }
.timeline-lab { min-height: 100vh; height: auto; padding: 24px 24px 48px; box-sizing: border-box; color: var(--text-main); font-family: var(--vf-font-mono); }
.timeline-lab header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 18px; }
.timeline-lab h1 { margin: 0; font-size: 15px; }
.timeline-lab header p { margin: 0; color: var(--text-muted); font-size: 11px; max-width: 80ch; }
.timeline-lab-theme { margin-left: auto; font: 700 10px var(--vf-font-mono); padding: 5px 9px; border: 1px solid var(--panel-border); border-radius: 5px; background: var(--panel-bg); color: var(--text-main); cursor: pointer; }
.timeline-lab-stages { display: grid; gap: 28px; }
.timeline-lab-stage { margin: 0; }
.timeline-lab-frame { position: relative; overflow: hidden; border: 1px solid var(--panel-border); border-radius: 8px; }
.timeline-lab-stage figcaption { display: flex; gap: 10px; margin-top: 8px; font-size: 11px; color: var(--text-muted); }
.timeline-lab-stage figcaption b { color: var(--text-main); }
`;

const body = `<title>Timeline Lab</title>
<style>
${css}
${lab}
</style>
<div id="timeline-lab" class="timeline-lab vf-godview theme-light platform-darwin" data-godview-animations="on">
  <header>
    <h1>Timeline Lab</h1>
    <p>The shipping timeline view over the example afternoon, at Godview's sizes. Drag to pan, ⌘-scroll to zoom, point at a lane to light it, press the map to put the head there.</p>
    <button type="button" class="timeline-lab-theme">Theme</button>
  </header>
  <div class="timeline-lab-mount"></div>
</div>
<script>
${script}
</script>
`;

await mkdir(dist, { recursive: true });
await writeFile(
  join(dist, 'timeline-lab.html'),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n</head>\n<body>\n${body}</body>\n</html>\n`,
);
console.log(`timeline lab written to ${join(dist, 'timeline-lab.html')}`);
