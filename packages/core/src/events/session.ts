import { z } from 'zod';

export const SessionStartedEventSchema = z.strictObject({
  type: z.literal('session:started'),
  nativeSessionId: z.string().trim().min(1).optional(),
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

export type SessionEvent = SessionStartedEvent | SessionReadyEvent | SessionExitedEvent;
export const SessionEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  SessionReadyEventSchema,
  SessionExitedEventSchema,
]);
