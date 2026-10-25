/**
 * Codex extensions (RFC 006 C1): the plugins, MCP servers and skills one
 * profile's `CODEX_HOME` holds, read through Codex itself, and its
 * marketplaces from the files Codex keeps them in — never from a credential
 * store.
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
 * - `config/read` with no cwd, for its `origins`: which config layer set each
 *   `mcp_servers.<name>` key. The reply also carries the merged config,
 *   secrets included; of it only the names of the servers whose `auth` is
 *   `ema_auth` are kept (see the sign-in acts below).
 * - `plugin/read` per enabled plugin of a local marketplace: the servers it
 *   brings. A remote marketplace's plugin is not read, since that read goes to
 *   the account's plugin service.
 * `codex mcp list --json`, run in the root with the same binding, then lists
 * every server the profile loads — its own, the plugins', and those the host
 * app adds — with each one's sign-in state. Its output carries environment
 * and header values; only their names are kept, and neither its output nor
 * its errors are ever repeated. A server that sends no header, runs in no
 * folder of its own, and whose command line or address hides nothing also
 * carries it whole as its definition, for a host to give another agent.
 *
 * What the reads do besides reading, per the source at rust-v0.150.0 and again
 * at rust-v0.164.0: `mcp list` starts no server and opens no MCP session, but
 * for an enabled HTTP server with no bearer variable, no Authorization header
 * and no stored sign-in it fetches the server's OAuth metadata, which is how it
 * tells "needs a sign-in" from "has none"; it reads its own sign-in store for
 * "signed in".
 * `plugin/installed` may refresh the account's remote-installed plugins, as
 * Codex does whenever it starts.
 *
 * Acts (RFC 006 C2), on what the profile itself holds: a server of the user
 * layer turns on and off through the app-server's `config/value/write` of
 * `mcp_servers.<name>.enabled` in the root's config.toml (its sign-in stays),
 * and goes with `codex mcp remove <name>`; a skill in `~/.agents/skills`
 * switches for this profile alone through `skills/config/write` on its
 * `SKILL.md`, and stays in the shared folder. A plugin the profile installed
 * turns on and off through the same write of its `plugins.<id>.enabled`, and
 * goes with `codex plugin remove <id>`. A plugin's, a project's, the app's or
 * an organization's item changes where it comes from. A streamable
 * HTTP server that asks for a sign-in gets `codex mcp login <name>`, in a
 * terminal the person answers (it opens a browser and waits for it), and one
 * signed in gets `codex mcp logout <name>`. Off Windows, Codex keeps that
 * sign-in in the OS keychain under the server's name and a hash of its
 * address — not its `CODEX_HOME` (`compute_store_key` in
 * codex-rs/rmcp-client/src/oauth.rs; the Direct keyring backend is the default
 * there, config/src/types.rs) — so every Codex profile holding that server at
 * that address shares it. A profile whose config sets
 * `mcp_oauth_credentials_store = "file"` keeps its own; that key is not read.
 * A server whose `auth` is `ema_auth` (enterprise-managed, which 0.150.0's
 * config loader still refuses) has no sign-in of its own: `codex mcp login`
 * refuses it ("Enterprise MCP authorization is managed by Codex account
 * sign-in"), and `codex mcp logout` removes the one enterprise grant every
 * such server of the profile shares — kept under the canonical `CODEX_HOME`,
 * so no other profile's (`run_login` and `run_logout` in
 * codex-rs/cli/src/mcp_cmd.rs, `compute_store_key` in oauth.rs, at
 * rust-v0.164.0; the refusals reproduced hermetically on 0.164.0). Which
 * servers those are is known from the profile's last inventory.
 * A server the profile does not hold is added by the same `config/value/write`,
 * replacing the whole `mcp_servers.<name>` table with the definition: its
 * command, arguments and `env_vars` (the names Codex forwards to the server
 * from its own environment, where the host puts each value), or its streamable
 * HTTP address. Never `codex mcp add`, which has no flag that names a forwarded
 * variable (its `--env` stores a value) and starts the browser login at once
 * for a server that offers OAuth (`run_add` in codex-rs/cli/src/mcp_cmd.rs at
 * rust-v0.150.0 and rust-v0.164.0). A skill a host keeps goes into
 * `~/.agents/skills`, the one folder Codex reads a person's skills from: the
 * host's copy moves in and a link to it stays where it was. Every Codex profile
 * reads that folder, and Grok, Kimi, OpenCode and Pi do too, so a skill there is
 * never taken away; only Codex's switch turns it off, for one profile.
 *
 * Shapes: `SkillsListResponse`, `PluginInstalledResponse` and
 * `PluginReadResponse` in codex-rs/app-server-protocol/src/protocol/v2/plugin.rs,
 * `ConfigReadResponse` in v2/config.rs, and `run_list` in
 * codex-rs/cli/src/mcp_cmd.rs, at rust-v0.150.0; every field read is in 0.164.0's
 * generated schema too (the Surface pin, whose model carries these requests but
 * not their results). The CLI spells sign-in states
 * in snake case (`not_logged_in`, `o_auth`), the protocol in camel case; both
 * are read.
 *
 * Marketplaces and their catalogs (RFC 006 C2) are read from files alone:
 * every app-server start runs Codex's startup work — a sync of its curated
 * catalog, an upgrade of each git marketplace that reinstalls its plugins, a
 * refresh of the account's remote catalog — and a catalog read fetches
 * nothing. The user layer's `config.toml` names the configured marketplaces,
 * `[marketplaces.<name>]` with `source_type` and `source`: a git one is a
 * snapshot in `.tmp/marketplaces/<name>/`, fetched when its
 * `.codex-marketplace-install.json` (which an upgrade writes) or else the
 * snapshot itself was last written — Codex keeps no other time for it; a local
 * one is read where it is, and `openai-bundled`, `openai-bundled-alpha` and
 * `openai-primary-runtime` are entries Codex's app writes. `.tmp/plugins/` is
 * the curated catalog, `openai-curated`, that Codex syncs itself when it
 * starts (`.tmp/plugins.sha` its time; `openai-api-curated` when only the
 * clone's API catalog is there), and `~/.agents/plugins/marketplace.json`
 * is a personal catalog every profile reads, whose plugins' `./` paths start
 * from the home. A catalog is the first of `.agents/plugins/marketplace.json`,
 * `.agents/plugins/api_marketplace.json` and `.claude-plugin/marketplace.json`
 * in its folder; each entry is `<plugin>@<marketplace>` as its catalog names
 * itself, the key Codex installs it by. A local entry's folder carries its
 * manifest: a root `plugin.json` of the Agent Plugins schema (skills in
 * `skills/`, servers in `mcp.json`), else `.codex-plugin/`, `.claude-plugin/`
 * or `.cursor-plugin/plugin.json` (skills where it says or `skills/`, servers
 * where it says or `.mcp.json`); a folder a link leads out of its marketplace
 * is not read. Codex installed a plugin when the config has `[plugins."<id>"]`
 * and `plugins/cache/<marketplace>/<plugin>/<version>/` holds a copy, the
 * highest version its own (`local` over any). The remote catalogs a ChatGPT
 * sign-in brings are fetched from the account and are not read. Per
 * codex-rs/core-plugins at openai/codex e7bbc79 (`marketplace.rs`,
 * `installed_marketplaces.rs`, `store.rs`, `manager.rs`, `startup_sync.rs`).
 *
 * A plugin a catalog lists installs with `codex plugin add
 * <plugin>@<marketplace>`, which never prompts; never through the app-server,
 * whose install starts a browser sign-in for each server of the plugin that
 * offers one. A marketplace is added with `codex plugin marketplace add
 * <source>` (a GitHub `owner/repo`, a git address, or a folder), a git one is
 * fetched again with `upgrade <name>` — which also reinstalls every plugin
 * installed from it, from the new snapshot — and one goes with `remove
 * <name>`, which leaves the plugins installed from it installed.
 */

