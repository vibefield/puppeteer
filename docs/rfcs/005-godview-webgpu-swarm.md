# RFC 005: Godview Swarm on WebGPU

- **Status:** Accepted and implemented; design locked 2026-09-09 and folded into the design-system record (§10)
- **Date:** 2026-09-06
- **Owners:** Godview maintainers
- **Related:** [`004-layered-agent-runtime.md`](./004-layered-agent-runtime.md), the swarm proposals record (`protos/godview-proto/swarm-proposals.html`, pass 9), `DESIGN.md` §2.4–2.7

## Decision

The swarm view draws everything inside its stage with one WebGPU canvas: the field, every agent body, its glow, its
burn graph, its context ring, its marks, and its text. The DOM keeps only what is not drawing: the shell chrome
around the stage, a visually hidden button per agent for keyboard and assistive access, and a hover tooltip.

The swarm is the first Godview view to render on the GPU. The list and rain views are unchanged by this RFC.

## Why

The swarm's design language is light and distance: soft outer glows, a graph that fills a body, a ring that follows
a rim, a dashed rim, breathing. Each of those was approximated in CSS with pre-blurred pseudo-elements, filters,
SVG, and 24 particle elements per working body, and the approximations were both the visual ceiling and the
performance floor: box-shadow blur and `filter: blur()` re-rasterise on every animation frame, while a field of
thirty bodies is thousands of DOM nodes moving under `transform` at 60 Hz.

A signed-distance renderer makes those marks analytic. A 34 px blur becomes one exponential of the distance to the
rim; a ring, a dash, and a gauge become annulus and angle tests; the graph is a function of x sampled from a buffer.
One render pass, four pipelines, and one instance buffer upload per frame is the whole cost, independent of how many
bodies are working or glowing. This is also the direction the Godview has been heading: fully shader-drawn.

WebGPU is available without flags in the Electron this app pins (Electron 43, Chromium 150): the probe on a
transparent, vibrancy-backed `file://` window returns a Metal 3 adapter, `bgra8unorm`, and accepts
`alphaMode: 'premultiplied'`. It is **not** exposed on `data:` URLs (not a secure context), which is only relevant
to probes and tests, never to the app.

## Boundaries that do not move

- Semantics still come from Core's monitor state and Ghosttea's session activity, never from terminal text
  (`DESIGN` ADR-003). The renderer is a pure function of `MonitorAgent[]`, the parameters, and the palette.
- Physics stays on the CPU in Matter.js. Bodies are tens, not thousands; drag constraints, walls, and chrome
  obstacles stay exactly as they are. The GPU renders positions; it does not own them.
- Colour still comes from the tokens. `monitor-palette.ts` remains the one reader of the design system; it gains a
  `swarm` block resolved from the theme-scoped `.vf-godview` root, because a canvas cannot inherit a custom property.
- Status is a mark, identity is a ground: the per-agent accent (§2.6) tints the graph, the ring, the link ring; the
  state reading is the body treatment and the orange of §2.5.
- Every mark an agent makes stays inside its own rim, because bodies cluster under centre gravity. Light is the one
  exception: a glow takes no room.

## Architecture

```text
MonitorAgent[] ─► bubble-model.ts ─► SwarmBubbleModel[]      (pure: state, radius, lines, series, colours)
                        │
      Matter.js ────────┼──► per-frame instance packing ──► GPU buffers
                        │                                      │
   glyph-atlas.ts ──────┘ (Canvas2D-rasterised glyphs, r8unorm) │
                                                               ▼
                           one render pass: field → glow → body → text  (premultiplied over the window's glass)
```

Files, all under `apps/godview/src/renderer/views/swarm/`:

