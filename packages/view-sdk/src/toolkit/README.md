# The toolkit

`@vibecook/puppeteer-view-sdk/toolkit` holds the presentation helpers a monitor view may use: the words it says,
the numbers it prints, the colours and marks it draws, and the loops and canvases it draws with. A view imports
the contract (`.`), the React adapter (`/react`) and this toolkit, and nothing else (L16, enforced by
`scripts/check-view-wall.mjs`).

Two rules hold for everything here:

- **Presentation only.** Nothing here computes a business fact. Totals, burn, recency, unread, project sequences
  and the row's own line (`detail`) are the backend's, delivered in the row. The toolkit only says them.
- **Framework-free.** It has no React and no host. A view drawn with React, a canvas or plain DOM uses the same
  words, numbers, colours and marks. The only browser globals it touches are `devicePixelRatio`, `matchMedia`,
  `requestAnimationFrame`, `performance` and `getComputedStyle` (resolving a colour in the view's own root), and only
  when a view calls the helper that needs them.

## What is here

| Module | What it gives a view |
|---|---|
| `format.ts` | `formatUsd`, `formatEstimate` (`~$7.03`, `~$7.03+` while partly priced, `—` with no price lane), `formatRatePerHour`, `formatElapsed` (`4:39`, `2h 05m`, `1d 03h`), `formatShort` (`11m`), `formatWords`, `formatClock`, `formatCount`, `formatTokens`, `formatPercent` |
| `state-words.ts` | MV-D11's one table: `STATE_WORDS` (status, terminal, wait, unread, kind), `statusWord`, `waitWord`, `waitMark`, `openingWord`, `unreadSpoken`, `stateTone`, `stateWord`; the recede steps `RECEDED_OPACITY`, `RECEDED_EMPTY_OPACITY`, `RECEDE_MS`, `everyReceded`, `recedeTarget`, `approachRecede` |
| `words.ts` | The words a row goes by: `detailLine` (the line under the name, M4's one rule: VibeField's reply-first), `deviceWord` (`This desktop` for `self`, never keyed on an id, M34), `projectName`, `modelWord`, a peer's write policy `hostWriteWord` / `hostWriteTitle` (from the row's `writable`, M41), and `waitBodyLine` — what a blocked body says it waits on, the swarm's chain in its own order: a question's header or text, the wait's detail, a permission's tool, a failure's code, then the reply or the wait word (M14) |
| `lane-words.ts` | A timeline lane's wait in the lane's own order (M2, M14): `laneWaitWords` says the blocker's detail, else a question's prompt, trimmed and cut at `LANE_WAIT_WORDS_MAX` (160), as the status ledger worded it until MV-6 removed it. The swarm's body words a wait in its own order |
| `spawn-menu.ts` | The spawn menu's tree as a view offers it (capability `spawn`): `menuOf`, `selfDevice`, `defaultProfile`, `ready`, `blooms`, `initials`, `profileWord`, `hereWord`, `budSub`, `glyphName`, and `spawnTargetFor`, which names the desktop you sit at by leaving it out (M34). The swarm's bloom and the list's two-step menu share it |
| `colour.ts` | `projectColour(seq, tint)`, `paneColour`, `projectHue`, `paneHue`, `oklchToHex`, `DEFAULT_PROJECT_TINT`, and `projectColourFor(palette)`, which hosts use to build the replica's theme colour function (L7); `hexToRgb255` for canvas `rgba()` |
| `light.ts` | The light a canvas view paints state with (DESIGN §8), the swarm's rules, which the timeline lights by since MV-8 folded its copy here (M57): `parseCssColor` / `resolveCssColor` (CSS into straight-alpha `Rgba`, resolved in the view's own root), `withAlpha`, `luminance`, `isLightTheme`, `rgbaCss`; a state colour as words (`readableColour`), as its light (`vividColour`, `stateGlow`) and as the ground a lit body sits on (`stateGround`), tuned by `StateLightTuning` (`DEFAULT_STATE_LIGHT` is the swarm's default tuning) |
| `marks.ts` | Agent marks (`agentMark`, `agentMarkSvg`, `agentMarkTile`, `AGENT_MARK_ATLAS`, the candidates) and profile glyphs (`PROFILE_GLYPHS`, `PROFILE_GLYPH_SHAPES`, `profileMarkName`, `profileGlyphMarkup`, `profileGlyphSvg`) |
| `mark-outline.ts` | A view's own mark, for its manifest (MV-D6): the host's bar FILLS `manifest.mark` in currentColor and never strokes it (ruled at MV-8: a stroked outline draws both edges). `strokeOutline(from, to)`, `strokesOutline(strokes)` and `ringOutline(cx, cy, r)` write the filled outline a monoline stroke paints on the bar's grid (`MARK_VIEW_BOX`, `MARK_STROKE` = 1.6, round caps) |
| `marks-atlas.ts` | `MARKS_ATLAS_URL`, the swarm's SDF atlas as a data URL |
| `canvas.ts` | `sizeCanvas` (device-pixel backing store, CSS-pixel element, writes only on change), `canvasRatio`, `watchDevicePixelRatio` |
| `motion.ts` | `createMotionLoop(callback, { animations, reducedMotion, fps? })`, which requests no frame at all while animations are off or motion is reduced, and re-evaluates on `loop.update(input.theme)` |

## Ported, with identical output

Every helper is ported from the views package. Where the views still keep their own copy, `test/toolkit-parity.test.ts`
runs each original beside its port over the same inputs, so an edit to either copy fails there. Where the original was
a frozen legacy view or the legacy shim (the swarm's and the timeline's words, the status ledger's wait words, the line
under the name), the copy went with MV-8, and the suite keeps the values the parity pinned.

The ports keep a few differences in their signatures, so a ported view prints exactly what it printed before:

- `formatRatePerHour` takes USD **an hour**, the row's `burnPerHour`. The swarm's own copy took USD a minute and
  multiplied by 60. The words are the same.
- `formatElapsed` prints days from 24 hours, as the timeline does. The swarm's terminal line never printed days
  (`27h 03m`), so it passes `{ days: false }`. Unifying the two would be a visible change, to be named and shown.
- `formatPercent` floors, as the list and the swarm print context. The rain's tooltip rounds (`CTX 43%`), so it
  keeps its own `Math.round`.
- `profileGlyphSvg` writes the same element `/react`'s `ProfileGlyph` renders, as markup. The React components
  themselves (`AgentIcon`, `ProfileGlyph`) are not in the toolkit, because it is framework-free: since MV-4 they are
  `@vibecook/puppeteer-view-sdk/react`'s (M6), drawn from these marks, and the views' copies are gone.
- `sizeCanvas` follows the timeline: it rounds the CSS size and the backing size, and writes the backing size only
  when it changes. The rain floored its backing size and wrote it on every resize. Pass `{ pixels: 'floor' }` to
  keep the rain's pixels; with integer `clientWidth` and an integer ratio the two agree anyway.

## Colour and the replica (L7)

A host resolves the live tokens into a `MonitorPalette`, builds `projectColourFor(palette)` and hands it to the
replica with the theme's key. The function deals each sequence once per theme and gives the neutral ramp to a row
with no `project.seq`. The replica re-colours rows only when the key changes, and views receive
`AgentView.colour` ready. A view never calls `projectColour` itself.

## The motion loop and `theme.animations`

```ts
const loop = createMotionLoop((time, deltaMs) => draw(time, deltaMs), input.theme);
// in update(input):
loop.update(input.theme); // starts or stops; keeps an fps given at creation
if (!loop.running) draw(performance.now(), 0); // a stopped loop draws once per update
```

While either switch says no, the loop holds no `requestAnimationFrame` at all, which is the conformance rule
(MV-W4: no loop when off).

## Workers and bundlers (MV-D7)

A view owns its worker. `createWorkerDriver` carries VibeField's swarm driver semantics into the SDK:
- **The watchdog.** A worker posts `WORKER_READY` once its imports have evaluated. Any message counts as proof
  of life, and a worker silent for 4 s is presumed never to arrive.
- **Demotion with replay.** A worker that never proved itself, or fails to load, is terminated. The same
  simulation then starts inline and is handed the world: the latest command of each `replayKey`, in the order of
  their latest post. Gestures are not replayed.
- **An honest mode.** `observeMode` reports `worker` or `inline`, and the view passes it to
  `commands.report({ physics })`.
- **No rebuild.** A proven worker that dies later is reported through `onError`, never rebuilt.
- **Its own end.** In the worker, `serveWorker` answers through `end.post` and ends the thread with `end.close()`,
  so a view's worker never names the global object (MV-W2 reads an alias of it as a reach, MV-8b).

```ts
// views/swarm/physics/driver.ts: the view's own code (the swarm's since MV-5; sketched here)
const driver = createWorkerDriver<Command, Message>({
  createWorker: () =>
    new Worker(new URL('./swarm-physics.worker.js', import.meta.url), { type: 'module', name: 'swarm-physics' }),
  createInline: (deliver) => createInlinePhysics(deliver),
  onMessage: receive,
  replayKey: (command) => (WORLD.has(command.type) ? command.type : undefined),
});
const stop = driver.observeMode((physics) => commands.report({ physics }));

// views/swarm/physics/swarm-physics.worker.ts: the worker entry, beside it
import { serveWorker } from '@vibecook/puppeteer-view-sdk/toolkit';
const end = serveWorker<Command>((command) => host.handle(command)); // after every import: `ready` is honest
// …and on `dispose`: end.close();
```

Three rules make that one line work in every host:
1. **Write the constructor literally:** `new Worker(new URL('./x.worker.js', import.meta.url), { static options })`.
   Vite bundles only that exact shape: `new Worker(` directly followed by `new URL(…, import.meta.url)`, with
   options it can read statically. A URL computed any other way, even `a ?? new URL(…)` inside the call, is
   invisible to Vite.
2. **Spell it `.js`.** A view is consumed as source, and Vite maps a missing `./x.worker.js` to the
   `./x.worker.ts` beside it. A published build carries the `.js`, and an esbuild host emits `.js`.
3. **Name it `<view>-<name>.worker.js`.** An esbuild host puts every view's worker in one flat output directory,
   so the view's id in the name keeps two views from colliding.

### What each host's bundler does with it

Verified on 2026-10-03 with `scripts/verify-worker-bundling.mjs` (fixture in `test/worker-bundling/`). Each build
ran in a hidden Electron 43.1.0 window, the way its host loads it, under its host's CSP. Vite 7.3.6 (this
workspace) and Vite 8.1.5 (VibeField's) gave identical results; esbuild was 0.24.2 (apps/godview's).

