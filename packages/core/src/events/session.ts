import { z } from 'zod';

export const SessionStartedEventSchema = z.strictObject({
  type: z.literal('session:started'),
  nativeSessionId: z.string().trim().min(1).optional(),
  /** The provider's own title for the session at its start, when it has one. */
  title: z.string().optional(),
  /** Claude Code `SessionStart.source`, e.g. "startup". */
  startSource: z.string().trim().min(1).optional(),
  /** A provider intentionally rotated native identity inside the same live runtime. */
  rebind: z.boolean().optional(),
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;

export const SessionReadyEventSchema = z.strictObject({ type: z.literal('session:ready') });
export type SessionReadyEvent = z.infer<typeof SessionReadyEventSchema>;

export const SessionExitedEventSchema = z.strictObject({
  type: z.literal('session:exited'),
  /** Provider-native session-end reason when one is available. */
  reason: z.string().trim().min(1).optional(),
});
export type SessionExitedEvent = z.infer<typeof SessionExitedEventSchema>;

/**
 * The provider's own title for the session changed: the name a person gave it, or the one the provider wrote for it.
 * Null says the session has none now. A title is the person's content: it is carried, never logged.
 */
export const SessionTitleUpdatedEventSchema = z.strictObject({
  type: z.literal('session:title-updated'),
  title: z.string().trim().min(1).nullable(),
});
export type SessionTitleUpdatedEvent = z.infer<typeof SessionTitleUpdatedEventSchema>;

export type SessionEvent = SessionStartedEvent | SessionReadyEvent | SessionExitedEvent | SessionTitleUpdatedEvent;
export const SessionEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  SessionReadyEventSchema,
  SessionExitedEventSchema,
  SessionTitleUpdatedEventSchema,
]);
