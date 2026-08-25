export const MAX_IMPORTED_SCENARIO_BYTES = 16 * 1024 * 1024;
const MAX_SCENARIO_STEPS = 10_000;

export interface ImportedScenario {
  label: string;
  document: unknown;
  steps: number;
  vendor?: string;
}

function scenarioSteps(document: unknown): unknown[] | undefined {
  if (Array.isArray(document)) return document;
  if (document === null || typeof document !== 'object') return undefined;
  const record = document as Record<string, unknown>;
  if (Array.isArray(record.steps)) return record.steps;
  return Array.isArray(record.then) ? record.then : undefined;
}

export function parseImportedScenario(text: string, fileName: string): ImportedScenario {
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORTED_SCENARIO_BYTES) {
    throw new Error(`scenario exceeds ${MAX_IMPORTED_SCENARIO_BYTES} bytes`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('scenario file is not valid JSON');
  }
  const steps = scenarioSteps(document);
  if (!steps || steps.length === 0 || steps.length > MAX_SCENARIO_STEPS) {
    throw new Error(`scenario must contain 1..${MAX_SCENARIO_STEPS} steps`);
  }
  const declaredName =
    document !== null && typeof document === 'object' && !Array.isArray(document)
      ? (document as Record<string, unknown>).name
      : undefined;
  const recording =
    document !== null && typeof document === 'object' && !Array.isArray(document)
      ? (document as Record<string, unknown>).recording
      : undefined;
  const vendor =
    recording !== null && typeof recording === 'object' && !Array.isArray(recording)
      ? (recording as Record<string, unknown>).vendor
      : undefined;
  return {
    label: typeof declaredName === 'string' && declaredName ? declaredName : fileName.replace(/\.json$/i, ''),
    document,
    steps: steps.length,
    ...(typeof vendor === 'string' && vendor ? { vendor } : {}),
  };
}
