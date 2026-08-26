import { z } from 'zod';

export const ToolActivityKindSchema = z.enum([
  'command',
  'web-search',
  'file-read',
  'file-edit',
  'browser',
  'mcp',
  'other',
]);
export type ToolActivityKind = z.infer<typeof ToolActivityKindSchema>;

/** Provider-neutral UI metadata. Adapters classify native tool names here. */
export const ToolPresentationSchema = z.strictObject({
  kind: ToolActivityKindSchema,
  title: z.string(),
  detail: z.string().optional(),
});
export type ToolPresentation = z.infer<typeof ToolPresentationSchema>;

export const ToolRequestedEventSchema = z.strictObject({
  type: z.literal('tool.requested'),
  toolCallId: z.string(),
  tool: z.string(),
  input: z.unknown().optional(),
  presentation: ToolPresentationSchema.optional(),
});
export type ToolRequestedEvent = z.infer<typeof ToolRequestedEventSchema>;

/** For structured/ACP drivers that distinguish acceptance from execution. */
export const ToolStartedEventSchema = z.strictObject({
  type: z.literal('tool.started'),
  toolCallId: z.string(),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  presentation: ToolPresentationSchema.optional(),
});
export type ToolStartedEvent = z.infer<typeof ToolStartedEventSchema>;

export const ToolCompletedEventSchema = z.strictObject({
  type: z.literal('tool.completed'),
  toolCallId: z.string(),
  tool: z.string().optional(),
  output: z.unknown().optional(),
  durationMs: z.number().optional(),
  presentation: ToolPresentationSchema.optional(),
});
export type ToolCompletedEvent = z.infer<typeof ToolCompletedEventSchema>;

export const ToolFailedEventSchema = z.strictObject({
  type: z.literal('tool.failed'),
  toolCallId: z.string(),
  tool: z.string().optional(),
  error: z.string().optional(),
  presentation: ToolPresentationSchema.optional(),
});
export type ToolFailedEvent = z.infer<typeof ToolFailedEventSchema>;

export type ToolStateEvent = ToolRequestedEvent | ToolStartedEvent | ToolCompletedEvent | ToolFailedEvent;

export const ToolStateEventSchema = z.discriminatedUnion('type', [
  ToolRequestedEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
]);
