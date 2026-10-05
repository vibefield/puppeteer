#!/usr/bin/env node

// Capture the view goldens (README.md): every lab view (list, rain, swarm, timeline) in both themes
// at Godview's three stage sizes, for n = 1 and n = 20, on the capture clock, still (the rain and
// the swarm in motion, below). One offscreen Electron window does all of it
// (capture-main.mjs). The wall clock's time zone and the locale are pinned, because the timeline
// prints local times.
//
//   node goldens/capture.mjs                 capture into a fresh temp dir and print it
//   node goldens/capture.mjs --compare       …then compare it against goldens/views (compare.mjs)
//   node goldens/capture.mjs --update        capture straight into goldens/views
//   options: --out <dir> · --only <text> (ids containing it) · --no-build (reuse dist/*-lab.html)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GOLDENS, compareGoldens } from './compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const dist = join(app, 'dist');
const electron = createRequire(import.meta.url)('electron');

/** The labs' own constants (packages/views/src/lab): LAB_SIZES, LAB_NOW_MS, LAB_SEED. capture-main
 * checks every stage against the size asked for, so a drift here fails loudly rather than quietly. */
const SIZES = { compact: [680, 170], default: [1180, 252], wide: [1728, 378] };
const CLOCK = '2026-10-03T15:00:00.000Z';
const SEED = 'mv0';
const THEMES = ['light', 'dark'];
const COUNTS = [1, 20];
const FRAMES = 60;
const DPR = 2;
// `animations`: what each view is captured with. The rain had no switch of its own until MV-4, so its goldens were
// always taken with its loop running, the capture clock stepping it; since it honours the switch (MV-W4) it is
// asked for motion outright, which draws exactly what it drew. Every other view is captured still.
const VIEWS = [
  { view: 'list', page: 'list-lab.html', script: 'list-lab.mjs', animations: '0' },
  { view: 'rain', page: 'rain-lab.html', script: 'rain-lab.mjs', animations: '1' },
  // The swarm (MV-5, M32): offscreen capturePage draws WebGPU. In motion, as the rain: its physics step on the capture
  // clock, so the field is the same settled field on every run.
  { view: 'swarm', page: 'swarm-lab.html', script: 'swarm-lab.mjs', animations: '1' },
  // One set of ids since MV-8: the timeline was captured twice, with the book Godview kept and bare (`-bare`), until
  // MV-6 retired the book (runtime only, L10) and both drew byte-identical images; MV-8 folded them (M60, M63).
  { view: 'timeline', page: 'timeline-lab.html', script: 'timeline-lab.mjs', animations: '0' },
];

const flag = (name) => process.argv.includes(`--${name}`);
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (!flag('no-build')) {
  for (const { script } of VIEWS) {
    const built = spawnSync(process.execPath, [join(app, script)], {
      cwd: app,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (built.status !== 0) throw new Error(`${script} failed (${built.status})`);
  }
}

const out = flag('update') ? GOLDENS : (option('out') ?? mkdtempSync(join(tmpdir(), 'godview-goldens-')));
const only = option('only');
const images = [];
for (const { view, page, animations } of VIEWS) {
  for (const theme of THEMES) {
    for (const [size, [width, height]] of Object.entries(SIZES)) {
      for (const n of COUNTS) {
        const file = `${view}/${theme}-${size}-n${n}.png`;
        if (only && !file.includes(only)) continue;
        const query = new URLSearchParams({ capture: '1', theme, size, n: String(n), animations });
        images.push({
          file,
          view,
          theme,
          size,
          n,
          animations: animations === '1' ? 'on' : 'off',
          width,
          height,
          url: `${pathToFileURL(join(dist, page)).href}?${query}`,
        });
      }
    }
  }
}
if (flag('update')) for (const { file } of images) rmSync(join(out, file), { force: true });

const timeoutMs = 60_000 + images.length * 15_000;
const scratch = mkdtempSync(join(tmpdir(), 'godview-goldens-job-'));
const jobPath = join(scratch, 'job.json');
writeFileSync(
  jobPath,
  JSON.stringify({
    dpr: DPR,
    frames: FRAMES,
    timeoutMs,
    pages: images.map((image) => ({ id: image.file, ...image, out: join(out, image.file) })),
  }),
);
const environment = { ...process.env, GODVIEW_GOLDENS_JOB: jobPath, TZ: 'UTC', LANG: 'en_US.UTF-8' };
delete environment.ELECTRON_RUN_AS_NODE;
// The window's own watchdog is the first guard; this is the second, for an Electron that never got as far.
const run = spawnSync(electron, [join(here, 'capture-main.mjs')], {
  cwd: app,
  env: environment,
  encoding: 'utf8',
  timeout: timeoutMs + 30_000,
  killSignal: 'SIGKILL',
});
rmSync(scratch, { recursive: true, force: true });
const lines = `${run.stdout ?? ''}`.split('\n');
const versions = JSON.parse(lines.find((line) => line.startsWith('GOLDEN_ENV '))?.slice(11) ?? '{}');
const failures = lines.filter((line) => line.startsWith('GOLDEN_FAIL ') || line.startsWith('GOLDEN_WATCHDOG'));
if (run.status !== 0 || failures.length > 0) {
  console.error(failures.join('\n') || `${run.stderr ?? ''}`.slice(-2000));
  console.error(`capture failed (electron exit ${run.status})`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const recorded = images.map(({ url: _url, width, height, ...image }) => ({
  ...image,
  stage: `${width}×${height}`,
  sha256: createHash('sha256')
    .update(readFileSync(join(out, image.file)))
    .digest('hex'),
}));
// A partial re-record keeps the rest of the inventory it did not touch.
const kept = existsSync(join(out, 'manifest.json'))
  ? JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).images.filter(
      (image) => only && !recorded.some((entry) => entry.file === image.file),
    )
  : [];
const manifest = {
  tool: 'apps/godview/goldens/capture.mjs',
  clock: CLOCK,
  seed: SEED,
  frames: FRAMES,
  dpr: DPR,
  timeZone: 'UTC',
  locale: 'en-US',
  // Per image since MV-4 (`images[].animations`): the rain is captured in motion, every other view still.
  animations: 'per image',
  environment: { ...versions, platform: process.platform, arch: process.arch, os: release() },
  images: [...kept, ...recorded].sort((left, right) => left.file.localeCompare(right.file)),
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`captured ${images.length} goldens into ${out}`);

if (flag('compare')) {
  const summary = compareGoldens({ candidate: out, ...(only ? { files: images.map((image) => image.file) } : {}) });
  for (const row of summary.rows.filter((entry) => entry.verdict !== 'PASS')) {
    console.log(`${row.verdict} ${row.file}${row.ratio === undefined ? '' : ` ${(row.ratio * 100).toFixed(3)} %`}`);
  }
  console.log(`goldens: ${summary.passed} of ${summary.images} pass — ${join(out, 'report.md')}`);
  process.exit(summary.failed === 0 ? 0 : 1);
}