| File                      | Owns                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `AgentSwarm.tsx`          | Physics, placement, pointer gestures, the canvas element, the hidden button list, the tooltip |
| `bubble-model.ts`         | The complete controller-free reading of one body: drawn state, radius, text lines, marks      |
| `burn-series.ts`          | `usage.samples` → forty buckets of ten minutes on the log intensity scale                     |
| `text-layout.ts`          | Fitting lines inside a circle's chord with ellipsis, given a measurer                         |
| `swarm-parameters.ts`     | Tunables (existing engine/size controls plus glow reach, strength, breath)                    |
| `gpu/glyph-atlas.ts`      | Glyph and sprite rasterisation at the device pixel ratio, shelf packing                       |
| `gpu/swarm-renderer.ts`   | Device and canvas lifecycle, pipelines, buffers, per-frame encoding                           |
| `gpu/shaders/*.wgsl`      | `field`, `glow`, `body`, `text`                                                               |
| `../../monitor/unread.ts` | Which idle agents have a reply the user has not looked at                                     |

### Drawn states

Five drawn states, from the proposals record (pass 9), all at the physics radius:

| State             | Radius | Body                                                                                                                              | Marks                                                                                                                                                                                          | Lines                          |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Terminal, empty   | 50     | Transparent, 1.5 px dashed rim at ink 52 %                                                                                        | Folder mark                                                                                                                                                                                    | name · `empty`                 |
| Terminal, running | 50     | Transparent, solid rim at ink 22 %, comet sweeping the rim (1.4 s)                                                                | Folder mark                                                                                                                                                                                    | name · `running` · elapsed     |
| Agent, idle       | 50     | Idle fill at the fill opacity                                                                                                     | Context ring in the ink; when unread, the latest reply on one line led by a blue dot                                                                                                        | name · model · effort · reply  |
| Agent, working    | 60–80  | Working fill, 1 px working rim, resting drop shadow breathing at 3 s, an accent light at the centre breathing with the mark | Burn bars in the ink, output up and input down about a baseline, the total below them, context ring in the ink, the agent's mark breathing behind the copy, the context figure on the top chord | branch · name · model · effort |
| Agent, blocked    | 50     | Blocked (inverted) fill flooded by the accent from the centre (95 % at the centre, about 44 % at the rim), no rim                 | The latest reply on one line led by an orange dot, or the blocker's kind when there is none; the ink is whichever of the theme's stands furthest from the flood                                 | name · model · effort · reply  |

Stale evidence dims the body to 58 % and desaturates it; a mounted pane wears its pane colour as the outer light;
the active pane and keyboard focus draw a focus ring. Spawn replays the arrival curve (0 → 1.2 → 0.96 → 1.035 → 1 over 720 ms) as a
per-body visual scale; size changes ease over 300 ms. A working body's radius is its share of the working sessions'
tokens: the least stays at the working size (60), the most takes the largest size (80), and the rest fall between in
proportion, so the field shows where the tokens are going. A lone working session, or a tie, stays at 60. Reduced motion, and the stage's `animations=off` diagnostic,
freeze the time uniform.

### Burn bars

The bars are the decided burn instrument, and they have two sides. Core's canonical usage samples carry the
cumulative prompt side (input, cache reads, cache creation) and completion side (output, reasoning) alongside the
total whenever a source splits its usage; the view differences each side into forty buckets over the last ten
minutes, each mapped to an intensity `t = clamp((log10(rate) − log10(500)) / 2, 0, 1)` so that 500 tok/min is the
floor and 50 000 tok/min the top. The shader draws twenty columns of thirty seconds (the mean of two samples; forty
of fifteen is a lab variant) across the middle 56 % of the diameter, each 60 % of its pitch wide with a semicircular
far end, in the theme's ink at 45 %, either side of a hairline baseline through the middle of the band: the
completion side rises, the prompt side falls, and each fills its half of the band at the top of the scale. The band
runs from 4 px under the model · effort line to 8 px above the total figure, whatever the radius. A silent side
keeps a 1.5 px stub. The newest pair is full and breathes, and turns orange when the burn is hot. A source that
does not split its usage puts the whole burn up, with the live `burnRatePerMin` as the newest bucket, and nothing
down. The bars are clipped to the circle and drawn under the text.

