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
const HistoryKindSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
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
  /**
   * False while a resume by `nativeSessionId` cannot succeed yet: the adapter has not seen the conversation's
   * durable record (the id is provisional, or the agent has not written it). A host must not end a live process
   * for such a resume. Absent once it can, and on every continuation written before this field existed.
   */
  resumable: z.boolean().optional(),
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
    /**
     * True when the normalizer tells a utility, a one-shot and an elsewhere
     * invocation apart from a session (`passthrough`), so that its `rejected`
     * means a session it cannot carry. Absent reads false. A strict host gives
     * a launcher only to an agent whose adapter classifies.
     */
    classifies: z.boolean().optional(),
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
  /**
   * The runtime kinds an external transcript index (Rosetta's `/api/runtimes`)
   * files this agent's native sessions under. A host joins an indexed session
   * to the provider that resumes it through these, never through a table of
   * its own. Absent when the agent keeps no native record such an index reads.
   */
  historyKinds: z.array(HistoryKindSchema).min(1).max(8).optional(),
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

/**
 * What an invocation that is not a managed session IS — a fact the adapter
 * states from its own CLI grammar; every host lets it run as typed.
 * `utility` runs no agent (help, version, a management subcommand);
 * `one-shot` runs an agent non-interactively in this process (print and exec
 * modes); `elsewhere` starts or opens an agent that does not live in this
 * process (background, cloud, attach).
 */
export const AgentNativeInvocationPassthroughKindSchema = z.enum(['utility', 'one-shot', 'elsewhere']);
export type AgentNativeInvocationPassthroughKind = z.infer<typeof AgentNativeInvocationPassthroughKindSchema>;

/**
 * Private adapter output. `options` never crosses the provider seam.
 * `accepted`: an interactive session here, every argument carried.
 * `passthrough`: not a session at all (see {@link AgentNativeInvocationPassthroughKind}).
 * `rejected`: an interactive session here that the managed launch cannot
 * carry; `argument` is the first token the adapter could not carry.
 */
export type AgentNativeInvocationResolution<Options = unknown> =
  | { status: 'accepted'; resume?: string; options?: Options }
  | { status: 'passthrough'; kind: AgentNativeInvocationPassthroughKind; reason: string }
  | { status: 'rejected'; reason: string; argument?: string };

/** Pure adapter service: normalize one vendor CLI grammar into adapter options. */
export interface AgentNativeInvocationNormalizer<Options = unknown> {
  normalize(invocation: AgentNativeInvocation): AgentNativeInvocationResolution<Options>;
}

// A registered symbol: every copy of this package that an adapter or a runtime loads reads the same one.
const AGENT_LAUNCH_REFUSED = Symbol.for('@vibefield/puppeteer-core/agent-launch-refused');
const AGENT_LAUNCH_REFUSAL_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/**
 * The one error an adapter throws whose words are for a person. A provider's
 * preparation or creation throws it when the launch must not proceed for a
 * reason the person can act on: `code` is the adapter's own, stable and
 * UPPER_SNAKE (at most 64 characters); `message` is one plain sentence with
 * nothing in it that is not theirs to read. The runtime carries exactly this
 * kind to the failure it answers, words and code. Anything else an adapter
 * throws is an internal failure, whose text is for logs.
 */
export class AgentLaunchRefusedError<Code extends string = string> extends Error {
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message);
    this.name = 'AgentLaunchRefusedError';
  }

  static {
    // The brand sits on the prototype: every instance of every subclass carries it, and none of their data shows it.
    Object.defineProperty(this.prototype, AGENT_LAUNCH_REFUSED, { value: true });
  }
}

/**
 * Whether `value` is an adapter's refusal ({@link AgentLaunchRefusedError}),
 * read by its brand and never by `instanceof`: an adapter that loads its own
 * copy of this package throws another copy's class. One whose code or message
 * breaks the class's rule is not a refusal.
 */
export function isAgentLaunchRefusedError(value: unknown): value is AgentLaunchRefusedError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { [AGENT_LAUNCH_REFUSED]?: unknown; code?: unknown; message?: unknown };
  return (
    candidate[AGENT_LAUNCH_REFUSED] === true &&
    typeof candidate.code === 'string' &&
    AGENT_LAUNCH_REFUSAL_CODE.test(candidate.code) &&
    typeof candidate.message === 'string'
  );
}
