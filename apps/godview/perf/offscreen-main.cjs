// Loaded into Godview's MAIN process by the perf harness (`NODE_OPTIONS=--require …`), before
// dist/main.cjs: every BrowserWindow Godview opens becomes an offscreen one — rendered at a fixed
// rate (60 Hz unless the harness says) and Retina's ratio, never shown — and nothing may take focus
// or show a Dock icon. Godview
// itself is unchanged; only its windows are moved off the screen, so a measurement run cannot
// steal James's focus or be occluded by his windows (which would stop its frames).
//
// Electron's own module is not wired up yet when this runs, so the patch is made on Godview's
// first `require('electron')`. Any other Node process that inherits NODE_OPTIONS (the agent shim,
// a helper) is left alone.
if (process.type === 'browser') {
  const Module = require('node:module');
  const ratio = Number(process.env.GODVIEW_PERF_DPR ?? 2);
  const rate = Number(process.env.GODVIEW_PERF_FPS ?? 60);
  // The harness registers its page probe on a blank page, then creates this file: the app's own
  // document loads only after that, so the probe is in place before the app's first script. The
  // blank page is what gives the window a renderer to register the probe with at all.
  const gate = process.env.GODVIEW_PERF_GATE;
  const { existsSync } = require('node:fs');
  const opened = () =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (existsSync(gate)) resolve();
        else if (Date.now() - started > 120_000) reject(new Error(`the perf gate ${gate} never opened`));
        else setTimeout(check, 25);
      };
      check();
    });
  const held = (contents, load) =>
    !gate || existsSync(gate) ? load() : contents.loadURL('about:blank').then(opened).then(load);
  let patched;
  const patch = (electron) => {
    const Base = electron.BrowserWindow;
    class OffscreenWindow extends Base {
      constructor(options = {}) {
        super({
          ...options,
          show: false,
          webPreferences: {
            ...options.webPreferences,
            offscreen: { deviceScaleFactor: ratio },
            backgroundThrottling: false,
          },
        });
        this.webContents.setFrameRate(rate);
      }
      loadFile(...args) {
        return held(this.webContents, () => super.loadFile(...args));
      }
      show() {}
      showInactive() {}
      focus() {}
      moveTop() {}
    }
    electron.app.focus = () => undefined;
    electron.app.dock?.hide();
    electron.app.on('browser-window-created', () => electron.app.dock?.hide());
    return new Proxy(electron, {
      get: (target, key) => (key === 'BrowserWindow' ? OffscreenWindow : Reflect.get(target, key)),
    });
  };
  const load = Module._load;
  Module._load = function loadPatched(request, ...rest) {
    const loaded = load.call(this, request, ...rest);
    if (request !== 'electron' || typeof loaded?.BrowserWindow !== 'function') return loaded;
    patched ??= patch(loaded);
    return patched;
  };
}
