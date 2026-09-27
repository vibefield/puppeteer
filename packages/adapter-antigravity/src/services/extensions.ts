/**
 * Antigravity extensions (RFC 006 C1): the plugins, MCP servers and skills one
 * profile's home holds, read from Antigravity's own files. Its listings are
 * not run: `agy plugin list` prints the import ledger alone, so a plugin copied
 * into place by hand, which a session still loads, is missing from it, and
 * `agy mcp list` prints a text table of the user file alone. No secret is
 * kept: Antigravity stores a server's environment, headers and OAuth client
 * secret as literal values in `mcp_config.json`, and only names are read out
 * of it.
 *
 * Layout per James's probe of 1.2.11 (puppeteer
 * draft/ANTIGRAVITY-PLUGINS-SKILLS-MCP.md, 2026-09-24), under the home a
 * profile binds (`PUPPETEER_ANTIGRAVITY_HOME`, which the driver makes `HOME`):
 * - `.gemini/config/` is the customization root the CLI shares with the IDE
 *   and Antigravity 2.0 on that home. `plugins/<name>/` holds each plugin,
 *   marked by `plugin.json` (`name` defaults to the folder, `"disabled": true`
 *   ships it off), whether `agy plugin install` put it there or a person did;
 *   `config.json` `plugins.<name>.enabled` switches one, and without an entry
 *   the manifest decides. `skills/<name>/SKILL.md` are the person's skills, and
 *   `mcp_config.json` `{ mcpServers }` their servers, in JSON that may carry
 *   comments and trailing commas.
 * - A plugin brings `skills/<name>/SKILL.md` and its own `mcp_config.json`
 *   (`mcp.json` is copied and ignored); a session names those servers
 *   `<plugin>_<server>`.
 * - `.gemini/antigravity-cli/builtin/skills/` caches the skills that ship with
 *   the CLI.
 * - `skills.json` and `plugins.json` register more folders. The probe found
 *   their schema, not where the global ones live, so one at the top of
 *   `config/` is reported as unread rather than followed.
 * A workspace's `.agents/` belongs to its repository, not the profile, and the
 * OAuth token file for MCP servers is never opened. The layout is not yet a
 * Surface claim, so the source is experimental.
 */

import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  describeMcpCommand,
  describeMcpUrl,
  EXTENSION_COMMAND_NAME,
  extensionActUnavailable,
  extensionCommandPlan,
  extensionNotOwnWords,
  extensionSkillFolderPlan,
  mcpServerDefinition,
  parseSkillFrontmatter,
  type AgentProfile,
  type ExtensionActKind,
  type ExtensionActPlan,
  type ExtensionActPlanOptions,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionProvider,
  type ExtensionService,
  type McpServerDefinition,
  type McpServerItem,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { resolveAntigravityExecutable } from '../detection.js';
import { ANTIGRAVITY_PROFILE_ROOT_VARIABLE } from './profiles.js';

export interface AntigravityExtensionOptions {
  /** Home directory the native default hangs off; defaults to the process home. Injected so tests never read the real one. */
  home?: string;
  now?: () => Date;
  /** The executable an act runs; the adapter's own resolution when absent. */
  executable?: string;
  env?: NodeJS.ProcessEnv;
}

/** The customization root and the CLI's own store, relative to the home a profile runs under. */
const CONFIG = ['.gemini', 'config'] as const;
const BUILTIN_SKILLS = ['.gemini', 'antigravity-cli', 'builtin', 'skills'] as const;

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FOLDERS = 512;
/** What `agy plugin validate` accepts as a plugin name. */
const PLUGIN_NAME = /^[A-Za-z0-9_-]+$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const bounded = (value: string | undefined, max: number): string | undefined =>
  value !== undefined && value.length <= max ? value : undefined;
const names = (values: Iterable<string>, pattern: RegExp): string[] =>
  [...new Set(values)].filter((value) => pattern.test(value)).slice(0, 64);

/**
 * JSON with `//` and `/* *\/` comments and trailing commas, which Antigravity's
 * MCP files allow. Both passes skip string contents, so a `//` inside a value
 * stays. Anything else malformed throws, as `JSON.parse` does.
 */
