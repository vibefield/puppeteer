// The Electron half of verify-worker-bundling.mjs: loads each built page in a
// hidden window, the way its host loads it, and reports what the fixture
// published as `globalThis.__result`. Run only by that script.
//
// - `scheme` pages are served from a privileged standard, secure scheme with a
//   Content-Security-Policy header, as VibeField serves its renderer.
// - `file` pages are loaded with `loadFile`, as puppeteer's Godview loads its
//   renderer (its CSP is the page's own meta tag) and as a lab page opens.
// - `url` pages are loaded as they are (a Vite dev server).
//
// No window is ever shown and nothing is typed or clicked.

import { app, BrowserWindow, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const config = JSON.parse(await readFile(process.argv[process.argv.length - 1], 'utf8'));
const SCHEME = 'vsdk-app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json' };

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.dock?.hide();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resultOf(window, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await window.webContents.executeJavaScript('globalThis.__result ?? null');
    if (result !== null) return result;
    await wait(50);
  }
  return null;
}

app.whenReady().then(async () => {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (relative.startsWith('..')) return new Response('', { status: 403 });
    try {
      const body = await readFile(join(config.schemeRoot, relative || 'index.html'));
      return new Response(body, {
        headers: {
          'content-type': TYPES[extname(relative || 'index.html')] ?? 'application/octet-stream',
          'content-security-policy': config.schemeCsp,
        },
      });
    } catch {
      return new Response('', { status: 404 });
    }
  });

  const results = [];
  for (const page of config.pages) {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const console = [];
    window.webContents.on('console-message', (event) => {
      if (console.length < 6) console.push(`${event.level}: ${event.message}`);
    });
    let result = null;
    let error;
    try {
      if (page.file) await window.loadFile(page.file);
      else await window.loadURL(page.scheme ? `${SCHEME}://app/index.html` : page.url);
      result = await resultOf(window, config.timeoutMs);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    results.push({ id: page.id, result, console, ...(error ? { error } : {}) });
    window.destroy();
  }
  process.stdout.write(`RESULTS ${JSON.stringify(results)}\n`);
  app.exit(0);
});
