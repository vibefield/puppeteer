#!/usr/bin/env node

// The swarm's goldens (README.md): not pixels but the frames the shipping AgentSwarm hands its
// renderer — every body's place, size, arrival, light, accent and bubble model, frame by frame —
// recorded through a paint spy. The spy replaces `createSwarmRenderer` for AgentSwarm alone at
// bundle time; everything else runs as shipped: the view, its models, the inline physics (on the
// capture clock's 60 Hz frames, so a fixed timestep), real layout and real chrome avoidance in an
// offscreen Electron window (capture-main.mjs).
//
// Each scenario steps 60 frames from mount, moves the world on (`labWorld({ churn: true })`: a
// status flip each way, a removal and an arrival), and steps 60 more. The golden keeps every 4th
// frame, the frames either side of the change, and the last; models are stored once, by hash.
//
//   node goldens/swarm-frames.mjs            record into a temp dir and compare against goldens/swarm
//   node goldens/swarm-frames.mjs --update   re-record goldens/swarm (an intentional change, named in its commit)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dist, labBundle, labEntry, labStyles, views } from '../lab-page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const goldens = join(here, 'swarm');
const electron = createRequire(import.meta.url)('electron');

const SIZES = { compact: [680, 170], default: [1180, 252], wide: [1728, 378] };
const SCENARIOS = [
  { name: 'default-n20-light', size: 'default', n: 20, theme: 'light' },
  { name: 'compact-n20-dark', size: 'compact', n: 20, theme: 'dark' },
  { name: 'default-n1-light', size: 'default', n: 1, theme: 'light' },
];
const BEFORE = 60;
const AFTER = 60;
const SCRIPT = [{ step: BEFORE }, { churn: true }, { step: AFTER }];
const KEEP_EVERY = 4;

/** The spy: the real renderer module, but `createSwarmRenderer` hands back a renderer that records. */
function spyModule() {
  const real = join(views, 'views/swarm/gpu/swarm-renderer.ts');
  return `export * from ${JSON.stringify(real)};
const frames = (globalThis.__vfSwarmFrames = []);
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const channels = (rgba) => rgba.map((channel) => round(channel, 3));
export async function createSwarmRenderer() {
  return {
    ok: true,
    renderer: {
      render(frame) {
        frames.push({
          time: round(frame.time, 4),
          motion: frame.motion,
          ...(frame.veil ? { veil: round(frame.veil, 3) } : {}),
          ...(frame.hold ? { hold: frame.hold } : {}),
          ...(frame.clearings ? { clearings: frame.clearings.length } : {}),
          bodies: frame.bodies.map((body) => ({
            id: body.model.id,
            x: round(body.x, 2),
            y: round(body.y, 2),
            radius: round(body.radius, 2),
            scale: round(body.scale, 3),
            opacity: round(body.opacity, 3),
            focus: body.focus,
            seed: round(body.seed, 4),
            accent: channels(body.accent),
            ...(body.link ? { link: channels(body.link) } : {}),
            ...(body.aboveClearings ? { above: true } : {}),
            model: body.model,
          })),
        });
      },
      resize() {},
      destroy() {},
      lost: new Promise(() => {}),
    },
  };
}
`;
}

