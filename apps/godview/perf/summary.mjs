// The perf harness's reading (L14): per n and view, each arm's median over the rounds, then the
// PAIRED per-round differences — A′ − A (the null arm: the same build twice) and, with a second
// build, B − A — read with one estimator for both. T is the median paired difference and MAD its
// own spread; z = |T| ÷ (1.858 · MAD ÷ √R). A metric regresses when B − A is positive, z > 4 and T
// exceeds 2 % of A's median. The A/A arm reading noise is what keeps that honest: its z should sit
// near or under 2. Medians decide; p95s are weather and are shown as such.
//
// The gate reads TOTALS (build-mv M33): frame time and long animation frames, every React root's
// render time, and the renderer main thread's task time with its parts. A view the host mounts in
// its own root, or whose updates a frame scheduler moves into rAF, moves work between the per-view
// rows without changing how much there is, so those rows are context: shown, never the verdict.

// Rates are per second of the NOMINAL window (`s`): the measured windows run a fraction of a
// millisecond apart, which would turn identical counts into a difference.
// A run recorded before a metric existed reads NaN for it, which every estimator below skips.
const perSecond = (value, s) => (typeof value === 'number' ? value / s : NaN);
export const METRICS = [
  { key: 'frameP50', label: 'frame p50 (ms)', read: (m) => m.frames.p50, role: 'gate' },
  { key: 'frameP95', label: 'frame p95 (ms)', read: (m) => m.frames.p95, role: 'weather' },
  { key: 'loafPer10s', label: 'long animation frames / 10 s', read: (m, s) => (m.loaf.count * 10) / s, role: 'gate' },
  { key: 'loafMsPerS', label: 'LoAF duration (ms / s)', read: (m, s) => m.loaf.totalMs / s, role: 'gate' },
  { key: 'loafBlockingPerS', label: 'LoAF blocking (ms / s)', read: (m, s) => m.loaf.blockingMs / s, role: 'gate' },
  {
    key: 'rootRenderMsPerS',
    label: 'all roots render (ms / s)',
    read: (m, s) => perSecond(m.react.rootRenderMs, s),
    role: 'gate',
  },
  {
    key: 'taskMsPerS',
    label: 'main-thread tasks (ms / s)',
    read: (m, s) => perSecond(m.main?.TaskDuration, s),
    role: 'gate',
  },
  {
    key: 'scriptMsPerS',
    label: '· script (ms / s)',
    read: (m, s) => perSecond(m.main?.ScriptDuration, s),
    role: 'gate',
  },
  {
    key: 'layoutMsPerS',
    label: '· layout (ms / s)',
    read: (m, s) => perSecond(m.main?.LayoutDuration, s),
    role: 'gate',
  },
  {
    key: 'recalcStyleMsPerS',
    label: '· recalc style (ms / s)',
    read: (m, s) => perSecond(m.main?.RecalcStyleDuration, s),
    role: 'gate',
  },
  {
    key: 'threadCpuMsPerS',
    label: 'main-thread CPU (ms / s)',
    read: (m, s) => perSecond(m.main?.ThreadTime, s),
    role: 'context',
  },
  {
    key: 'processCpuMsPerS',
    label: 'renderer process CPU (ms / s)',
    read: (m, s) => perSecond(m.main?.ProcessTime, s),
    role: 'context',
  },
  { key: 'rafWorkPerS', label: 'rAF work (ms / s)', read: (m, s) => (m.raf ? m.raf.workMs / s : NaN), role: 'context' },
  {
    key: 'commitsPerS',
    label: 'all React commits / s (every root)',
    read: (m, s) => m.react.commits / s,
    role: 'context',
  },
  {
    key: 'viewCommitsPerS',
    label: 'view commits / s (host root)',
    read: (m, s) => m.react.viewCommits / s,
    role: 'context',
  },
  {
    key: 'viewRenderMsPerS',
    label: 'view render (ms / s, host root)',
    read: (m, s) => m.react.viewRenderMs / s,
    role: 'context',
  },
];
/** Where a root sits, as the probe placed it: holding the stage, below it (a view's own), elsewhere. */
const PLACES = ['host', 'stage', 'other', 'unplaced'];

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
      // Each place's render time and commits per second, the roots of one place summed.
      cell.roots ??= {};
      for (const root of measurement.react.roots ?? []) {
        const place = (cell.roots[root.place] ??= {});
        const arm = (place[run.arm] ??= { renderMs: [], commits: [] });
        arm.renderMs[run.round] = (arm.renderMs[run.round] ?? 0) + root.renderMs / seconds;
        arm.commits[run.round] = (arm.commits[run.round] ?? 0) + root.commits / seconds;
      }
    }
  }
  return [...cells.values()].sort((left, right) => left.count - right.count || left.view.localeCompare(right.view));
}

