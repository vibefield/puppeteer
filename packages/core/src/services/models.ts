import { z } from 'zod';
import { AgentProviderDescriptorSchema, AgentProviderIdSchema } from './provider.js';
import { AgentProfileIdSchema, type AgentProfile } from './profiles.js';
import { AgentLaunchRefusedError } from './launch.js';

const Text = z.string().min(1).max(8_192);
const Id = z.string().min(1).max(1_024);

export const AgentModelControlSchema = z
  .strictObject({
    id: Id,
    label: Text,
    role: z.enum(['effort', 'thinking', 'variant']),
    values: z
      .array(z.strictObject({ id: Id, label: Text }))
      .min(1)
      .max(128),
    defaultValue: Id.optional(),
  })
  .superRefine((control, ctx) => {
    if (new Set(control.values.map((value) => value.id)).size !== control.values.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate model control value' });
    if (control.defaultValue && !control.values.some((value) => value.id === control.defaultValue))
      ctx.addIssue({ code: 'custom', message: 'model control default must be an offered value' });
  });
export type AgentModelControl = z.infer<typeof AgentModelControlSchema>;

/** IDs are opaque launch choices. Neither a label nor an id named "default" means inherit settings. */
export const AgentModelChoiceSchema = z
  .strictObject({
    id: Id,
    label: Text,
    description: Text.optional(),
    group: Text.optional(),
    controls: z.array(AgentModelControlSchema).max(16),
  })
  .superRefine((choice, ctx) => {
    if (new Set(choice.controls.map((control) => control.id)).size !== choice.controls.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate model control id' });
  });
export type AgentModelChoice = z.infer<typeof AgentModelChoiceSchema>;

export const AgentModelProviderSchema = z.strictObject({
  ...AgentProviderDescriptorSchema.shape,
  discovery: z.enum(['prelaunch', 'session']),
  /**
   * True when the agent's native resume takes the options a selection translates to, so a resumed session starts at
   * it. Absent or false: a resume that carries a selection is refused, never resumed without it.
   */
  resumeSelection: z.boolean().optional(),
});
export type AgentModelProvider = z.infer<typeof AgentModelProviderSchema>;

export const AgentModelCatalogSchema = z
  .strictObject({
    provider: AgentProviderIdSchema,
    profileId: AgentProfileIdSchema.optional(),
    cwd: Text,
    observedAt: z.iso.datetime({ offset: true }),
    source: z.strictObject({
      kind: z.enum(['native-protocol', 'native-command', 'native-helper']),
      /** A fresh local read may still contain a vendor's cache. Unknown is not live. */
      freshness: z.enum(['live', 'cached', 'stale', 'unknown']),
      nativeVersion: Text.optional(),
    }),
    /** Complete only for this profile's native picker, never a promise of inference access. */
    completeness: z.enum(['complete', 'partial']),
    customModels: z.boolean(),
    models: z.array(AgentModelChoiceSchema).max(20_000),
  })
  .superRefine((catalog, ctx) => {
    if (new Set(catalog.models.map((model) => model.id)).size !== catalog.models.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate model choice id' });
  });
export type AgentModelCatalog = z.infer<typeof AgentModelCatalogSchema>;

export const AgentModelDiscoveryFailureSchema = z.strictObject({
  status: z.enum(['unsupported', 'requires-session', 'auth-required', 'unavailable', 'error', 'cancelled']),
  provider: AgentProviderIdSchema,
  code: z.enum([
    'unsupported',
    'requires-session',
    'auth-required',
    'not-found',
    'timeout',
    'cancelled',
    'invalid-response',
    'invalid-context',
    'native-error',
  ]),
  /** Adapter-authored text only: native stderr, configuration and tokens never cross this boundary. */
  message: Text,
});
export type AgentModelDiscoveryFailure = z.infer<typeof AgentModelDiscoveryFailureSchema>;
export const AgentModelDiscoveryResultSchema = z.union([
  z.strictObject({ status: z.literal('available'), catalog: AgentModelCatalogSchema }),
  AgentModelDiscoveryFailureSchema,
]);
export type AgentModelDiscoveryResult = z.infer<typeof AgentModelDiscoveryResultSchema>;

export const AgentModelSelectionSchema = z.strictObject({
  modelId: Id,
  /** An explicit opt-in for an unlisted native model; never inferred from a missing catalog entry. */
  custom: z.boolean().optional(),
  controls: z.record(Id, Id).optional(),
});
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>;

export interface AgentModelDiscoveryContext {
  cwd: string;
  profile?: AgentProfile | undefined;
  signal?: AbortSignal | undefined;
  /** Bounds the complete discovery, including native startup. */
  timeoutMs?: number | undefined;
}

/** Provider-owned discovery and translation. The runtime never serializes the native options. */
export interface AgentModelService {
  readonly provider: AgentModelProvider;
  discover(context: AgentModelDiscoveryContext): Promise<AgentModelDiscoveryResult>;
  toAgentOptions(selection: AgentModelSelection, catalog: AgentModelCatalog): unknown;
}

/** Pure validation shared by native adapters and the runtime. Omission of the selection inherits settings. */
export function validateModelSelection(catalog: AgentModelCatalog, input: AgentModelSelection): AgentModelSelection {
  const parsed = AgentModelSelectionSchema.safeParse(input);
  if (!parsed.success)
    throw new AgentLaunchRefusedError('INVALID_MODEL_SELECTION', 'The model selection is malformed.');
  const selection = parsed.data;
  const choice = catalog.models.find((model) => model.id === selection.modelId);
  if (!choice && !(selection.custom === true && catalog.customModels))
    throw new AgentLaunchRefusedError('INVALID_MODEL_SELECTION', 'The selected model is not offered by this profile.');
  for (const [id, value] of Object.entries(selection.controls ?? {})) {
    const control = choice?.controls.find((control) => control.id === id);
    if (!control?.values.some((option) => option.id === value))
      throw new AgentLaunchRefusedError(
        'INVALID_MODEL_SELECTION',
        'The selected model does not offer this control value.',
      );
  }
  return selection;
}

/** Callbacks own I/O and native parsing; this wrapper rejects malformed or foreign public results. */
export function defineModelService(service: AgentModelService): AgentModelService {
  const provider = AgentModelProviderSchema.parse(service.provider);
  return {
    provider,
    async discover(context) {
      try {
        context.signal?.throwIfAborted();
        const result = AgentModelDiscoveryResultSchema.parse(await service.discover(context));
        if ((result.status === 'available' ? result.catalog.provider : result.provider) !== provider.id)
          throw new Error('foreign model catalog');
        return result;
      } catch (error) {
        const rawCode = error instanceof Error && 'code' in error ? error.code : undefined;
        const code = context.signal?.aborted
          ? 'cancelled'
          : error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : error instanceof Error && error.name === 'AbortError'
              ? 'cancelled'
              : ['not-found', 'timeout', 'cancelled', 'auth-required', 'unsupported', 'native-error'].includes(
                    String(rawCode),
                  )
                ? (rawCode as 'not-found' | 'timeout' | 'cancelled' | 'auth-required' | 'unsupported' | 'native-error')
                : 'invalid-response';
        return {
          provider: provider.id,
          status:
            code === 'cancelled'
              ? 'cancelled'
              : code === 'auth-required'
                ? 'auth-required'
                : code === 'unsupported'
                  ? 'unsupported'
                  : code === 'not-found' || code === 'timeout'
                    ? 'unavailable'
                    : 'error',
          code,
          message:
            code === 'cancelled'
              ? 'Model discovery was cancelled.'
              : code === 'timeout'
                ? 'Model discovery timed out.'
                : code === 'auth-required'
                  ? 'Sign in to discover models.'
                  : code === 'not-found'
                    ? 'The native agent could not be started.'
                    : code === 'unsupported'
                      ? 'This installation does not expose model discovery.'
                      : 'The native agent did not return a valid model catalog.',
        };
      }
    },
    toAgentOptions(selection, catalog) {
      if (catalog.provider !== provider.id) throw new Error('Model catalog belongs to another provider.');
      return service.toAgentOptions(validateModelSelection(catalog, selection), catalog);
    },
  };
}
