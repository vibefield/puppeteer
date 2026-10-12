import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CatalogPlugin,
  describeMcpDefinition,
  EXTENSION_SKILL_FOLDER_NAME,
  ExtensionActPlanSchema,
  ExtensionActReceiptSchema,
  isExtensionSource,
  type AgentHost,
  type AgentProfile,
  type AvailableExtensionActPlan,
  type ExtensionActItem,
  type ExtensionActKind,
  type ExtensionActPlan,
  type ExtensionActPlanOptions,
  type ExtensionActReceipt,
  type ExtensionActTarget,
  type ExtensionFailure,
  type ExtensionInventory,
  type ExtensionReach,
  isNormalizedAbsolutePath,
  type MarketplaceItem,
  type McpServerDefinition,
  type McpServerItem,
  type PluginItem,
  type SkillItem,
} from '@vibefield/puppeteer-core';
import { runUpdateCommand, type UpdateCommandResult, type UpdateCommandRunner } from '../distribution/update.js';
import { buildAgentEnvironment } from '../host/environment.js';
import type { ExtensionCatalogReader } from './catalog.js';
import { performFileSteps } from './files.js';
import type { ExtensionInventoryReader, ExtensionProviderEntry } from './inventory.js';

/**
 * RFC 006 C2: an act on one server, skill or plugin a profile's agent holds —
 * turned on, turned off or removed, a plugin also updated or removed with its
 * data — through the agent's own command or protocol.
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
 *
 * A skill the host keeps is placed where the agent looks for skills: the
 * adapter plans the folder's steps (a link, a link taken away, the agent's own
 * folder moved to where the host keeps it) and the runtime performs them
 * itself, checking each (./files.ts); the second read is the receipt here too.
 *
 * An install takes a plugin the agent does not hold: one its marketplaces list
 * (a fresh read of its catalog must list it), or one from a source a person
 * gives, where the agent installs from sources. A marketplace is added from a
 * source, fetched again (`update`) or removed. The receipt of an install or an
 * add is the second read holding it — by its id, or as the one plugin or
 * marketplace the first read did not have; of a fetch, the marketplace's time
 * moving.
 */

/** An act is one small edit of the agent's own config: one that hangs is ended. */
const ACT_TIMEOUT_MS = 2 * 60_000;
/**
 * An install, an update, and a marketplace's add or fetch go to the network —
 * a clone, a package manager, dependencies — and take longer before one is
 * called hung.
 */
const FETCH_TIMEOUT_MS = 15 * 60_000;
const timeoutOf = (act: ExtensionActKind): number =>
  act === 'install' || act === 'update' || act === 'add' ? FETCH_TIMEOUT_MS : ACT_TIMEOUT_MS;

