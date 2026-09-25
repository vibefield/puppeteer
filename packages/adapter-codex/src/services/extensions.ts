/**
 * Codex extensions (RFC 006 C1): the plugins, MCP servers and skills one
 * profile's `CODEX_HOME` holds, read through Codex itself — never from its
 * `config.toml`, its plugin cache or a credential store.
 *
 * One private app-server, bound to the profile and started in its root,
 * answers four reads:
 * - `skills/list` with the root as the only cwd, so no repository's skills
 *   join in: user skills (`~/.agents/skills`, which every Codex profile reads
 *   and each switches on its own with `[[skills.config]]`), system skills
 *   (copied into `$CODEX_HOME/skills/.system/`), admin skills, and the skills
 *   of enabled plugins (scope `user` with a `pluginId`, named
 *   `<plugin>:<folder>`).
 * - `plugin/installed` with no cwd: what this root has installed.
 * - `config/read` with no cwd, for its `origins` alone: which config layer set
 *   each `mcp_servers.<name>` key. The reply also carries the merged config,
 *   secrets included; nothing else of it is kept.
 * - `plugin/read` per enabled plugin of a local marketplace: the servers it
 *   brings. A remote marketplace's plugin is not read, since that read goes to
 *   the account's plugin service.
 * `codex mcp list --json`, run in the root with the same binding, then lists
 * every server the profile loads — its own, the plugins', and those the host
 * app adds — with each one's sign-in state. Its output carries environment
 * and header values; only their names are kept, and neither its output nor
 * its errors are ever repeated.
 *
 * What the reads do besides reading, per the source at rust-v0.150.0: `mcp
 * list` starts no server and opens no MCP session, but for an enabled HTTP
 * server with no bearer variable, no Authorization header and no stored
 * sign-in it fetches the server's OAuth metadata, which is how it tells "needs
 * a sign-in" from "has none"; it reads its own sign-in store for "signed in".
 * `plugin/installed` may refresh the account's remote-installed plugins, as
 * Codex does whenever it starts.
 *
 * Acts (RFC 006 C2), on what the profile itself holds: a server of the user
 * layer turns on and off through the app-server's `config/value/write` of
 * `mcp_servers.<name>.enabled` in the root's config.toml (its sign-in stays),
 * and goes with `codex mcp remove <name>`; a skill in `~/.agents/skills`
 * switches for this profile alone through `skills/config/write` on its
 * `SKILL.md`, and stays in the shared folder. A plugin's, a project's, the
 * app's or an organization's item changes where it comes from.
 *
 * Shapes: `SkillsListResponse`, `PluginInstalledResponse` and
 * `PluginReadResponse` in codex-rs/app-server-protocol/src/protocol/v2/plugin.rs,
 * `ConfigReadResponse` in v2/config.rs, and `run_list` in
 * codex-rs/cli/src/mcp_cmd.rs, at rust-v0.150.0 (the Surface pin, whose model
 * carries these requests but not their results). The CLI spells sign-in states
 * in snake case (`not_logged_in`, `o_auth`), the protocol in camel case; both
 * are read.
 */