import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  describeMcpCommand,
  describeMcpUrl,
  EXTENSION_COMMAND_NAME,
  EXTENSION_PLUGIN_NAME,
  EXTENSION_SKILL_FOLDER_NAME,
  extensionActUnavailable,
  extensionCommandPlan,
  extensionFilesPlan,
  extensionNotOwnWords,
  extensionTerminalPlan,
  isExtensionSource,
  mcpServerDefinition,
  PUPPETEER_VERSION,
  type AgentProfile,
  type AvailableExtensionActPlan,
  type CatalogMarketplace,
  type CatalogParts,
  type CatalogPlugin,
  type ExtensionActIo,
  type ExtensionActItem,
  type ExtensionActKind,
  type ExtensionActOutcome,
  type ExtensionActPlan,
  type ExtensionActPlanOptions,
  type ExtensionActTarget,
  type ExtensionCatalog,
  type ExtensionFailure,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionProvider,
  type ExtensionReach,
  type ExtensionService,
  type MarketplaceItem,
  type McpServerItem,
  type PluginItem,
  type SkillItem,
} from '@vibefield/puppeteer-core';
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
   * Home directory the native default root and `~/.agents/skills` hang off;
   * the process home when absent. When given, Codex's own processes get it as
   * `HOME` and the profile's root as `CODEX_HOME`, so a host's tests never
   * reach the real ones.
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
const present = (value: unknown): boolean => value !== undefined && value !== null;
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
  /** Names of the servers whose merged `auth` is `ema_auth`: the one value of the merged config kept. */
  enterpriseServers?: ReadonlySet<string>;
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