### Context ring and figures

A 1 px track at ink 18 % and a gauge in the ink at 55 % (a mid grey over either fill), a twelfth of the radius wide (5 px at 60, 6.7 px at 80)
with round caps, from twelve o'clock clockwise, its outer edge on the rim. The gauge is the same colour whatever
the state: the figure, not the gauge, turns orange at 80 % and above. On a working body the context figure (`62%`) sits on the top chord, orange when hot, and the
session's total tokens (`1.2M`, from `usage.cumulativeTokens`) on the bottom one under the bars' floor; both are
10.5 px, 7 px in from the rim.

### The latest reply

Core's monitor state carries `lastAssistantMessage`, reduced from `conversation:assistant-message` and
`turn:completed` into a `conversation` family (root actor only, text bounded at 400 characters). A blocked body
shows its first line led by an orange dot, since the agent is waiting on the user; an unread idle body shows it led
by a blue dot. Neither reads terminal text: the adapters observe the message through hooks and transcripts.

### The pane light and the flood

A mounted body emits light in its pane colour, which is also its accent: two analytic falloffs of the distance
outside the rim, a tight photographic rim `exp(−d/6)` and a designer halo `(1 − d/reach)^2.65`, at
`strength · (0.45 · rim + 0.6 · halo)`, measured from a gutter a thirtieth of the radius off the rim (2 px at 60). The gutter is a solid band of the pane
colour just outside the rim, so the mount reads as a crisp ring first and a light second, and the ink gauge inside
the rim stays clear of both. Reach, strength, and a breath rate are tunables so the weight can be dialled live; breath 0 is the steady
lamp. The glow pass renders after the bodies with premultiplied over blending, so light
falls onto neighbours the way light does. The light replaced the 4 px band the DOM drew; the band and the tether
stay in the renderer as lab variants.

A blocked body is flooded by its accent from the centre: a gaussian at 95 % reaching 1.6 radii, so the circle is
nearly the colour at the centre and about 44 % of it at the rim, where the ring and the reply still read. The ink
over a flooded body is whichever of the theme's inks stands furthest in luminance from the flood, the blocked ink
winning ties. The flood carries the blocked reading on its own; the outer light that blocked bodies used to wear is
a lab variant.

### Text

Agent marks are signed-distance tiles (`gpu/marks/marks.png`, twenty 64-texel tiles baked from LobeHub's static
SVGs by `research/svg-sdf`'s generator: spread 8, pxRange 16, the edge at 0.5; each agent's own mark plus the
neighbours it could be confused with, so the lab can show the choice) and are reconstructed in the text pass at
any size from the field, so a mark that breathes with the working body (0.92–1.08, 8–24 %, every 1.5 s, the DOM's
ignition glyph) stays crisp. The tile table lives with the other branding in `AgentIcon.tsx`; a provider without a
tile falls back to its letter.

Glyphs are rasterised by Canvas2D at the device pixel ratio into an `r8unorm` atlas, one entry per size, weight,
style, and character, in the same monospace stack the shell uses, and drawn as instanced quads snapped to device
pixels. Multi-channel distance fields were rejected: the type is 7–14 px, the face is the OS's, and the OS
rasteriser at 2× is the reference the design was approved against. Marks that are pictures (provider watermark,
activity-kind glyphs, the folder) rasterise into the same atlas from inline SVG.

### Colour

The accent is the agent's colour, or the pane's when mounted. It appears in three places: the pane light outside a
mounted body's rim, the flood filling a blocked body, and a light at a working body's centre (a gaussian at 16–34 %
reaching half to three quarters of the radius, breathing with the mark). Everything drawn inside a body is the
theme's ink and greys, the centre light apart: the folder name, the context gauge, the burn bars, the marks, the type.
Orange remains the one state colour, for the hot redline, the hot figure, and the blocker kind.

