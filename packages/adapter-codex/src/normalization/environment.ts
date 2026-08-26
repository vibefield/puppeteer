import type { AgentModelIdentity, EnvironmentEvent } from '@vibecook/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str } from './types.js';

/** Codex cwd and model evidence normalized for the Core environment service. */
export class CodexEnvironmentNormalizer {
  constructor(private readonly modelDisplayName: (modelId: string) => string | undefined = () => undefined) {}

  normalize(input: CodexNormalizationInput): CategoryNormalization<EnvironmentEvent> {
    const events: EnvironmentEvent[] = [];
    const { method, params } = input;

    switch (method) {
      case 'thread/started': {
        const currentCwd = str(rec(params.thread)?.cwd);
        if (currentCwd) events.push({ type: 'session.environment.updated', currentCwd });
        return { handled: true, events };
      }

      case 'thread/settings/updated': {
        const settings = rec(params.threadSettings) ?? params;
        const currentCwd = str(settings.cwd);
        const modelId = str(settings.model);
        const provider = str(settings.modelProvider);
        if (currentCwd || modelId) {
          events.push({
            type: 'session.environment.updated',
            ...(currentCwd ? { currentCwd } : {}),
            ...(modelId ? { model: this.model(modelId, provider) } : {}),
          });
        }
        return { handled: true, events };
      }

      case 'model/rerouted': {
        const modelId = str(params.toModel);
        if (modelId) events.push({ type: 'session.environment.updated', model: this.model(modelId) });
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