/** `config/read`'s merged `mcp_servers`: the names whose `auth` is `ema_auth`, and nothing else of it. */
function enterpriseServersFrom(result: unknown): SessionRead['enterpriseServers'] {
  const config = rec(rec(result)?.config);
  if (!config) return undefined;
  const servers = rec(config.mcp_servers) ?? {};
  return new Set(Object.keys(servers).filter((name) => rec(servers[name])?.auth === 'ema_auth'));
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

/** Off Windows a server's own sign-in is one keychain entry for every Codex profile (see above). */
const SIGN_IN_REACHES: readonly ExtensionReach[] = process.platform === 'win32' ? [] : ['every-profile'];
/** An enterprise server's sign-out ends the grant the profile's other enterprise servers use, in this profile alone. */
const ENTERPRISE_SIGN_OUT_REACHES: readonly ExtensionReach[] = ['sign-in'];

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
    let fields: Pick<McpServerItem, 'transport' | 'target' | 'env' | 'headers' | 'definition'>;
    const type = text(transport.type);
    const status = text(entry.auth_status);
    if (type === 'stdio') {
      const command = text(transport.command);
      if (!command) continue;
      const args = strings(transport.args);
      const variables = [
        ...Object.keys(rec(transport.env) ?? {}),
        ...list(transport.env_vars).flatMap((variable) => text(variable) ?? text(rec(variable)?.name) ?? []),
      ];
      const env = names(variables, ENVIRONMENT_NAME);
      // No definition carries a working directory, and the command may not run without its own. Every
      // name goes in unfiltered: one Core would not take keeps the server home rather than lose a variable.
      const definition = present(transport.cwd)
        ? undefined
        : mcpServerDefinition({ transport: 'stdio', command, args, env: [...new Set(variables)] });
      fields = {
        transport: 'stdio',
        target: describeMcpCommand(command, args),
        ...(env.length > 0 ? { env } : {}),
        ...(definition ? { definition } : {}),
      };
    } else if (type === 'streamable_http') {
      const url = text(transport.url);
      if (!url) continue;
      const bearer = text(transport.bearer_token_env_var);
      const fixed = rec(transport.http_headers) ?? {};
      const fromEnvironment = rec(transport.env_http_headers) ?? {};
      const headers = names(
        [...Object.keys(fixed), ...Object.keys(fromEnvironment), ...(bearer ? ['Authorization'] : [])],
        HEADER_NAME,
      );
      const env = names(
        [...Object.values(fromEnvironment).flatMap((value) => text(value) ?? []), ...(bearer ? [bearer] : [])],
        ENVIRONMENT_NAME,
      );
      // A header's value stays behind, so any header keeps a server home: every one it is configured
      // with, and the account token Codex adds itself, which it also reports as `bearer_token`
      // (`compute_auth_status` in codex-rs/codex-mcp/src/mcp/auth.rs). A helper's are named only when it runs.
      const bearing = present(transport.bearer_token_env_var) || status === 'bearer_token' || status === 'bearerToken';
      const sent = [...Object.keys(fixed), ...Object.keys(fromEnvironment), ...(bearing ? ['Authorization'] : [])];
      const definition = present(transport.http_headers_helper)
        ? undefined
        : mcpServerDefinition({ transport: 'http', url, headers: sent });
      fields = {
        transport: 'http',
        target: describeMcpUrl(url),
        ...(env.length > 0 ? { env } : {}),
        ...(headers.length > 0 ? { headers } : {}),
        ...(definition ? { definition } : {}),
      };
    } else {
      continue;
    }
    if (fields.target.length > 8_192) continue;
    const auth = authOf(status);
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

/**
 * An add, from the server as Codex would hold it: its whole `mcp_servers.<name>`
 * table, written through the app-server (see above). The name is one segment
 * of that key path, so it must be one `codex mcp` would take.
 */
function addPlan(target: ExtensionActTarget, item: McpServerItem): ExtensionActPlan {
  if (item.definition === undefined) {
    return extensionActUnavailable(target, 'add', 'unsupported', 'Codex adds a server only from its definition');
  }
  if (!EXTENSION_COMMAND_NAME.test(item.id)) {
    return extensionActUnavailable(target, 'add', 'no-command', "Codex's commands do not take this server's name");
  }
  const { definition } = item;
  if (definition.transport === 'sse') {
    return extensionActUnavailable(
      target,
      'add',
      'unsupported',
      'Codex reaches a remote server only over streamable HTTP',
    );
  }
  const value =
    definition.transport === 'stdio'
      ? {
          command: definition.command,
          args: [...definition.args],
          ...(definition.env !== undefined ? { env_vars: [...definition.env] } : {}),
        }
      : { url: definition.url };
  const keyPath = `mcp_servers.${item.id}`;
  return {
    target,
    act: 'add',
    available: true,
    runs: { kind: 'protocol', method: 'config/value/write', params: { keyPath, mergeStrategy: 'replace', value } },
    display: `config/value/write ${keyPath} = ${JSON.stringify(value)}`,
    reaches: [],
  };
}

/**
 * An act on a plugin the profile installed. `codex plugin add` writes
 * `[plugins."<id>"] enabled = true` to the root's config.toml (the report,
 * draft/CODEX-PLUGINS-SKILLS-MCP.md), so the switch is that key, written
 * through the app-server as a server's is; the write splits its key path at
 * each dot, so an id with one would name another table. A workspace-managed
 * plugin keeps the workspace's state whatever a local `enabled = false` says,
 * which is why it is not the profile's own. `codex plugin remove <id>` deletes
 * the cached copy (the report; not probed), and is Codex's only uninstall.
 * Codex has no update of one plugin: `codex plugin marketplace upgrade` brings
 * a marketplace's plugins up to date. An install is `codex plugin add` of the
 * catalog's `<plugin>@<marketplace>` (see above); Codex takes no other source.
 */
function pluginPlan(
  executable: string,
  profile: AgentProfile,
  item: PluginItem,
  act: ExtensionActKind,
  options: ExtensionActPlanOptions,
): ExtensionActPlan {
  const target: ExtensionActTarget = { kind: 'plugin', id: item.id };
  if (act === 'install') {
    if (options.source !== undefined) {
      return extensionActUnavailable(
        target,
        act,
        'unsupported',
        'Codex installs a plugin only from a marketplace; add the marketplace first',
      );
    }
    if (options.listed?.blocked !== undefined) {
      return extensionActUnavailable(target, act, 'blocked', options.listed.blocked);
    }
    // `codex plugin add` takes a bare name only with `--marketplace`: the catalog's key names both
    if (!EXTENSION_PLUGIN_NAME.test(item.id) || !item.id.includes('@')) {
      return extensionActUnavailable(target, act, 'unsupported', "Codex's commands do not take this plugin's name");
    }
    return extensionCommandPlan({
      target,
      act,
      argv: codexArgv(executable, ['plugin', 'add', item.id, '--json']),
      env: codexProfileBinding(profile),
      reaches: [],
    });
  }
  if (item.origin !== 'own') {
    return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Codex', item));
  }
  if (act === 'add') {
    return extensionActUnavailable(target, act, 'unsupported', 'Codex installs a plugin from its marketplace');
  }
  if (act === 'sign-in' || act === 'sign-out') {
    return extensionActUnavailable(target, act, 'unsupported', 'Codex has no sign-in for a plugin');
  }
  if (act === 'purge') {
    return extensionActUnavailable(
      target,
      act,
      'unsupported',
      'Codex removes a plugin one way, with `codex plugin remove`',
    );
  }
  if (act === 'update') {
    return extensionActUnavailable(
      target,
      act,
      'no-command',
      'Codex brings its plugins up to date when their marketplace is upgraded',
    );
  }
  if (!EXTENSION_PLUGIN_NAME.test(item.id)) {
    return extensionActUnavailable(target, act, 'no-command', "Codex's commands do not take this plugin's name");
  }
  if (act === 'remove') {
    return extensionCommandPlan({
      target,
      act,
      argv: codexArgv(executable, ['plugin', 'remove', item.id]),
      env: codexProfileBinding(profile),
      reaches: [],
    });
  }
  if (item.id.includes('.')) {
    return extensionActUnavailable(target, act, 'no-command', "Codex's config cannot name this plugin's key");
  }
  const enabled = act === 'enable';
  const keyPath = `plugins.${item.id}.enabled`;
  return {
    target,
    act,
    available: true,
    runs: {
      kind: 'protocol',
      method: 'config/value/write',
      params: { keyPath, mergeStrategy: 'replace', value: enabled },
    },
    display: `config/value/write ${keyPath} = ${enabled}`,
    reaches: [],
  };
}

/**
 * A skill a host keeps, placed where Codex reads a person's skills: the host's
 * one copy moves into `~/.agents/skills` and a link is left where it was, so
 * every link to the host's folder still resolves. That folder is every Codex
 * profile's and other agents' too. Pure: the runtime checks each step.
 */
function skillAddPlan(item: SkillItem, sharedSkills: string, home: string): ExtensionActPlan {
  const target: ExtensionActTarget = { kind: 'skill', id: item.id };
  const unsupported = (message: string) => extensionActUnavailable(target, 'add', 'unsupported', message);
  const kept = item.linkTarget;
  if (kept === undefined) {
    return unsupported('Codex takes a skill only as a folder, which it keeps in ~/.agents/skills');
  }
  if (!EXTENSION_SKILL_FOLDER_NAME.test(item.id)) {
    return unsupported(`Codex cannot keep a skill folder named ${item.id} in ~/.agents/skills`);
  }
  if (kept === sharedSkills || kept.startsWith(`${sharedSkills}${sep}`)) {
    return unsupported(`Codex already reads ${item.name} where it is, in ~/.agents/skills`);
  }
  const placed = join(sharedSkills, item.id);
  return extensionFilesPlan({
    target,
    act: 'add',
    steps: [
      { op: 'move', from: kept, to: placed },
      { op: 'link', path: kept, target: placed },
    ],
    reaches: ['shared-folder'],
    home,
  });
}

// ---------------------------------------------------------------------------
// config.toml, read for its marketplaces and the plugins it records: the TOML
// a Codex config holds, by the reader the Grok adapter reads Grok's with.
// Anything else is an error the caller reports, never a guess.
// ---------------------------------------------------------------------------

type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
interface TomlTable {
  [key: string]: TomlValue;
}

const isTable = (value: TomlValue | undefined): value is TomlTable =>
  value !== undefined && typeof value === 'object' && !Array.isArray(value);
// Tables have no prototype, so a key such as `__proto__` is only a key.
const newTable = (): TomlTable => Object.create(null) as TomlTable;

export function parseCodexConfig(source: string): TomlTable {
  const root = newTable();
  let table = root;
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`config.toml: ${what} at offset ${i}`);
  };
  const skipSpaces = () => {
    while (source[i] === ' ' || source[i] === '\t') i++;
  };
  const skipComment = () => {
    if (source[i] === '#') while (i < source.length && source[i] !== '\n') i++;
  };
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (source[i] !== '\n' && source[i] !== '\r') return;
      i++;
    }
  };

  const escape = (): string => {
    const c = source[i++];
    const simple: Record<string, string> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      e: '\x1b',
      '"': '"',
      '\\': '\\',
    };
    if (c !== undefined && simple[c] !== undefined) return simple[c];
    if (c === 'u' || c === 'U') {
      const hex = source.slice(i, i + (c === 'u' ? 4 : 8));
      if (!/^(?:[0-9A-Fa-f]{4}|[0-9A-Fa-f]{8})$/u.test(hex)) fail('bad unicode escape');
      i += hex.length;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return fail('bad escape');
  };
  const basicString = (): string => {
    if (source.startsWith('"""', i)) {
      i += 3;
      if (source[i] === '\r') i++;
      if (source[i] === '\n') i++;
      let out = '';
      while (i < source.length) {
        if (source.startsWith('"""', i)) {
          // Up to two quotes before the closing three belong to the text.
          let run = 3;
          while (run < 5 && source[i + run] === '"') run++;
          i += run;
          return out + '"'.repeat(run - 3);
        }
        const c = source[i++]!;
        if (c !== '\\') {
          out += c;
          continue;
        }
        // A backslash that ends a line trims the break and the next line's indent.
        let j = i;
        while (source[j] === ' ' || source[j] === '\t') j++;
        if (source[j] === '\n' || source[j] === '\r') {
          i = j;
          while (source[i] === ' ' || source[i] === '\t' || source[i] === '\n' || source[i] === '\r') i++;
          continue;
        }
        out += escape();
      }
      return fail('unterminated string');
    }
    i++;
    let out = '';
    while (i < source.length) {
      const c = source[i++]!;
      if (c === '"') return out;
      if (c === '\n') fail('line break in a string');
      out += c === '\\' ? escape() : c;
    }
    return fail('unterminated string');
  };
  const literalString = (): string => {
    if (source.startsWith("'''", i)) {
      i += 3;
      if (source[i] === '\r') i++;
      if (source[i] === '\n') i++;
      let end = source.indexOf("'''", i);
      if (end < 0) fail('unterminated string');
      // As with basic strings, up to two quotes before the closing three are text.
      for (let extra = 0; extra < 2 && source[end + 3] === "'"; extra++) end++;
      const out = source.slice(i, end);
      i = end + 3;
      return out;
    }
    i++;
    const end = source.indexOf("'", i);
    const lineBreak = source.indexOf('\n', i);
    if (end < 0 || (lineBreak >= 0 && lineBreak < end)) fail('unterminated string');
    const out = source.slice(i, end);
    i = end + 1;
    return out;
  };
  const key = (): string => {
    skipSpaces();
    if (source[i] === '"') return basicString();
    if (source[i] === "'") return literalString();
    const start = i;
    while (i < source.length && /[A-Za-z0-9_-]/u.test(source[i]!)) i++;
    if (i === start) fail('expected a key');
    return source.slice(start, i);
  };
  const keyPath = (): string[] => {
    const path = [key()];
    for (;;) {
      skipSpaces();
      if (source[i] !== '.') return path;
      i++;
      path.push(key());
    }
  };
  const assign = (target: TomlTable, path: string[], value: TomlValue) => {
    let cursor = target;
    for (const part of path.slice(0, -1)) {
      const next = cursor[part];
      if (next === undefined) cursor = cursor[part] = newTable();
      else if (isTable(next)) cursor = next;
      else fail(`${part} is not a table`);
    }
    cursor[path[path.length - 1]!] = value;
  };
  const value = (): TomlValue => {
    skipSpaces();
    const c = source[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === '[') {
      i++;
      const items: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (source[i] === ']') {
          i++;
          return items;
        }
        items.push(value());
        skipBlank();
        if (source[i] === ',') i++;
        else if (source[i] !== ']') fail('expected , or ]');
      }
    }
    if (c === '{') {
      // Line breaks and a trailing comma are allowed, as TOML 1.1 allows them.
      i++;
      const inline = newTable();
      for (;;) {
        skipBlank();
        if (source[i] === '}') {
          i++;
          return inline;
        }
        const path = keyPath();
        skipSpaces();
        if (source[i] !== '=') fail('expected =');
        i++;
        assign(inline, path, value());
        skipBlank();
        if (source[i] === ',') i++;
        else if (source[i] !== '}') fail('expected , or }');
      }
    }
    const start = i;
    while (i < source.length && !/[\s,\]}#]/u.test(source[i]!)) i++;
    const token = source.slice(start, i);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?$/u.test(token)) return Number(token.replaceAll('_', ''));
    if (/^0(?:x[0-9A-Fa-f_]+|o[0-7_]+|b[01_]+)$/u.test(token)) return Number(token.replaceAll('_', ''));
    if (/^[+-]?(?:inf|nan)$/u.test(token))
      return token.endsWith('nan') ? Number.NaN : token.startsWith('-') ? -Infinity : Infinity;
    // Dates and times are kept as their text; nothing read here holds one.
    if (
      /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(
        token,
      )
    ) {
      return token;
    }
    return fail('unrecognized value');
  };
  const tableAt = (path: string[]): TomlTable => {
    let cursor = root;
    for (const part of path) {
      let next = cursor[part];
      if (next === undefined) next = cursor[part] = newTable();
      // `[a.b]` after `[[a]]` continues the last `a`.
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isTable(next)) return fail(`${part} is not a table`);
      cursor = next;
    }
    return cursor;
  };

  for (;;) {
    skipBlank();
    if (i >= source.length) return root;
    if (source[i] === '[') {
      const array = source[i + 1] === '[';
      i += array ? 2 : 1;
      const path = keyPath();
      skipSpaces();
      if (!source.startsWith(array ? ']]' : ']', i)) fail('expected ]');
      i += array ? 2 : 1;
      if (array) {
        const parent = tableAt(path.slice(0, -1));
        const name = path[path.length - 1]!;
        const list = parent[name] ?? (parent[name] = []);
        if (!Array.isArray(list)) fail(`${name} is not an array of tables`);
        const entry = newTable();
        (list as TomlValue[]).push(entry);
        table = entry;
      } else {
        table = tableAt(path);
      }
    } else {
      const path = keyPath();
      skipSpaces();
      if (source[i] !== '=') fail('expected =');
      i++;
      assign(table, path, value());
    }
    skipSpaces();
    skipComment();
    if (i < source.length && source[i] !== '\n' && source[i] !== '\r') fail('expected the end of the line');
  }
}