import { execFile } from 'node:child_process';
import { lstat, readlink, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  describeMcpCommand,
  describeMcpUrl,
  EXTENSION_COMMAND_NAME,
  extensionActUnavailable,
  extensionCommandPlan,
  extensionNotOwnWords,
  PUPPETEER_VERSION,
  type AgentProfile,
  type AvailableExtensionActPlan,
  type ExtensionActIo,
  type ExtensionActKind,
  type ExtensionActOutcome,
  type ExtensionActPlan,
  type ExtensionFailure,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionProvider,
  type ExtensionService,
  type McpServerItem,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { resolveCodexExecutable } from '../detection.js';
import { AppServerClient, spawnAppServerTransport, type Transport } from '../transport/app-server-client.js';
import { codexProfileBinding } from './profiles.js';

const CLIENT_INFO = { name: 'puppeteer-extensions', version: PUPPETEER_VERSION } as const;
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;

export interface CodexExtensionOptions {
  executable?: string;
  /**
   * Home directory the native default root hangs off. When given, Codex's own
   * processes get it as `HOME` and the profile's root as `CODEX_HOME`, so a
   * host's tests never reach the real ones.
   */
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  requestTimeoutMs?: number;
  /** Injected transport factory; the default spawns `codex app-server` in the profile's root with its binding. */
  spawnTransport?: (options: { executable?: string; env?: Record<string, string>; cwd?: string }) => Transport;
  /** Injected runner for `codex mcp list --json`, resolving its standard output; the default runs it without a shell. */
  listServers?: (options: { executable: string; env: Record<string, string>; cwd: string }) => Promise<string>;
}

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');
const bounded = (value: string | undefined, max: number): string | undefined =>
  value !== undefined && value.length <= max ? value : undefined;
const names = (values: Iterable<string>, pattern: RegExp): string[] =>
  [...new Set(values)].filter((value) => pattern.test(value)).slice(0, 64);

/** A command line that runs an npm install's `.js` shim under Node rather than rely on its shebang. */
function codexArgv(executable: string, args: readonly string[]): string[] {
  if (!SCRIPT_EXECUTABLE.test(executable)) return [executable, ...args];
  return [process.versions.electron ? 'node' : process.execPath, executable, ...args];
}

function defaultListServers(options: {
  executable: string;
  env: Record<string, string>;
  cwd: string;
}): Promise<string> {
  const [command, ...args] = codexArgv(options.executable, ['mcp', 'list', '--json']);
  return new Promise((resolveOutput, reject) => {
    execFile(
      command!,
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        // Output and stderr may hold a server's secrets: the failure names neither.
        if (error) reject(new Error('`codex mcp list --json` did not complete'));
        else resolveOutput(stdout);
      },
    );
  });
}

/** Which config layer a server's keys came from, per `config/read` `origins`. */
interface ServerOrigin {
  origin: 'own' | 'project' | 'managed';
  project?: string;
  file?: string;
}

interface SessionRead {
  skills?: SkillItem[];
  plugins?: { items: PluginItem[]; readable: Array<{ id: string; name: string; marketplacePath: string }> };
  /** Keys of `config/read` origins under `mcp_servers.`, with the layer that set each. */
  origins?: Array<{ key: string; layer: ServerOrigin }>;
  /** Server name → the enabled local plugin that brings it. */
  pluginServers?: Map<string, string>;
}

function layerOf(metadata: unknown): ServerOrigin {
  const layer = rec(rec(metadata)?.name);
  const type = text(layer?.type);
  const file = text(layer?.file);
  if (type === 'user') return { origin: 'own', ...(file ? { file } : {}) };
  if (type === 'project') {
    const folder = text(layer?.dotCodexFolder);
    return { origin: 'project', ...(folder ? { project: dirname(folder), file: join(folder, 'config.toml') } : {}) };
  }
  // system, mdm, enterpriseManaged and the legacy managed files.
  return { origin: 'managed', ...(file ? { file } : {}) };
}

function originsFrom(result: unknown): SessionRead['origins'] {
  const origins = rec(rec(result)?.origins);
  if (!origins) return undefined;
  return Object.entries(origins)
    .filter(([key]) => key.startsWith('mcp_servers.'))
    .map(([key, metadata]) => ({ key, layer: layerOf(metadata) }));
}

/**
 * Where a listed server comes from. A name with keys in the user layer is the
 * profile's own; else a project's or an organization's layer; else the
 * enabled plugin that declares it; else the host app or the account added it
 * (the ChatGPT connectors server, a desktop app's), and it reads as managed.
 */
