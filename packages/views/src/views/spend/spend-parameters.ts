import type { MonitorParameterGroup } from '@vibefield/puppeteer-view-sdk';

// The spend view's tunables: few on purpose. The colours, the scale and the
// motion are DESIGN §8's and are not offered; what is left is how heavy the
// lines are drawn and how strongly the lit line's wash shows.

export interface SpendParameters {
  /** A line's width at rest, px; the lit line is drawn this plus 0.75, the rest this plus 0.25 (DESIGN §8: 1.75 · 2.5). */
  weight: number;
  /** The wash under the lit line, as a multiple of DESIGN §8's (16% at the top of the plot to 2% at $0). */
  wash: number;
}

export const DEFAULT_SPEND_PARAMETERS: Readonly<SpendParameters> = {
  weight: 1.75,
  wash: 1,
};

export const SPEND_PARAMETER_GROUPS: readonly MonitorParameterGroup[] = [
  {
    title: 'LINES',
    controls: [
      { key: 'weight', label: 'Line weight', min: 1, max: 3, step: 0.25, defaultValue: 1.75 },
      { key: 'wash', label: 'Lit wash', min: 0, max: 2, step: 0.1, defaultValue: 1 },
    ],
  },
];

const definitions = SPEND_PARAMETER_GROUPS.flatMap((group) => group.controls);

export function normalizeSpendParameters(value: unknown): SpendParameters {
  const source = value && typeof value === 'object' ? (value as Partial<Record<keyof SpendParameters, unknown>>) : {};
  const normalized = { ...DEFAULT_SPEND_PARAMETERS };
  for (const definition of definitions) {
    const key = definition.key as keyof SpendParameters;
    const candidate = source[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    normalized[key] = Math.max(definition.min, Math.min(definition.max, candidate));
  }
  return normalized;
}