// ---------------------------------------------------------------------------
// Marketplaces and their catalogs, from files alone (see above)
// ---------------------------------------------------------------------------

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** What one listed plugin's folder is read for, at most, to say what it brings. */
const MAX_PLUGIN_ENTRIES = 400;
/**
 * Only a catalog's first entries have their folders read (the curated one
 * lists some hundred), and any Codex holds a copy of, whose folder says
 * whether the catalog's is newer; the rest show what their entry says.
 */
const MAX_CATALOG_FOLDERS = 400;
/** How many listed plugins' folders are read at once. */
const CATALOG_LANES = 8;
/** Core's bounds on one catalog. */
const MAX_CATALOG_MARKETPLACES = 256;
const MAX_CATALOG_PLUGINS = 8_192;
/** Where a marketplace's catalog sits in its folder, the first found read (`find_marketplace_manifest_path`). */
const CATALOG_FILES = [
  ['.agents', 'plugins', 'marketplace.json'],
  ['.agents', 'plugins', 'api_marketplace.json'],
  ['.claude-plugin', 'marketplace.json'],
] as const;
/** A plugin's manifest when its root `plugin.json` is not an Agent Plugins one (`DISCOVERABLE_PLUGIN_MANIFEST_PATHS`). */
const PLUGIN_MANIFEST_FOLDERS = ['.codex-plugin', '.claude-plugin', '.cursor-plugin'] as const;
const AGENT_PLUGIN_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/';
const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
/** A marketplace name Codex takes (`validate_plugin_segment`): no dot, so never a path. */
const MARKETPLACE_NAME = /^[A-Za-z0-9_-]{1,256}$/u;
/** A plugin name Codex takes: a dot only between two segments. */
const PLUGIN_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;
/** A version folder in Codex's plugin cache (`validate_plugin_version_segment`). */
const VERSION_SEGMENT = /^[A-Za-z0-9._+-]{1,128}$/u;
/** A cached version that is not the manifest's: a local copy, a curated sync's commit, a digest. */
const UNVERSIONED = /^(?:local|[0-9a-f]{7,40}|agent-plugins-[0-9a-f]+)$/iu;
const CURATED = 'openai-curated';
/** The curated clone's catalog for an API-key sign-in, `.agents/plugins/api_marketplace.json` in the same folder. */
const CURATED_API = 'openai-api-curated';
/** The marketplaces Codex's own app writes into the config, and keeps. */
const SHIPPED = new Set(['openai-bundled', 'openai-bundled-alpha', 'openai-primary-runtime']);
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
/** An scp-like git address, `[user@]host:path`, as `codex plugin marketplace add` keeps one. */
const SCP_ADDRESS = /^(?:([^@/:\s]+)@)?([^/:\s]{2,}):(?!\/\/)([^\s?#]+)$/u;
const MASKED = '•••';

/** A file that is absent reads as nothing; one that exists and cannot be read is an error the caller reports. */
async function readSized(path: string, limit: number): Promise<string | undefined> {
  let size: number;
  try {
    const found = await stat(path);
    if (!found.isFile()) return undefined;
    size = found.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
  if (size > limit) throw new Error(`${basename(path)} is larger than ${limit} bytes`);
  return readFile(path, 'utf8');
}

async function readObject(path: string, limit: number): Promise<Json | undefined> {
  const source = await readSized(path, limit);
  if (source === undefined) return undefined;
  const document = rec(JSON.parse(source));
  if (!document) throw new Error(`${basename(path)} is not a JSON object`);
  return document;
}

/** One of the plugin's own files, never a link: absent or anything else reads as nothing. */
async function ownFile(path: string, limit = MAX_MANIFEST_BYTES): Promise<string | undefined> {
  try {
    const found = await lstat(path);
    if (!found.isFile() || found.size > limit) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** What is at a path itself, never where a link leads: `file`, `folder`, `other`, or undefined when nothing is. */
async function ownEntry(path: string): Promise<'file' | 'folder' | 'other' | undefined> {
  try {
    const found = await lstat(path);
    return found.isFile() ? 'file' : found.isDirectory() ? 'folder' : 'other';
  } catch {
    return undefined;
  }
}

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

async function modifiedAt(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/** Whether `path`, once links resolve, is `folder` or inside it. */
async function within(folder: string, path: string): Promise<boolean> {
  try {
    const [realFolder, realPath] = await Promise.all([realpath(folder), realpath(path)]);
    return realPath === realFolder || realPath.startsWith(`${realFolder}${sep}`);
  } catch {
    return false;
  }
}

/** A `./` path inside a folder, as Codex resolves one: normal segments only. */
function insidePath(folder: string, path: string): string | undefined {
  if (!path.startsWith('./')) return undefined;
  const rest = path.slice(2);
  if (rest.startsWith('/')) return undefined;
  const segments = rest.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment.includes('\\'))) {
    return undefined;
  }
  return join(folder, ...segments);
}

/**
 * A configured source as a host may show it, as the Grok adapter shows a git
 * address: a folder as it is; an scp-like `git@host:path` as it is too — `git`
 * is the user every git host takes over SSH, and that form holds no password —
 * with any other user masked; any other address as {@link describeMcpUrl}
 * renders one, which masks what it cannot parse.
 */
function shownSource(source: string): string | undefined {
  const trimmed = source.trim();
  const scp = SCHEME.test(trimmed) ? null : SCP_ADDRESS.exec(trimmed);
  const shown =
    isAbsolute(trimmed) || trimmed.startsWith('~/')
      ? trimmed
      : scp
        ? `${scp[1] === undefined ? '' : scp[1] === 'git' ? 'git@' : `${MASKED}@`}${scp[2]}:${scp[3]}`
        : describeMcpUrl(trimmed);
  return shown.length <= 8_192 ? shown : undefined;
}

/** A path under the home as a person reads it, from `~`. */
function fromHome(home: string, path: string): string {
  const inside = relative(home, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) ? `~/${inside.split(sep).join('/')}` : path;
}

/** The first catalog file Codex reads in a marketplace's folder. */
async function catalogFileIn(folder: string): Promise<string | undefined> {
  for (const parts of CATALOG_FILES) {
    const path = join(folder, ...parts);
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // the next place
    }
  }
  return undefined;
}

/** A marketplace a profile knows, and the catalog Codex reads for it. */
interface KnownMarketplace {
  item: MarketplaceItem;
  /** The folder its catalog's `./` plugin paths start from. */
  folder?: string;
  /** The catalog: `{ name, interface?, plugins }`; absent with `unread`. */
  catalog?: Json;
  unread?: string;
}

interface ProfileMarketplaces {
  marketplaces: KnownMarketplace[];
  /** The user layer's `[plugins."<id>"]` keys: each one Codex installed, with its copy in the cache. */
  configured: Set<string>;
  /** config.toml could not be read, so which marketplaces the profile configures is not known. */
  configUnread?: true;
  /** What the read could not cover, in a person's words. */
  unread?: string;
}

/** A catalog document Codex would load: its own name, one Codex keys plugins by, and a list of plugins. */
function catalogShape(document: Json | undefined): Json | undefined {
  const name = typeof document?.name === 'string' ? document.name : undefined;
  return document !== undefined && name !== undefined && MARKETPLACE_NAME.test(name) && Array.isArray(document.plugins)
    ? document
    : undefined;
}

/**
 * Every marketplace a profile knows, in Codex's order — the personal catalog,
 * then the configured and curated ones by folder — each id once.
 */
async function readMarketplaces(root: string, home: string): Promise<ProfileMarketplaces> {
  const problems: string[] = [];
  let config: TomlTable = newTable();
  let configUnread = false;
  try {
    const source = await readSized(join(root, 'config.toml'), MAX_CONFIG_BYTES);
    if (source !== undefined) config = parseCodexConfig(source);
  } catch {
    configUnread = true;
    problems.push('config.toml could not be read');
  }

  const found: Array<KnownMarketplace & { missing: string }> = [];
  const configuredMarketplaces = config.marketplaces;
  if (isTable(configuredMarketplaces)) {
    for (const [name, entry] of Object.entries(configuredMarketplaces)) {
      if (!isTable(entry) || !MARKETPLACE_NAME.test(name)) continue;
      const source = typeof entry.source === 'string' ? text(entry.source) : undefined;
      const shown = source === undefined ? undefined : shownSource(source);
      if (entry.source_type === 'local') {
        // read in place: the folder is the source, and nothing keeps a time for it
        const folder = source !== undefined && isAbsolute(source) ? source : undefined;
        found.push({
          item: {
            kind: 'marketplace',
            id: name,
            name,
            origin: SHIPPED.has(name) ? 'managed' : 'own',
            enabled: true,
            ...(shown ? { source: shown } : {}),
            ...(folder ? { location: folder } : {}),
          },
          ...(folder ? { folder } : {}),
          missing: 'Its folder holds no catalog Codex reads',
        });
        continue;
      }
      const folder = join(root, '.tmp', 'marketplaces', name);
      const updatedAt =
        (await modifiedAt(join(folder, '.codex-marketplace-install.json'))) ?? (await modifiedAt(folder));
      found.push({
        item: {
          kind: 'marketplace',
          id: name,
          name,
          origin: SHIPPED.has(name) ? 'managed' : 'own',
          enabled: true,
          ...(shown ? { source: shown } : {}),
          location: folder,
          ...(updatedAt ? { updatedAt } : {}),
        },
        folder,
        missing: 'Codex has no copy of its catalog in this profile',
      });
    }
  }

  const curated = join(root, '.tmp', 'plugins');
  if (await isDirectory(curated)) {
    const updatedAt = await modifiedAt(join(root, '.tmp', 'plugins.sha'));
    // Codex names the clone by the file it reads there (`managed_marketplace_name`): the openai/plugins
    // catalog, `openai-curated`, which comes first; its API one, `openai-api-curated`, only alone
    const file = await catalogFileIn(curated);
    const id = file === join(curated, '.agents', 'plugins', 'api_marketplace.json') ? CURATED_API : CURATED;
    found.push({
      item: {
        kind: 'marketplace',
        id,
        name: id,
        origin: 'bundled',
        enabled: true,
        location: curated,
        ...(updatedAt ? { updatedAt } : {}),
      },
      folder: curated,
      missing: 'Codex has no copy of its catalog in this profile',
    });
  }
  // Codex sorts its roots by path; a local one with no folder has no catalog, and goes last
  found.sort((left, right) =>
    left.folder === undefined || right.folder === undefined
      ? Number(left.folder === undefined) - Number(right.folder === undefined)
      : byText(left.folder, right.folder),
  );

  // The personal catalog comes first, and names itself: it is no entry of the config.
  const personalFile = await catalogFileIn(home);
  if (personalFile !== undefined) {
    let personal: Json | undefined;
    try {
      personal = catalogShape(await readObject(personalFile, MAX_CATALOG_BYTES));
    } catch {
      personal = undefined;
    }
    const name = personal === undefined ? undefined : text(personal.name);
    if (personal !== undefined && name !== undefined) {
      found.unshift({
        item: {
          kind: 'marketplace',
          id: name,
          name,
          origin: 'own',
          enabled: true,
          shared: true,
          location: personalFile,
        },
        folder: home,
        catalog: personal,
        missing: '',
      });
    } else {
      problems.push(`${fromHome(home, personalFile)} could not be read`);
    }
  }

  const marketplaces: KnownMarketplace[] = [];
  const ids = new Set<string>();
  for (const { missing, ...known } of found) {
    if (ids.has(known.item.id)) {
      // one id is one marketplace to a host: the later is said, never dropped quietly
      problems.push(`two marketplaces are named ${known.item.id}, and only the first is listed`);
      continue;
    }
    ids.add(known.item.id);
    let catalog = known.catalog;
    let unread: string | undefined;
    if (catalog === undefined) {
      const file = known.folder === undefined ? undefined : await catalogFileIn(known.folder);
      if (file === undefined) unread = missing;
      else {
        try {
          catalog = catalogShape(await readObject(file, MAX_CATALOG_BYTES));
        } catch {
          catalog = undefined;
        }
        if (catalog === undefined) unread = 'Its catalog could not be read';
        else if (catalog.name !== known.item.id) {
          // Codex keys a plugin, its config entry and its cached copy by the name the catalog gives
          // itself (`<plugin>@<that name>`), and finds the marketplace `codex plugin add` names by it
          // too; its own add and upgrade keep that name the configured one's. A catalog that names
          // itself otherwise lists nothing here, rather than plugins under a key Codex would refuse.
          // One of Codex's own (the curated clone, one its app writes) must carry its reserved name,
          // or Codex leaves it out altogether (`validate_expected_marketplace_name`).
          unread =
            known.item.origin === 'own'
              ? `Its catalog calls itself ${String(catalog.name)}, the name Codex lists and installs its plugins by`
              : `Its catalog calls itself ${String(catalog.name)}, and Codex takes it only as ${known.item.id}`;
          catalog = undefined;
        }
      }
    }
    const shownName = bounded(text(rec(catalog?.interface)?.displayName), 256);
    marketplaces.push({
      ...known,
      item: { ...known.item, ...(shownName ? { name: shownName } : {}) },
      ...(catalog ? { catalog } : {}),
      ...(unread ? { unread } : {}),
    });
  }

  const configured = new Set<string>();
  const plugins = config.plugins;
  if (isTable(plugins)) {
    for (const [id, entry] of Object.entries(plugins)) if (isTable(entry)) configured.add(id);
  }
  return {
    marketplaces,
    configured,
    ...(configUnread ? { configUnread: true as const } : {}),
    ...(problems.length > 0 ? { unread: problems.join('; ') } : {}),
  };
}

/** What a catalog entry says of its plugin, the way Codex reads it for a listing. */
interface Described {
  displayName?: string;
  shortDescription?: string;
  description?: string;
  developerName?: string;
  category?: string;
  websiteUrl?: string;
  version?: string;
  brings?: CatalogParts;
}

const faceOf = (face: Json): Described => {
  const described: Described = {};
  const displayName = text(face.displayName);
  const shortDescription = text(face.shortDescription);
  const developerName = text(face.developerName);
  const category = text(face.category);
  const websiteUrl = text(face.websiteUrl) ?? text(face.websiteURL);
  if (displayName) described.displayName = displayName;
  if (shortDescription) described.shortDescription = shortDescription;
  if (developerName) described.developerName = developerName;
  if (category) described.category = category;
  if (websiteUrl) described.websiteUrl = websiteUrl;
  return described;
};

/**
 * Who made a plugin, as its catalog entry or manifest says: `author` as text,
 * or an object's `name`, as the Claude and Grok adapters read one. Codex's own
 * listing reads only the object's; a name is a name either way, and
 * {@link authorName} keeps it alone.
 */
function authorOf(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : rec(value)?.name;
  return typeof raw === 'string' ? text(raw) : undefined;
}

/**
 * The entry's own fields, which Codex reads as the plugin's manifest when its
 * source carries none: a git or npm source, or a folder without one.
 */
function describedByEntry(entry: Json): Described {
  const face = rec(entry.interface) ?? {};
  const described = faceOf(face);
  const displayName = described.displayName ?? text(entry.displayName);
  const developerName = described.developerName ?? authorOf(entry.author);
  const websiteUrl = described.websiteUrl ?? text(entry.homepage);
  const description = text(entry.description);
  const version = text(entry.version);
  return {
    ...described,
    ...(displayName ? { displayName } : {}),
    ...(developerName ? { developerName } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
  };
}

const parsedObject = (source: string | undefined): Json | undefined => {
  if (source === undefined) return undefined;
  try {
    return rec(JSON.parse(source));
  } catch {
    return undefined;
  }
};

/**
 * A plugin folder's manifest where Codex finds one (`find_plugin_manifest_path`):
 * a root `plugin.json` that names the Agent Plugins schema, else the first of
 * the older places — never through a link. `none` when Codex finds none, and so
 * reads the catalog entry's own fields instead; `invalid` when it finds one it
 * cannot parse, and so knows nothing of the plugin.
 */
async function pluginManifestIn(
  folder: string,
): Promise<{ format: 'agent' | 'legacy'; manifest: Json } | 'none' | 'invalid'> {
  const root = join(folder, 'plugin.json');
  const rootEntry = await ownEntry(root);
  if (rootEntry === 'folder' || rootEntry === 'other') return 'none';
  if (rootEntry === 'file') {
    const manifest = parsedObject(await ownFile(root));
    const schema = typeof manifest?.$schema === 'string' ? manifest.$schema : undefined;
    if (schema?.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)) {
      return schema === AGENT_PLUGIN_SCHEMA && manifest ? { format: 'agent', manifest } : 'invalid';
    }
  }
  for (const place of PLUGIN_MANIFEST_FOLDERS) {
    const holder = await ownEntry(join(folder, place));
    if (holder === undefined) continue;
    if (holder !== 'folder') return 'none';
    const path = join(folder, place, 'plugin.json');
    const entry = await ownEntry(path);
    if (entry === undefined) continue;
    if (entry !== 'file') return 'none';
    const manifest = parsedObject(await ownFile(path));
    return manifest ? { format: 'legacy', manifest } : 'invalid';
  }
  return 'none';
}

/** An Agent Plugins manifest as Codex reads it: its own fields, or the face its Codex extension or overlay gives. */
async function describedByAgentManifest(folder: string, manifest: Json): Promise<Described> {
  const name = text(manifest.name);
  const description = text(manifest.description);
  const developerName = authorOf(manifest.author);
  const websiteUrl = text(manifest.homepage);
  const version = text(manifest.version);
  const extension = rec(rec(manifest.extensions)?.['com.openai']);
  const overlay = extension ? undefined : parsedObject(await ownFile(join(folder, '.codex-plugin', 'plugin.json')));
  // a Codex extension's face, else the overlay's, replaces the whole one the manifest's own fields make
  const replaced = rec((extension ?? overlay)?.interface);
  const face: Described = replaced
    ? faceOf(replaced)
    : {
        ...(name ? { displayName: name } : {}),
        ...(description ? { shortDescription: description } : {}),
        ...(developerName ? { developerName } : {}),
        category: 'Other',
        ...(websiteUrl ? { websiteUrl } : {}),
      };
  return { ...face, ...(description ? { description } : {}), ...(version ? { version } : {}) };
}

function describedByLegacyManifest(manifest: Json): Described {
  const described = faceOf(rec(manifest.interface) ?? {});
  const description = text(manifest.description);
  const version = text(manifest.version);
  return { ...described, ...(description ? { description } : {}), ...(version ? { version } : {}) };
}

/** A plugin file's server names: `{ mcpServers: { … } }`, or the servers' map itself. */
function serverNames(document: Json | undefined): string[] {
  if (!document) return [];
  const servers = rec(document.mcpServers) ?? document;
  return Object.entries(servers)
    .filter(([name, server]) => rec(server) !== undefined && name.trim() !== '' && name.length <= 256)
    .map(([name]) => name);
}

/**
 * What a local plugin brings, by name, from its own folder: the skill folders
 * where Codex looks for its skills, and its servers — never past a link, and
 * never more than a few hundred entries.
 */
async function bringsOf(folder: string, format: 'agent' | 'legacy', manifest: Json): Promise<CatalogParts | undefined> {
  const declared = format === 'legacy' ? manifest.skills : undefined;
  const declaredPaths = typeof declared === 'string' ? [declared] : strings(declared);
  const skillRoots = (declaredPaths.length > 0 ? declaredPaths : ['./skills'])
    .map((path) => insidePath(folder, path))
    .filter((path): path is string => path !== undefined);
  const skills: string[] = [];
  let budget = MAX_PLUGIN_ENTRIES;
  for (const skillRoot of skillRoots) {
    if (budget <= 0 || (await ownEntry(skillRoot)) !== 'folder') continue;
    // a declared folder may be one skill itself
    if ((await ownEntry(join(skillRoot, 'SKILL.md'))) === 'file') {
      skills.push(basename(skillRoot));
      budget -= 1;
      continue;
    }
    let entries: Dirent[];
    try {
      entries = (await readdir(skillRoot, { withFileTypes: true })).slice(0, budget);
    } catch {
      continue;
    }
    budget -= entries.length;
    for (const entry of entries.sort((left, right) => byText(left.name, right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if ((await ownEntry(join(skillRoot, entry.name, 'SKILL.md'))) === 'file') skills.push(entry.name);
    }
  }

  let servers: string[] = [];
  const declaredServers = format === 'legacy' ? manifest.mcpServers : undefined;
  if (rec(declaredServers)) {
    servers = serverNames({ mcpServers: declaredServers });
  } else {
    const file =
      format === 'agent'
        ? join(folder, 'mcp.json')
        : typeof declaredServers === 'string'
          ? insidePath(folder, declaredServers)
          : join(folder, '.mcp.json');
    if (file !== undefined) servers = serverNames(parsedObject(await ownFile(file)));
  }

  const unique = (values: string[], max: number) =>
    [...new Set(values)].filter((value) => value.trim() !== '' && value.length <= 256).slice(0, max);
  const brought: CatalogParts = {
    ...(skills.length > 0 ? { skills: unique(skills, 256) } : {}),
    ...(servers.length > 0 ? { servers: unique(servers, 64) } : {}),
  };
  return Object.keys(brought).length > 0 ? brought : undefined;
}

/** Where a catalog entry's plugin comes from: a folder in the marketplace, or a source Codex fetches. */
function entrySource(source: unknown, folder: string | undefined): { local: string } | { remote: true } | undefined {
  const local = (path: string): { local: string } | undefined => {
    if (folder === undefined) return undefined;
    const resolved = path === '.' || path === './' ? folder : insidePath(folder, path);
    return resolved === undefined ? undefined : { local: resolved };
  };
  if (typeof source === 'string') return local(source);
  const described = rec(source);
  switch (described?.source) {
    case 'local':
      return typeof described.path === 'string' ? local(described.path) : undefined;
    case 'url':
    case 'git-subdir':
      return text(described.url) ? { remote: true } : undefined;
    case 'npm':
      return text(described.package) ? { remote: true } : undefined;
    default:
      // a source Codex does not support: it skips the entry
      return undefined;
  }
}

/**
 * A developer's name as a listing shows it: npm's `Name <email> (address)`
 * keeps the name alone, and any email-shaped word goes. Each pattern stops at
 * the next bracket of its own kind and a word's `@` is found as text, so an
 * author from a catalog, which anyone may write, is read in one pass however
 * it is crafted, as the Grok adapter reads one: `<[^>]*>`, `\S+@\S+` and a
 * `(…@…)` pattern would backtrack on a long run that never ends them.
 */
function authorName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value
    .replace(/<[^<>]*>/gu, ' ')
    .replace(/\([^()]*\)/gu, (group) => (group.includes('://') || group.includes('@') ? ' ' : group))
    .split(/[\s\u0000-\u001f\u007f]+/u)
    // a word with an `@` inside it is an address, as `\S+@\S+` would find it
    .filter((word) => !word.slice(1, -1).includes('@'))
    .join(' ')
    .trim();
  return name !== '' && name.length <= 256 ? name : undefined;
}

function shownHomepage(value: string | undefined): string | undefined {
  if (value === undefined || !SCHEME.test(value)) return undefined;
  const shown = describeMcpUrl(value);
  return shown !== MASKED && shown.length <= 8_192 ? shown : undefined;
}

/** Codex's order of version folders (`compare_plugin_versions`): semver where both are, else by their text. */
function compareVersions(left: string, right: string): number {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
  const a = semver.exec(left);
  const b = semver.exec(right);
  if (!a || !b) return byText(left, right);
  const number = (x: string, y: string) => (x.length !== y.length ? x.length - y.length : byText(x, y));
  for (const index of [1, 2, 3]) {
    const order = number(a[index]!, b[index]!);
    if (order !== 0) return order;
  }
  const [preA, preB] = [a[4], b[4]];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let index = 0; index < Math.min(partsA.length, partsB.length); index++) {
    const [x, y] = [partsA[index]!, partsB[index]!];
    const numeric = /^\d+$/u;
    const order =
      numeric.test(x) && numeric.test(y) ? number(x, y) : numeric.test(x) ? -1 : numeric.test(y) ? 1 : byText(x, y);
    if (order !== 0) return order;
  }
  return partsA.length - partsB.length;
}

/** The version of the copy Codex holds of a plugin (`active_plugin_version`), or undefined when it holds none. */
async function heldVersion(root: string, marketplace: string, plugin: string): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, 'plugins', 'cache', marketplace, plugin), { withFileTypes: true });
  } catch {
    return undefined;
  }
  const versions = entries
    .filter((entry) => entry.isDirectory() && VERSION_SEGMENT.test(entry.name) && !/^\.\.?$/u.test(entry.name))
    .map((entry) => entry.name);
  if (versions.length === 0) return undefined;
  if (versions.includes('local')) return 'local';
  return versions.sort(compareVersions)[versions.length - 1];
}

