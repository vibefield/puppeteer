import { z } from 'zod';

export const AgentProviderModeSchema = z.strictObject({
  raw: z.string().trim().min(1),
  normalized: z.string().trim().min(1).optional(),
});
export type AgentProviderMode = z.infer<typeof AgentProviderModeSchema>;

/** A configured provider mode intent or effective provider observation. */
export const ModeUpdatedEventSchema = z.strictObject({
  type: z.literal('mode:updated'),
  intent: z.enum(['configured', 'observed']).optional(),
  modeKind: z.enum(['provider-session', 'provider-permission']),
  mode: AgentProviderModeSchema.nullable(),
});
export type ModeUpdatedEvent = z.infer<typeof ModeUpdatedEventSchema>;

export type ModeEvent = ModeUpdatedEvent;
export const ModeEventSchema = ModeUpdatedEventSchema;
