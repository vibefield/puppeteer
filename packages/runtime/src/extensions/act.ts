import { stat } from 'node:fs/promises';
import {
  describeMcpDefinition,
  ExtensionActPlanSchema,
  ExtensionActReceiptSchema,
  type AgentHost,
  type AgentProfile,
  type AvailableExtensionActPlan,
  type ExtensionActKind,
  type ExtensionActPlan,
  type ExtensionActReceipt,
  type ExtensionActTarget,
  type ExtensionFailure,
  type ExtensionInventory,
  type ExtensionReach,
  type McpServerDefinition,
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
 *
 * A sign-in is the one act a person answers — the agent's own login opens a
 * browser and may ask for a pasted code — so its plan runs in a terminal of
 * the host's: `start` opens it, the host says when it ended, and `settle`
 * reads the agent again for the receipt.
 *
 * An add gives the agent a server it does not hold, from a definition the host
 * keeps: the fresh read must find no server by that name (an agent's add
 * replaces one), the adapter plans from the server as the agent would hold
 * it, and the second read holding it is the receipt.
 */

/** An act is one small edit of the agent's own config: one that hangs is ended. */
const ACT_TIMEOUT_MS = 2 * 60_000;

export interface ExtensionActRequest {
  providerId: string;
  /** The native default's when none is named. */
  profileId?: string;
  /** For `add`, the server's name as the target's id. */
  target: ExtensionActTarget;
  act: ExtensionActKind;
  /** What an `add` gives the agent; only with `add`. */
  definition?: McpServerDefinition;
  /** Opaque display text as it arrives; never parsed. */
  onOutput?: (chunk: string) => void;
  /** Aborting stops the act and everything it started. */
  signal?: AbortSignal;
}

/** A terminal act's request: the person answers it in the terminal, so nothing streams here. */
export type ExtensionTerminalActRequest = Omit<ExtensionActRequest, 'onOutput' | 'signal'>;

/** A terminal act the host is running: what `settle` needs once the host says it ended. */
export interface StartedExtensionAct {
  /** The host's terminal, as its `spawnTerminal` named it. */
  runtimeSessionId: string;
  providerId: string;
  profileId: string;
  target: ExtensionActTarget;
  act: ExtensionActKind;
  /** What runs, as a person reads it. */
  display: string;
  reaches: ExtensionReach[];
  startedAt: string;
  /** The item as the read the plan came from found it (none for an add): the receipt compares against it. */
  before?: McpServerItem | SkillItem;
}

/** How a terminal act's terminal ended, as the host saw it; nothing when the host stopped waiting. */
export interface ExtensionActEnd {
  /** Its exit code; null when a signal ended it. */
  exitCode?: number | null;
  /** The host ended it because the person cancelled: its exit is not the agent refusing. */
  stopped?: boolean;
}

export interface ExtensionActRunnerOptions {
  providers: ReadonlyMap<string, ExtensionProviderEntry>;
  reader: ExtensionInventoryReader;
  resolveProfile(providerId: string, profileId: string): Promise<{ profile: AgentProfile } | { error: string }>;
  nativeDefaultProfileId(providerId: string): string | undefined;
  /** Injected so tests never run an agent. */
  run?: UpdateCommandRunner;
  /** The host a terminal act opens its terminal in; without one, a terminal act cannot start. */
  host?: AgentHost;
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
    /**
     * Servers a host would give the agent, by name: each one's add, planned
     * against `items` (a name the agent already holds answers `held`).
     */
    adds?: ReadonlyArray<{ name: string; definition: McpServerDefinition }>;
  }): Promise<ExtensionActPlan[] | ExtensionFailure>;
  /** Runs an act whose plan needs no terminal: a command or a protocol call. */
  run(request: ExtensionActRequest): Promise<ExtensionActReceipt>;
  /**
   * Opens an act whose plan runs in a terminal the person answers (a sign-in)
   * in the host's terminal, planned from a fresh read. Its receipt waits for
   * `settle`; an act that cannot start answers with its receipt now.
   */
  start(request: ExtensionTerminalActRequest): Promise<StartedExtensionAct | ExtensionActReceipt>;
  /** The host's terminal ended (or the host stopped waiting): read the agent again for the receipt. */
  settle(started: StartedExtensionAct, ended?: ExtensionActEnd): Promise<ExtensionActReceipt>;
}

const SERVER_ACTS: readonly ExtensionActKind[] = ['enable', 'disable', 'remove', 'sign-in', 'sign-out'];
const SKILL_ACTS: readonly ExtensionActKind[] = ['enable', 'disable', 'remove'];

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
  'sign-in': 'signed in',
  'sign-out': 'signed out',
  add: 'added',
};

