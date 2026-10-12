#!/usr/bin/env node

// Compare a capture against the goldens (README.md): per pixel, a pixel differs when any channel
// moved by more than `--tolerance` (0–255); an image fails when more than `--threshold` of its
// pixels differ, when its size changed, or when it is missing. Every image with a differing pixel
// gets a diff — golden | capture | where they differ, in red over the golden faded — and the run
// writes report.md and report.json beside the diffs. Exit 1 when anything failed.
//
//   node goldens/compare.mjs --candidate <dir> [--golden <dir>] [--out <dir>] [--tolerance 8] [--threshold 0.001]

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

export const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), 'views');
export const DEFAULT_TOLERANCE = 8;
export const DEFAULT_THRESHOLD = 0.001;

function pngsUnder(directory) {
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.png')) found.push(relative(directory, path));
    }
  };
  walk(directory);
  return found.sort();
}

/** Golden, capture and the differing pixels side by side. */
function diffImage(golden, capture, mask, maxDelta) {
  const { width, height } = golden;
  const out = new Uint8Array(width * 3 * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const row = y * width * 3;
      for (let channel = 0; channel < 4; channel += 1) {
        out[(row + x) * 4 + channel] = golden.data[source + channel];
        out[(row + width + x) * 4 + channel] = capture.data[source + channel];
      }
      const target = (row + 2 * width + x) * 4;
      const delta = mask[y * width + x];
      if (delta > 0) {
        // Red, brighter the further it moved.
        out[target] = 255;
        out[target + 1] = out[target + 2] = Math.round(160 * (1 - delta / Math.max(1, maxDelta)));
      } else {
        const luma = 0.299 * golden.data[source] + 0.587 * golden.data[source + 1] + 0.114 * golden.data[source + 2];
        out[target] = out[target + 1] = out[target + 2] = Math.round(200 + luma * 0.2);
      }
      out[target + 3] = 255;
    }
  }
  return encodePng({ width: width * 3, height, data: out });
}

export function compareGoldens({
  golden = GOLDENS,
  candidate,
  out = candidate,
  tolerance = DEFAULT_TOLERANCE,
  threshold = DEFAULT_THRESHOLD,
  /** Only these goldens (a partial capture's ids); every golden when absent. */
  files,
}) {
  const rows = [];
  const captured = new Set(pngsUnder(candidate));
  const wanted = files ? new Set(files) : undefined;
  for (const file of pngsUnder(golden).filter((path) => !wanted || wanted.has(path))) {
    if (!captured.has(file)) {
      rows.push({ file, verdict: 'MISSING' });
      continue;
    }
    captured.delete(file);
    const expected = decodePng(readFileSync(join(golden, file)));
    const actual = decodePng(readFileSync(join(candidate, file)));
    if (expected.width !== actual.width || expected.height !== actual.height) {
      rows.push({
        file,
        verdict: 'SIZE',
        golden: `${expected.width}×${expected.height}`,
        capture: `${actual.width}×${actual.height}`,
      });
      continue;
    }
    const pixels = expected.width * expected.height;
    const mask = new Uint8Array(pixels);
    let differing = 0;
    let maxDelta = 0;
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      let delta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        delta = Math.max(delta, Math.abs(expected.data[pixel * 4 + channel] - actual.data[pixel * 4 + channel]));
      }
      maxDelta = Math.max(maxDelta, delta);
      if (delta > tolerance) {
        mask[pixel] = delta;
        differing += 1;
      }
    }
    const ratio = differing / pixels;
    const row = { file, verdict: ratio > threshold ? 'FAIL' : 'PASS', differing, ratio, maxDelta };
    if (differing > 0) {
      const diff = join(out, 'diffs', file.replace(/\.png$/, '.diff.png'));
      mkdirSync(dirname(diff), { recursive: true });
      writeFileSync(diff, diffImage(expected, actual, mask, maxDelta));
      row.diff = relative(out, diff);
    }
    rows.push(row);
  }
  for (const file of captured) rows.push({ file, verdict: 'NEW' });

  const failed = rows.filter((row) => row.verdict !== 'PASS');
  const summary = {
    golden,
    candidate,
    tolerance,
    threshold,
    images: rows.length,
    passed: rows.length - failed.length,
    failed: failed.length,
    rows,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const percent = (value) => (value === undefined ? '' : `${(value * 100).toFixed(3)} %`);
  writeFileSync(
    join(out, 'report.md'),
    [
      `# Goldens: ${summary.passed} of ${summary.images} pass`,
      '',
      `Golden \`${golden}\` · capture \`${candidate}\` · a pixel differs past ${tolerance}/255 on any channel · an image fails past ${percent(threshold)} of its pixels.`,
      '',
      '| image | verdict | differing pixels | share | max Δ | diff |',
      '|---|---|---|---|---|---|',
      ...rows.map(
        (row) =>
          `| ${row.file} | ${row.verdict}${row.verdict === 'SIZE' ? ` (${row.golden} → ${row.capture})` : ''} | ${row.differing ?? ''} | ${percent(row.ratio)} | ${row.maxDelta ?? ''} | ${row.diff ? `[diff](${row.diff})` : ''} |`,
      ),
      '',
    ].join('\n'),
  );
  return summary;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const candidate = argument('candidate');
  if (!candidate) {
    console.error(
      'usage: compare.mjs --candidate <dir> [--golden <dir>] [--out <dir>] [--tolerance 8] [--threshold 0.001]',
    );
    process.exit(2);
  }
  const summary = compareGoldens({
    golden: argument('golden', GOLDENS),
    candidate,
    out: argument('out', candidate),
    tolerance: Number(argument('tolerance', DEFAULT_TOLERANCE)),
    threshold: Number(argument('threshold', DEFAULT_THRESHOLD)),
  });
  for (const row of summary.rows.filter((entry) => entry.verdict !== 'PASS')) {
    console.log(`${row.verdict} ${row.file}${row.ratio === undefined ? '' : ` ${(row.ratio * 100).toFixed(3)} %`}`);
  }
  console.log(
    `goldens: ${summary.passed} of ${summary.images} pass — ${join(argument('out', candidate), 'report.md')}`,
  );
  process.exit(summary.failed === 0 ? 0 : 1);
}