| Host bundler | Where the simulation ran | Why | What the host does |
|---|---|---|---|
| Vite build (VibeField's renderer, standard secure scheme, production CSP) | worker | Vite resolves the entry and emits a same-origin worker chunk | nothing |
| Vite dev server (VibeField's `pnpm dev`) | worker | the same, served | nothing |
| esbuild ESM without the entry built (apps/godview/build.mjs before MV-5, `loadFile`, Godview's CSP) | inline, demoted ("unknown worker error") | esbuild leaves `new URL(…)` untouched and emits no worker; the fetch fails and the `error` event demotes at once | see the next row |
| esbuild ESM, with the host also building the entry | worker | `build({ entryPoints: { 'swarm-physics.worker': <the view's entry> }, outdir })` puts it beside the chunks, where `import.meta.url` resolves (build.mjs already copies ghosttea's `terminal-render.worker.js` the same way) | one more entry point per view worker — build.mjs builds the swarm's `swarm-physics.worker` since MV-5 |
| esbuild IIFE (the labs' single page) | inline from the start ("Failed to construct 'URL'") | IIFE empties `import.meta`, so `new URL(…, undefined)` throws inside `createWorker` | nothing can fix this from inside the view |
| esbuild IIFE, with a URL the page provides | worker | the page builds the entry as IIFE text and hands over a blob URL (labs have no CSP) | needs a way to hand the URL to the view (below) |

So `new URL('./x.worker.js', import.meta.url)` gives a working worker under Vite as written. Under esbuild ESM it
works once the host builds the entry beside its chunks. Under esbuild IIFE it never can. In every case where it
cannot, the driver demotes, and the reported mode tells the truth.

**Open (asked of the lead): a host-provided URL.** The contract has no way today to hand a view a worker URL its
host built. The fixture's `__workerUrl` stands in for one. The candidate is an additive field
(`MonitorViewManifest.workers` naming the entries, `MonitorViewInput.workers` mapping each name to a URL). With
it, a lab gets a real worker and an esbuild host can pass its emitted file explicitly. Without it, labs simulate
inline, honestly.

### Running the proof

```sh
pnpm --filter @vibecook/puppeteer-view-sdk verify:worker-bundling            # this workspace's Vite
pnpm --filter @vibecook/puppeteer-view-sdk verify:worker-bundling -- --vite <path to another vite package>
```

It is not part of `pnpm test`, because it starts Electron (hidden windows only, no input). It runs one Electron
process per page. In a single session, Electron 43's main process died with SIGTRAP when the next window opened
after a window whose page ran a dedicated worker had been destroyed. Each page on its own was reliable. Godview
itself did not reproduce it (MV-5, `apps/godview/worker-windows-probe.mjs`, Electron 43.1.0, 2026-10-05): four
offscreen windows opened through its own door, two destroyed while their swarm's physics worker ran, another opened
after each, the main process alive throughout.
