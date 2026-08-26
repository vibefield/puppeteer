import type { AgentEvent } from '@vibecook/puppeteer-core';
import { isOpenCodeRecord, openCodeText } from './wire.js';

/** OpenCode session snapshots → deduplicated environment events. */
export class OpenCodeEnvironmentNormalizer {
  private currentDirectory: string | undefined;
  private currentModel: string | undefined;

  modelId(): string | undefined {
    return this.currentModel;
  }

  observeModel(modelId: string | undefined): void {
    if (modelId) this.currentModel = modelId;
  }

  normalize(info: Record<string, unknown>): AgentEvent[] {
    const directory = openCodeText(info.directory);
    const model = isOpenCodeRecord(info.model) ? info.model : undefined;
    const modelID = openCodeText(model?.id);
    const changedDirectory = directory !== undefined && directory !== this.currentDirectory;
    const changedModel = modelID !== undefined && modelID !== this.currentModel;
    if (!changedDirectory && !changedModel) return [];
    if (changedDirectory) this.currentDirectory = directory;
    if (changedModel) this.currentModel = modelID;
    return [
      {
        type: 'session.environment.updated',
        ...(changedDirectory ? { currentCwd: directory } : {}),
        ...(changedModel
          ? {
              model: {
                id: modelID!,
                ...(openCodeText(model?.providerID) ? { provider: openCodeText(model?.providerID) } : {}),
              },
            }
          : {}),
      },
    ];
  }
}
