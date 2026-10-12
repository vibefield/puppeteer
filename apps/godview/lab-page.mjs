// What the view labs' build scripts share (list-lab.mjs, rain-lab.mjs, timeline-lab.mjs): find a lab entry in
// @vibefield/puppeteer-views, bundle it, inline the Godview skin and the views' whole stylesheet so
// every token resolves as in the app, and write one self-contained page under dist/.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
export const dist = join(root, 'dist');
const renderer = join(root, 'src/renderer');
// The package exports its swarm lab entry, not its package.json; the views' source root is walked
// up from it (`.ts` in-repo, `.js` once published), and every lab sits beside the swarm's.
const swarmLab = createRequire(import.meta.url).resolve('@vibefield/puppeteer-views/lab');
export const views = join(dirname(swarmLab), '../../..');

/** `views/<name>/lab/main.(ts|js)`. */
export function labEntry(name) {
  const entry = ['ts', 'js']
    .map((ext) => join(views, `views/${name}/lab/main.${ext}`))
    .find((path) => existsSync(path));
  if (!entry) throw new Error(`no ${name} lab entry under ${views}`);
  return entry;
}

/**
 * The entry as one IIFE, safe to inline in a script tag, and the stylesheets its modules import: a view on the SDK
 * brings its own from its entry module (L18), which esbuild emits beside the script. `plugins` let a golden tool
 * swap one module (the paint spy).
 */
export async function labBundle(entry, plugins = []) {
  const bundle = await build({
    entryPoints: [entry],
    plugins,
    bundle: true,
    write: false,
    // Where a view's stylesheet lands beside the script; nothing is written there.
    outdir: join(dist, 'lab-bundle'),
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    // A lab ships as one page; React's development build would triple it.
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js'));
  const css = bundle.outputFiles.filter((file) => file.path.endsWith('.css'));
  return {
    script: script.text.replaceAll('</script', '<\\/script'),
    css: css.map((file) => file.text).join('\n'),
  };
}

/** The entry's script alone, for a page that inlines no view stylesheet of its own. */
export async function labScript(entry, plugins = []) {
  return (await labBundle(entry, plugins)).script;
}

/** The skin (tokens, godview.css), the views' stylesheet with its imports resolved, and the lab's own layout. */
export async function labStyles() {
  const viewsCss = await build({
    entryPoints: [join(views, 'styles/views.css')],
    bundle: true,
    write: false,
    logLevel: 'warning',
  });
  return [
    await readFile(join(renderer, 'styles/tokens.css'), 'utf8'),
    await readFile(join(renderer, 'styles/godview.css'), 'utf8'),
    viewsCss.outputFiles[0].text,
    await readFile(join(views, 'lab/view-lab.css'), 'utf8'),
  ].join('\n');
}

/** Write `dist/<file>`: a view lab page whose root is `#lab`, mounting into `.view-lab-mount`. */
export async function writeViewLab({ file, title, lede, entry }) {
  const { script, css } = await labBundle(entry);
  const page = `<title>${title}</title>
<style>
${await labStyles()}
${css}
</style>
<div id="lab" class="lab-root view-lab vf-godview theme-light platform-darwin" data-godview-animations="on">
  <header>
    <h1>${title}</h1>
    <p>${lede}</p>
    <button type="button" class="view-lab-theme">Theme</button>
  </header>
  <div class="view-lab-mount"></div>
</div>
<script>
${script}
</script>
`;
  await mkdir(dist, { recursive: true });
  const path = join(dist, file);
  await writeFile(
    path,
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n</head>\n<body>\n${page}</body>\n</html>\n`,
  );
  return path;
}
