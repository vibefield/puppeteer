import type { AgentArtifactService } from '@vibecook/puppeteer-core';
import type { SemanticObservationHandle } from '../observation/semantic-provider.js';

export type ClaudeSemanticAttachment = Promise<SemanticObservationHandle | undefined> | undefined;

/** Adapt Claude's lazy semantic observer into Core's bounded artifact capability. */
export function createClaudeArtifactService(attachment: () => ClaudeSemanticAttachment): AgentArtifactService {
  return {
    async read(artifactId, options) {
      const handle = await attachment();
      if (!handle) {
        return { status: 'unavailable', message: 'Claude semantic observation is not attached' };
      }
      return handle.readArtifact(artifactId, options);
    },
  };
}