function parseJsonc(source: string): unknown {
  let stripped = '';
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      stripped += char;
      if (char === '\\') stripped += source[++index] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      stripped += char;
    } else if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = (end === -1 ? source.length : end) - 1;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) throw new SyntaxError('unterminated comment');
      stripped += ' ';
      index = end + 1;
    } else {
      stripped += char;
    }
  }
  let cleaned = '';
  inString = false;
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index]!;
    if (inString) {
      cleaned += char;
      if (char === '\\') cleaned += stripped[++index] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      cleaned += char;
    } else if (char === ',') {
      let next = index + 1;
      while (next < stripped.length && /\s/u.test(stripped[next]!)) next += 1;
      // A trailing comma: the next token closes the object or array.
      if (stripped[next] !== '}' && stripped[next] !== ']') cleaned += char;
    } else {
      cleaned += char;
    }
  }
  return JSON.parse(cleaned);
}

/**
 * A file that is absent reads as undefined; one that exists and cannot be
 * parsed throws for the caller to report. The parser's message quotes its
 * input, which may hold a secret, so no caller ever repeats it.
 */
async function readDocument(path: string, limit: number, commented = false): Promise<Json | undefined> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
  if (size > limit) throw new Error(`larger than ${limit} bytes`);
  const contents = await readFile(path, 'utf8');
  const document = rec(commented ? parseJsonc(contents) : JSON.parse(contents));
  if (!document) throw new Error('not a JSON object');
  return document;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string, limit = MAX_MANIFEST_BYTES): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > limit) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The visible folders (or links to them) directly inside one, in name order. */
async function folders(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_FOLDERS);
  } catch {
    return [];
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

interface SkillFolder {
  folder: string;
  folderName: string;
  name: string;
  description?: string;
  linkTarget?: string;
}

/** Each `<name>/SKILL.md` directly inside a skills folder; `name` defaults to the folder's. */
async function skillFolders(root: string): Promise<SkillFolder[]> {
  const skills: SkillFolder[] = [];
  for (const folderName of await folders(root)) {
    const folder = join(root, folderName);
    const document = await readText(join(folder, 'SKILL.md'));
    if (document === undefined) continue;
    const frontmatter = parseSkillFrontmatter(document);
    const linkTarget = await linkTargetOf(folder);
    skills.push({
      folder,
      folderName,
      name: frontmatter.name ?? folderName,
      ...(frontmatter.description ? { description: frontmatter.description.slice(0, 2_048) } : {}),
      ...(linkTarget ? { linkTarget } : {}),
    });
  }
  return skills;
}

/**
 * One server as a listing may show it. A definition with neither `command` nor
 * `serverUrl` — the stub `agy mcp disable` leaves for a name it never had —
 * yields nothing; nor does anything under `oauth`, where the client secret is.
 */
function serverItem(
  name: string,
  definition: unknown,
  fields: Pick<McpServerItem, 'id' | 'origin' | 'enabled' | 'location'> & Partial<Pick<McpServerItem, 'plugin'>>,
): McpServerItem | undefined {
  const server = rec(definition);
  const serverName = bounded(text(name), 256);
  if (!server || !serverName || fields.id.length > 512) return undefined;
  const command = text(server.command);
  const url = text(server.serverUrl);
  let transport: McpServerItem['transport'];
  let target: string;
  if (command) {
    transport = 'stdio';
    target = describeMcpCommand(command, strings(server.args));
  } else if (url) {
    // `serverUrl` is Streamable HTTP or SSE; only an explicit type says which.
    transport = text(server.type) === 'sse' ? 'sse' : 'http';
    target = describeMcpUrl(url);
  } else {
    return undefined;
  }
  if (target.length > 8_192) return undefined;
  const env = names(Object.keys(rec(server.env) ?? {}), ENVIRONMENT_NAME);
  const headers = names(Object.keys(rec(server.headers) ?? {}), HEADER_NAME);
  // A plugin's server comes and goes with its plugin, and may run from its folder: only the person's own travel.
  const portable = fields.origin === 'own' ? definitionOf(server, transport) : undefined;
  return {
    kind: 'mcp-server',
    ...fields,
    name: serverName,
    transport,
    target,
    ...(env.length > 0 ? { env } : {}),
    ...(headers.length > 0 ? { headers } : {}),
    ...(portable === undefined ? {} : { definition: portable }),
  };
}

/**
 * The server as another agent could take it, which Core decides from the
 * values as Antigravity keeps them, before any masking — every `env` and
 * `headers` key, and `args` only when all text. None when the entry holds what
 * a definition cannot carry: a working folder (`cwd`), a fixed OAuth client
 * whose secret stays behind (`oauth`), or Google credentials
 * (`authProviderType`).
 */
function definitionOf(server: Json, transport: McpServerItem['transport']): McpServerDefinition | undefined {
  if (server.cwd !== undefined || server.oauth !== undefined || server.authProviderType !== undefined) return undefined;
  const args = server.args ?? [];
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) return undefined;
  return mcpServerDefinition({
    transport,
    command: text(server.command),
    args,
    url: text(server.serverUrl),
    env: Object.keys(rec(server.env) ?? {}),
    headers: Object.keys(rec(server.headers) ?? {}),
  });
}

