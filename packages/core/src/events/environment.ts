import { z } from 'zod';

/** Git metadata resolved for the agent's current working directory. */
export const AgentGitStateSchema = z.strictObject({
  root: z.string().trim().min(1),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  detached: z.boolean(),
  worktree: z.boolean().optional(),
});
export type AgentGitState = z.infer<typeof AgentGitStateSchema>;

/**
 * A sparse update to the agent-owned filesystem environment. Omitted fields do
 * not change existing state; null clears cwd or records that the current cwd
 * is outside a Git repository. Model, effort, and provider mode each have
 * their own category so consumers never need to inspect unrelated fields.
 */
export const EnvironmentUpdatedEventSchema = z.strictObject({
  type: z.literal('environment:updated'),
  currentCwd: z.string().trim().min(1).nullable().optional(),
  git: AgentGitStateSchema.nullable().optional(),
});
export type EnvironmentUpdatedEvent = z.infer<typeof EnvironmentUpdatedEventSchema>;

export type EnvironmentEvent = EnvironmentUpdatedEvent;
export const EnvironmentEventSchema = EnvironmentUpdatedEventSchema;
