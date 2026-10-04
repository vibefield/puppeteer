// The perf harness's reading (L14): per n and view, each arm's median over the rounds, then the
// PAIRED per-round differences — A′ − A (the null arm: the same build twice) and, with a second
// build, B − A — read with one estimator for both. T is the median paired difference and MAD its
// own spread; z = |T| ÷ (1.858 · MAD ÷ √R). A metric regresses when B − A is positive, z > 4 and T
// exceeds 2 % of A's median. The A/A arm reading noise is what keeps that honest: its z should sit
// near or under 2. Medians decide; p95s are weather and are shown as such.

// Rates are per second of the NOMINAL window (`s`): the measured windows run a fraction of a
// millisecond apart, which would turn identical counts into a difference.
export const METRICS = [
  { key: 'frameP50', label: 'frame p50 (ms)', read: (m) => m.frames.p50 },
  { key: 'frameP95', label: 'frame p95 (ms) — weather', read: (m) => m.frames.p95, weather: true },
  { key: 'loafPer10s', label: 'long animation frames / 10 s', read: (m, s) => (m.loaf.count * 10) / s },
  { key: 'loafMsPerS', label: 'LoAF duration (ms / s)', read: (m, s) => m.loaf.totalMs / s },
  { key: 'loafBlockingPerS', label: 'LoAF blocking (ms / s)', read: (m, s) => m.loaf.blockingMs / s },
  { key: 'rafWorkPerS', label: 'rAF work (ms / s)', read: (m, s) => (m.raf ? m.raf.workMs / s : NaN) },
  { key: 'viewCommitsPerS', label: 'view commits / s', read: (m, s) => m.react.viewCommits / s },
  { key: 'viewRenderMsPerS', label: 'view render (ms / s)', read: (m, s) => m.react.viewRenderMs / s },
  { key: 'commitsPerS', label: 'all React commits / s', read: (m, s) => m.react.commits / s },
];

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Below this a paired difference is no difference: the metrics are not resolved more finely. */
const RESOLUTION = 1e-3;

/** T, MAD and z over paired per-round differences, rounded to the resolution first, so float dust
 * between two equal readings never reads as a certain difference. */
export function paired(differences) {
  const values = differences
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.round(value / RESOLUTION) * RESOLUTION);
  if (values.length === 0) return null;
  const centre = median(values);
  const spread = median(values.map((value) => Math.abs(value - centre)));
  const scale = (1.858 * spread) / Math.sqrt(values.length);
  const z = Math.abs(centre) < RESOLUTION ? 0 : scale === 0 ? Infinity : Math.abs(centre) / scale;
  return { t: centre, mad: spread, z, rounds: values.length };
}

/** `{ [count/view]: { [metric]: { [arm]: value[] by round } } }` from the runs that finished. */
export function collect(results) {
  const seconds = results.config.windowMs / 1000;
  const cells = new Map();
  for (const run of results.runs) {
    if (run.failed) continue;
    for (const measurement of run.measurements) {
      const id = `${measurement.count}/${measurement.view}`;
      if (!cells.has(id)) cells.set(id, { count: measurement.count, view: measurement.view, metrics: {} });
      const cell = cells.get(id);
      for (const metric of METRICS) {
        cell.metrics[metric.key] ??= {};
        cell.metrics[metric.key][run.arm] ??= [];
        cell.metrics[metric.key][run.arm][run.round] = metric.read(measurement, seconds);
      }
    }
  }
  return [...cells.values()].sort((left, right) => left.count - right.count || left.view.localeCompare(right.view));
}

const fixed = (value, digits = 2) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits));
const zText = (reading) => (reading === null ? '—' : Number.isFinite(reading.z) ? reading.z.toFixed(1) : '∞');

export function readCell(cell) {
  const rows = [];
  for (const metric of METRICS) {
    const arms = cell.metrics[metric.key] ?? {};
    const a = arms.A ?? [];
    const rounds = Math.max(a.length, (arms["A'"] ?? []).length, (arms.B ?? []).length);
    const difference = (other) =>
      Array.from({ length: rounds }, (_, round) => (other?.[round] ?? NaN) - (a[round] ?? NaN));
    const null_ = paired(difference(arms["A'"]));
    const slice = arms.B ? paired(difference(arms.B)) : null;
    const baseline = median(a);
    const regressed =
      slice !== null && !metric.weather && slice.t > 0 && slice.z > 4 && baseline !== null && slice.t > 0.02 * baseline;
    rows.push({
      metric,
      a: baseline,
      aPrime: median(arms["A'"] ?? []),
      b: arms.B ? median(arms.B) : null,
      null_,
      slice,
      regressed,
    });
  }
  return rows;
}

export function summarise(results) {
  const cells = collect(results);
  const hasB = Boolean(results.config.builds.B);
  const lines = [
    `# Godview perf — ${hasB ? 'A/B with an A/A null arm' : 'A/A baseline'}`,
    '',
    `- A: \`${results.config.builds.A}\`${hasB ? `\n- B: \`${results.config.builds.B}\`` : ''}`,
    `- ${results.config.rounds} rounds · n = ${results.config.counts.join(', ')} · views ${results.config.views.join(', ')} · ${results.config.warmupMs / 1000} s warm-up + ${results.config.windowMs / 1000} s window per view · a state change per agent every ${results.config.stepMs / 1000} s · offscreen at ${results.config.fps ?? 60} Hz, DPR 2`,
    `- started ${results.startedAt}${results.finishedAt ? `, finished ${results.finishedAt}` : ' (unfinished)'}`,
    '',
    '## Runs and load',
    '',
    '| round | arm | load at start (1/5/15 min) | waited | load at end | outcome |',
    '|---|---|---|---|---|---|',
    ...results.runs.map(
      (run) =>
        `| ${run.round} | ${run.arm} | ${run.load?.before?.load?.join(' / ') ?? '—'} | ${run.load?.before ? `${Math.round(run.load.before.waitedMs / 1000)} s` : '—'} | ${run.load?.after?.join(' / ') ?? '—'} | ${run.failed ? `FAILED: ${run.failed}` : `${Math.round(run.ms / 1000)} s, ${run.driver.sent} ops (${run.driver.failed} failed)`} |`,
    ),
    '',
    '## Per view and n',
    '',
    `T = the median paired difference over rounds, MAD its spread, z = |T| ÷ (1.858·MAD/√R). ${hasB ? 'B regresses on a metric when B − A > 0, z > 4 and T > 2 % of A. ' : ''}The A/A arm is the noise: its z should stay near 2 or below.`,
    '',
  ];
  for (const cell of cells) {
    lines.push(`### n = ${cell.count} · ${cell.view}`, '');
    lines.push(
      hasB
        ? '| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |'
        : '| metric | A | A′ | A′ − A: T | MAD | z |',
    );
    lines.push(hasB ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|');
    for (const row of readCell(cell)) {
      if (hasB) {
        lines.push(
          `| ${row.metric.label} | ${fixed(row.a)} | ${fixed(row.aPrime)} | ${fixed(row.b)} | ${fixed(row.null_?.t)}, ${fixed(row.null_?.mad)}, ${zText(row.null_)} | ${fixed(row.slice?.t)}, ${fixed(row.slice?.mad)}, ${zText(row.slice)} | ${row.metric.weather ? 'weather' : row.regressed ? '**worse**' : 'ok'} |`,
        );
      } else {
        lines.push(
          `| ${row.metric.label} | ${fixed(row.a)} | ${fixed(row.aPrime)} | ${fixed(row.null_?.t)} | ${fixed(row.null_?.mad)} | ${zText(row.null_)} |`,
        );
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
