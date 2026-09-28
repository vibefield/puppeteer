export const quantile = (values: number[], q: number): number | null =>
  values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)]! : null;

type StartupSample = { round: number; arm: string; readyMs?: number; failure?: string };
export function compareStartup(samples: readonly StartupSample[], count: number) {
  const pairs = Array.from({ length: count }, (_, round) => {
    const value = (arm: string) => samples.find((s) => s.round === round && s.arm === arm && !s.failure)?.readyMs;
    const baseline = value('baseline'),
      current = value('current'),
      control = value('null');
    return baseline !== undefined && current !== undefined && control !== undefined
      ? { savingsMs: baseline - current, nullDifferenceMs: Math.abs(baseline - control) }
      : undefined;
  }).filter((v): v is { savingsMs: number; nullDifferenceMs: number } => v !== undefined);
  const pairedMedianSavingsMs = quantile(
    pairs.map((p) => p.savingsMs),
    0.5,
  );
  const nullP95DifferenceMs = quantile(
    pairs.map((p) => p.nullDifferenceMs),
    0.95,
  );
  return {
    pairs: pairs.length,
    pairedMedianSavingsMs,
    nullP95DifferenceMs,
    verdict:
      pairs.length !== count ||
      samples.some((s) => s.failure) ||
      pairedMedianSavingsMs === null ||
      nullP95DifferenceMs === null
        ? 'incomplete'
        : Math.abs(pairedMedianSavingsMs) <= nullP95DifferenceMs
          ? 'below-null-noise'
          : pairedMedianSavingsMs > 0
            ? 'median-improvement-resolved'
            : 'median-regression-resolved',
  };
}
