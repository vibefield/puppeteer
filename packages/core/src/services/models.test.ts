import { describe, expect, it, vi } from 'vitest';
import {
  AgentModelCatalogSchema,
  defineModelService,
  validateModelSelection,
  type AgentModelCatalog,
} from './models.js';

const catalog: AgentModelCatalog = {
  provider: 'example',
  cwd: '/workspace',
  observedAt: '2026-10-12T12:00:00.000Z',
  source: { kind: 'native-protocol', freshness: 'unknown' },
  completeness: 'complete',
  customModels: true,
  models: [
    { id: 'default', label: 'Native alias', controls: [] },
    {
      id: 'deep',
      label: 'Deep',
      controls: [{ id: 'effort', label: 'Effort', role: 'effort', values: [{ id: 'high', label: 'High' }] }],
    },
  ],
};

describe('public model catalog boundary', () => {
  it('rejects private payloads, duplicate choices, and contradictory control metadata', () => {
    expect(AgentModelCatalogSchema.safeParse({ ...catalog, raw: { apiKey: 'secret' } }).success).toBe(false);
    expect(
      AgentModelCatalogSchema.safeParse({ ...catalog, models: [catalog.models[0], catalog.models[0]] }).success,
    ).toBe(false);
    const model = catalog.models[1]!;
    for (const control of [
      { ...model.controls[0], defaultValue: 'unknown' },
      {
        ...model.controls[0],
        values: [
          { id: 'high', label: 'High' },
          { id: 'high', label: 'Duplicate' },
        ],
      },
    ])
      expect(
        AgentModelCatalogSchema.safeParse({ ...catalog, models: [{ ...model, controls: [control] }] }).success,
      ).toBe(false);
    expect(AgentModelCatalogSchema.parse(catalog)).toEqual(catalog);
  });

  it('validates controls against the selected model, never a provider-wide enum', () => {
    expect(validateModelSelection(catalog, { modelId: 'deep', controls: { effort: 'high' } })).toEqual({
      modelId: 'deep',
      controls: { effort: 'high' },
    });
    for (const selection of [
      { modelId: 'default', controls: { effort: 'high' } },
      { modelId: 'deep', controls: { effort: 'max' } },
      { modelId: 'deep', controls: { hiddenFlag: 'high' } },
      { modelId: 'unknown' },
    ])
      expect(() => validateModelSelection(catalog, selection)).toThrow('selected model');
  });

  it('requires an explicit custom opt-in and never guesses custom model controls', () => {
    expect(validateModelSelection(catalog, { modelId: 'new-model', custom: true })).toEqual({
      modelId: 'new-model',
      custom: true,
    });
    expect(() =>
      validateModelSelection({ ...catalog, customModels: false }, { modelId: 'new-model', custom: true }),
    ).toThrow();
    expect(() =>
      validateModelSelection(catalog, { modelId: 'new-model', custom: true, controls: { effort: 'high' } }),
    ).toThrow();
    expect(validateModelSelection(catalog, { modelId: 'default' })).toEqual({ modelId: 'default' });
  });

  it('sanitizes malformed native results and refuses foreign catalogs', async () => {
    const service = defineModelService({
      provider: { id: 'example', label: 'Example', discovery: 'prelaunch' },
      discover: async () => {
        throw new Error('secret credential and native stderr');
      },
      toAgentOptions: (selection) => selection,
    });
    const result = await service.discover({ cwd: '/workspace' });
    expect(result).toMatchObject({ status: 'error', code: 'invalid-response' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(() => service.toAgentOptions({ modelId: 'default' }, { ...catalog, provider: 'foreign' })).toThrow();
  });

  it('does not enter a provider when discovery is already cancelled', async () => {
    const discover = vi.fn();
    const service = defineModelService({
      provider: { id: 'example', label: 'Example', discovery: 'prelaunch' },
      discover,
      toAgentOptions: () => ({}),
    });
    expect(await service.discover({ cwd: '/workspace', signal: AbortSignal.abort() })).toMatchObject({
      status: 'cancelled',
    });
    expect(discover).not.toHaveBeenCalled();
  });
});
