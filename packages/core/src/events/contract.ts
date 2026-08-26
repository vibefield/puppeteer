import { z } from 'zod';

/** Shared execution and evidence vocabulary used by every event category. */

/**
 * Minimal structural contract implemented by every normalized event. Category
 * modules refine `type` to one canonical `category:event-name` literal and own
 * the rest of the payload schema. Runtime metadata belongs on the envelope.
 */
export interface AgentEventContract<Type extends `${string}:${string}` = `${string}:${string}`> {
  type: Type;
}

/** DESIGN ADR-001 — native-tui is a first-class mode, not a fallback. */
export const AgentExecutionModeSchema = z.enum(['native-tui', 'structured', 'acp']);
export type AgentExecutionMode = z.infer<typeof AgentExecutionModeSchema>;

/** DESIGN §19.2 — the runtime must never overstate what it can observe. */
export const ObservationLevelSchema = z.enum([
  'structured',
  'native-hooks',
  'native-log',
  'workspace-process',
  'terminal-only',
]);
export type ObservationLevel = z.infer<typeof ObservationLevelSchema>;

/** DESIGN §14.1 — where a normalized event came from. */
export const AgentEventSourceSchema = z.enum([
  'native-hook',
  'native-transcript',
  'native-telemetry',
  'native-protocol',
  'native-statusline',
  'native-log',
  'workspace',
  'process',
  'terminal-inference',
  'runtime',
]);
export type AgentEventSource = z.infer<typeof AgentEventSourceSchema>;

export const AgentEventConfidenceSchema = z.enum(['authoritative', 'derived', 'inferred']);
export type AgentEventConfidence = z.infer<typeof AgentEventConfidenceSchema>;

/** Stable source-owned identity retained when another layer restamps delivery order. */
const SourcePositionSchema = z.number().int().nonnegative().safe();

export const AgentEventSourceRefSchema = z
  .strictObject({
    namespace: z.string().trim().min(1),
    eventId: z.string().trim().min(1),
    revisionKey: z.string().trim().min(1).optional(),
    sourceGeneration: SourcePositionSchema.optional(),
    cursorStart: SourcePositionSchema.optional(),
    cursorEnd: SourcePositionSchema.optional(),
  })
  .refine(
    ({ cursorStart, cursorEnd }) => cursorStart === undefined || cursorEnd === undefined || cursorEnd >= cursorStart,
    { message: 'cursorEnd must be greater than or equal to cursorStart', path: ['cursorEnd'] },
  );
export type AgentEventSourceRef = z.infer<typeof AgentEventSourceRefSchema>;

/** DESIGN §21.4 — process exit and semantic turn completion are separate facts. */
export const ProcessExitReasonSchema = z.enum([
  'completed',
  'user-terminated',
  'runtime-terminated',
  'signal',
  'crash',
  'spawn-failed',
  'workspace-failed',
  'unknown',
]);
export type ProcessExitReason = z.infer<typeof ProcessExitReasonSchema>;
