import {
  AgentNativeInvocationIntentSchema,
  type AgentLaunchImplementation,
  type AgentNativeInvocationIntent,
  type ExternalRef,
  type HostIngress,
} from '@vibefield/puppeteer-core';
import type {
  AdoptPreparedSessionResult,
  AgentRuntime,
  AgentWorkspaceRequest,
  PreparationFailure,
} from '../../types.js';
import {
  declineSpawnThrough,
  type SpawnThroughDeclineCode,
  type SpawnThroughLaunchRequest,
  type SpawnThroughResponse,
} from './protocol.js';

/** What a host adds to a typed launch. The intent itself is the shim's and cannot be overridden here. */
export interface SpawnThroughLaunchOptions {
  title?: string | undefined;
  creationRequestId?: string | undefined;
  externalRefs?: readonly ExternalRef[] | undefined;
  workspace?: AgentWorkspaceRequest | undefined;
  /** The host's say over the session's loopback ingress, so a host that restarts can re-attach the run. */
  ingress?: HostIngress | undefined;
}

/** The port a host implements to turn a typed command into a managed session. */
export interface SpawnThroughHost {
  runtime: Pick<
    AgentRuntime,
    'launchProviders' | 'classifyInvocation' | 'prepareInvocation' | 'adoptPrepared' | 'cancelPrepared'
  >;
  /** Which of the host's terminals contains this process — the host's own evidence. */
  resolveTerminal(process: { pid: number; parentPid: number }): Promise<{ terminalSessionId: string } | undefined>;
  /** What the host adds to a launch: its durable identity, its say over the ingress, a title. */
  launchOptions?(intent: AgentNativeInvocationIntent): SpawnThroughLaunchOptions | undefined;
  /**
   * Refuse, rather than let run unmanaged, an interactive session in one of
   * the host's own terminals that it cannot manage — and nothing else (the
   * rule of refusal, {@link prepareSpawnThroughLaunch}). Default false.
   */
  strict?: boolean | undefined;
  /**
   * The words a person reads in their terminal when a launch is refused there,
   * one or two lines; the shim prints them after `puppeteer: <command>: `. The
   * kit bounds them (printable characters, two lines,
   * `MAX_REFUSAL_MESSAGE_LENGTH`). Absent, throwing, or left empty by the
   * bound: the kit's own sentence (`spawnThroughRefusalMessage`).
   */
  refusal?(refused: SpawnThroughRefusal): string;
  /** The host's record of the run, written before the shim is told to exec. */
  onAdopted(adopted: AdoptedSpawnThroughSession): void | Promise<void>;
  /** Absolute path to the imposter's `ai`, when this host can emulate. */
  imposterBin?(): string | undefined;
  /** Host-owned state root when the adapter's descriptor requests isolation. */
  imposterStateRoot?(providerId: string): string | undefined;
}

export interface AdoptedSpawnThroughSession {
  info: Exclude<AdoptPreparedSessionResult, { error: unknown }>;
  terminalSessionId: string;
  /** The shim's pid, which becomes the agent's at exec: the host watches it and reports its exit. */
  processId: number;
  preparationId: string;
}

/** A refusal, as a host words it ({@link SpawnThroughHost.refusal}). */
export interface SpawnThroughRefusal {
  code: SpawnThroughDeclineCode;
  reason: string;
  /** The first argument the managed launch could not carry, when the adapter named one. */
  argument?: string;
  /**
   * With `launch-refused`: the adapter's own code for its refusal, whose sentence
   * is `reason`. A host may word a code it knows, and say the adapter's sentence for the rest.
   */
  providerCode?: string;
  providerId: string;
  /** The name the person typed (`ai` for the imposter's route). */
  command: string;
}

function positivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function launchOptionsOf(options: SpawnThroughLaunchOptions | undefined): SpawnThroughLaunchOptions {
  if (!options) return {};
  const { title, creationRequestId, externalRefs, workspace, ingress } = options;
  return {
    ...(title === undefined ? {} : { title }),
    ...(creationRequestId === undefined ? {} : { creationRequestId }),
    ...(externalRefs === undefined ? {} : { externalRefs }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(ingress === undefined ? {} : { ingress }),
  };
}

/**
 * THE RULE OF REFUSAL. A launch that cannot be `exec` is refused only when all
 * three hold: the host is strict; the invocation is an interactive session —
 * the adapter did not call it a passthrough, and its input and output are a
 * terminal; and the process is in a terminal the host owns. Everything else
 * runs as typed (`fallback`), in every mode.
 */
function refuses(
  strict: boolean | undefined,
  invocation: { session: boolean; interactive: boolean; placed: boolean },
): boolean {
  return strict === true && invocation.session && invocation.interactive && invocation.placed;
}

function naming(reason: string, argument: string | undefined): string {
  return argument === undefined ? reason : `${reason} (${argument})`;
}

/** A failed preparation, kept distinguishable by the runtime's own code. */
function preparationDecline(error: PreparationFailure['error']): SpawnThroughDeclineCode {
  switch (error.code) {
    case 'NATIVE_INVOCATION_PASSTHROUGH':
      return 'passthrough';
    case 'NATIVE_INVOCATION_UNSUPPORTED':
      return 'unsupported-agent';
    case 'INVALID_NATIVE_INVOCATION':
      return error.argument === undefined ? 'invalid-invocation' : 'rejected-argument';
    case 'AGENT_LAUNCH_REFUSED':
      return 'launch-refused';
    default:
      return 'prepare-failed';
  }
}

/** The host's words for a refusal, or none when it has none to give. */
function hostWords(host: SpawnThroughHost, refused: SpawnThroughRefusal): string | undefined {
  try {
    const words = host.refusal?.(refused);
    return typeof words === 'string' ? words : undefined;
  } catch {
    // A host that could not word its refusal still refuses: the kit's sentence says why.
    return undefined;
  }
}

/**
 * Turn one `launch` request into a managed session in the terminal that
 * contains it, or decline it. Every decline is judged by the rule of refusal
 * ({@link refuses}), and the order follows from it: the request, then what the
 * invocation is (the adapter's grammar — a version query or a one-shot never
 * waits on a terminal lookup), then the containing terminal, and only then the
 * declines a strict host may refuse, the preparation and the adoption. Nothing
 * is prepared for a process no terminal of the host's contains, and a
 * preparation no terminal adopted is cancelled rather than left to expire. The
 * host's record is written before the shim is told to exec.
 *
 * `exec-failed` is not handled here: the host owns its records, so it cancels
 * the preparation and withdraws what `onAdopted` recorded.
 */
export async function prepareSpawnThroughLaunch(
  request: SpawnThroughLaunchRequest,
  host: SpawnThroughHost,
): Promise<SpawnThroughResponse> {
  // What the rule reads, as each step establishes it.
  const invocation = { session: false, interactive: request.interactive, placed: false };
  const decline = (
    code: SpawnThroughDeclineCode,
    reason: string,
    { argument, providerCode }: { argument?: string | undefined; providerCode?: string | undefined } = {},
  ): SpawnThroughResponse => {
    if (!refuses(host.strict, invocation)) return declineSpawnThrough({ code, reason });
    const refused: SpawnThroughRefusal = {
      code,
      reason,
      ...(argument === undefined ? {} : { argument }),
      ...(providerCode === undefined ? {} : { providerCode }),
      providerId: request.providerId,
      // A shim from before the request carried its name.
      command: request.command ?? request.providerId,
    };
    // The rule refuses only after `resolveTerminal` answered: every refusal from here is placed.
    return declineSpawnThrough({ code, reason }, { message: hostWords(host, refused), placed: true });
  };

  // 1. The request. One the kit cannot read names no process it could place.
  if (!positivePid(request.pid) || !positivePid(request.parentPid)) {
    return decline('invalid-request', 'invalid process identity');
  }
  const intent = AgentNativeInvocationIntentSchema.safeParse({
    providerId: request.providerId,
    cwd: request.cwd,
    argv: request.argv,
    environment: request.environment,
  });
  if (!intent.success) return decline('invalid-request', 'invalid launch request');

  // 2. What it is — the grammar alone; the implementation the host would run is judged at 5.
  const classified = host.runtime.classifyInvocation({ ...intent.data, implementation: { kind: 'native' } });
  if (classified.status === 'passthrough') return decline('passthrough', classified.reason);
  invocation.session = true;
  if (!invocation.interactive) {
    return decline('not-interactive', 'its input or output is not a terminal: a one-shot run');
  }

  // 3. Where it is. An agent typed where the launcher's directory leaked (an editor's terminal, a
  // detached job) reaches the gateway too, and no terminal of the host's holds it.
  const terminal = await host.resolveTerminal({ pid: request.pid, parentPid: request.parentPid });
  if (!terminal) return decline('outside-host-terminals', 'not in a terminal this host owns');
  invocation.placed = true;

  // 4. Only now, a session in the host's terminal that the host cannot manage.
  if (classified.status === 'unsupported') {
    const code = classified.code === 'NATIVE_INVOCATION_UNSUPPORTED' ? 'unsupported-agent' : 'invalid-invocation';
    return decline(code, classified.reason);
  }
  const provider = host.runtime.launchProviders().find((candidate) => candidate.id === intent.data.providerId);
  const capability = provider?.nativeInvocation;
  if (!provider || !capability) return decline('unsupported-agent', 'agent does not support managed native invocation');
  if (classified.status === 'rejected') {
    return decline('rejected-argument', naming(classified.reason, classified.argument), {
      argument: classified.argument,
    });
  }

  // 5. The implementation.
  let implementation: AgentLaunchImplementation = { kind: 'native' };
  if (request.imposter) {
    const imposter = capability.imposter;
    if (!imposter) return decline('imposter-unavailable', 'agent does not advertise a conformant pane imposter');
    const executable = host.imposterBin?.();
    if (!executable) return decline('imposter-unavailable', 'the puppeteer imposter is not installed beside the host');
    if (imposter.state === 'isolated-root') {
      const stateRoot = host.imposterStateRoot?.(provider.id);
      if (!stateRoot) return decline('imposter-unavailable', 'an isolated imposter state root is unavailable');
      implementation = { kind: 'imposter', executable, stateRoot };
    } else {
      implementation = { kind: 'imposter', executable };
    }
  }

  // 6. Prepare, adopt, record.
  const prepared = await host.runtime.prepareInvocation({
    ...launchOptionsOf(host.launchOptions?.(intent.data)),
    ...intent.data,
    implementation,
  });
  if ('error' in prepared) {
    // A strict host refuses only a session. Its adapter's `rejected` means one
    // only when the adapter classifies (`nativeInvocation.classifies`); an
    // adapter that does not answers `rejected` for a version query too, so a
    // strict host gives launchers only to agents whose adapters classify. A
    // passthrough the real implementation reveals runs as typed, as at 2.
    if (prepared.error.code === 'NATIVE_INVOCATION_PASSTHROUGH') invocation.session = false;
    const { argument, refusal } = prepared.error;
    return decline(preparationDecline(prepared.error), naming(prepared.error.message, argument), {
      argument,
      providerCode: refusal?.code,
    });
  }

  const adopted = await host.runtime.adoptPrepared(prepared.preparationId, {
    runtimeRunId: prepared.runtimeRunId,
    terminalSessionId: terminal.terminalSessionId,
    processId: request.pid,
  });
  if ('error' in adopted) {
    await host.runtime.cancelPrepared(prepared.preparationId);
    const code = adopted.error.code === 'RUNTIME_SESSION_CONFLICT' ? 'terminal-conflict' : 'adopt-failed';
    return decline(code, adopted.error.message);
  }

  await host.onAdopted({
    info: adopted,
    terminalSessionId: terminal.terminalSessionId,
    processId: request.pid,
    preparationId: prepared.preparationId,
  });
  return { action: 'exec', preparationId: prepared.preparationId, launch: prepared.launch };
}