export interface ExtensionActRequest {
  providerId: string;
  /** The native default's when none is named. */
  profileId?: string;
  /**
   * For `add`, the server's or the skill's name as the target's id — or a
   * marketplace's source; for `install`, the catalog's id for the plugin, or
   * the source a person gave.
   */
  target: ExtensionActTarget;
  act: ExtensionActKind;
  /** What an `add` gives the agent; only with `add`. */
  definition?: McpServerDefinition;
  /**
   * For a plugin's `install` from a source a person gave (a package, a
   * repository, a folder), and a marketplace's `add`: that source, as
   * `isExtensionSource` allows; the target's id is the same string.
   */
  source?: string;
  /**
   * A skill's folder, absolute: for `add`, the one copy the host keeps, which
   * the agent is given a link to; for `remove`, where the host keeps the
   * agent's own folder instead of leaving it.
   */
  folder?: string;
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
  before?: ExtensionActItem;
  /** For an install or a marketplace's add: the ids of that kind the agent held before, so the one it gained is known. */
  known?: string[];
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
  /** The catalogs an install from a marketplace is found in; without one, only a source installs. */
  catalogs?: ExtensionCatalogReader;
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
    items: ReadonlyArray<ExtensionActItem>;
    /**
     * Servers a host would give the agent, by name: each one's add, planned
     * against `items` (a name the agent already holds answers `held`).
     */
    adds?: ReadonlyArray<{ name: string; definition: McpServerDefinition }>;
    /** Skills a host would give the agent, by name, each from the folder it keeps: each one's link. */
    skills?: ReadonlyArray<{ name: string; folder: string }>;
    /**
     * Plugins the agent's catalog lists, as a host offers them: each one's
     * install, planned against `items` (a plugin the agent holds answers `held`).
     */
    installs?: ReadonlyArray<CatalogPlugin>;
    /**
     * Sources a person gave, as a host offers them before anything runs: each
     * plugin source's install and each marketplace source's add, planned
     * against `items` — never a read of their own.
     */
    sources?: { plugins?: readonly string[]; marketplaces?: readonly string[] };
    /**
     * The folder a host keeps skills in: a skill of the agent's own that is a
     * real folder is planned to move to `<keep>/<name>` when it goes.
     */
    keep?: string;
    /** Plan only the offers (adds, installs, sources); `items` then only say what the agent holds. */
    offersOnly?: boolean;
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

const ACTS: Record<ExtensionActItem['kind'], readonly ExtensionActKind[]> = {
  'mcp-server': ['enable', 'disable', 'remove', 'sign-in', 'sign-out'],
  skill: ['enable', 'disable', 'remove'],
  plugin: ['enable', 'disable', 'remove', 'purge', 'update'],
  marketplace: ['update', 'remove'],
};

type Located =
  | { failure: ExtensionFailure }
  | {
      profile: AgentProfile;
      entry: ExtensionProviderEntry;
      item: ExtensionActItem | undefined;
      /** For an install from a catalog: the entry that lists it. */
      listed?: CatalogPlugin;
      /** For an install or a marketplace's add: the ids of that kind the agent holds now. */
      known?: string[];
      /** For a marketplace's fetch: the versions of the plugins installed from it, by id. */
      versions?: Record<string, string>;
    };

const DONE: Record<ExtensionActKind, string> = {
  enable: 'turned on',
  disable: 'turned off',
  remove: 'removed',
  'sign-in': 'signed in',
  'sign-out': 'signed out',
  add: 'added',
  update: 'updated',
  purge: 'removed with its data',
  install: 'installed',
};

const signs = (act: ExtensionActKind): boolean => act === 'sign-in' || act === 'sign-out';

/**
 * What the second read says an act did, beside what the agent answered when
 * it ran (`error`). A switch is done when the read shows it switched, a
 * removal when the item is gone, an add when it is there, an update when the
 * version moved, a sign-in or sign-out when the agent says so — and an agent
 * that keeps its sign-ins where no read looks leaves it unconfirmed.
 */
function outcome(
  act: ExtensionActKind,
  label: string,
  before: ExtensionActItem | undefined,
  after: ExtensionActItem | undefined,
  display: string,
  error: string | undefined,
): Pick<ExtensionActReceipt, 'status' | 'message'> {
  // a files plan's error is a whole clause; a command's follows the command it names
  const said = (why: string | undefined) => (display === '' ? `${why}` : `${display} ${why}`);
  const done = (message: string): Pick<ExtensionActReceipt, 'status' | 'message'> => ({
    status: 'changed',
    message: `${message}${error === undefined ? '' : `, though ${said(error)}`}`,
  });
  const refused = { status: 'failed' as const, message: said(error) };
  if (act === 'add' || act === 'install' || before === undefined) {
    if (after !== undefined) {
      if (act !== 'install') return done(after.kind === 'marketplace' ? `added ${after.name}` : DONE.add);
      return done(after.kind === 'plugin' && after.version !== undefined ? `installed ${after.version}` : DONE.install);
    }
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
  if (act === 'update' && before.kind === 'marketplace') {
    // a catalog fetched again: the time the agent keeps for it moved
    const was = before.updatedAt;
    const is = after?.kind === 'marketplace' ? after.updatedAt : undefined;
    if (after !== undefined && is !== undefined && is !== was) return done('fetched its catalog again');
    if (error !== undefined) return refused;
    if (after === undefined) return { status: 'unchanged', message: 'no longer there' };
    return is === undefined
      ? { status: 'unconfirmed', message: `${label} does not say when it last fetched it` }
      : { status: 'unchanged', message: `${label} holds the catalog it had` };
  }
  if (act === 'update') {
    const was = before.kind === 'plugin' ? before.version : undefined;
    const is = after?.kind === 'plugin' ? after.version : undefined;
    if (after !== undefined && is !== was) {
      return done(was !== undefined && is !== undefined ? `updated ${was} → ${is}` : DONE.update);
    }
    if (error !== undefined) return refused;
    return {
      status: 'unchanged',
      message: after === undefined ? 'no longer there' : `${label} still holds ${is ?? 'the same version'}`,
    };
  }
  const removal = act === 'remove' || act === 'purge';
  const switched = removal ? after === undefined : after !== undefined && after.enabled === (act === 'enable');
  if (switched && (removal || before.enabled !== after!.enabled)) return done(DONE[act]);
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
    const profile = resolved.profile;
    const known = (kind: ExtensionActItem['kind']) =>
      inventory.items.filter((candidate) => candidate.kind === kind).map((candidate) => candidate.id);
    if (request.act === 'install' && request.target.kind === 'plugin') {
      const held = find(inventory, request.target);
      if (request.source !== undefined) return { profile, entry, item: held, known: known('plugin') };
      // from a marketplace: a fresh read of the agent's catalog must list it
      if (options.catalogs === undefined) {
        return {
          failure: failure('unsupported', providerId, `${entry.provider.label} has no catalog to install from`),
        };
      }
      const catalog = await options.catalogs.catalog(providerId, target, { fresh: true });
      if ('status' in catalog) return { failure: catalog };
      const listed = catalog.plugins.find((candidate) => candidate.id === request.target.id);
      if (listed === undefined) {
        return {
          failure: failure(
            'not-found',
            providerId,
            `no marketplace ${entry.provider.label} knows lists ${request.target.id} in this profile`,
          ),
        };
      }
      // the agent's own record can name what it installed from an entry its own way
      const heldFrom =
        held ?? (listed.held === undefined ? undefined : find(inventory, { kind: 'plugin', id: listed.held }));
      return { profile, entry, item: heldFrom, listed, known: known('plugin') };
    }
    if (request.act === 'add' && request.target.kind === 'marketplace') {
      const held = inventory.items.find(
        (candidate): candidate is MarketplaceItem =>
          candidate.kind === 'marketplace' &&
          (candidate.id === request.target.id || candidate.source === request.target.id),
      );
      return { profile, entry, item: held, known: known('marketplace') };
    }
    const item =
      request.act !== 'add'
        ? find(inventory, request.target)
        : request.target.kind === 'skill'
          ? ownSkillNamed(inventory.items, request.target.id)
          : request.target.kind === 'mcp-server'
            ? ownServerNamed(inventory.items, request.target.id)
            : undefined;
    if (request.act === 'update' && request.target.kind === 'marketplace') {
      // an agent's fetch may update the plugins installed from it too: the receipt says so
      return { profile, entry, item, versions: versionsFrom(inventory, request.target.id) };
    }
    return { profile, entry, item };
  }

  function planFor(
    located: Exclude<Located, { failure: ExtensionFailure }>,
    request: ExtensionActRequest | Omit<ExtensionActRequest, 'onOutput' | 'signal'>,
  ): ExtensionActPlan | ExtensionFailure {
    const { entry, profile, item } = located;
    const unavailable = (reason: 'unsupported' | 'no-sign-in', message: string): ExtensionActPlan => ({
      target: request.target,
      act: request.act,
      available: false,
      reason,
      message,
    });
    if (request.act === 'install') {
      if (request.target.kind !== 'plugin') return unavailable('unsupported', 'only a plugin is installed');
      return planInstall(located, request.providerId, request.target, request.source);
    }
    if (request.target.kind === 'marketplace') {
      if (request.act === 'add') return planMarketplaceAdd(located, request.providerId, request.target, request.source);
      if (request.act !== 'update' && request.act !== 'remove') {
        return unavailable('unsupported', 'a marketplace is added, fetched again or removed');
      }
    }
    if (request.act === 'add') {
      if (request.target.kind === 'plugin') {
        // an agent installs a plugin its own way (a marketplace, a package, a folder): not an add
        return unavailable('unsupported', 'only a server or a skill is added; a plugin is installed');
      }
      return request.target.kind === 'skill'
        ? planSkillAdd(located, request.providerId, request.target, request.folder, item !== undefined)
        : planAdd(located, request.providerId, request.target, request.definition, item !== undefined);
    }
    // a removal that takes the data too is a plugin's alone; an update a plugin's or a marketplace's (above)
    if (request.act === 'purge' && request.target.kind !== 'plugin') {
      return unavailable('unsupported', 'only a plugin is removed with its data');
    }
    if (request.act === 'update' && request.target.kind !== 'plugin' && request.target.kind !== 'marketplace') {
      return unavailable('unsupported', 'only a plugin is updated');
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
    if (item.kind !== 'mcp-server' && signs(request.act))
      return unavailable('no-sign-in', `a ${item.kind} has no sign-in`);
    if (item.kind === 'marketplace' && !ACTS.marketplace.includes(request.act))
      return unavailable('unsupported', 'a marketplace is added, fetched again or removed');
    const planOptions: ExtensionActPlanOptions =
      item.kind === 'skill' && request.act === 'remove' && request.folder !== undefined
        ? { keepIn: request.folder }
        : {};
    if (planOptions.keepIn !== undefined && !isNormalizedAbsolutePath(planOptions.keepIn)) {
      return failure('invalid', request.providerId, 'a skill is kept only in an absolute folder');
    }
    return answered(entry, profile, item, request.act, request.providerId, planOptions);
  }

  /**
   * A skill's add, planned from the skill as the agent would hold it once
   * placed — a link to the folder the host keeps — on an agent that has skills
   * and holds none of its own by that name (the link would go where it is).
   */
  function planSkillAdd(
    located: Exclude<Located, { failure: ExtensionFailure }>,
    providerId: string,
    target: ExtensionActTarget,
    folder: string | undefined,
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
    if (folder === undefined || !isNormalizedAbsolutePath(folder)) {
      return failure('invalid', providerId, "a skill's add needs the absolute folder the host keeps it in");
    }
    if (entry.provider.support.skills === undefined) return unavailable('unsupported', `${label} has no skills`);
    if (held) return unavailable('held', `${label} already has a skill named ${target.id}`);
    const skill: SkillItem = {
      kind: 'skill',
      id: target.id,
      name: target.id,
      origin: 'own',
      enabled: true,
      linkTarget: folder,
    };
    return answered(entry, profile, skill, 'add', providerId);
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

  /**
   * An install, planned from the plugin as the agent would hold it once
   * installed: from the catalog entry that lists it, or named by the source a
   * person gave — only for an agent that installs from sources — and only
   * when the agent holds none by that id.
   */
  function planInstall(
    located: Exclude<Located, { failure: ExtensionFailure }>,
    providerId: string,
    target: ExtensionActTarget,
    source: string | undefined,
  ): ExtensionActPlan | ExtensionFailure {
    const { entry, profile, item: held, listed } = located;
    const label = entry.provider.label;
    const unavailable = (reason: 'held' | 'unsupported' | 'blocked', message: string): ExtensionActPlan => ({
      target,
      act: 'install',
      available: false,
      reason,
      message,
    });
    const support = entry.provider.support.plugins;
    if (source !== undefined && (!isExtensionSource(source) || source !== target.id)) {
      return failure('invalid', providerId, 'a source is one line naming a package, a repository or a folder');
    }
    if (support === undefined) return unavailable('unsupported', `${label} has no plugins`);
    if (source !== undefined && support.sources === undefined) {
      return unavailable('unsupported', `${label} installs plugins only from its marketplaces`);
    }
    if (source === undefined && listed === undefined) {
      return failure('invalid', providerId, 'an install needs the catalog entry that lists it, or a source');
    }
    if (held !== undefined || listed?.held !== undefined) {
      return unavailable('held', `${label} already has ${held?.name ?? listed!.name}`);
    }
    if (listed?.blocked !== undefined) return unavailable('blocked', listed.blocked);
    const plugin: PluginItem =
      listed === undefined || source !== undefined
        ? { kind: 'plugin', id: target.id, name: target.id, origin: 'own', enabled: true }
        : {
            kind: 'plugin',
            id: listed.id,
            name: listed.name,
            origin: 'own',
            enabled: true,
            marketplace: listed.marketplace,
            ...(listed.version === undefined ? {} : { version: listed.version }),
            ...(listed.description === undefined ? {} : { description: listed.description }),
            ...(listed.author === undefined ? {} : { author: listed.author }),
            ...(listed.homepage === undefined ? {} : { homepage: listed.homepage }),
          };
    return answered(
      entry,
      profile,
      plugin,
      'install',
      providerId,
      source === undefined ? { ...(listed === undefined ? {} : { listed }) } : { source, holds: located.known ?? [] },
    );
  }

  /**
   * A marketplace's add, planned from the marketplace as the agent would hold
   * it once added — named by its source until the agent reads its own name
   * from the catalog — only when the agent holds none from that source.
   */
  function planMarketplaceAdd(
    located: Exclude<Located, { failure: ExtensionFailure }>,
    providerId: string,
    target: ExtensionActTarget,
    source: string | undefined,
  ): ExtensionActPlan | ExtensionFailure {
    const { entry, profile, item: held } = located;
    const label = entry.provider.label;
    if (source === undefined || !isExtensionSource(source) || source !== target.id) {
      return failure(
        'invalid',
        providerId,
        "a marketplace's add needs its source: one line naming a repository, an address or a folder",
      );
    }
    const unavailable = (reason: 'held' | 'unsupported', message: string): ExtensionActPlan => ({
      target,
      act: 'add',
      available: false,
      reason,
      message,
    });
    if (entry.provider.support.marketplaces === undefined)
      return unavailable('unsupported', `${label} has no marketplaces`);
    if (held !== undefined) return unavailable('held', `${label} already has ${held.name}`);
    const marketplace: MarketplaceItem = {
      kind: 'marketplace',
      id: source,
      name: source,
      origin: 'own',
      enabled: true,
      source,
    };
    return answered(entry, profile, marketplace, 'add', providerId);
  }

  /** The adapter's answer for one item and act, checked against the schema and against what was asked. */
  function answered(
    entry: ExtensionProviderEntry,
    profile: AgentProfile,
    item: ExtensionActItem,
    act: ExtensionActKind,
    providerId: string,
    planOptions: ExtensionActPlanOptions = {},
  ): ExtensionActPlan | ExtensionFailure {
    let answer: unknown;
    try {
      answer = entry.service.plan!(profile, item, act, planOptions);
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
        timeoutMs: timeoutOf(plan.act),
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
      before?: ExtensionActItem;
      display: string;
      error: string | undefined;
      /** Where a skill's steps placed it: an agent that names skills by their own words still holds it there. */
      placed?: ReadonlySet<string>;
      /** For an install or a marketplace's add: the ids of that kind the agent held before. */
      known?: readonly string[];
      /** For a marketplace's fetch: the versions of the plugins installed from it before. */
      versions?: Readonly<Record<string, string>>;
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
    const after =
      ran.act === 'install' || (ran.act === 'add' && ran.target.kind === 'marketplace')
        ? gained(afterRead, ran.target, ran.known)
        : ran.act === 'add' && ran.target.kind === 'skill'
          ? (ownSkillNamed(afterRead.items, ran.target.id) ??
            afterRead.items.find(
              (item): item is SkillItem =>
                item.kind === 'skill' &&
                item.origin === 'own' &&
                item.location !== undefined &&
                ran.placed?.has(item.location) === true,
            ))
          : find(afterRead, ran.target);
    // an install from a folder of several plugins gains each of them: the receipt names them all
    if (ran.act === 'install' && ran.known !== undefined && find(afterRead, ran.target) === undefined) {
      const known = ran.known;
      const fresh = afterRead.items.filter((item) => item.kind === 'plugin' && !known.includes(item.id));
      if (fresh.length > 1) {
        return {
          status: 'changed',
          message: `installed ${fresh.map((item) => item.name).join(', ')}${ran.error === undefined ? '' : `, though ${ran.display} ${ran.error}`}`,
        };
      }
    }
    const said = outcome(ran.act, label, ran.before, after, ran.display, ran.error);
    if (ran.versions === undefined) return said;
    // what else the fetch changed: the plugins installed from it whose version moved
    const now = versionsFrom(afterRead, ran.target.id);
    const moved = Object.entries(ran.versions)
      .filter(([id, version]) => now[id] !== undefined && now[id] !== version)
      .map(([id, version]) => `${nameOf(afterRead, id)} ${version} → ${now[id]}`);
    return moved.length === 0
      ? said
      : { ...said, message: `${said.message}; ${label} also updated ${moved.join(', ')}` };
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
      // a real folder of the agent's own moves to where the host keeps skills, under its name
      const keepIn = (item: ExtensionActItem, act: ExtensionActKind): { folder?: string } =>
        request.keep !== undefined &&
        item.kind === 'skill' &&
        act === 'remove' &&
        item.linkTarget === undefined &&
        EXTENSION_SKILL_FOLDER_NAME.test(item.name)
          ? { folder: join(request.keep, item.name) }
          : {};
      for (const item of request.offersOnly === true ? [] : request.items) {
        for (const act of ACTS[item.kind]) {
          const plan = planFor(
            { ...located, item },
            { providerId, target: { kind: item.kind, id: item.id }, act, ...keepIn(item, act) },
          );
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
      for (const { name, folder } of request.skills ?? []) {
        const target = { kind: 'skill' as const, id: name };
        const plan = planSkillAdd(
          { ...located, item: undefined },
          providerId,
          target,
          folder,
          ownSkillNamed(request.items, name) !== undefined,
        );
        if (!('status' in plan)) plans.push(plan);
      }
      const knownOf = (kind: 'plugin' | 'marketplace') =>
        request.items.filter((candidate) => candidate.kind === kind).map((candidate) => candidate.id);
      for (const source of request.sources?.plugins ?? []) {
        const target = { kind: 'plugin' as const, id: source };
        const held = request.items.find(
          (candidate): candidate is PluginItem => candidate.kind === 'plugin' && candidate.id === source,
        );
        const plan = planInstall({ ...located, item: held, known: knownOf('plugin') }, providerId, target, source);
        if (!('status' in plan)) plans.push(plan);
      }
      for (const source of request.sources?.marketplaces ?? []) {
        const target = { kind: 'marketplace' as const, id: source };
        const held = request.items.find(
          (candidate): candidate is MarketplaceItem =>
            candidate.kind === 'marketplace' && (candidate.id === source || candidate.source === source),
        );
        const plan = planMarketplaceAdd({ ...located, item: held }, providerId, target, source);
        if (!('status' in plan)) plans.push(plan);
      }
      for (const listed of request.installs ?? []) {
        const held = request.items.find(
          (candidate): candidate is PluginItem =>
            candidate.kind === 'plugin' && (candidate.id === listed.id || candidate.id === listed.held),
        );
        const plan = planInstall(
          { ...located, item: held, listed },
          providerId,
          { kind: 'plugin', id: listed.id },
          undefined,
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
      let takeBack: (() => Promise<boolean>) | undefined;
      if (plan.runs.kind === 'files') {
        const result = await performFileSteps(plan.runs.steps, {
          ...(processEnv.HOME === undefined ? {} : { home: processEnv.HOME }),
          ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
          ...(options.report === undefined ? {} : { report: options.report }),
        });
        error = result.error;
        takeBack = result.undo;
      } else if (plan.runs.kind === 'command') {
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
      const read = await readBack(request.providerId, profile.id, entry.provider.label, {
        act: request.act,
        target: request.target,
        ...(request.act === 'add' || request.act === 'install' || located.item === undefined
          ? {}
          : { before: located.item }),
        ...(located.known === undefined ? {} : { known: located.known }),
        ...(located.versions === undefined ? {} : { versions: located.versions }),
        // a files plan's error names its step
        display: plan.runs.kind === 'files' ? '' : plan.display,
        error,
        ...(plan.runs.kind === 'files'
          ? {
              placed: new Set(
                plan.runs.steps.flatMap((step) =>
                  step.op === 'link' ? [step.path] : step.op === 'move' ? [step.to] : [],
                ),
              ),
            }
          : {}),
      });
      // A skill placed where the agent does not read it (a SKILL.md it skips) would sit
      // there and block the next try: its steps are taken back, and the receipt says so.
      if (request.act === 'add' && read.status === 'unchanged' && takeBack !== undefined) {
        const whole = await takeBack();
        return receipt(profile.id, {
          ...ran,
          status: 'unchanged',
          message: `${read.message}, so ${whole ? 'what was placed was taken back' : 'what was placed could not all be taken back'}`,
        });
      }
      return receipt(profile.id, { ...ran, ...read });
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
          ...(request.act === 'add' || request.act === 'install' || located.item === undefined
            ? {}
            : { before: located.item }),
          ...(located.known === undefined ? {} : { known: [...located.known] }),
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
          ...(started.known === undefined ? {} : { known: started.known }),
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

/** The agent's own skill by that name or key: where a link by that name would go, or one the agent reads already. */
function ownSkillNamed(items: ReadonlyArray<ExtensionInventory['items'][number]>, name: string): SkillItem | undefined {
  return items.find(
    (item): item is SkillItem =>
      item.kind === 'skill' && item.origin === 'own' && (item.name === name || item.id === name),
  );
}

/** The versions of the plugins installed from one marketplace, by id. */
function versionsFrom(inventory: ExtensionInventory, marketplace: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const item of inventory.items) {
    if (item.kind === 'plugin' && item.marketplace === marketplace && item.version !== undefined) {
      versions[item.id] = item.version;
    }
  }
  return versions;
}

function nameOf(inventory: ExtensionInventory, id: string): string {
  return inventory.items.find((item) => item.kind === 'plugin' && item.id === id)?.name ?? id;
}

function find(inventory: ExtensionInventory, target: ExtensionActTarget): ExtensionActItem | undefined {
  return inventory.items.find((candidate) => candidate.kind === target.kind && candidate.id === target.id);
}

/**
 * What an install or a marketplace's add left the agent holding: the item by
 * the id it was asked by (a marketplace also by its source), else the one item
 * of that kind the read before did not have — the agent names a plugin from a
 * source, and a marketplace from its catalog, its own way.
 */
function gained(
  inventory: ExtensionInventory,
  target: ExtensionActTarget,
  known: readonly string[] | undefined,
): ExtensionActItem | undefined {
  const named =
    find(inventory, target) ??
    (target.kind === 'marketplace'
      ? inventory.items.find((candidate) => candidate.kind === 'marketplace' && candidate.source === target.id)
      : undefined);
  if (named !== undefined || known === undefined) return named;
  const fresh = inventory.items.filter((candidate) => candidate.kind === target.kind && !known.includes(candidate.id));
  return fresh.length === 1 ? fresh[0] : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
