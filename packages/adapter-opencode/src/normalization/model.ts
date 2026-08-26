import type { ModelEvent } from '@vibecook/puppeteer-core';
import { isOpenCodeRecord, openCodeText } from './wire.js';

/** OpenCode model snapshots -> deduplicated Core model events. */
export class OpenCodeModelNormalizer {
  private currentModel: string | undefined;

  modelId(): string | undefined {
    return this.currentModel;
  }

  observeModel(modelId: string | undefined): void {
    if (modelId) this.currentModel = modelId;
  }

  normalize(info: Record<string, unknown>): ModelEvent[] {
    const model = isOpenCodeRecord(info.model) ? info.model : undefined;
    const modelID = openCodeText(model?.id);
    if (modelID === undefined || modelID === this.currentModel) return [];
    this.currentModel = modelID;
    const provider = openCodeText(model?.providerID);
    return [{ type: 'model:updated', model: { id: modelID, ...(provider ? { provider } : {}) } }];
  }
}