/** `task` for each item, a few at a time, with its answers in the items' order. */
async function mapBounded<T, R>(
  items: readonly T[],
  lanes: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const answers = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) answers[index] = await task(items[index]!, index);
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
  return answers;
}

/** What a listed plugin's own folder says of it, the way Codex reads one for its listing. */
async function describedByFolder(marketplaceFolder: string, folder: string, entry: Json): Promise<Described> {
  // a folder a link leads out of the marketplace is not read
  if (!(await within(marketplaceFolder, folder))) return describedByEntryAlone(entry);
  const found = await pluginManifestIn(folder);
  if (found === 'invalid') return {};
  const described =
    found === 'none'
      ? describedByEntry(entry)
      : found.format === 'agent'
        ? await describedByAgentManifest(folder, found.manifest)
        : describedByLegacyManifest(found.manifest);
  // with no manifest of its own, the entry's fields are the one Codex reads, paths and all
  const brings =
    found === 'none' ? await bringsOf(folder, 'legacy', entry) : await bringsOf(folder, found.format, found.manifest);
  return brings ? { ...described, brings } : described;
}

/**
 * What the entry says of itself, and no version: the copy Codex would hold is
 * versioned by a manifest this read has not seen — one fetched from git or npm
 * when installed, or a folder this read does not open.
 */
