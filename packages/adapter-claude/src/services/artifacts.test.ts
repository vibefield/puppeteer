import { describe, expect, it, vi } from 'vitest';
import type { SemanticObservationHandle } from '../observation/semantic-provider.js';
import { createClaudeArtifactService } from './artifacts.js';

describe('createClaudeArtifactService', () => {
  it('reports unavailable until the lazy semantic attachment exists', async () => {
    const service = createClaudeArtifactService(() => undefined);
    await expect(service.read('opaque:workflow-1', { maxBytes: 1024 })).resolves.toEqual({
      status: 'unavailable',
      message: 'Claude semantic observation is not attached',
    });
  });

  it('delegates bounded reads to the current semantic attachment', async () => {
    const readArtifact = vi.fn(async () => ({ status: 'denied' as const }));
    const handle = { readArtifact } as unknown as SemanticObservationHandle;
    const service = createClaudeArtifactService(() => Promise.resolve(handle));

    await expect(service.read('opaque:workflow-1', { maxBytes: 2048 })).resolves.toEqual({ status: 'denied' });
    expect(readArtifact).toHaveBeenCalledWith('opaque:workflow-1', { maxBytes: 2048 });
  });
});