async function buildPage() {
  const scratch = mkdtempSync(join(tmpdir(), 'godview-swarm-spy-'));
  const spy = join(scratch, 'swarm-renderer-spy.js');
  writeFileSync(spy, spyModule());
  const plugin = {
    name: 'swarm-renderer-spy',
    setup(build) {
      // Only the shipping view's renderer is swapped; the spy's own import reaches the real module by path.
      build.onResolve({ filter: /gpu\/swarm-renderer\.js$/ }, (args) =>
        args.importer.endsWith('AgentSwarm.tsx') ? { path: spy } : undefined,
      );
    },
  };
  // The view's own stylesheets ride in the bundle (L18): the field's size is theirs.
  const { script, css } = await labBundle(labEntry('swarm'), [plugin]);
  rmSync(scratch, { recursive: true, force: true });
  const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Swarm frames</title><style>
${await labStyles()}
${css}
</style></head>
<body>
<div id="lab" class="lab-root swarm-lab vf-godview theme-light platform-darwin" data-godview-animations="on">
  <div class="lab-view"></div>
</div>
<script>
${script}
</script>
</body>
</html>
`;
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'swarm-frames-lab.html'), page);
  return join(dist, 'swarm-frames-lab.html');
}

const round = (value) => (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value);
const rounded = (value) =>
  Array.isArray(value)
    ? value.map(rounded)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rounded(entry)]))
      : round(value);

/** Every frame recorded → the golden: the kept frames, models by hash. */
function goldenOf(scenario, raw) {
  const models = {};
  const frames = raw.map((frame, index) => ({
    index,
    ...frame,
    bodies: frame.bodies.map(({ model, ...body }) => {
      const json = JSON.stringify(rounded(model));
      const hash = createHash('sha256').update(json).digest('hex').slice(0, 12);
      models[hash] ??= JSON.parse(json);
      return { ...body, model: hash };
    }),
  }));
  const kept = frames.filter(
    (frame) =>
      frame.index % KEEP_EVERY === 0 ||
      frame.index === BEFORE - 1 ||
      frame.index === BEFORE ||
      frame.index === frames.length - 1,
  );
  const used = new Set(kept.flatMap((frame) => frame.bodies.map((body) => body.model)));
  return {
    scenario,
    script: SCRIPT,
    keepEvery: KEEP_EVERY,
    recorded: frames.length,
    frames: kept,
    models: Object.fromEntries(Object.entries(models).filter(([hash]) => used.has(hash))),
  };
}

/** Field-by-field: the first differences, with where they are. */
function differences(expected, actual, path = '', found = []) {
  if (found.length >= 20) return found;
  if (typeof expected !== typeof actual || Array.isArray(expected) !== Array.isArray(actual)) {
    found.push(`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`);
  } else if (expected && typeof expected === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) differences(expected[key], actual[key], `${path}/${key}`, found);
  } else if (expected !== actual) {
    found.push(`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`);
  }
  return found;
}

const page = await buildPage();
const update = process.argv.includes('--update');
const out = update ? goldens : mkdtempSync(join(tmpdir(), 'godview-swarm-frames-'));
const raw = mkdtempSync(join(tmpdir(), 'godview-swarm-raw-'));
const job = join(raw, 'job.json');
writeFileSync(
  job,
  JSON.stringify({
    dpr: 2,
    frames: 0,
    timeoutMs: 60_000 + SCENARIOS.length * 30_000,
    pages: SCENARIOS.map((scenario) => {
      const [width, height] = SIZES[scenario.size];
      const query = new URLSearchParams({
        capture: '1',
        size: scenario.size,
        n: String(scenario.n),
        theme: scenario.theme,
        animations: '1',
      });
      return {
        id: scenario.name,
        url: `${pathToFileURL(page).href}?${query}`,
        width,
        height,
        script: SCRIPT,
        collect: 'frames',
        out: join(raw, `${scenario.name}.json`),
      };
    }),
  }),
);
const environment = { ...process.env, GODVIEW_GOLDENS_JOB: job, TZ: 'UTC', LANG: 'en_US.UTF-8' };
delete environment.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electron, [join(here, 'capture-main.mjs')], {
  cwd: app,
  env: environment,
  encoding: 'utf8',
  timeout: 60_000 + SCENARIOS.length * 30_000 + 30_000,
  killSignal: 'SIGKILL',
});
const failures = `${run.stdout ?? ''}`.split('\n').filter((line) => /^GOLDEN_(FAIL|WATCHDOG)/.test(line));
if (run.status !== 0 || failures.length > 0) {
  console.error(failures.join('\n') || `${run.stderr ?? ''}`.slice(-2000));
  process.exit(1);
}

mkdirSync(out, { recursive: true });
let failed = 0;
for (const scenario of SCENARIOS) {
  const golden = goldenOf(scenario, JSON.parse(readFileSync(join(raw, `${scenario.name}.json`), 'utf8')));
  writeFileSync(join(out, `${scenario.name}.json`), `${JSON.stringify(golden, null, 1)}\n`);
  if (update) continue;
  const committed = join(goldens, `${scenario.name}.json`);
  if (!existsSync(committed)) {
    failed += 1;
    console.log(`MISSING ${scenario.name}: no golden at ${committed}`);
    continue;
  }
  const found = differences(JSON.parse(readFileSync(committed, 'utf8')), golden);
  if (found.length === 0)
    console.log(`PASS ${scenario.name}: ${golden.frames.length} frames, ${golden.recorded} recorded`);
  else {
    failed += 1;
    console.log(`FAIL ${scenario.name}:\n  ${found.join('\n  ')}`);
  }
}
rmSync(raw, { recursive: true, force: true });
console.log(
  update
    ? `swarm goldens written to ${out}`
    : `swarm frames: ${SCENARIOS.length - failed} of ${SCENARIOS.length} match — capture in ${out}`,
);
process.exit(failed === 0 ? 0 : 1);