function describedByEntryAlone(entry: Json): Described {
  const described = describedByEntry(entry);
  delete described.version;
  return described;
}

/**
 * One marketplace's listed plugins, in its catalog's order, each key once
 * (Codex keeps the first). A plugin's key is `<plugin>@<marketplace>` by the
 * marketplace's id, which its catalog's own name matches (readMarketplaces):
 * the key Codex installs, records and caches it by.
 */
async function listedPlugins(
  root: string,
  known: KnownMarketplace,
  configured: Set<string>,
  room: number,
): Promise<CatalogPlugin[]> {
  const catalog = known.catalog;
  if (!catalog) return [];
  const marketplace = known.item.id;
  const entries: Array<{ entry: Json; name: string; id: string; source: { local: string } | { remote: true } }> = [];
  const seen = new Set<string>();
  for (const raw of list(catalog.plugins)) {
    if (entries.length >= room) break;
    const entry = rec(raw);
    const name = text(entry?.name);
    if (!entry || !name || !PLUGIN_NAME.test(name)) continue;
    const id = `${name}@${marketplace}`;
    const source = entrySource(entry.source, known.folder);
    if (id.length > 512 || source === undefined || seen.has(id)) continue;
    seen.add(id);
    const products = rec(entry.policy)?.products;
    // an entry for other OpenAI products only is left out of Codex's own listing
    if (
      Array.isArray(products) &&
      !products.some((product) => typeof product === 'string' && product.toLowerCase() === 'codex')
    ) {
      continue;
    }
    entries.push({ entry, name, id, source });
  }

  return mapBounded(entries, CATALOG_LANES, async ({ entry, name, id, source }, index): Promise<CatalogPlugin> => {
    const held = configured.has(id) ? await heldVersion(root, marketplace, name) : undefined;
    const described =
      'local' in source && known.folder !== undefined && (index < MAX_CATALOG_FOLDERS || held !== undefined)
        ? await describedByFolder(known.folder, source.local, entry)
        : describedByEntryAlone(entry);
    const shownName = bounded(described.displayName, 256) ?? name.slice(0, 256);
    const description = (described.shortDescription ?? described.description)?.slice(0, 2_048);
    const author = authorName(described.developerName);
    // the marketplace's category wins over the plugin's own
    const category = bounded(text(entry.category) ?? described.category, 64);
    const version =
      described.version !== undefined && VERSION_SEGMENT.test(described.version) ? described.version : undefined;
    const homepage = shownHomepage(described.websiteUrl);
    const newer =
      held !== undefined &&
      marketplace !== CURATED &&
      marketplace !== CURATED_API &&
      version !== undefined &&
      !UNVERSIONED.test(held) &&
      held !== version;
    return {
      id,
      name: shownName,
      marketplace,
      ...(description ? { description } : {}),
      ...(author ? { author } : {}),
      ...(category ? { category } : {}),
      ...(version ? { version } : {}),
      ...(homepage ? { homepage } : {}),
      ...(described.brings ? { brings: described.brings } : {}),
      ...(text(rec(entry.policy)?.installation) === 'NOT_AVAILABLE'
        ? { blocked: 'Codex does not offer it for install' }
        : {}),
      ...(held !== undefined ? { held: id } : {}),
      ...(newer ? { newer: true as const } : {}),
    };
  });
}

