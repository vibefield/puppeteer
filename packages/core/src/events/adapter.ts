import { z } from 'zod';

/** DESIGN ADR-008 — unrecognized native events survive normalization. */
export const AdapterDiagnosticSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});
export type AdapterDiagnostic = z.infer<typeof AdapterDiagnosticSchema>;

export const UnknownNativeEventSchema = z.strictObject({
  type: z.literal('adapter.native-event'),
  adapter: z.string(),
  nativeType: z.string().optional(),
  /** Normalized adapter degradation detail retained by the runtime state projection. */
  diagnostic: AdapterDiagnosticSchema.optional(),
});
export type UnknownNativeEvent = z.infer<typeof UnknownNativeEventSchema>;

export type AdapterEvent = UnknownNativeEvent;
export const AdapterEventSchema = UnknownNativeEventSchema;
