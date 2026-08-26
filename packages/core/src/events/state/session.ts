import { z } from 'zod';

export const SessionStartedEventSchema = z.strictObject({
  type: z.literal('session.started'),
  nativeSessionId: z.string().optional(),
  title: z.string().optional(),
  /** Claude Code `SessionStart.source`, e.g. "startup". */
  startSource: z.string().optional(),
  /** A provider intentionally rotated native identity inside the same live runtime. */
  rebind: z.boolean().optional(),
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;

export const SessionReadyEventSchema = z.strictObject({
  type: z.literal('session.ready'),
});
export type SessionReadyEvent = z.infer<typeof SessionReadyEventSchema>;

export const SessionExitedEventSchema = z.strictObject({
  type: z.literal('session.exited'),
  /** Claude Code `SessionEnd.reason`; value set not yet fully mapped. */
  reason: z.string().optional(),
});
export type SessionExitedEvent = z.infer<typeof SessionExitedEventSchema>;

export type SessionStateEvent = SessionStartedEvent | SessionReadyEvent | SessionExitedEvent;

export const SessionStateEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  SessionReadyEventSchema,
  SessionExitedEventSchema,
]);