/** Antigravity extension capability: the customization root and the CLI's builtin skills, per home. */
export function createAntigravityExtensionService(options: AntigravityExtensionOptions = {}): ExtensionService {
  const nativeHome = options.home ?? homedir();
  const now = options.now ?? (() => new Date());

  const provider: ExtensionProvider = {
    id: 'antigravity',
    label: 'Antigravity',
    support: {
      // `agy plugin install|enable|disable|uninstall`, under the bound home.
      plugins: { store: 'profile', changes: 'command', read: true },
      // `agy plugin install <name>@<marketplace>` and `plugin link` exist; where a marketplace is registered was not found.
      marketplaces: { store: 'profile', changes: 'command', read: false },
      // `agy mcp add|enable|disable|remove` edit the home's `mcp_config.json`.
      mcpServers: { store: 'profile', changes: 'command', read: true },
      // No skills command: a skill is a folder, and nothing switches one off.
      skills: { store: 'profile', changes: 'folder', read: true },
    },
  };

  // A managed root is the home the child runs under; the native default is
  // the process home, whatever root variable the host happens to inherit.
  const homeOf = (profile: AgentProfile): string => (profile.kind === 'managed' ? profile.dataRoot : nativeHome);

  const executable = resolveAntigravityExecutable(options.executable, options.env ?? process.env);
  const profileEnv = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'managed' ? { HOME: profile.dataRoot, [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: profile.dataRoot } : {};

  // Acts (RFC 006 C2): a server of the home's own `mcp_config.json` turns on and
  // off with `agy mcp enable|disable <name>` under the profile's HOME — only a
  // name the read found, since disabling an unknown one writes a stub. A
  // server's removal was not probed and is not offered. A server a host keeps
  // comes in with `agy mcp add`, stdio or Streamable HTTP, and never one that
  // reads a variable: `--env` stores a literal value. Skills switch only inside
  // the app, and are placed as folders (`planSkill`).
  function plan(
    profile: AgentProfile,
    item: McpServerItem | SkillItem,
    act: ExtensionActKind,
    options: ExtensionActPlanOptions = {},
  ): ExtensionActPlan {
    if (item.kind === 'skill') return planSkill(profile, item, act, options);
    if (act === 'add') return planAdd(profile, item);
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Antigravity', item));
    }
    if (act === 'sign-in' || act === 'sign-out') {
      return item.transport === 'stdio'
        ? extensionActUnavailable(target, act, 'no-sign-in', `${item.name} runs on this machine and has no sign-in`)
        : extensionActUnavailable(target, act, 'in-app', 'Antigravity signs in to a server only in its /mcp panel');
    }
    if (act === 'remove') {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        'Removing a server from Antigravity is not offered yet: turn it off instead',
      );
    }
    if (!EXTENSION_COMMAND_NAME.test(item.id)) {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        "Antigravity's commands do not take this server's name",
      );
    }
    return extensionCommandPlan({
      target,
      act,
      argv: [executable, 'mcp', act, item.id],
      env: profileEnv(profile),
    });
  }

  /**
   * `agy mcp add` writes the server into the home's `mcp_config.json`: stdio,
   * or Streamable HTTP when the positional after the name is an http(s)
   * address, so an SSE server has no add. Antigravity reads a server's values
   * only as literals in that file (`--env KEY=value` stores one), and a host
   * keeps values out of an agent's files, so a server that reads a variable is
   * not added. As the CLI's own help shows, the `--` before the command is how
   * a command line with flags of its own reaches the server instead of
   * `agy mcp add`.
   */
  function planAdd(profile: AgentProfile, item: McpServerItem): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    const unsupported = (message: string) => extensionActUnavailable(target, 'add', 'unsupported', message);
    if (item.definition === undefined) {
      return unsupported('Antigravity adds only a server, from its definition');
    }
    if (!EXTENSION_COMMAND_NAME.test(item.id)) {
      return extensionActUnavailable(
        target,
        'add',
        'no-command',
        "Antigravity's commands do not take this server's name",
      );
    }
    const { definition } = item;
    let server: string[];
    if (definition.transport === 'stdio') {
      if (definition.env !== undefined) {
        return unsupported("Antigravity reads a server's values only from its own file, never from a variable");
      }
      server = [item.id, '--', definition.command, ...definition.args];
    } else if (definition.transport === 'sse') {
      return unsupported('Antigravity adds a remote server by its command only as Streamable HTTP');
    } else if (!/^https?:\/\//u.test(definition.url)) {
      // Any other positional is a command to Antigravity's add.
      return unsupported('Antigravity adds a remote server only at an http(s) address');
    } else {
      server = [item.id, definition.url];
    }
    return extensionCommandPlan({
      target,
      act: 'add',
      argv: [executable, 'mcp', 'add', ...server],
      env: profileEnv(profile),
      reaches: [],
    });
  }

  /**
   * A skill the host keeps is linked into the bound home's
   * `.gemini/config/skills/`, the one folder of the person's own skills;
   * taking one away unlinks it, or moves a real folder of the person's to
   * where the host keeps it. The builtins and a plugin's skills are not the
   * person's to place or take. Whether Antigravity itself follows a linked
   * skill folder is unproven (the 1.2.11 probe placed none; `/skills reload`
   * would tell): the read here follows links, and the runtime's second read is
   * the receipt.
   */
  function planSkill(
    profile: AgentProfile,
    item: SkillItem,
    act: ExtensionActKind,
    options: ExtensionActPlanOptions,
  ): ExtensionActPlan {
    if (act === 'add' || act === 'remove') {
      return extensionSkillFolderPlan({
        label: 'Antigravity',
        folder: join(homeOf(profile), ...CONFIG, 'skills'),
        item,
        act,
        ...(act === 'remove' && options.keepIn !== undefined ? { keepIn: options.keepIn } : {}),
        home: nativeHome,
      });
    }
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Antigravity', item));
    }
    return extensionActUnavailable(target, act, 'in-app', 'Antigravity switches a skill only inside the app');
  }

  return {
    provider,
    plan,

    async inventory(profile: AgentProfile): Promise<ExtensionInventory> {
      const home = homeOf(profile);
      const config = join(home, ...CONFIG);
      const plugins: PluginItem[] = [];
      const servers: McpServerItem[] = [];
      const skills: SkillItem[] = [];
      const unread = new Map<ExtensionKind, string>();
      const report = (kind: ExtensionKind, message: string) => {
        if (!unread.has(kind)) unread.set(kind, message);
      };
      const serverIds = new Set<string>();
      const skillIds = new Set<string>();
      const addServer = (item: McpServerItem | undefined) => {
        if (!item || serverIds.has(item.id)) return;
        serverIds.add(item.id);
        servers.push(item);
      };
      const addSkill = (item: SkillItem) => {
        if (item.name.length > 256 || item.id.length > 512 || skillIds.has(item.id)) return;
        skillIds.add(item.id);
        skills.push(item);
      };

      // Which plugins are on. Unreadable, every plugin falls back to its manifest.
      let switches: Json | undefined;
      try {
        switches = rec((await readDocument(join(config, 'config.json'), MAX_CONFIG_BYTES))?.plugins);
      } catch {
        report('plugin', 'config.json could not be read');
      }

      const pluginIds = new Set<string>();
      for (const folderName of await folders(join(config, 'plugins'))) {
        const folder = join(config, 'plugins', folderName);
        // No manifest is no plugin; one that does not parse is one Antigravity cannot load either.
        const manifest = await readDocument(join(folder, 'plugin.json'), MAX_MANIFEST_BYTES).catch(() => undefined);
        if (!manifest) continue;
        const name = text(manifest.name) ?? folderName;
        if (!PLUGIN_NAME.test(name) || name.length > 256 || pluginIds.has(name)) continue;
        pluginIds.add(name);
        const switched = rec(switches?.[name])?.enabled;
        const enabled = typeof switched === 'boolean' ? switched : manifest.disabled !== true;
        const version = bounded(text(manifest.version), 128);
        const description = text(manifest.description)?.slice(0, 2_048);
        plugins.push({
          kind: 'plugin',
          id: name,
          name,
          origin: 'own',
          enabled,
          location: folder,
          ...(version ? { version } : {}),
          ...(description ? { description } : {}),
        });

        const serverFile = join(folder, 'mcp_config.json');
        const declared = await readDocument(serverFile, MAX_CONFIG_BYTES, true).catch(() => undefined);
        for (const [serverName, definition] of Object.entries(rec(declared?.mcpServers) ?? {})) {
          addServer(
            serverItem(serverName, definition, {
              id: `plugin:${name}:${serverName}`,
              origin: 'plugin',
              plugin: name,
              enabled: enabled && rec(definition)?.disabled !== true,
              location: serverFile,
            }),
          );
        }
        for (const skill of await skillFolders(join(folder, 'skills'))) {
          // A skill whose own name already carries its plugin's is shown once, unprefixed.
          const skillName = skill.name.startsWith(`${name}:`) ? skill.name.slice(name.length + 1) : skill.name;
          addSkill({
            kind: 'skill',
            id: `plugin:${name}:${skillName}`,
            name: skillName,
            origin: 'plugin',
            plugin: name,
            enabled,
            location: skill.folder,
            ...(skill.description ? { description: skill.description } : {}),
          });
        }
      }
      if (await exists(join(config, 'plugins.json'))) {
        report('plugin', 'plugins.json names more plugin folders, which are not read');
      }

      const userServers = join(config, 'mcp_config.json');
      try {
        const document = await readDocument(userServers, MAX_CONFIG_BYTES, true);
        for (const [serverName, definition] of Object.entries(rec(document?.mcpServers) ?? {})) {
          addServer(
            serverItem(serverName, definition, {
              id: serverName,
              origin: 'own',
              enabled: rec(definition)?.disabled !== true,
              location: userServers,
            }),
          );
        }
      } catch {
        report('mcp-server', 'mcp_config.json could not be read');
      }

      for (const skill of await skillFolders(join(config, 'skills'))) {
        addSkill({
          kind: 'skill',
          id: skill.folderName,
          name: skill.name,
          origin: 'own',
          enabled: true,
          location: skill.folder,
          ...(skill.description ? { description: skill.description } : {}),
          ...(skill.linkTarget ? { linkTarget: skill.linkTarget } : {}),
        });
      }
      for (const skill of await skillFolders(join(home, ...BUILTIN_SKILLS))) {
        addSkill({
          kind: 'skill',
          id: `builtin:${skill.folderName}`,
          name: skill.name,
          origin: 'bundled',
          enabled: true,
          location: skill.folder,
          ...(skill.description ? { description: skill.description } : {}),
        });
      }
      if (await exists(join(config, 'skills.json'))) {
        report('skill', 'skills.json names more skill folders, which are not read');
      }

      const items: ExtensionItem[] = [...plugins, ...servers, ...skills];
      return {
        provider: 'antigravity',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        items,
        ...(unread.size > 0 ? { unread: [...unread].map(([kind, message]) => ({ kind, message })) } : {}),
        source: { kind: 'native-store', stability: 'experimental' },
      };
    },
  };
}
