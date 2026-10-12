// The goldens' Electron main (run by capture.mjs, never directly): ONE offscreen window, never
// shown, Dock hidden, so nothing takes focus or appears on screen. For each job it sizes the
// window to the stage, opens the lab page with `capture=1`, waits for the lab to mount, steps the
// capture clock, checks the stage sits at the origin at the size asked for, and writes the stage's
// pixels as Chromium encodes them.
//
// One window for every page, on purpose: destroying an offscreen window and opening the next
// crashed Electron 43 here (SIGTRAP). A watchdog exits the app, since macOS ships no `timeout`.

import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const job = JSON.parse(readFileSync(process.env.GODVIEW_GOLDENS_JOB, 'utf8'));
// One locale, whatever the machine's. (The ratio is the window's own: `offscreen.deviceScaleFactor`.)
app.commandLine.appendSwitch('lang', 'en-US');
app.dock?.hide();

const watchdog = setTimeout(() => {
  console.error('GOLDEN_WATCHDOG: the capture did not finish in time');
  app.exit(2);
}, job.timeoutMs);

const PROBE = `(() => {
  const stage = document.querySelector('[data-lab-stage] section');
  const rect = stage?.getBoundingClientRect();
  return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: window.devicePixelRatio } : null;
})()`;

// Not a top-level await: Electron emits `ready` only once the ESM entry has finished evaluating,
// so awaiting it here would wait forever.
app.whenReady().then(capture);

async function capture() {
  console.log(
    `GOLDEN_ENV ${JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node })}`,
  );
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 800,
    height: 600,
    // Retina's ratio, whatever display is attached: an offscreen page is at 1 unless told otherwise.
    webPreferences: { offscreen: { deviceScaleFactor: job.dpr }, backgroundThrottling: false },
  });
  window.webContents.setFrameRate(60);
  let errors = [];
  window.webContents.on('console-message', (event) => {
    if (event.level !== 'error') return;
    errors.push(String(event.message).slice(0, 300));
  });

  let failed = 0;
  for (const page of job.pages) {
    errors = [];
    const started = Date.now();
    try {
      window.setContentSize(page.width, page.height);
      await window.loadURL(page.url);
      // A page's script: frames to step and changes to make, in order (`swarm-frames.mjs`); else just the frames.
      const script = page.script ?? [{ step: job.frames }];
      const actions = script.map((action) =>
        action.churn ? 'await window.__vfLab.churn();' : `await window.__vfLab.step(${action.step});`,
      );
      await window.webContents.executeJavaScript(
        `(async () => { await window.__vfLab.ready(); ${actions.join(' ')} return true; })()`,
      );
      const rect = await window.webContents.executeJavaScript(PROBE);
      const placed = rect && rect.x === 0 && rect.y === 0 && rect.width === page.width && rect.height === page.height;
      if (!placed)
        throw new Error(`the stage is not ${page.width}×${page.height} at the origin: ${JSON.stringify(rect)}`);
      if (rect.dpr !== job.dpr) throw new Error(`devicePixelRatio is ${rect.dpr}, not ${job.dpr}`);
      if (errors.length > 0) throw new Error(`the page logged errors: ${errors.join(' | ')}`);
      if (page.collect === 'frames') {
        // What the paint spy recorded: every frame the view handed its renderer.
        const frames = await window.webContents.executeJavaScript('JSON.stringify(window.__vfSwarmFrames ?? null)');
        if (frames === 'null') throw new Error('no frames recorded: is this the paint-spy page?');
        mkdirSync(dirname(page.out), { recursive: true });
        writeFileSync(page.out, frames);
        console.log(
          `GOLDEN ${JSON.stringify({ id: page.id, frames: JSON.parse(frames).length, ms: Date.now() - started })}`,
        );
        continue;
      }
      const image = await window.webContents.capturePage({ x: 0, y: 0, width: page.width, height: page.height });
      mkdirSync(dirname(page.out), { recursive: true });
      writeFileSync(page.out, image.toPNG());
      const size = image.getSize();
      console.log(
        `GOLDEN ${JSON.stringify({ id: page.id, width: size.width, height: size.height, ms: Date.now() - started })}`,
      );
    } catch (error) {
      failed += 1;
      console.log(`GOLDEN_FAIL ${JSON.stringify({ id: page.id, error: String(error?.message ?? error) })}`);
    }
  }
  window.destroy();
  clearTimeout(watchdog);
  app.exit(failed === 0 ? 0 : 1);
}
