// Loaded into Godview's MAIN process by worker-windows-probe.mjs (`NODE_OPTIONS=--require …`),
// before dist/main.cjs: every window Godview opens is offscreen and never shown (the perf
// harness's shape, perf/offscreen-main.cjs), and the probe drives the windows from here: wait for
// a window whose swarm runs its physics in a worker, open a second window through Godview's own
// door, destroy the first, open a third, and expect its swarm's worker too. Then quit.
//
// A main process that dies between those steps is the Electron 43 SIGTRAP of build-mv M14; the
// runner reads the signal. Every step has a deadline, so a page that never answers fails rather
// than hangs.
if (process.type === 'browser') {
  const Module = require('node:module');
  const STEP_MS = 60_000;
  const log = (line) => console.log(`PROBE ${line}`);
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
            offscreen: { deviceScaleFactor: 1 },
            backgroundThrottling: false,
          },
        });
        this.webContents.setFrameRate(30);
      }
      show() {}
      showInactive() {}
      focus() {}
      moveTop() {}
    }
    electron.app.focus = () => undefined;
    electron.app.dock?.hide();
    electron.app.on('browser-window-created', () => electron.app.dock?.hide());

    const windows = [];
    electron.app.on('browser-window-created', (_event, window) => {
      windows.push(window);
      log(`window ${windows.length} created`);
    });

    /** The swarm's physics mode, as the slot writes it on ITS element (never the view's DOM, W5). */
    const PHYSICS = `(() => {
      const slot = document.querySelector('[data-monitor-view-slot]');
      return slot ? { view: slot.getAttribute('data-monitor-view'), physics: slot.getAttribute('data-monitor-view-physics'), renderer: slot.getAttribute('data-monitor-view-renderer') } : null;
    })()`;
    /** Polls `probe` until it answers; an error it throws ends the probe at once (never swallowed). */
    const until = async (what, probe) => {
      const deadline = Date.now() + STEP_MS;
      for (;;) {
        const value = await probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };
    const alive = (window) => !window.isDestroyed() && !window.webContents.isDestroyed();
    const physicsOf = async (window) => {
      try {
        return await window.webContents.executeJavaScript(PHYSICS);
      } catch {
        return null; // the page is still loading, or was torn down under us
      }
    };
    /** The next window not yet claimed whose swarm's physics run in a worker; inline fails at once. */
    const claimed = new Set();
    const nextSwarm = (label) =>
      until(`${label}: a window whose swarm's physics run in a worker`, async () => {
        for (const window of windows) {
          if (claimed.has(window) || !alive(window)) continue;
          const state = await physicsOf(window);
          if (!state || state.view !== 'swarm') continue;
          if (state.physics === 'inline') throw new Error(`${label}: the swarm's physics ran inline`);
          if (state.physics === 'worker') {
            claimed.add(window);
            return { window, state };
          }
        }
        return undefined;
      });
    const open = (from) => from.webContents.executeJavaScript('window.desktop.newWindow()');
    const destroyed = (window, label) =>
      until(`${label} destroyed`, async () => (window.isDestroyed() ? true : undefined));

    const drive = async () => {
      const first = await nextSwarm('window 1');
      log(`window 1 swarm ${JSON.stringify(first.state)}`);
      // A second window, through Godview's own door.
      await open(first.window);
      const second = await nextSwarm('window 2');
      log(`window 2 swarm ${JSON.stringify(second.state)}`);
      // Destroy the window whose page ran the worker…
      first.window.destroy();
      await destroyed(first.window, 'window 1');
      log('window 1 destroyed');
      // …and open a third after it (the M14 risk): its swarm runs in a worker too.
      await open(second.window);
      const third = await nextSwarm('window 3');
      log(`window 3 swarm ${JSON.stringify(third.state)}`);
      // And the other way round: the newest goes, the older stays, another opens.
      third.window.destroy();
      await destroyed(third.window, 'window 3');
      log('window 3 destroyed');
      await open(second.window);
      const fourth = await nextSwarm('window 4');
      log(`window 4 swarm ${JSON.stringify(fourth.state)}`);
      log(`main process alive after ${windows.length} windows, 2 destroyed`);
    };

    /** Godview's own shutdown first (its before-quit tears its daemons down); a hard exit if it lingers. */
    const leave = (code) => {
      setTimeout(() => electron.app.exit(code), 10_000).unref();
      process.exitCode = code;
      electron.app.quit();
    };
    electron.app.whenReady().then(() => {
      drive().then(
        () => {
          log('OK');
          leave(0);
        },
        (error) => {
          log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
          leave(2);
        },
      );
    });

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
