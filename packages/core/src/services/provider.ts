import { z } from 'zod';

/** Stable provider identity shared by every normalized provider capability. */
export const AgentProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/**
 * Consumer-facing provider metadata.
 *
 * Provider ids remain opaque outside adapters and Runtime. Products render the
 * adapter-authored label and may layer optional product-owned artwork on top.
 */
export const AgentProviderDescriptorSchema = z.strictObject({
  id: AgentProviderIdSchema,
  label: z.string().trim().min(1).max(256),
});

export type AgentProviderDescriptor = z.infer<typeof AgentProviderDescriptorSchema>;
