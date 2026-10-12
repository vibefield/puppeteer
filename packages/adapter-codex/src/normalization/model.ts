import type { AgentModelIdentity, ModelEvent } from '@vibefield/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str } from './types.js';

/** Codex model evidence normalized exclusively for the Core model service. */
export class CodexModelNormalizer {
  constructor(private readonly modelDisplayName: (modelId: string) => string | undefined = () => undefined) {}

  normalize(input: CodexNormalizationInput): CategoryNormalization<ModelEvent> {
    const events: ModelEvent[] = [];
    const { method, params } = input;

    switch (method) {
      case 'thread/settings/updated': {
        const settings = rec(params.threadSettings) ?? params;
        const modelId = str(settings.model);
        const provider = str(settings.modelProvider);
        if (modelId) events.push({ type: 'model:updated', model: this.model(modelId, provider) });
        return { handled: true, events };
      }
      case 'model/rerouted': {
        const modelId = str(params.toModel);
        if (modelId) events.push({ type: 'model:updated', model: this.model(modelId) });
        return { handled: true, events };
      }
      default:
        return { handled: false, events };
    }
  }

  private model(modelId: string, provider?: string): AgentModelIdentity {
    const displayName = this.modelDisplayName(modelId);
    return { id: modelId, ...(displayName ? { displayName } : {}), ...(provider ? { provider } : {}) };
  }
}
