/** Keep small positive estimates visibly distinct from a known zero. */
export function formatUsd(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value > 0 && value < 0.001) return '<$0.001';
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: value > 0 && value < 0.01 ? 3 : 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 3 : 2,
  })}`;
}
