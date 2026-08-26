import type { MonitorArtifactReadResult } from '../monitor/types.js';

/** Bounded resolution of adapter-issued opaque monitor artifact references. */
export interface AgentArtifactService {
  read(artifactId: string, options: { maxBytes: number }): Promise<MonitorArtifactReadResult>;
}
