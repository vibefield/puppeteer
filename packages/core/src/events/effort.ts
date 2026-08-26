import { z } from 'zod';

/** A configured reasoning-effort intent or effective provider observation. */
export const EffortUpdatedEventSchema = z.strictObject({
  type: z.literal('effort:updated'),
  intent: z.enum(['configured', 'observed']).optional(),
  effort: z.string().trim().min(1).nullable(),
});
export type EffortUpdatedEvent = z.infer<typeof EffortUpdatedEventSchema>;

export type EffortEvent = EffortUpdatedEvent;
export const EffortEventSchema = EffortUpdatedEventSchema;