/**
 * An act on a marketplace: Codex's own `codex plugin marketplace` command. A
 * git one is fetched again and a local one is read where it is; the curated
 * catalog and the ones Codex's app writes are Codex's; the personal catalog is
 * a file every profile reads.
 */
function marketplacePlan(
  executable: string,
  profile: AgentProfile,
  item: MarketplaceItem,
  act: ExtensionActKind,
  home: string,
): ExtensionActPlan {
  const target: ExtensionActTarget = { kind: 'marketplace', id: item.id };
  const command = (args: string[], reaches: ExtensionReach[]) =>
    extensionCommandPlan({
      target,
      act,
      argv: codexArgv(executable, ['plugin', 'marketplace', ...args, '--json']),
      env: codexProfileBinding(profile),
      reaches,
    });
  if (act === 'add') {
    if (item.source === undefined || !isExtensionSource(item.source)) {
      return extensionActUnavailable(
        target,
        act,
        'unsupported',
        'Codex adds a marketplace from a GitHub repository, a git address or a folder',
      );
    }
    return command(['add', item.source], []);
  }
  if (act !== 'update' && act !== 'remove') {
    return extensionActUnavailable(target, act, 'unsupported', 'Codex adds, upgrades or removes a marketplace');
  }
  if (item.origin === 'bundled' || item.origin === 'managed') {
    return extensionActUnavailable(
      target,
      act,
      'not-own',
      act === 'update' ? 'Codex keeps it current itself' : 'It ships with Codex',
    );
  }
  if (item.shared === true) {
    return act === 'update'
      ? extensionActUnavailable(target, act, 'unsupported', 'Codex reads a local marketplace where it is')
      : extensionActUnavailable(
          target,
          act,
          'not-own',
          `It is \`${item.location === undefined ? '~/.agents/plugins/marketplace.json' : fromHome(home, item.location)}\`, which every Codex profile reads; it changes there`,
        );
  }
  if (item.origin !== 'own')
    return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Codex', item));
  if (!EXTENSION_COMMAND_NAME.test(item.id)) {
    return extensionActUnavailable(target, act, 'unsupported', "Codex's commands do not take this marketplace's name");
  }
  if (act === 'remove') return command(['remove', item.id], []);
  // a git marketplace's snapshot is Codex's own copy; any other is a folder Codex reads in place
  if (item.location !== join(profile.dataRoot, '.tmp', 'marketplaces', item.id)) {
    return extensionActUnavailable(target, act, 'unsupported', 'Codex reads a local marketplace where it is');
  }
  return command(['upgrade', item.id], ['plugins']);
}

