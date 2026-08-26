import { z } from 'zod';

export const WorkspaceChangedEventSchema = z.strictObject({
  type: z.literal('workspace.changed'),
  paths: z.array(z.string()).optional(),
});
export type WorkspaceChangedEvent = z.infer<typeof WorkspaceChangedEventSchema>;

export type WorkspaceEvent = WorkspaceChangedEvent;
export const WorkspaceEventSchema = WorkspaceChangedEventSchema;