const verdict = (row) =>
  row.metric.role === 'weather'
    ? 'weather'
    : row.slice === null
      ? '—'
      : row.metric.role === 'context'
        ? row.rose
          ? 'context · up'
          : 'context'
        : row.regressed
          ? '**worse**'
          : 'ok';

/** Each place's median render time and commits per second, per arm: where the roots' work sat. */
function rootsLine(cell) {
  const arms = ['A', "A'", 'B'].filter((arm) => PLACES.some((place) => cell.roots?.[place]?.[arm]));
  if (arms.length === 0) return null;
  const parts = arms.map((arm) => {
    const places = PLACES.filter((place) => cell.roots[place]?.[arm]).map((place) => {
      const { renderMs, commits } = cell.roots[place][arm];
      return `${place} ${fixed(median(renderMs), 1)} (${fixed(median(commits), 1)} commits)`;
    });
    return `${arm === "A'" ? 'A′' : arm} ${places.join(', ')}`;
  });
  return `Roots' render, ms / s (median): ${parts.join(' · ')}.`;
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
    // The regression rule, read on every row; only a gate row's reading is a verdict.
    const rule = (reading) =>
      reading !== null && reading.t > 0 && reading.z > 4 && baseline !== null && reading.t > 0.02 * baseline;
    const rose = rule(slice);
    const regressed = rose && metric.role === 'gate';
    rows.push({
      metric,
      a: baseline,
      aPrime: median(arms["A'"] ?? []),
      b: arms.B ? median(arms.B) : null,
      null_,
      slice,
      rose,
      regressed,
      nullRose: rule(null_),
    });
  }
  return rows;
}

/** The verdict over every cell: the gate rows that regressed, the context rows that rose, and the
 * A/A arm's health on the gate rows. */
function gateSection(cells, hasB) {
  const readings = cells.flatMap((cell) => readCell(cell).map((row) => ({ cell, row })));
  const where = ({ cell, row }) => `n = ${cell.count} · ${cell.view} · ${row.metric.label}`;
  const shift = ({ cell, row }) =>
    `${where({ cell, row })}: B − A ${fixed(row.slice.t)} (z ${zText(row.slice)}; A ${fixed(row.a)})`;
  const gate = readings.filter(({ row }) => row.metric.role === 'gate' && row.null_ !== null);
  const highest = gate.reduce(
    (top, reading) => (top === null || reading.row.null_.z > top.row.null_.z ? reading : top),
    null,
  );
  const lines = [
    '## The gate (totals)',
    '',
    `Gate rows: ${METRICS.filter((metric) => metric.role === 'gate')
      .map((metric) => metric.label.replace(/^· /, ''))
      .join(
        ', ',
      )}. The per-view rows and the CPU times are context (M33): they show where work sat, never the verdict.`,
    '',
  ];
  if (hasB) {
    const worse = readings.filter(({ row }) => row.regressed);
    const read = readings.filter(({ row }) => row.metric.role === 'gate' && row.slice !== null).length;
    lines.push(
      worse.length === 0
        ? `- **No gate reading regressed**: ${read} gate readings across ${cells.length} cells.`
        : `- **B is worse on ${worse.length} gate reading${worse.length === 1 ? '' : 's'}:**`,
      ...worse.map((reading) => `  - ${shift(reading)}`),
    );
  }
  lines.push(
    highest === null
      ? '- A/A health: no gate reading.'
      : `- A/A health over ${gate.length} gate readings: the highest z is ${zText(highest.row.null_)} (${where(highest)}); ${gate.filter(({ row }) => row.null_.z > 2.3).length} above 2.3; ${gate.filter(({ row }) => row.nullRose).length} meet the regression rule.`,
  );
  if (hasB) {
    const rose = readings.filter(({ row }) => row.metric.role === 'context' && row.rose);
    lines.push(
      rose.length === 0
        ? '- No context reading rose.'
        : `- Context readings that rose (the rule read on a context row; no verdict):`,
      ...rose.map((reading) => `  - ${shift(reading)}`),
    );
  }
  lines.push('');
  return lines;
}

