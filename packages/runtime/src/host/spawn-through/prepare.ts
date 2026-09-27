import {
  AgentNativeInvocationIntentSchema,
  type AgentLaunchImplementation,
  type AgentNativeInvocationIntent,
  type ExternalRef,
  type HostIngress,
} from '@vibecook/puppeteer-core';
import type { AdoptPreparedSessionResult, AgentRuntime, AgentWorkspaceRequest } from '../../types.js';
import { declineSpawnThrough, type SpawnThroughLaunchRequest, type SpawnThroughResponse } from './protocol.js';

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
  runtime: Pick<AgentRuntime, 'launchProviders' | 'prepareInvocation' | 'adoptPrepared' | 'cancelPrepared'>;
  /** Which of the host's terminals contains this process — the host's own evidence. */
  resolveTerminal(process: { pid: number; parentPid: number }): Promise<{ terminalSessionId: string } | undefined>;
  /** What the host adds to a launch: its durable identity, its say over the ingress, a title. */
  launchOptions?(intent: AgentNativeInvocationIntent): SpawnThroughLaunchOptions | undefined;
  /** Refuse instead of falling through. Default false. */
  strict?: boolean | undefined;
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
 * Turn one `launch` request into a managed session in the terminal that
 * contains it, or decline it. The order is the contract: the provider and its
 * capability, then the containing terminal, then the preparation, then the
 * adoption — so nothing is prepared for a process no terminal of the host's
 * contains, and a preparation no terminal adopted is cancelled rather than left
 * to expire. The host's record is written before the shim is told to exec.
 *
 * `exec-failed` is not handled here: the host owns its records, so it cancels
 * the preparation and withdraws what `onAdopted` recorded.
 */
export async function prepareSpawnThroughLaunch(
  request: SpawnThroughLaunchRequest,
  host: SpawnThroughHost,
): Promise<SpawnThroughResponse> {
  const decline = (reason: string): SpawnThroughResponse => declineSpawnThrough(reason, { strict: host.strict });
  if (!positivePid(request.pid) || !positivePid(request.parentPid)) return decline('invalid process identity');
  const intent = AgentNativeInvocationIntentSchema.safeParse({
    providerId: request.providerId,
    cwd: request.cwd,
    argv: request.argv,
    environment: request.environment,
  });
  if (!intent.success) return decline('invalid launch request');
  const provider = host.runtime.launchProviders().find((candidate) => candidate.id === intent.data.providerId);
  const capability = provider?.nativeInvocation;
  if (!provider || !capability) return decline('agent does not support managed native invocation');

  let implementation: AgentLaunchImplementation = { kind: 'native' };
  if (request.imposter) {
    const imposter = capability.imposter;
    if (!imposter) return decline('agent does not advertise a conformant pane imposter');
    const executable = host.imposterBin?.();
    if (!executable) return decline('the puppeteer imposter is not installed beside the host');
    if (imposter.state === 'isolated-root') {
      const stateRoot = host.imposterStateRoot?.(provider.id);
      if (!stateRoot) return decline('an isolated imposter state root is unavailable');
      implementation = { kind: 'imposter', executable, stateRoot };
    } else {
      implementation = { kind: 'imposter', executable };
    }
  }

  const terminal = await host.resolveTerminal({ pid: request.pid, parentPid: request.parentPid });
  if (!terminal) return decline('containing terminal was not found');

  const prepared = await host.runtime.prepareInvocation({
    ...launchOptionsOf(host.launchOptions?.(intent.data)),
    ...intent.data,
    implementation,
  });
  if ('error' in prepared) {
    // Every adapter's normalizer answers one `rejected` for two different
    // things: an invocation that is not a session at all (a version query, a
    // one-shot print mode) and a session whose arguments it cannot carry. A
    // strict host refuses both, the first wrongly, until the adapters tell them
    // apart (PU-9a: a `passthrough` status, answered `fallback` in every mode).
    // No host turns strict on before then.
    return decline(prepared.error.message);
  }

  const adopted = await host.runtime.adoptPrepared(prepared.preparationId, {
    runtimeRunId: prepared.runtimeRunId,
    terminalSessionId: terminal.terminalSessionId,
    processId: request.pid,
  });
  if ('error' in adopted) {
    await host.runtime.cancelPrepared(prepared.preparationId);
    return decline(adopted.error.message);
  }

  await host.onAdopted({
    info: adopted,
    terminalSessionId: terminal.terminalSessionId,
    processId: request.pid,
    preparationId: prepared.preparationId,
  });
  return { action: 'exec', preparationId: prepared.preparationId, launch: prepared.launch };
}
