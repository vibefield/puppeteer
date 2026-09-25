import { stat } from 'node:fs/promises';
import {
  ExtensionActPlanSchema,
  ExtensionActReceiptSchema,
  type AgentProfile,
  type AvailableExtensionActPlan,
  type ExtensionActKind,
  type ExtensionActPlan,
  type ExtensionActReceipt,
  type ExtensionActTarget,
  type ExtensionFailure,
  type ExtensionInventory,
  type McpServerItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { runUpdateCommand, type UpdateCommandResult, type UpdateCommandRunner } from '../distribution/update.js';
import { buildAgentEnvironment } from '../host/environment.js';
import type { ExtensionInventoryReader, ExtensionProviderEntry } from './inventory.js';

/**
 * RFC 006 C2: an act on one server or skill a profile's agent holds — turned
 * on, turned off or removed — through the agent's own command or protocol.
 * The adapter plans it from the item a fresh read found; the runtime runs a
 * command plan the way it runs an updater (no stdin, a process group of its
 * own, the clean environment plus the plan's variables that point the agent at
 * the profile) and hands a protocol plan to the adapter. The receipt is a
 * second fresh read, never the output, which is display text only.
 */

/** An act is one small edit of the agent's own config: one that hangs is ended. */
const ACT_TIMEOUT_MS = 2 * 60_000;

export interface ExtensionActRequest {
  providerId: string;
  /** The native default's when none is named. */
  profileId?: string;
  target: ExtensionActTarget;
  act: ExtensionActKind;
  /** Opaque display text as it arrives; never parsed. */
  onOutput?: (chunk: string) => void;
  /** Aborting stops the act and everything it started. */
  signal?: AbortSignal;
}

export interface ExtensionActRunnerOptions {
  providers: ReadonlyMap<string, ExtensionProviderEntry>;
  reader: ExtensionInventoryReader;
  resolveProfile(providerId: string, profileId: string): Promise<{ profile: AgentProfile } | { error: string }>;
  nativeDefaultProfileId(providerId: string): string | undefined;
  /** Injected so tests never run an agent. */
  run?: UpdateCommandRunner;
  /** The process environment the clean one is built from. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  report?(error: unknown): void;
}

export interface ExtensionActRunner {
  /** What the act would run, or why the agent cannot; a failure when the agent could not be read. */
  plan(request: Omit<ExtensionActRequest, 'onOutput' | 'signal'>): Promise<ExtensionActPlan | ExtensionFailure>;
  /**
   * Every act the agent answers for items a read already found — each item,
   * each act — planned without reading again (the adapter's plan is pure), so
   * a host can say beside each item what a click would run.
   */
  plans(request: {
    providerId: string;
    profileId?: string;
    items: ReadonlyArray<McpServerItem | SkillItem>;
  }): Promise<ExtensionActPlan[] | ExtensionFailure>;
  run(request: ExtensionActRequest): Promise<ExtensionActReceipt>;
}

const ACTS: readonly ExtensionActKind[] = ['enable', 'disable', 'remove'];

type Located =
  | { failure: ExtensionFailure }
  | {
      profile: AgentProfile;
      entry: ExtensionProviderEntry;
      item: McpServerItem | SkillItem | undefined;
    };

const DONE: Record<ExtensionActKind, string> = {
  enable: 'turned on',
  disable: 'turned off',
  remove: 'removed',
};

export function createExtensionActRunner(options: ExtensionActRunnerOptions): ExtensionActRunner {
  const now = options.now ?? (() => new Date());
  const processEnv = options.env ?? process.env;

  const failure = (
    status: ExtensionFailure['status'],
    provider: string,
    message: string,
    retryable = false,
  ): ExtensionFailure => ({ status, provider, message, retryable });

  async function locate(request: Omit<ExtensionActRequest, 'onOutput' | 'signal'>): Promise<Located> {
    const { providerId } = request;
    const entry = options.providers.get(providerId);
    if (entry === undefined) {
      return {
        failure: failure('unsupported', providerId, `agent provider does not expose extensions: ${providerId}`),
      };
    }
    if (entry.service.plan === undefined) {
      return { failure: failure('unsupported', providerId, `${entry.provider.label} has no extension acts`) };
    }
    const target = request.profileId ?? options.nativeDefaultProfileId(providerId);
    if (target === undefined) {
      return { failure: failure('unsupported', providerId, `${providerId} has no native default profile`) };
    }
    const resolved = await options.resolveProfile(providerId, target);
    if ('error' in resolved) return { failure: failure('not-found', providerId, resolved.error) };
    // a fresh read: an act plans from what the agent holds now
    const inventory = await options.reader.inventory(providerId, target, { fresh: true });
    if ('status' in inventory) return { failure: inventory };
    return { profile: resolved.profile, entry, item: find(inventory, request.target) };
  }

  function planFor(
    located: Exclude<Located, { failure: ExtensionFailure }>,
    request: ExtensionActRequest | Omit<ExtensionActRequest, 'onOutput' | 'signal'>,
  ): ExtensionActPlan | ExtensionFailure {
    const { entry, profile, item } = located;
    if (item === undefined) {
      return {
        target: request.target,
        act: request.act,
        available: false,
        reason: 'not-held',
        message: `${entry.provider.label} does not hold ${request.target.id} in this profile`,
      };
    }
    let answer: unknown;
    try {
      answer = entry.service.plan!(profile, item, request.act);
    } catch (error) {
      options.report?.(error);
      return failure('invalid', request.providerId, `${entry.provider.label} could not plan the act`);
    }
    const parsed = ExtensionActPlanSchema.safeParse(answer);
    if (
      !parsed.success ||
      parsed.data.act !== request.act ||
      parsed.data.target.kind !== request.target.kind ||
      parsed.data.target.id !== request.target.id
    ) {
      return failure('invalid', request.providerId, `${entry.provider.label} answered with a malformed act plan`);
    }
    return parsed.data;
  }

  async function runCommand(
    profile: AgentProfile,
    plan: AvailableExtensionActPlan & { runs: { kind: 'command' } },
    request: ExtensionActRequest,
  ): Promise<UpdateCommandResult> {
    const environment: Record<string, string> = {
      ...buildAgentEnvironment({
        ...(processEnv.PATH === undefined ? {} : { path: processEnv.PATH }),
        ...(processEnv.HOME === undefined ? {} : { home: processEnv.HOME }),
      }),
      PYTHONUNBUFFERED: '1',
      ...(plan.runs.env ?? {}),
    };
    // The agent's own folder, never a project: a command that also reads a
    // project's config must find none.
    const cwd = (await isDirectory(profile.dataRoot)) ? profile.dataRoot : (environment.HOME ?? process.cwd());
    try {
      return await (options.run ?? runUpdateCommand)({
        argv: plan.runs.argv,
        env: environment,
        cwd,
        timeoutMs: ACT_TIMEOUT_MS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onOutput: (chunk) => {
          if (request.onOutput === undefined) return;
          try {
            request.onOutput(chunk);
          } catch (error) {
            // a host's display failing must not stop the act the person asked for
            options.report?.(error);
          }
        },
      });
    } catch (error) {
      options.report?.(error);
      return { exitCode: null, error: 'could not be started' };
    }
  }

  return {
    async plan(request) {
      const located = await locate(request);
      if ('failure' in located) return located.failure;
      return planFor(located, request);
    },

    async plans(request) {
      const { providerId } = request;
      const entry = options.providers.get(providerId);
      if (entry === undefined) {
        return failure('unsupported', providerId, `agent provider does not expose extensions: ${providerId}`);
      }
      if (entry.service.plan === undefined) return [];
      const target = request.profileId ?? options.nativeDefaultProfileId(providerId);
      if (target === undefined) return failure('unsupported', providerId, `${providerId} has no native default profile`);
      const resolved = await options.resolveProfile(providerId, target);
      if ('error' in resolved) return failure('not-found', providerId, resolved.error);
      const located = { profile: resolved.profile, entry };
      const plans: ExtensionActPlan[] = [];
      for (const item of request.items) {
        for (const act of ACTS) {
          const plan = planFor(
            { ...located, item },
            { providerId, target: { kind: item.kind, id: item.id }, act },
          );
          // one malformed answer is reported and left out; the rest stand
          if (!('status' in plan)) plans.push(plan);
        }
      }
      return plans;
    },

    async run(request) {
      const startedAt = now().toISOString();
      const base = {
        provider: request.providerId,
        target: request.target,
        act: request.act,
        startedAt,
      };
      const receipt = (
        profileId: string,
        fields: Pick<ExtensionActReceipt, 'status' | 'message'> & Partial<ExtensionActReceipt>,
      ): ExtensionActReceipt => {
        const candidate = { ...base, profileId, finishedAt: now().toISOString(), ...fields };
        const parsed = ExtensionActReceiptSchema.safeParse(candidate);
        if (parsed.success) return parsed.data;
        options.report?.(new Error(`act receipt for ${request.providerId} failed schema validation`));
        return {
          ...base,
          profileId,
          finishedAt: now().toISOString(),
          status: 'failed',
          message: 'the act receipt could not be assembled',
        };
      };
      const profileId = request.profileId ?? options.nativeDefaultProfileId(request.providerId) ?? 'unknown';

      const located = await locate(request);
      if ('failure' in located) return receipt(profileId, { status: 'failed', message: located.failure.message });
      const plan = planFor(located, request);
      if ('status' in plan) return receipt(located.profile.id, { status: 'failed', message: plan.message });
      if (!plan.available) return receipt(located.profile.id, { status: 'unavailable', message: plan.message });

      const { profile, entry } = located;
      const before = located.item!;
      let exitCode: number | undefined;
      let error: string | undefined;
      if (plan.runs.kind === 'command') {
        const result = await runCommand(
          profile,
          plan as AvailableExtensionActPlan & { runs: { kind: 'command' } },
          request,
        );
        if (result.exitCode !== null) exitCode = result.exitCode;
        if (result.error !== undefined) error = result.error;
        else if (result.exitCode !== 0)
          error = result.exitCode === null ? 'did not run to completion' : `exited with ${result.exitCode}`;
      } else if (entry.service.perform === undefined) {
        return receipt(profile.id, {
          status: 'failed',
          display: plan.display,
          message: `${entry.provider.label} cannot run a protocol act`,
        });
      } else {
        try {
          const outcome = await entry.service.perform(profile, plan, {
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
          });
          if (outcome.exitCode !== undefined) exitCode = outcome.exitCode;
          if (!outcome.ok) error = outcome.error ?? 'was refused';
        } catch (thrown) {
          options.report?.(thrown);
          error = 'could not be run';
        }
      }

      const afterRead = await options.reader.inventory(request.providerId, profile.id, { fresh: true });
      const ran = {
        display: plan.display,
        ...(exitCode === undefined ? {} : { exitCode }),
      };
      if ('status' in afterRead) {
        return receipt(profile.id, {
          ...ran,
          status: 'failed',
          message:
            error === undefined
              ? `it ran, but ${entry.provider.label} could not be read again to confirm: ${afterRead.message}`
              : `${plan.display} ${error}`,
        });
      }
      const after = find(afterRead, request.target);
      const done =
        request.act === 'remove'
          ? after === undefined
          : after !== undefined && after.enabled === (request.act === 'enable');
      if (done && (request.act === 'remove' || before.enabled !== after!.enabled)) {
        return receipt(profile.id, {
          ...ran,
          status: 'changed',
          message: `${DONE[request.act]}${error === undefined ? '' : `, though ${plan.display} ${error}`}`,
        });
      }
      if (error !== undefined)
        return receipt(profile.id, { ...ran, status: 'failed', message: `${plan.display} ${error}` });
      return receipt(profile.id, {
        ...ran,
        status: 'unchanged',
        message:
          after === undefined
            ? 'no longer there'
            : `${entry.provider.label} still holds it ${after.enabled ? 'on' : 'off'}`,
      });
    },
  };
}

function find(inventory: ExtensionInventory, target: ExtensionActTarget): McpServerItem | SkillItem | undefined {
  const item = inventory.items.find((candidate) => candidate.kind === target.kind && candidate.id === target.id);
  return item?.kind === 'mcp-server' || item?.kind === 'skill' ? item : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