export function summarise(results) {
  const cells = collect(results);
  const hasB = Boolean(results.config.builds.B);
  const lines = [
    `# Godview perf — ${hasB ? 'A/B with an A/A null arm' : 'A/A baseline'}`,
    '',
    `- A: \`${results.config.builds.A}\`${hasB ? `\n- B: \`${results.config.builds.B}\`` : ''}`,
    ...(results.config.syntheticBMs > 0
      ? [
          `- B is A's own build plus a ${results.config.syntheticBMs} ms busy wait in every page animation-frame callback: the negative control, which the gate must call worse.`,
        ]
      : []),
    `- ${results.config.rounds} rounds · n = ${results.config.counts.join(', ')} · views ${results.config.views.join(', ')} · ${results.config.warmupMs / 1000} s warm-up + ${results.config.windowMs / 1000} s window per view · a state change per agent every ${results.config.stepMs / 1000} s · offscreen at ${results.config.fps ?? 60} Hz, DPR 2`,
    `- started ${results.startedAt}${results.finishedAt ? `, finished ${results.finishedAt}` : ' (unfinished)'}`,
    '',
    ...gateSection(cells, hasB),
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
    `T = the median paired difference over rounds, MAD its spread, z = |T| ÷ (1.858·MAD/√R). ${hasB ? 'B regresses on a gate row when B − A > 0, z > 4 and T > 2 % of A; the same rule on a context row reads "context · up", which is no verdict. ' : ''}The A/A arm is the noise: its z should stay near 2 or below.`,
    '',
  ];
  for (const cell of cells) {
    lines.push(`### n = ${cell.count} · ${cell.view}`, '');
    lines.push(
      hasB
        ? '| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |'
        : '| metric | A | A′ | A′ − A: T | MAD | z | role |',
    );
    lines.push(hasB ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|');
    for (const row of readCell(cell)) {
      if (hasB) {
        lines.push(
          `| ${row.metric.label} | ${fixed(row.a)} | ${fixed(row.aPrime)} | ${fixed(row.b)} | ${fixed(row.null_?.t)}, ${fixed(row.null_?.mad)}, ${zText(row.null_)} | ${fixed(row.slice?.t)}, ${fixed(row.slice?.mad)}, ${zText(row.slice)} | ${verdict(row)} |`,
        );
      } else {
        lines.push(
          `| ${row.metric.label} | ${fixed(row.a)} | ${fixed(row.aPrime)} | ${fixed(row.null_?.t)} | ${fixed(row.null_?.mad)} | ${zText(row.null_)} | ${row.metric.role} |`,
        );
      }
    }
    const roots = rootsLine(cell);
    lines.push('', ...(roots ? [roots, ''] : []));
  }
  return `${lines.join('\n')}\n`;
}
