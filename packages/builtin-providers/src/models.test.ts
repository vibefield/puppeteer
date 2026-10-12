import { describe, expect, it } from 'vitest';
import { AgentModelCatalogSchema, type AgentModelChoice, type AgentModelService } from '@vibefield/puppeteer-core';
import { createAcpModelService } from '@vibefield/puppeteer-adapter-acp';
import { createClaudeModelService, decodeClaudeModels } from '@vibefield/puppeteer-adapter-claude';
import { createCodexModelService, decodeCodexModels } from '@vibefield/puppeteer-adapter-codex';
import { createCopilotModelService, decodeCopilotModels } from '@vibefield/puppeteer-adapter-copilot';
import { createGrokModelService, decodeGrokModels } from '@vibefield/puppeteer-adapter-grok';
import { createKimiModelService, decodeKimiModels } from '@vibefield/puppeteer-adapter-kimi';
import { createOpenCodeModelService, decodeOpenCodeModels } from '@vibefield/puppeteer-adapter-opencode';
import { createHermesModelService, decodeHermesModels } from '@vibefield/puppeteer-adapter-hermes';
import { createAntigravityModelService, decodeAntigravityModels } from '@vibefield/puppeteer-adapter-antigravity';
import { createPiModelService, decodePiModels } from '@vibefield/puppeteer-adapter-pi';

function catalog(service: AgentModelService, models: AgentModelChoice[]) {
  return AgentModelCatalogSchema.parse({
    provider: service.provider.id,
    cwd: '/workspace',
    observedAt: '2026-10-12T12:00:00.000Z',
    source: { kind: 'native-protocol', freshness: 'unknown' },
    completeness: 'complete',
    customModels: false,
    models,
  });
}

// Small native-shaped fixtures, based on the metadata probes of 2026-10-12.
const cases: [AgentModelService, AgentModelChoice[], Record<string, string>, unknown][] = [
  [
    createClaudeModelService(),
    decodeClaudeModels([
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        supportsEffort: true,
        supportedEffortLevels: ['high', 'max'],
        apiKey: 'secret',
      },
    ]),
    { effort: 'max' },
    { model: 'sonnet', effort: 'max' },
  ],
  [
    createCodexModelService(),
    decodeCodexModels([
      {
        id: 'picker-id',
        model: 'native-id',
        displayName: 'Codex',
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Native explanation' }],
        defaultReasoningEffort: 'high',
      },
    ]),
    { effort: 'high' },
    { model: 'native-id', effort: 'high' },
  ],
  [
    createCopilotModelService(),
    decodeCopilotModels([{ id: 'copilot-model', name: 'Copilot Model', supportedReasoningEfforts: ['high'] }]),
    { effort: 'high' },
    { model: 'copilot-model', effort: 'high' },
  ],
  [
    createGrokModelService(),
    decodeGrokModels(
      'You are logged in with grok.com.\nDefault model: grok-one\nAvailable models:\n  * grok-one (default)\n  - grok-two\n',
    ),
    {},
    { model: 'grok-one' },
  ],
  [
    createKimiModelService(),
    decodeKimiModels({
      providers: { native: { api_key: 'secret' } },
      models: { alias: { name: 'Actual model', capabilities: ['thinking'], api_key: 'secret' } },
    }),
    {},
    { model: 'alias' },
  ],
  [
    createOpenCodeModelService(),
    decodeOpenCodeModels({
      connected: ['connected'],
      all: [
        { id: 'disconnected', models: { hidden: { id: 'hidden' } } },
        {
          id: 'connected',
          name: 'Connected',
          options: { apiKey: 'secret' },
          models: { key: { id: 'model/with/slashes', name: 'Model', variants: { high: { reasoningEffort: 'high' } } } },
        },
      ],
    }),
    { variant: 'high' },
    { model: { providerID: 'connected', modelID: 'model/with/slashes', variant: 'high' } },
  ],
  [
    createHermesModelService(),
    decodeHermesModels({
      models: [{ provider: 'native-provider', id: 'native/model', reasoning: true, apiKey: 'secret' }],
    }),
    {},
    { provider: 'native-provider', model: 'native/model' },
  ],
  [createAntigravityModelService(), decodeAntigravityModels('model-high\tModel (High)\n'), {}, { model: 'model-high' }],
  [
    createPiModelService(),
    decodePiModels([
      {
        provider: 'xai',
        id: 'grok-next',
        name: 'Grok',
        reasoning: true,
        thinkingLevelMap: { off: null, low: 'low', high: 'high', xhigh: null },
        apiKey: 'secret',
      },
    ]),
    { thinking: 'high' },
    { provider: 'xai', model: 'grok-next', thinking: 'high' },
  ],
];

describe('builtin native model discovery contract', () => {
  it.each(cases)(
    'translates %s opaque choices into that adapter’s private launch options',
    (service, models, controls, expected) => {
      const publicCatalog = catalog(service, models);
      expect(service.provider.discovery).toBe('prelaunch');
      expect(JSON.stringify(publicCatalog)).not.toContain('secret');
      expect(service.toAgentOptions({ modelId: models[0]!.id, controls }, publicCatalog)).toEqual(expected);
      expect(() =>
        service.toAgentOptions({ modelId: models[0]!.id, controls: { inventedControl: 'value' } }, publicCatalog),
      ).toThrow();
    },
  );

  it('does not infer effort domains from reasoning hints, labels, or other models', () => {
    expect(
      decodeClaudeModels([
        { value: 'auto', displayName: 'Auto', supportsEffort: false, supportedEffortLevels: ['high'] },
      ])[0]?.controls,
    ).toEqual([]);
    expect(
      decodeCopilotModels([{ id: 'auto', capabilities: { supports: { reasoningEffort: true } } }])[0]?.controls,
    ).toEqual([]);
    expect(decodeKimiModels({ models: { alias: { capabilities: ['thinking'] } } })[0]?.controls).toEqual([]);
    expect(decodeHermesModels({ models: [{ id: 'reasoning', provider: 'x', reasoning: true }] })[0]?.controls).toEqual(
      [],
    );
    expect(decodeAntigravityModels('model-high\tModel (High)')[0]?.controls).toEqual([]);
    const pi = decodePiModels([
      { provider: 'p', id: 'a', reasoning: true, thinkingLevelMap: { off: null, low: '', high: 'high', xhigh: null } },
      { provider: 'p', id: 'b', reasoning: true },
    ]);
    expect(pi[0]?.controls[0]?.values.map((value) => value.id)).toEqual(['low', 'high']);
    expect(pi[1]?.controls).toEqual([]);
  });

  it('treats a malformed native catalog as an error, never a made-up fallback list', () => {
    expect(() => decodeGrokModels('settings fetch failed')).toThrow();
    expect(() => decodeAntigravityModels('unexpected table format')).toThrow();
    expect(() => decodeKimiModels({ providers: [] })).toThrow();
    expect(() => decodeOpenCodeModels({ all: [] })).toThrow();
    expect(() => catalog(createClaudeModelService(), decodeClaudeModels([{ unrecognized: true }]))).toThrow();
  });

  it('advertises generic ACP discovery as session-only without creating one', async () => {
    const service = createAcpModelService();
    expect(service.provider.discovery).toBe('session');
    expect(await service.discover({ cwd: '/workspace' })).toMatchObject({
      status: 'requires-session',
      provider: 'acp',
      code: 'requires-session',
    });
  });
});
