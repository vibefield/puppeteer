import { z } from 'zod';

/** Provider-neutral identity for the model currently serving this session. */
export const AgentModelIdentitySchema = z.strictObject({
  /** Stable provider model id, suitable for matching a model catalog. */
  id: z.string(),
  /** Human-facing model-card label when the provider publishes one. */
  displayName: z.string().optional(),
  /** Provider/model-family name when it is available independently of the id. */
  provider: z.string().optional(),
});
export type AgentModelIdentity = z.infer<typeof AgentModelIdentitySchema>;

export const AgentProviderModeSchema = z.strictObject({
  raw: z.string(),
  normalized: z.string().optional(),
});
export type AgentProviderMode = z.infer<typeof AgentProviderModeSchema>;

/** Git metadata resolved for the agent's current working directory. */
export const AgentGitStateSchema = z.strictObject({
  root: z.string(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  detached: z.boolean(),
  worktree: z.boolean().optional(),
});
export type AgentGitState = z.infer<typeof AgentGitStateSchema>;

/**
 * A sparse update to the agent-owned execution environment. Omitted fields do
 * not change existing state; null explicitly clears cwd/model or records that
 * the current cwd is outside a Git repository.
 */
export const SessionEnvironmentUpdatedEventSchema = z.strictObject({
  type: z.literal('session.environment.updated'),
  /** Launch intent is retained separately from effective provider observations. */
  intent: z.enum(['configured', 'observed']).optional(),
  currentCwd: z.string().nullable().optional(),
  model: AgentModelIdentitySchema.nullable().optional(),
  git: AgentGitStateSchema.nullable().optional(),
  effort: z.string().nullable().optional(),
  providerSessionMode: AgentProviderModeSchema.nullable().optional(),
  providerPermissionMode: AgentProviderModeSchema.nullable().optional(),
});
export type SessionEnvironmentUpdatedEvent = z.infer<typeof SessionEnvironmentUpdatedEventSchema>;

export type EnvironmentEvent = SessionEnvironmentUpdatedEvent;
export const EnvironmentEventSchema = SessionEnvironmentUpdatedEventSchema;
