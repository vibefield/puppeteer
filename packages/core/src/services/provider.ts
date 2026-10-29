import { z } from 'zod';

/** Stable provider identity shared by every normalized provider capability. */
export const AgentProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/** Adapter support, independent of the user's installed version or managed native policy. */
export const AgentBriefingCapabilitiesSchema = z.strictObject({
  mcpServers: z.boolean(),
  allowTools: z.boolean(),
  instructions: z.boolean(),
  /**
   * Where stdio servers run. A host that authenticates by terminal ancestry must require `terminal`;
   * a helper needs a separate trusted process-to-run association, and an external ACP agent owns its topology.
   */
  mcpServerProcess: z.enum(['terminal', 'helper', 'external']).optional(),
});
export type AgentBriefingCapabilities = z.infer<typeof AgentBriefingCapabilitiesSchema>;

/**
 * Consumer-facing provider metadata.
 *
 * Provider ids remain opaque outside adapters and Runtime. Products render the
 * adapter-authored label and may layer optional product-owned artwork on top.
 */
export const AgentProviderDescriptorSchema = z.strictObject({
  id: AgentProviderIdSchema,
  label: z.string().trim().min(1).max(256),
  /** Absent means no per-run briefing fields are supported. */
  briefing: AgentBriefingCapabilitiesSchema.optional(),
});

export type AgentProviderDescriptor = z.infer<typeof AgentProviderDescriptorSchema>;