function ownerOf(
  name: string,
  origins: NonNullable<SessionRead['origins']>,
  pluginServers: Map<string, string>,
): Pick<McpServerItem, 'origin' | 'plugin' | 'project' | 'location'> {
  const prefix = `mcp_servers.${name}.`;
  const layers = origins.filter(({ key }) => key.startsWith(prefix)).map(({ layer }) => layer);
  const layer =
    layers.find(({ origin }) => origin === 'own') ??
    layers.find(({ origin }) => origin === 'project') ??
    layers.find(({ origin }) => origin === 'managed');
  if (layer) {
    return {
      origin: layer.origin,
      ...(layer.project !== undefined ? { project: layer.project } : {}),
      ...(layer.file !== undefined ? { location: layer.file } : {}),
    };
  }
  const plugin = pluginServers.get(name);
  return plugin !== undefined ? { origin: 'plugin', plugin } : { origin: 'managed' };
}

function authOf(status: string | undefined): McpServerItem['auth'] | undefined {
  if (status === 'o_auth' || status === 'oAuth') return 'signed-in';
  if (status === 'not_logged_in' || status === 'notLoggedIn') return 'needs-sign-in';
  // bearer_token is a configured credential, not a sign-in; unknown and unsupported say nothing.
  return undefined;
}

/** `codex mcp list --json`; undefined when the document is not the array it prints. */
function serversFrom(
  stdout: string,
  owner: (name: string) => Pick<McpServerItem, 'origin' | 'plugin' | 'project' | 'location'>,
): McpServerItem[] | undefined {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(document)) return undefined;
  const items: McpServerItem[] = [];
  const seen = new Set<string>();
  for (const raw of document) {
    const entry = rec(raw);
    const name = bounded(text(entry?.name), 256);
    const transport = rec(entry?.transport);
    if (!entry || !name || !transport || typeof entry.enabled !== 'boolean' || seen.has(name)) continue;
    let fields: Pick<McpServerItem, 'transport' | 'target' | 'env' | 'headers'>;
    const type = text(transport.type);
    if (type === 'stdio') {
      const command = text(transport.command);
      if (!command) continue;
      const env = names(
        [
          ...Object.keys(rec(transport.env) ?? {}),
          ...list(transport.env_vars).flatMap((variable) => text(variable) ?? text(rec(variable)?.name) ?? []),
        ],
        ENVIRONMENT_NAME,
      );
      fields = {
        transport: 'stdio',
        target: describeMcpCommand(command, strings(transport.args)),
        ...(env.length > 0 ? { env } : {}),
      };
    } else if (type === 'streamable_http') {
      const url = text(transport.url);
      if (!url) continue;
      const bearer = text(transport.bearer_token_env_var);
      const fromEnvironment = rec(transport.env_http_headers) ?? {};
      const headers = names(
        [
          ...Object.keys(rec(transport.http_headers) ?? {}),
          ...Object.keys(fromEnvironment),
          ...(bearer ? ['Authorization'] : []),
        ],
        HEADER_NAME,
      );
      const env = names(
        [...Object.values(fromEnvironment).flatMap((value) => text(value) ?? []), ...(bearer ? [bearer] : [])],
        ENVIRONMENT_NAME,
      );
      fields = {
        transport: 'http',
        target: describeMcpUrl(url),
        ...(env.length > 0 ? { env } : {}),
        ...(headers.length > 0 ? { headers } : {}),
      };
    } else {
      continue;
    }
    if (fields.target.length > 8_192) continue;
    const auth = authOf(text(entry.auth_status));
    seen.add(name);
    items.push({
      kind: 'mcp-server',
      id: name,
      name,
      ...owner(name),
      enabled: entry.enabled,
      ...fields,
      ...(auth ? { auth } : {}),
    });
  }
  return items;
}