const signs = (act: ExtensionActKind): boolean => act === 'sign-in' || act === 'sign-out';

/**
 * What the second read says an act did, beside what the agent answered when
 * it ran (`error`). A switch is done when the read shows it switched, a
 * removal when the item is gone, an add when it is there, a sign-in or
 * sign-out when the agent says so — and an agent that keeps its sign-ins
 * where no read looks leaves it unconfirmed.
 */
function outcome(
  act: ExtensionActKind,
  label: string,
  before: McpServerItem | SkillItem | undefined,
  after: McpServerItem | SkillItem | undefined,
  display: string,
  error: string | undefined,
): Pick<ExtensionActReceipt, 'status' | 'message'> {
  const done = (message: string): Pick<ExtensionActReceipt, 'status' | 'message'> => ({
    status: 'changed',
    message: `${message}${error === undefined ? '' : `, though ${display} ${error}`}`,
  });
  const refused = { status: 'failed' as const, message: `${display} ${error}` };
  if (act === 'add' || before === undefined) {
    if (after !== undefined) return done(DONE.add);
    if (error !== undefined) return refused;
    return { status: 'unchanged', message: `${label} does not hold it` };
  }
  if (signs(act)) {
    const was = before.kind === 'mcp-server' ? before.auth : undefined;
    const is = after?.kind === 'mcp-server' ? after.auth : undefined;
    if (after !== undefined && is === undefined) {
      return error === undefined
        ? { status: 'unconfirmed', message: `${label} says whether it is signed in only inside a session` }
        : refused;
    }
    const goal = act === 'sign-in' ? 'signed-in' : 'needs-sign-in';
    if (is === goal && was !== goal) return done(DONE[act]);
    if (error !== undefined) return refused;
    return {
      status: 'unchanged',
      message:
        after === undefined
          ? 'no longer there'
          : is === 'signed-in'
            ? `${label} still holds a sign-in`
            : `${label} still asks you to sign in`,
    };
  }
  const switched = act === 'remove' ? after === undefined : after !== undefined && after.enabled === (act === 'enable');
  if (switched && (act === 'remove' || before.enabled !== after!.enabled)) return done(DONE[act]);
  if (error !== undefined) return refused;
  return {
    status: 'unchanged',
    message: after === undefined ? 'no longer there' : `${label} still holds it ${after.enabled ? 'on' : 'off'}`,
  };
}

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
    const item =
      request.act === 'add' ? ownServerNamed(inventory.items, request.target.id) : find(inventory, request.target);
    return { profile: resolved.profile, entry, item };
  }

  function planFor(
    located: Exclude<Located, { failure: ExtensionFailure }>,
    request: ExtensionActRequest | Omit<ExtensionActRequest, 'onOutput' | 'signal'>,
  ): ExtensionActPlan | ExtensionFailure {
    const { entry, profile, item } = located;
    if (request.act === 'add') {
      return planAdd(located, request.providerId, request.target, request.definition, item !== undefined);
    }
    if (item === undefined) {
      return {
        target: request.target,
        act: request.act,
        available: false,
        reason: 'not-held',
        message: `${entry.provider.label} does not hold ${request.target.id} in this profile`,
      };
    }
    if (item.kind === 'skill' && signs(request.act)) {
      return {
        target: request.target,
        act: request.act,
        available: false,
        reason: 'no-sign-in',
        message: 'a skill has no sign-in',
      };
    }
    return answered(entry, profile, item, request.act, request.providerId);
  }

  /**
   * An add, planned from the server as the agent would hold it once added —
   * only for a server, from its definition, on an agent that has servers and
   * holds none of its own by that name (the agent's add would replace it).
   */
  function planAdd(
    located: Exclude<Located, { failure: ExtensionFailure }>,
    providerId: string,
    target: ExtensionActTarget,
    definition: McpServerDefinition | undefined,
    held: boolean,
  ): ExtensionActPlan | ExtensionFailure {
    const { entry, profile } = located;
    const label = entry.provider.label;
    const unavailable = (reason: 'held' | 'unsupported', message: string): ExtensionActPlan => ({
      target,
      act: 'add',
      available: false,
      reason,
      message,
    });
    if (target.kind !== 'mcp-server') return unavailable('unsupported', 'only a server is added from a definition');
    if (definition === undefined) return failure('invalid', providerId, "an add needs the server's definition");
    if (entry.provider.support.mcpServers === undefined)
      return unavailable('unsupported', `${label} has no MCP servers`);
    if (held) return unavailable('held', `${label} already has a server named ${target.id}`);
    const server: McpServerItem = {
      kind: 'mcp-server',
      id: target.id,
      name: target.id,
      origin: 'own',
      enabled: true,
      transport: definition.transport,
      target: describeMcpDefinition(definition),
      ...(definition.transport === 'stdio' && definition.env !== undefined ? { env: [...definition.env] } : {}),
      definition,
    };
    return answered(entry, profile, server, 'add', providerId);
  }

  /** The adapter's answer for one item and act, checked against the schema and against what was asked. */
  function answered(
    entry: ExtensionProviderEntry,
    profile: AgentProfile,
    item: McpServerItem | SkillItem,
    act: ExtensionActKind,
    providerId: string,
  ): ExtensionActPlan | ExtensionFailure {
    let answer: unknown;
    try {
      answer = entry.service.plan!(profile, item, act);
    } catch (error) {
      options.report?.(error);
      return failure('invalid', providerId, `${entry.provider.label} could not plan the act`);
    }
    const parsed = ExtensionActPlanSchema.safeParse(answer);
    if (
      !parsed.success ||
      parsed.data.act !== act ||
      parsed.data.target.kind !== item.kind ||
      parsed.data.target.id !== item.id
    ) {
      return failure('invalid', providerId, `${entry.provider.label} answered with a malformed act plan`);
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

  type ReceiptFields = Pick<ExtensionActReceipt, 'status' | 'message'> & Partial<ExtensionActReceipt>;

  /** A receipt checked against its schema: one that fails it is reported, and says so. */
  function assemble(
    base: Pick<ExtensionActReceipt, 'provider' | 'target' | 'act' | 'startedAt'>,
    profileId: string,
    fields: ReceiptFields,
  ): ExtensionActReceipt {
    const candidate = { ...base, profileId, finishedAt: now().toISOString(), ...fields };
    const parsed = ExtensionActReceiptSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    options.report?.(new Error(`act receipt for ${base.provider} failed schema validation`));
    return {
      ...base,
      profileId,
      finishedAt: now().toISOString(),
      status: 'failed',
      message: 'the act receipt could not be assembled',
    };
  }

  /** The second read, and what it says the act did. */
  async function readBack(
    providerId: string,
    profileId: string,
    label: string,
    ran: {
      act: ExtensionActKind;
      target: ExtensionActTarget;
      before?: McpServerItem | SkillItem;
      display: string;
      error: string | undefined;
    },
  ): Promise<Pick<ExtensionActReceipt, 'status' | 'message'>> {
    const afterRead = await options.reader.inventory(providerId, profileId, { fresh: true });
    if ('status' in afterRead) {
      return {
        status: 'failed',
        message:
          ran.error === undefined
            ? `it ran, but ${label} could not be read again to confirm: ${afterRead.message}`
            : `${ran.display} ${ran.error}`,
      };
    }
    return outcome(ran.act, label, ran.before, find(afterRead, ran.target), ran.display, ran.error);
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
      if (target === undefined)
        return failure('unsupported', providerId, `${providerId} has no native default profile`);
      const resolved = await options.resolveProfile(providerId, target);
      if ('error' in resolved) return failure('not-found', providerId, resolved.error);
      const located = { profile: resolved.profile, entry };
      const plans: ExtensionActPlan[] = [];
      for (const item of request.items) {
        for (const act of item.kind === 'mcp-server' ? SERVER_ACTS : SKILL_ACTS) {
          const plan = planFor({ ...located, item }, { providerId, target: { kind: item.kind, id: item.id }, act });
          // one malformed answer is reported and left out; the rest stand
          if (!('status' in plan)) plans.push(plan);
        }
      }
      for (const { name, definition } of request.adds ?? []) {
        const target = { kind: 'mcp-server' as const, id: name };
        const plan = planAdd(
          { ...located, item: undefined },
          providerId,
          target,
          definition,
          ownServerNamed(request.items, name) !== undefined,
        );
        if (!('status' in plan)) plans.push(plan);
      }
      return plans;
    },

    async run(request) {
      const base = {
        provider: request.providerId,
        target: request.target,
        act: request.act,
        startedAt: now().toISOString(),
      };
      const receipt = (profileId: string, fields: ReceiptFields): ExtensionActReceipt =>
        assemble(base, profileId, fields);
      const profileId = request.profileId ?? options.nativeDefaultProfileId(request.providerId) ?? 'unknown';

      const located = await locate(request);
      if ('failure' in located) return receipt(profileId, { status: 'failed', message: located.failure.message });
      const plan = planFor(located, request);
      if ('status' in plan) return receipt(located.profile.id, { status: 'failed', message: plan.message });
      if (!plan.available) return receipt(located.profile.id, { status: 'unavailable', message: plan.message });

      const { profile, entry } = located;
      if (plan.runs.kind === 'terminal') {
        // the person answers it: only a terminal of the host's runs it (`start`)
        return receipt(profile.id, {
          status: 'failed',
          display: plan.display,
          message: `${plan.display} runs in a terminal the person answers`,
        });
      }
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

      const ran = {
        display: plan.display,
        ...(exitCode === undefined ? {} : { exitCode }),
      };
      return receipt(profile.id, {
        ...ran,
        ...(await readBack(request.providerId, profile.id, entry.provider.label, {
          act: request.act,
          target: request.target,
          ...(request.act === 'add' || located.item === undefined ? {} : { before: located.item }),
          display: plan.display,
          error,
        })),
      });
    },

    async start(request) {
      const base = {
        provider: request.providerId,
        target: request.target,
        act: request.act,
        startedAt: now().toISOString(),
      };
      const receipt = (profileId: string, fields: ReceiptFields): ExtensionActReceipt =>
        assemble(base, profileId, fields);
      const profileId = request.profileId ?? options.nativeDefaultProfileId(request.providerId) ?? 'unknown';

      const located = await locate(request);
      if ('failure' in located) return receipt(profileId, { status: 'failed', message: located.failure.message });
      const plan = planFor(located, request);
      if ('status' in plan) return receipt(located.profile.id, { status: 'failed', message: plan.message });
      if (!plan.available) return receipt(located.profile.id, { status: 'unavailable', message: plan.message });

      const { profile } = located;
      if (plan.runs.kind !== 'terminal') {
        return receipt(profile.id, {
          status: 'failed',
          display: plan.display,
          message: `${plan.display} runs without a terminal`,
        });
      }
      if (options.host === undefined) {
        return receipt(profile.id, {
          status: 'failed',
          display: plan.display,
          message: 'there is no terminal to run it in',
        });
      }
      const [command, ...args] = plan.runs.argv;
      // The agent's own folder, never a project, as a command act's is.
      const cwd = (await isDirectory(profile.dataRoot)) ? profile.dataRoot : (processEnv.HOME ?? process.cwd());
      try {
        const { runtimeSessionId } = await options.host.spawnTerminal({
          command: command!,
          args,
          cwd,
          ...(plan.runs.env === undefined ? {} : { env: { ...plan.runs.env } }),
        });
        return {
          runtimeSessionId,
          providerId: request.providerId,
          profileId: profile.id,
          target: request.target,
          act: request.act,
          display: plan.display,
          reaches: [...plan.reaches],
          startedAt: base.startedAt,
          ...(request.act === 'add' || located.item === undefined ? {} : { before: located.item }),
        };
      } catch (error) {
        options.report?.(error);
        return receipt(profile.id, {
          status: 'failed',
          display: plan.display,
          message: `${plan.display} could not be started`,
        });
      }
    },

    async settle(started, ended = {}) {
      const base = {
        provider: started.providerId,
        target: started.target,
        act: started.act,
        startedAt: started.startedAt,
      };
      const label = options.providers.get(started.providerId)?.provider.label ?? started.providerId;
      // a terminal the person cancelled ended because they asked, not because the agent refused
      const error =
        ended.stopped === true || ended.exitCode === undefined || ended.exitCode === 0
          ? undefined
          : ended.exitCode === null
            ? 'did not run to completion'
            : `exited with ${ended.exitCode}`;
      return assemble(base, started.profileId, {
        display: started.display,
        ...(typeof ended.exitCode === 'number' ? { exitCode: ended.exitCode } : {}),
        ...(await readBack(started.providerId, started.profileId, label, {
          act: started.act,
          target: started.target,
          ...(started.before === undefined ? {} : { before: started.before }),
          display: started.display,
          error,
        })),
      });
    },
  };
}

/** The agent's own server by that name or key: what an add would replace. */
function ownServerNamed(
  items: ReadonlyArray<ExtensionInventory['items'][number]>,
  name: string,
): McpServerItem | undefined {
  return items.find(
    (item): item is McpServerItem =>
      item.kind === 'mcp-server' && item.origin === 'own' && (item.name === name || item.id === name),
  );
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
