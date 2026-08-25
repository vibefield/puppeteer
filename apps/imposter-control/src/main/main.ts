/**
 * Agent adaptation devkit: a thin Electron shell over the native control
 * plane plus optional downstream projections. The plane remains useful by
 * itself; normalization is composed here, where importing adapters and Core
 * cannot contaminate Imposter's native truth.
 */
import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlPlane } from './plane.js';
import { createNormalizationLab } from './normalization-lab.js';
import { createPersonaSpawner } from './spawner.js';

export function loadConsoleUi(): string {
  // The bundle reads dist/index.html while vitest imports the source template.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, 'index.html'),
    join(here, '..', 'renderer', 'index.html'),
    join(here, '..', '..', 'dist', 'index.html'),
  ]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error('agent adaptation devkit UI not found beside the app');
}

const consoleAssets = new Map([
  ['/assets/renderer.js', { file: 'renderer.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/assets/renderer.css', { file: 'renderer.css', contentType: 'text/css; charset=utf-8' }],
  ['/assets/renderer.js.map', { file: 'renderer.js.map', contentType: 'application/json; charset=utf-8' }],
  ['/assets/renderer.css.map', { file: 'renderer.css.map', contentType: 'application/json; charset=utf-8' }],
]);

export function loadConsoleAsset(path: string): { body: string; contentType: string } | undefined {
  const asset = consoleAssets.get(path);
  if (!asset) return undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'assets', asset.file), join(here, '..', '..', 'dist', 'assets', asset.file)]) {
    if (existsSync(candidate)) return { body: readFileSync(candidate, 'utf8'), contentType: asset.contentType };
  }
  throw new Error(`agent adaptation devkit asset ${asset.file} not found beside the app`);
}

const smoke = process.argv.includes('--smoke');
const spawners = [
  createPersonaSpawner('claude', 'Claude native surface'),
  createPersonaSpawner('codex', 'Codex native surface'),
  createPersonaSpawner('grok', 'Grok native surface'),
  createPersonaSpawner('kimi', 'Kimi native surface'),
  createPersonaSpawner('opencode', 'OpenCode native surface'),
  createPersonaSpawner('hermes', 'Hermes native surface'),
];
const plane = createControlPlane({
  uiHtml: loadConsoleUi(),
  uiAsset: loadConsoleAsset,
  spawners,
  projections: [createNormalizationLab()],
  // Sessions joining and leaving is the one thing worth watching from the
  // terminal you launched in, and it is how you notice an imposter that failed
  // to dial in at all.
  log: (message) => console.log(`[plane] ${message}`),
});
let quitReady = false;
let shutdownPromise: Promise<void> | undefined;
let mainWindow: BrowserWindow | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await Promise.all(spawners.map((spawner) => spawner.disposeAll()));
    await plane.stop();
  })();
  return shutdownPromise;
}

// Only the electron main process boots the window shell; vitest imports this
// module for loadConsoleUi and has no electron runtime.
if (process.type === 'browser') {
  app
    .whenReady()
    .then(async () => {
      await plane.start();
      if (smoke) {
        console.log(`agent adaptation devkit control plane at ${plane.url}`);
        await shutdown();
        quitReady = true;
        app.exit(0);
        return;
      }
      // The console is also a plain web page; print the authenticated URL so it
      // can be opened in a real browser with devtools, or driven by a script.
      console.log(`agent adaptation devkit at ${plane.consoleUrl}`);
      mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        title: 'puppeteer — agent adaptation devkit',
      });
      mainWindow.on('closed', () => {
        mainWindow = undefined;
      });
      mainWindow.removeMenu();
      await mainWindow.loadURL(plane.consoleUrl);
    })
    .catch((error) => {
      console.error(error);
      void shutdown().finally(() => {
        quitReady = true;
        app.exit(1);
      });
    });

  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    void shutdown().finally(() => {
      quitReady = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
}
