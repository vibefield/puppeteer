import { z } from 'zod';
import { ProcessExitReasonSchema } from './contract.js';

export const ProcessStartedEventSchema = z.strictObject({
  type: z.literal('process:started'),
  pid: z.number().int().positive().safe(),
});
export type ProcessStartedEvent = z.infer<typeof ProcessStartedEventSchema>;

export const ProcessExitedEventSchema = z.strictObject({
  type: z.literal('process:exited'),
  exitCode: z.number().int().safe().optional(),
  signal: z.string().trim().min(1).optional(),
  reason: ProcessExitReasonSchema,
});
export type ProcessExitedEvent = z.infer<typeof ProcessExitedEventSchema>;

export type ProcessEvent = ProcessStartedEvent | ProcessExitedEvent;
export const ProcessEventSchema = z.discriminatedUnion('type', [ProcessStartedEventSchema, ProcessExitedEventSchema]);
