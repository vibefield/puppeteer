import { z } from 'zod';

/** Provider-neutral identity for the model currently serving this session. */
export const AgentModelIdentitySchema = z.strictObject({
  /** Stable provider model id, suitable for matching a model catalog. */
  id: z.string().trim().min(1),
  /** Human-facing model-card label when the provider publishes one. */
  displayName: z.string().trim().min(1).optional(),
  /** Provider/model-family name when it is available independently of the id. */
  provider: z.string().trim().min(1).optional(),
});
export type AgentModelIdentity = z.infer<typeof AgentModelIdentitySchema>;

/** A configured model intent or effective provider model observation. */
export const ModelUpdatedEventSchema = z.strictObject({
  type: z.literal('model:updated'),
  intent: z.enum(['configured', 'observed']).optional(),
  model: AgentModelIdentitySchema.nullable(),
});
export type ModelUpdatedEvent = z.infer<typeof ModelUpdatedEventSchema>;

export type ModelEvent = ModelUpdatedEvent;
export const ModelEventSchema = ModelUpdatedEventSchema;