/** Codex extension capability: one app-server session and one `mcp list` per inventory. */
export function createCodexExtensionService(options: CodexExtensionOptions = {}): ExtensionService {
  const executable = resolveCodexExecutable(options.executable, options.env ?? process.env);
  const now = options.now ?? (() => new Date());
  const spawnTransport = options.spawnTransport ?? ((spawnOptions) => spawnAppServerTransport(spawnOptions));
  const listServers = options.listServers ?? defaultListServers;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const home = options.home ?? homedir();
  // Codex's `user` skill scope, `$HOME/.agents/skills`: the only folder it reads a person's skills from.
  const sharedSkills = join(home, '.agents', 'skills');
  // Per profile root, the enterprise-managed servers its last inventory found (see above).
  const enterpriseServers = new Map<string, ReadonlySet<string>>();

  const provider: ExtensionProvider = {
    id: 'codex',
    label: 'Codex',
    support: {
      // `codex plugin add|remove`, installed per CODEX_HOME, from a marketplace only, whose catalogs are files.
      plugins: { store: 'profile', changes: 'command', read: true, catalog: true },
      // `[marketplaces.*]` per root, plus the personal catalog every profile reads from `~/.agents/plugins/`.
      marketplaces: {
        store: 'mixed',
        changes: 'command',
        read: true,
        sources: 'A GitHub repository (owner/repo), a git address, or a folder',
      },
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
      const enterprise = config ? enterpriseServersFrom(config.value) : undefined;
      const skillItems = skills ? await skillsFrom(skills.value) : undefined;
      return {
        ...(skillItems ? { skills: skillItems } : {}),
        ...(plugins ? { plugins } : {}),
        ...(origins ? { origins } : {}),
        ...(pluginServers ? { pluginServers } : {}),
        ...(enterprise ? { enterpriseServers: enterprise } : {}),
      };
    } finally {
      if (client) await client.close();
      else await transport?.close();
    }
  }

  function plan(
    profile: AgentProfile,
    item: ExtensionActItem,
    act: ExtensionActKind,
    planOptions: ExtensionActPlanOptions = {},
  ): ExtensionActPlan {
    if (item.kind === 'plugin') return pluginPlan(executable, profile, item, act, planOptions);
    if (item.kind === 'marketplace') return marketplacePlan(executable, profile, item, act, home);
    const target = { kind: item.kind, id: item.id };
    if (act === 'install') {
      return extensionActUnavailable(target, act, 'unsupported', 'Codex installs plugins, from its marketplaces');
    }
    // An add plans from an item no read found, so it answers apart from every act on one held.
    if (act === 'add') return item.kind === 'skill' ? skillAddPlan(item, sharedSkills, home) : addPlan(target, item);
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Codex', item));
    }
    if (item.kind === 'mcp-server') {
      if (!EXTENSION_COMMAND_NAME.test(item.id)) {
        return extensionActUnavailable(target, act, 'no-command', "Codex's commands do not take this server's name");
      }
      if (act === 'sign-in' || act === 'sign-out') {
        const enterprise = item.transport === 'http' && enterpriseServers.get(profile.dataRoot)?.has(item.id) === true;
        if (enterprise && act === 'sign-in') {
          return extensionActUnavailable(
            target,
            act,
            'in-app',
            `Codex signs in to ${item.name} with the Codex account's own sign-in, in Codex itself`,
          );
        }
        // `mcp list` says "signed in" or "asks" only for a server Codex can sign in to; an enterprise
        // server's sign-out stays, as Codex keeps it, even when the list cannot tell its state.
        if (item.transport !== 'http' || (item.auth === undefined && !enterprise)) {
          return extensionActUnavailable(
            target,
            act,
            'no-sign-in',
            item.transport === 'http'
              ? `Codex has no sign-in for ${item.name}: it sends a key, or asks for none`
              : `${item.name} runs on this machine and has no sign-in`,
          );
        }
        const fields = {
          target,
          act,
          argv: codexArgv(executable, ['mcp', act === 'sign-in' ? 'login' : 'logout', item.id]),
          env: codexProfileBinding(profile),
          reaches: enterprise ? ENTERPRISE_SIGN_OUT_REACHES : SIGN_IN_REACHES,
        };
        return act === 'sign-in' ? extensionTerminalPlan(fields) : extensionCommandPlan(fields);
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
    // A skill of your own lives in ~/.agents/skills; Codex's switch for it is this profile's alone, and taking
    // the folder away would take it from every other profile and agent that reads it.
    if (act === 'remove') {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        `${item.name} is in ~/.agents/skills, which every Codex profile and other agents read; Codex's switch turns it off here`,
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
      const [session, listing, marketplaces] = await Promise.allSettled([
        readSession(env, root),
        listServers({ executable, env, cwd: root }),
        readMarketplaces(root, home),
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
      if (read.enterpriseServers) enterpriseServers.set(root, read.enterpriseServers);
      else enterpriseServers.delete(root);
      const items: ExtensionItem[] = [];
      const unread: NonNullable<ExtensionInventory['unread']> = [];

      if (read.plugins) items.push(...read.plugins.items);
      else unread.push({ kind: 'plugin', message: '`plugin/installed` could not be read' });

      if (marketplaces.status === 'rejected') {
        unread.push({ kind: 'marketplace', message: 'the marketplaces could not be read' });
      } else {
        items.push(...marketplaces.value.marketplaces.map(({ item }) => item));
        if (marketplaces.value.unread) unread.push({ kind: 'marketplace', message: marketplaces.value.unread });
      }

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

    // Files only (see above): no app-server, no command, no network.
    async catalog(profile: AgentProfile): Promise<ExtensionCatalog | ExtensionFailure> {
      const root = profile.dataRoot;
      if (!(await isDirectory(root))) {
        return {
          status: 'not-found',
          provider: 'codex',
          message: 'this profile has no Codex root on disk yet',
          retryable: false,
        };
      }
      const known = await readMarketplaces(root, home);
      if (known.configUnread) {
        return {
          status: 'unavailable',
          provider: 'codex',
          message: "this profile's config.toml could not be read, so its marketplaces are not known",
          retryable: true,
        };
      }
      const marketplaces: CatalogMarketplace[] = [];
      const plugins: CatalogPlugin[] = [];
      for (const marketplace of known.marketplaces.slice(0, MAX_CATALOG_MARKETPLACES)) {
        const { item } = marketplace;
        marketplaces.push({
          id: item.id,
          name: item.name,
          ...(item.source !== undefined ? { source: item.source } : {}),
          ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
          origin: item.origin,
          ...(item.shared ? { shared: true as const } : {}),
          ...(marketplace.unread !== undefined ? { unread: marketplace.unread } : {}),
        });
        const room = MAX_CATALOG_PLUGINS - plugins.length;
        if (room > 0) plugins.push(...(await listedPlugins(root, marketplace, known.configured, room)));
      }
      return {
        provider: 'codex',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        marketplaces,
        plugins,
        // Codex clones it itself when it starts, from a reserved name no add may take
        ...(known.marketplaces.some(({ item }) => item.id === CURATED || item.id === CURATED_API)
          ? {}
          : {
              suggested: [
                {
                  name: CURATED,
                  message: 'Codex fetches its curated catalog the first time it starts in this profile',
                },
              ],
            }),
        source: { kind: 'native-store', stability: 'experimental' },
      };
    },
  };
}