/** `plugin/installed`: the installed plugins, and which of them a local `plugin/read` can describe. */
function pluginsFrom(result: unknown): SessionRead['plugins'] {
  const marketplaces = rec(result)?.marketplaces;
  if (!Array.isArray(marketplaces)) return undefined;
  const items: PluginItem[] = [];
  const readable: Array<{ id: string; name: string; marketplacePath: string }> = [];
  const seen = new Set<string>();
  for (const rawMarketplace of marketplaces) {
    const marketplace = rec(rawMarketplace);
    const marketplaceName = bounded(text(marketplace?.name), 512);
    const marketplacePath = text(marketplace?.path);
    for (const raw of list(marketplace?.plugins)) {
      const plugin = rec(raw);
      const id = bounded(text(plugin?.id), 512);
      const name = bounded(text(plugin?.name), 256);
      if (!plugin || !id || !name || plugin.installed !== true || typeof plugin.enabled !== 'boolean') continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const version = bounded(text(plugin.localVersion) ?? text(plugin.version), 128);
      const description = text(rec(plugin.interface)?.shortDescription)?.slice(0, 2_048);
      items.push({
        kind: 'plugin',
        id,
        name,
        // A plugin a workspace setting or a connector installed is the organization's, not the person's.
        origin: text(plugin.installPolicySource) ? 'managed' : 'own',
        enabled: plugin.enabled,
        ...(version ? { version } : {}),
        ...(marketplaceName ? { marketplace: marketplaceName } : {}),
        ...(description ? { description } : {}),
      });
      if (plugin.enabled && marketplacePath) readable.push({ id, name, marketplacePath });
    }
  }
  return { items, readable };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function linkTargetOf(folder: string): Promise<string | undefined> {
  try {
    if (!(await lstat(folder)).isSymbolicLink()) return undefined;
    return resolve(dirname(folder), await readlink(folder));
  } catch {
    return undefined;
  }
}

/** `skills/list`: one entry per cwd asked for; each skill with its `SKILL.md` path, scope and switch. */
async function skillsFrom(result: unknown): Promise<SkillItem[] | undefined> {
  const data = rec(result)?.data;
  if (!Array.isArray(data)) return undefined;
  const items: SkillItem[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    for (const raw of list(rec(entry)?.skills)) {
      const skill = rec(raw);
      const path = text(skill?.path);
      const listed = text(skill?.name);
      if (!skill || !path || !listed || typeof skill.enabled !== 'boolean') continue;
      const folder = dirname(path);
      const scope = text(skill.scope);
      const pluginId = bounded(text(skill.pluginId), 512);
      const description = text(skill.description)?.slice(0, 2_048);
      const base = {
        kind: 'skill' as const,
        enabled: skill.enabled,
        location: folder,
        ...(description ? { description } : {}),
      };
      let item: SkillItem;
      if (pluginId) {
        // The protocol names a plugin's skill `<plugin>:<folder>`; the skill itself is the part after.
        const prefix = `${pluginId.split('@')[0]}:`;
        const name = listed.startsWith(prefix) ? listed.slice(prefix.length) : listed;
        item = { ...base, id: `plugin:${pluginId}:${name}`, name, origin: 'plugin', plugin: pluginId };
      } else if (scope === 'user') {
        const linkTarget = await linkTargetOf(folder);
        item = {
          ...base,
          id: basename(folder),
          name: listed,
          origin: 'own',
          shared: true,
          switchable: true,
          ...(linkTarget ? { linkTarget } : {}),
        };
      } else if (scope === 'system') {
        item = { ...base, id: `system:${basename(folder)}`, name: listed, origin: 'bundled' };
      } else if (scope === 'admin') {
        item = { ...base, id: `admin:${basename(folder)}`, name: listed, origin: 'managed' };
      } else {
        // `repo`: a repository around the root, which is not the profile's.
        continue;
      }
      if (item.name.length > 256 || item.id.length > 512 || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

/** Codex extension capability: one app-server session and one `mcp list` per inventory. */
export function createCodexExtensionService(options: CodexExtensionOptions = {}): ExtensionService {
  const executable = resolveCodexExecutable(options.executable, options.env ?? process.env);
  const now = options.now ?? (() => new Date());
  const spawnTransport = options.spawnTransport ?? ((spawnOptions) => spawnAppServerTransport(spawnOptions));
  const listServers = options.listServers ?? defaultListServers;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

  const provider: ExtensionProvider = {
    id: 'codex',
    label: 'Codex',
    support: {
      // `codex plugin add|remove`, installed per CODEX_HOME.
      plugins: { store: 'profile', changes: 'command', read: true },
      // `[marketplaces.*]` per root, plus the personal catalog every profile reads from `~/.agents/plugins/`.
      marketplaces: { store: 'mixed', changes: 'command', read: false },
      // `codex mcp add|remove`, written to the root's config.toml.
      mcpServers: { store: 'profile', changes: 'command', read: true },
      // User skills are one shared folder, system skills per root; the app-server's skills config write switches one per profile.
      skills: { store: 'mixed', changes: 'folder', read: true },
    },
  };

  // A test home pins everything Codex reads to it, whatever this process inherited.
  const environmentFor = (profile: AgentProfile): Record<string, string> => ({
    ...codexProfileBinding(profile),
    ...(options.home !== undefined ? { HOME: options.home, CODEX_HOME: profile.dataRoot } : {}),
  });

  async function readSession(env: Record<string, string>, root: string): Promise<SessionRead> {
    let transport: Transport | undefined;
    let client: AppServerClient | undefined;
    try {
      transport = spawnTransport({ executable, env, cwd: root });
      client = new AppServerClient(transport, { requestTimeoutMs });
      await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
      client.notify('initialized');
      const session = client;
      const settled = (request: Promise<unknown>) =>
        request.then(
          (value) => ({ value }),
          () => undefined,
        );
      const [skills, installed, config] = await Promise.all([
        settled(session.request('skills/list', { cwds: [root] })),
        settled(session.request('plugin/installed', {})),
        settled(session.request('config/read', {})),
      ]);
      const plugins = installed ? pluginsFrom(installed.value) : undefined;
      let pluginServers: Map<string, string> | undefined;
      if (plugins) {
        pluginServers = new Map();
        const reads = await Promise.all(
          plugins.readable.map(async (plugin) => {
            const read = await settled(
              session.request('plugin/read', { marketplacePath: plugin.marketplacePath, pluginName: plugin.name }),
            );
            return { plugin, servers: strings(rec(rec(read?.value)?.plugin)?.mcpServers) };
          }),
        );
        for (const { plugin, servers } of reads) {
          for (const server of servers) if (!pluginServers.has(server)) pluginServers.set(server, plugin.id);
        }
      }
      const origins = config ? originsFrom(config.value) : undefined;
      const skillItems = skills ? await skillsFrom(skills.value) : undefined;
      return {
        ...(skillItems ? { skills: skillItems } : {}),
        ...(plugins ? { plugins } : {}),
        ...(origins ? { origins } : {}),
        ...(pluginServers ? { pluginServers } : {}),
      };
    } finally {
      if (client) await client.close();
      else await transport?.close();
    }
  }

  function plan(profile: AgentProfile, item: McpServerItem | SkillItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Codex', item));
    }
    if (item.kind === 'mcp-server') {
      if (!EXTENSION_COMMAND_NAME.test(item.id)) {
        return extensionActUnavailable(target, act, 'no-command', "Codex's commands do not take this server's name");
      }
      if (act === 'remove') {
        return extensionCommandPlan({
          target,
          act,
          argv: codexArgv(executable, ['mcp', 'remove', item.id]),
          env: codexProfileBinding(profile),
          reaches: ['definition'],
        });
      }
      const enabled = act === 'enable';
      return {
        target,
        act,
        available: true,
        runs: {
          kind: 'protocol',
          method: 'config/value/write',
          params: { keyPath: `mcp_servers.${item.id}.enabled`, mergeStrategy: 'replace', value: enabled },
        },
        display: `config/value/write mcp_servers.${item.id}.enabled = ${enabled}`,
        reaches: [],
      };
    }
    // A skill of your own lives in ~/.agents/skills; Codex's switch for it is this profile's alone.
    if (act === 'remove') {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        'Codex has no command that removes a skill: it lives in ~/.agents/skills, which every profile reads',
      );
    }
    if (item.switchable !== true || item.location === undefined) {
      return extensionActUnavailable(target, act, 'no-command', 'Codex has no switch for this skill');
    }
    const enabled = act === 'enable';
    return {
      target,
      act,
      available: true,
      runs: {
        kind: 'protocol',
        method: 'skills/config/write',
        params: { path: join(item.location, 'SKILL.md'), enabled },
      },
      display: `skills/config/write ${item.id} enabled = ${enabled}`,
      reaches: [],
    };
  }

  async function perform(
    profile: AgentProfile,
    planned: AvailableExtensionActPlan,
    io: ExtensionActIo,
  ): Promise<ExtensionActOutcome> {
    if (planned.runs.kind !== 'protocol') return { ok: false, error: 'is not a protocol call' };
    const root = profile.dataRoot;
    if (!(await isDirectory(root))) return { ok: false, error: 'found no Codex root on disk' };
    const { method, params } = planned.runs;
    let transport: Transport | undefined;
    let client: AppServerClient | undefined;
    const onAbort = (): void => {
      void (client ? client.close() : transport?.close());
    };
    io.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      transport = spawnTransport({ executable, env: environmentFor(profile), cwd: root });
      client = new AppServerClient(transport, { requestTimeoutMs });
      await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
      client.notify('initialized');
      io.onOutput?.(`${planned.display}\n`);
      try {
        await client.request(method, params ?? {});
      } catch {
        // Codex's refusal may quote its config: it is never repeated.
        io.onOutput?.('Codex refused it.\n');
        return { ok: false, error: 'was refused by Codex' };
      }
      io.onOutput?.('Codex wrote it to its config.\n');
      return { ok: true };
    } catch {
      return { ok: false, error: io.signal?.aborted ? 'was stopped' : 'could not reach the Codex app-server' };
    } finally {
      io.signal?.removeEventListener('abort', onAbort);
      if (client) await client.close();
      else await transport?.close();
    }
  }

  return {
    provider,
    plan,
    perform,

    async inventory(profile: AgentProfile): Promise<ExtensionInventory | ExtensionFailure> {
      const env = environmentFor(profile);
      const root = profile.dataRoot;
      // Codex refuses a CODEX_HOME that does not exist, and both reads run in it.
      if (!(await isDirectory(root))) {
        return {
          status: 'not-found',
          provider: 'codex',
          message: 'this profile has no Codex root on disk yet',
          retryable: false,
        };
      }
      const [session, listing] = await Promise.allSettled([
        readSession(env, root),
        listServers({ executable, env, cwd: root }),
      ]);
      if (session.status === 'rejected') {
        return {
          status: 'unavailable',
          provider: 'codex',
          message: 'the Codex app-server could not be read for this profile',
          retryable: true,
        };
      }
      const read = session.value;
      const items: ExtensionItem[] = [];
      const unread: NonNullable<ExtensionInventory['unread']> = [];

      if (read.plugins) items.push(...read.plugins.items);
      else unread.push({ kind: 'plugin', message: '`plugin/installed` could not be read' });

      if (listing.status === 'rejected') {
        unread.push({ kind: 'mcp-server', message: '`codex mcp list --json` could not be run' });
      } else if (!read.origins || !read.pluginServers) {
        unread.push({ kind: 'mcp-server', message: 'where each server comes from could not be read' });
      } else {
        const { origins, pluginServers } = read;
        const servers = serversFrom(listing.value, (name) => ownerOf(name, origins, pluginServers));
        if (servers) items.push(...servers);
        else unread.push({ kind: 'mcp-server', message: '`codex mcp list --json` printed an unrecognized document' });
      }

      if (read.skills) items.push(...read.skills);
      else unread.push({ kind: 'skill', message: '`skills/list` could not be read' });

      return {
        provider: 'codex',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        items,
        ...(unread.length > 0 ? { unread } : {}),
        // The published app-server page still calls the plugin methods under development.
        source: { kind: 'native-protocol', stability: 'experimental' },
      };
    },
  };
}
