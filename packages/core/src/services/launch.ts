import { z } from 'zod';
import { AgentProviderDescriptorSchema, AgentProviderIdSchema } from './provider.js';

/**
 * Provider-neutral launch and continuation contracts.
 *
 * Metadata and wire payloads are Zod schemas because they cross package,
 * process, and persistence boundaries. Provider callbacks remain TypeScript
 * interfaces: their normalized options are deliberately private to the
 * adapter/runtime composition and are never serialized for consumers.
 */

const NonEmptyStringSchema = z.string().trim().min(1).max(8_192);
const CommandNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const EnvironmentVariableSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

/** Opaque, adapter-owned information sufficient to continue one native conversation. */
export const AgentContinuationSchema = z.strictObject({
  providerId: AgentProviderIdSchema,
  nativeSessionId: NonEmptyStringSchema,
  /** Generic implementation identity; defaults old persisted continuations to native. */
  implementation: z.enum(['native', 'imposter']).default('native'),
  /** Adapter-versioned, credential-free state. Consumers persist but never inspect it. */
  state: z.string().max(8_192).optional(),
});
export type AgentContinuation = z.infer<typeof AgentContinuationSchema>;

export const AgentLaunchCommandSchema = z.strictObject({
  /** Name intercepted in an interactive shell. */
  name: CommandNameSchema,
  /** Adapter-resolved real executable used when the host declines interception. */
  executable: NonEmptyStringSchema,
});
export type AgentLaunchCommand = z.infer<typeof AgentLaunchCommandSchema>;

export const AgentNativeInvocationCapabilitySchema = z
  .strictObject({
    commands: z.array(AgentLaunchCommandSchema).min(1).max(16),
    /** The complete shell-environment allow-list accepted by this adapter. */
    environmentVariables: z.array(EnvironmentVariableSchema).max(32),
    /** Present only when the adapter has a conformant native-compatible imposter route. */
    imposter: z
      .strictObject({
        state: z.enum(['none', 'isolated-root']),
      })
      .optional(),
  })
  .superRefine((capability, context) => {
    const commandNames = new Set<string>();
    capability.commands.forEach((command, index) => {
      if (commandNames.has(command.name)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate launch command: ${command.name}`,
          path: ['commands', index],
        });
      }
      commandNames.add(command.name);
    });
    const environmentNames = new Set<string>();
    capability.environmentVariables.forEach((name, index) => {
      if (environmentNames.has(name)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate launch environment variable: ${name}`,
          path: ['environmentVariables', index],
        });
      }
      environmentNames.add(name);
    });
  });
export type AgentNativeInvocationCapability = z.infer<typeof AgentNativeInvocationCapabilitySchema>;

/** Adapter-owned launch capability advertised to generic runtimes and hosts. */
export const AgentLaunchProviderSchema = z.strictObject({
  ...AgentProviderDescriptorSchema.shape,
  resume: z.boolean(),
  nativeInvocation: AgentNativeInvocationCapabilitySchema.optional(),
});
export type AgentLaunchProvider = z.infer<typeof AgentLaunchProviderSchema>;

export const AgentLaunchImplementationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native') }),
  z.strictObject({
    kind: z.literal('imposter'),
    executable: NonEmptyStringSchema,
    /** Host-owned durable root when the advertised imposter capability requires one. */
    stateRoot: NonEmptyStringSchema.optional(),
  }),
]);
export type AgentLaunchImplementation = z.infer<typeof AgentLaunchImplementationSchema>;

const NativeInvocationEnvironmentSchema = z
  .record(EnvironmentVariableSchema, z.string().max(8_192))
  .superRefine((environment, context) => {
    if (Object.keys(environment).length > 32) {
      context.addIssue({ code: 'custom', message: 'native invocation environment exceeds 32 entries' });
    }
  });

/** Untrusted shell intent before a host chooses the trusted implementation. */
export const AgentNativeInvocationIntentSchema = z.strictObject({
  providerId: AgentProviderIdSchema,
  cwd: NonEmptyStringSchema,
  argv: z.array(z.string().max(8_192)).max(256),
  environment: NativeInvocationEnvironmentSchema,
});
export type AgentNativeInvocationIntent = z.infer<typeof AgentNativeInvocationIntentSchema>;

/** Validated native CLI intent handed from a terminal host to one adapter. */
export const AgentNativeInvocationSchema = z.strictObject({
  ...AgentNativeInvocationIntentSchema.shape,
  implementation: AgentLaunchImplementationSchema,
});
export type AgentNativeInvocation = z.infer<typeof AgentNativeInvocationSchema>;

/** Private adapter output. `options` never crosses the provider seam. */
export type AgentNativeInvocationResolution<Options = unknown> =
  { status: 'accepted'; resume?: string; options?: Options } | { status: 'rejected'; reason: string };

/** Pure adapter service: normalize one vendor CLI grammar into adapter options. */
export interface AgentNativeInvocationNormalizer<Options = unknown> {
  normalize(invocation: AgentNativeInvocation): AgentNativeInvocationResolution<Options>;
}
