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
  `requestAnimationFrame` and `performance`, and only when a view calls the helper that needs them.

## What is here

| Module | What it gives a view |
|---|---|
| `format.ts` | `formatUsd`, `formatEstimate` (`~$7.03`, `~$7.03+` while partly priced, `—` with no price lane), `formatRatePerHour`, `formatElapsed` (`4:39`, `2h 05m`, `1d 03h`), `formatShort` (`11m`), `formatWords`, `formatClock`, `formatCount`, `formatTokens`, `formatPercent` |
| `state-words.ts` | MV-D11's one table: `STATE_WORDS` (status, terminal, wait, unread, kind), `statusWord`, `waitWord`, `waitMark`, `openingWord`, `unreadSpoken`, `stateTone`, `stateWord`; the recede steps `RECEDED_OPACITY`, `RECEDED_EMPTY_OPACITY`, `RECEDE_MS`, `everyReceded`, `recedeTarget`, `approachRecede` |
| `colour.ts` | `projectColour(seq, tint)`, `paneColour`, `projectHue`, `paneHue`, `oklchToHex`, `DEFAULT_PROJECT_TINT`, and `projectColourFor(palette)`, which hosts use to build the replica's theme colour function (L7); `hexToRgb255` for canvas `rgba()` |
| `marks.ts` | Agent marks (`agentMark`, `agentMarkSvg`, `agentMarkTile`, `AGENT_MARK_ATLAS`, the candidates) and profile glyphs (`PROFILE_GLYPHS`, `PROFILE_GLYPH_SHAPES`, `profileMarkName`, `profileGlyphMarkup`, `profileGlyphSvg`) |
| `marks-atlas.ts` | `MARKS_ATLAS_URL`, the swarm's SDF atlas as a data URL |
| `canvas.ts` | `sizeCanvas` (device-pixel backing store, CSS-pixel element, writes only on change), `canvasRatio`, `watchDevicePixelRatio` |
| `motion.ts` | `createMotionLoop(callback, { animations, reducedMotion, fps? })`, which requests no frame at all while animations are off or motion is reduced, and re-evaluates on `loop.update(input.theme)` |

## Ported, with identical output

Every helper is ported from the views package, which keeps its own copies until the views move onto the SDK in
wave 3. `test/toolkit-parity.test.ts` runs each original beside its port over the same inputs, so an edit to
either copy fails there. Delete that suite together with the views' copies.

The ports keep a few differences in their signatures, so a ported view prints exactly what it printed before:

- `formatRatePerHour` takes USD **an hour**, the row's `burnPerHour`. The swarm's own copy took USD a minute and
  multiplied by 60. The words are the same.
- `formatElapsed` prints days from 24 hours, as the timeline does. The swarm's terminal line never printed days
  (`27h 03m`), so it passes `{ days: false }`. Unifying the two would be a visible change, to be named and shown.
- `formatPercent` floors, as the list and the swarm print context. The rain's tooltip rounds (`CTX 43%`), so it
  keeps its own `Math.round`.
- `profileGlyphSvg` writes the same element the views' React `ProfileGlyph` renders, as markup. The React
  components themselves (`AgentIcon`, `ProfileGlyph`) are not in the toolkit, because it is framework-free.
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