### Variants

None remain. The lab's alternatives (the tether and the band, the centre light's absence, the soft and flat floods,
the blocked body's outer light, the forty bars, the three gauge weights and four separators) were each seen beside
the winner and deleted once James picked; the design was locked on 2026-09-09 and folded into the design-system
record's swarm section. `RenderBody.glow` remains only so the lab can weigh the pane light's settings side by side.

### Interaction

Pointer events land on the canvas. Hit testing is the topmost body under the pointer (draw order: idle, then
working, then blocked, later arrivals on top). Drag attaches the existing Matter constraint; click selects and
nudges; a long press on empty field creates a terminal there, with the hold indicator drawn by the GPU. Hover shows a
DOM tooltip with the same title text as before. The hidden button list keeps every body reachable by keyboard.

### Unread

An agent is unread while it is idle, it is not the active pane, and Core's `statusSince` is later than the moment
the user last had it in front of them (the later of first sight and the last projection in which it was active).
Reading Core's timestamp rather than watching the status change is what survives coalescing: a short turn can begin
and end between two renders. The rule lives in `monitor/unread.ts` and is applied in `useMonitorAgents`, so any view
may draw it; the swarm draws the dot.

### Failure and fallback

No adapter or device: the stage shows one line, `WebGPU is unavailable on this GPU`, and the hidden button list keeps
the agents reachable. Device loss re-creates the renderer. There is no DOM-bubble fallback; the previous
implementation is removed, not kept in parallel.

## Iterating the design

The review surface is the design lab, `pnpm --filter godview swarm-lab`, which writes `apps/godview/dist/swarm-lab.html`
(and a body-only copy for publishing as an artifact). It runs the production renderer, shaders, and body model over
fixture agents (`views/swarm/lab/fixtures.ts`): every drawn state, the blocked light under several settings, and a
settled field, with the view's own tunables as live controls and a theme switch. What the lab draws is what Godview
draws, so a design change is reviewed as the pixels the app will paint.

The loop: express a candidate as a variant in the code it touches (a flag on the model, a uniform or per-body field
in the renderer, a shader branch), add a stage per variant to the fixtures so the candidates sit side by side, rebuild
the lab and publish it, pick, then delete the losing branches. Variants never live in a separate mock; the proposals
page in `protos/godview-proto/` is the record of what was decided, not a second implementation.

## Build changes

- `@webgpu/types` (dev) and `"types": ["node", "@webgpu/types"]` in the app `tsconfig`.
- esbuild renderer bundle: `loader: { '.wgsl': 'text' }`; `global.d.ts` declares `*.wgsl` as a string module.
- `radiusBlocked` default 70 → 40 per the decided sizes; glow tunables added to the PRESENTATION group.

## Verification

- `pnpm --filter godview typecheck` and `test` (pure modules: model, series, layout, unread, parameters).
- `pnpm godview:smoke` boots the bundle in Electron.
- A live pass on an isolated profile, driven without touching OS focus: Godview launched with
  `--remote-debugging-port`, the page captured and fed input over the Chrome DevTools Protocol, the repository's
  Imposter selected through `PUPPETEER_IMPOSTER_BIN`, and its scenarios (deep research, permission) pushed from a
  scratch control plane on `PUPPETEER_IMPOSTER_SOCKET`. Checked this way: the hollow and running terminal with its
  clock and comet, the idle, working (graph, redline, activity line, figure), and blocked (light, kind line) bodies,
  the pane-link ring, the unread dot, hold-to-create, drag, hover, and both themes.

## Follow-ups

- The running command's name: Ghosttea reports the foreground process group, not its name. A main-process probe
  (like `process-cwd.ts`) can resolve it as explicit process evidence and hand it down through the session record.
- The list and rain views on the same renderer, if their designs ever call for it.
