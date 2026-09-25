/**
 * Claude Code extensions (RFC 006 C1): the plugins, marketplaces, MCP servers
 * and skills one profile's root holds, read from Claude Code's own store files.
 * Never from `claude mcp list`, which connects to every server it lists, and
 * never from a credential store: a server's environment and headers are read
 * as names only.
 *
 * Layout per James's probe of 2.1.282 (puppeteer
 * draft/CLAUDE-PLUGINS-SKILLS-MCP.md, 2026-09-24):
 * - The app-state file holds user servers (top-level `mcpServers`) and
 *   one-project servers (`projects[<path>].mcpServers`, switched off per
 *   project by `disabledMcpServers`). A managed root keeps it at
 *   `<root>/.claude.json`; the native default beside the root, at
 *   `~/.claude.json`.
 * - `settings.json` `enabledPlugins` says which installed plugins load, and
 *   `skillOverrides` can switch a skill off.
 * - `plugins/installed_plugins.json` is `{ version, plugins: { <id>: [{ scope,
 *   version, installPath, … }] } }`; `plugins/known_marketplaces.json` maps a
 *   marketplace to `{ source, installLocation, lastUpdated }`; plugins the
 *   claude.ai account turns on are downloaded to `plugins/synced/`. A
 *   plugin's folder holds `.claude-plugin/plugin.json`, `.mcp.json` and
 *   `skills/<name>/SKILL.md`.
 * - Personal skills are `<root>/skills/<name>/SKILL.md`; `skills/synced/` holds
 *   the account's. A linked skill folder is read from its target.
 * A project's `.mcp.json` and `.claude/` live in its working tree, not the
 * profile, and are not read here.
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
  parseSkillFrontmatter,
  type AgentProfile,
  type ExtensionActKind,
  type ExtensionActPlan,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionProvider,
  type ExtensionService,
  type McpServerItem,
  type McpTransport,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { resolveClaudeExecutable } from '../detection.js';
import { CLAUDE_PROFILE_ROOT_VARIABLE } from './profiles.js';

export interface ClaudeExtensionOptions {
  /** Home directory the native default root hangs off; defaults to the process home. */
  home?: string;
  now?: () => Date;
  /** The executable an act runs; the adapter's own resolution when absent. */
  executable?: string;
  env?: NodeJS.ProcessEnv;
}

/** The app-state file grows with project history; past this it is not parsed. */
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SKILLS_PER_FOLDER = 512;

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** A store file that is absent reads as empty; one that exists and cannot be parsed is a failure the caller reports. */
async function readJson(path: string, limit = MAX_STORE_BYTES): Promise<Json | undefined> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
      return undefined;
    throw error;
  }
  if (size > limit) throw new Error(`${path} is larger than ${limit} bytes`);
  const document = rec(JSON.parse(await readFile(path, 'utf8')));
  if (!document) throw new Error(`${path} is not a JSON object`);
  return document;
}

async function readText(path: string, limit = MAX_MANIFEST_BYTES): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > limit) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function transportOf(definition: Json): McpTransport | undefined {
  const type = text(definition.type);
  if (type === undefined || type === 'stdio') return text(definition.command) ? 'stdio' : undefined;
  if (type === 'http' || type === 'streamable-http') return 'http';
  if (type === 'sse' || type === 'ws') return type;
  return undefined;
}

/**
 * One server definition as a listing may show it. A definition Claude Code
 * itself skips — a `url` with no `type`, an unknown type — yields nothing.
 */
function serverItem(
  name: string,
  definition: unknown,
  fields: Pick<McpServerItem, 'id' | 'origin' | 'enabled'> &
    Partial<Pick<McpServerItem, 'plugin' | 'project' | 'location'>>,
): McpServerItem | undefined {
  const server = rec(definition);
  if (!server || !text(name)) return undefined;
  const transport = transportOf(server);
  if (!transport) return undefined;
  const target =
    transport === 'stdio'
      ? describeMcpCommand(text(server.command)!, strings(server.args))
      : text(server.url)
        ? describeMcpUrl(text(server.url)!)
        : undefined;
  if (!target) return undefined;
  const env = Object.keys(rec(server.env) ?? {}).filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key));
  const headers = Object.keys(rec(server.headers) ?? {}).filter((key) =>
    /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(key),
  );
  return {
    kind: 'mcp-server',
    ...fields,
    name: name.trim().slice(0, 256),
    transport,
    target,
    ...(env.length > 0 ? { env: env.slice(0, 64) } : {}),
    ...(headers.length > 0 ? { headers: headers.slice(0, 64) } : {}),
  };
}

/** A plugin's servers: `.mcp.json`, whose top level is `mcpServers` or the map itself, or an inline `mcpServers` in its manifest. */
function pluginServers(manifest: Json | undefined, dotMcp: Json | undefined): Json {
  const inline = rec(manifest?.mcpServers);
  const file = dotMcp ? (rec(dotMcp.mcpServers) ?? dotMcp) : undefined;
  return { ...(file ?? {}), ...(inline ?? {}) };
}

interface SkillFolder {
  folder: string;
  name: string;
  description?: string;
  linkTarget?: string;
}

/** Every `<name>/SKILL.md` directly under a skills folder, following linked folders to their targets. */
async function skillFolders(parent: string, skip: ReadonlySet<string> = new Set()): Promise<SkillFolder[]> {
  let entries: Array<{ name: string }>;
  try {
    entries = (await readdir(parent, { withFileTypes: true })).slice(0, MAX_SKILLS_PER_FOLDER);
  } catch {
    return [];
  }
  const found: SkillFolder[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
    const folder = join(parent, entry.name);
    let linkTarget: string | undefined;
    try {
      if ((await lstat(folder)).isSymbolicLink()) linkTarget = resolve(dirname(folder), await readlink(folder));
      if (!(await stat(folder)).isDirectory()) continue;
    } catch {
      continue;
    }
    const markdown = await readText(join(folder, 'SKILL.md'));
    if (markdown === undefined) continue;
    const frontmatter = parseSkillFrontmatter(markdown);
    found.push({
      folder,
      name: entry.name,
      ...(frontmatter.description ? { description: frontmatter.description.slice(0, 2_048) } : {}),
      ...(linkTarget ? { linkTarget } : {}),
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function skillItem(
  skill: SkillFolder,
  fields: Pick<SkillItem, 'id' | 'origin' | 'enabled'> & Partial<Pick<SkillItem, 'plugin'>>,
): SkillItem {
  return {
    kind: 'skill',
    ...fields,
    name: skill.name.slice(0, 256),
    location: skill.folder,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.linkTarget ? { linkTarget: skill.linkTarget } : {}),
  };
}

/** Claude Code extensions capability: its own store files, per profile root. */
export function createClaudeExtensionService(options: ClaudeExtensionOptions = {}): ExtensionService {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());

  const provider: ExtensionProvider = {
    id: 'claude',
    label: 'Claude',
    support: {
      plugins: { store: 'profile', changes: 'command', read: true },
      marketplaces: { store: 'profile', changes: 'command', read: true },
      mcpServers: { store: 'profile', changes: 'command', read: true },
      skills: { store: 'profile', changes: 'folder', read: true },
    },
  };

  const executable = resolveClaudeExecutable(options.executable, options.env ?? process.env);

  // Acts (RFC 006 C2): Claude Code has no switch that turns a server off for a
  // whole profile (`/mcp` does it one project at a time), so a user server is
  // only removed — `claude mcp remove --scope user <name>`, which also deletes
  // a remote server's stored sign-in. A skill's switch is a settings key.
  function plan(profile: AgentProfile, item: McpServerItem | SkillItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Claude Code', item));
    }
    if (item.kind === 'skill') {
      return extensionActUnavailable(target, act, 'no-command', 'Claude Code turns a skill off only in its settings');
    }
    if (act !== 'remove') {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        'Claude Code has no switch for a whole profile: /mcp turns a server off one project at a time',
      );
    }
    if (!EXTENSION_COMMAND_NAME.test(item.id)) {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        "Claude Code's commands do not take this server's name",
      );
    }
    return extensionCommandPlan({
      target,
      act,
      argv: [executable, 'mcp', 'remove', '--scope', 'user', item.id],
      env: profile.kind === 'managed' ? { [CLAUDE_PROFILE_ROOT_VARIABLE]: profile.dataRoot } : {},
      reaches: item.transport === 'stdio' ? ['definition'] : ['definition', 'sign-in'],
    });
  }

  return {
    provider,
    plan,
    async inventory(profile: AgentProfile): Promise<ExtensionInventory> {
      const root = profile.dataRoot;
      // The native default keeps its app state beside its root, not inside it.
      const appState = profile.kind === 'managed' ? join(root, '.claude.json') : join(home, '.claude.json');
      const pluginsRoot = join(root, 'plugins');
      const items: ExtensionItem[] = [];
      const unread: Array<{ kind: ExtensionKind; message: string }> = [];
      const cannotRead = (kind: ExtensionKind, what: string) => {
        if (!unread.some((entry) => entry.kind === kind)) unread.push({ kind, message: `${what} could not be read` });
      };

      let settings: Json | undefined;
      try {
        settings = await readJson(join(root, 'settings.json'), MAX_MANIFEST_BYTES * 4);
      } catch {
        cannotRead('plugin', 'settings.json');
      }
      const enabledPlugins = rec(settings?.enabledPlugins) ?? {};
      const skillOverrides = rec(settings?.skillOverrides) ?? {};

      // Marketplaces: the ones fetched for this root, and the ones claude.ai added.
      for (const [file, origin] of [
        ['known_marketplaces.json', 'own'],
        ['known_marketplaces_claudeai.json', 'managed'],
      ] as const) {
        let marketplaces: Json | undefined;
        try {
          marketplaces = await readJson(join(pluginsRoot, file), MAX_MANIFEST_BYTES * 4);
        } catch {
          cannotRead('marketplace', file);
        }
        for (const [name, value] of Object.entries(marketplaces ?? {})) {
          const entry = rec(value);
          if (!entry || !text(name) || items.some((item) => item.kind === 'marketplace' && item.id === name)) continue;
          const source = rec(entry.source);
          const from =
            text(source?.repo) ??
            text(source?.path) ??
            (text(source?.url) ? describeMcpUrl(text(source!.url)!) : undefined);
          const updatedAt = text(entry.lastUpdated);
          items.push({
            kind: 'marketplace',
            id: name,
            name: name.slice(0, 256),
            origin,
            enabled: true,
            ...(from ? { source: from } : {}),
            ...(updatedAt && ISO_WITH_OFFSET.test(updatedAt) ? { updatedAt } : {}),
            ...(text(entry.installLocation) ? { location: text(entry.installLocation)! } : {}),
          });
        }
      }

      // Plugins installed for this root (user scope), and the account's synced ones.
      const plugins: Array<{ item: PluginItem; folder?: string }> = [];
      let installed: Json | undefined;
      try {
        installed = await readJson(join(pluginsRoot, 'installed_plugins.json'), MAX_MANIFEST_BYTES * 8);
      } catch {
        cannotRead('plugin', 'installed_plugins.json');
      }
      for (const [id, records] of Object.entries(rec(installed?.plugins) ?? {})) {
        // Project and local installs belong to a working tree; only this root's own are the profile's.
        const record = (Array.isArray(records) ? records : [])
          .map(rec)
          .find((candidate) => candidate && text(candidate.scope) === 'user');
        if (!record || !text(id)) continue;
        const [name, marketplace] = id.split('@');
        const version = text(record.version);
        plugins.push({
          item: {
            kind: 'plugin',
            id,
            name: (name || id).slice(0, 256),
            origin: 'own',
            enabled: enabledPlugins[id] === true,
            ...(version ? { version: version.slice(0, 128) } : {}),
            ...(marketplace ? { marketplace } : {}),
            ...(text(record.installPath) ? { location: text(record.installPath)! } : {}),
          },
          ...(text(record.installPath) ? { folder: text(record.installPath)! } : {}),
        });
      }
      try {
        for (const entry of await readdir(join(pluginsRoot, 'synced'), { withFileTypes: true })) {
          if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
          const id = `${entry.name}@synced`;
          const folder = join(pluginsRoot, 'synced', entry.name);
          plugins.push({
            item: {
              kind: 'plugin',
              id,
              name: entry.name.slice(0, 256),
              origin: 'managed',
              enabled: true,
              location: folder,
            },
            folder,
          });
        }
      } catch {
        // No synced plugins: the account turned none on, or the root never signed in to claude.ai.
      }

      for (const { item, folder } of plugins) {
        let manifest: Json | undefined;
        let dotMcp: Json | undefined;
        // A plugin whose manifest or server file does not parse still counts as installed.
        if (folder) {
          manifest = await readJson(join(folder, '.claude-plugin', 'plugin.json'), MAX_MANIFEST_BYTES).catch(
            () => undefined,
          );
          dotMcp = await readJson(join(folder, '.mcp.json'), MAX_MANIFEST_BYTES).catch(() => undefined);
        }
        const description = text(manifest?.description);
        items.push(description ? { ...item, description: description.slice(0, 2_048) } : item);
        if (!folder) continue;
        for (const [name, definition] of Object.entries(pluginServers(manifest, dotMcp))) {
          const server = serverItem(name, definition, {
            id: `plugin:${item.id}:${name}`,
            origin: 'plugin',
            enabled: item.enabled,
            plugin: item.id,
          });
          if (server) items.push(server);
        }
        for (const skill of await skillFolders(join(folder, 'skills'))) {
          items.push(
            skillItem(skill, {
              id: `plugin:${item.id}:${skill.name}`,
              origin: 'plugin',
              enabled: item.enabled,
              plugin: item.id,
            }),
          );
        }
      }

      // Servers: this root's own, and the ones kept for one project.
      let state: Json | undefined;
      try {
        state = await readJson(appState);
      } catch {
        cannotRead('mcp-server', '.claude.json');
      }
      for (const [name, definition] of Object.entries(rec(state?.mcpServers) ?? {})) {
        const server = serverItem(name, definition, { id: name, origin: 'own', enabled: true, location: appState });
        if (server) items.push(server);
      }
      for (const [project, value] of Object.entries(rec(state?.projects) ?? {})) {
        const entry = rec(value);
        const disabled = new Set(strings(entry?.disabledMcpServers));
        for (const [name, definition] of Object.entries(rec(entry?.mcpServers) ?? {})) {
          const server = serverItem(name, definition, {
            id: `project:${project}:${name}`,
            origin: 'project',
            enabled: !disabled.has(name),
            project,
            location: appState,
          });
          if (server) items.push(server);
        }
      }

      // Skills: the person's, then the account's synced ones.
      const skillOn = (name: string) => text(skillOverrides[name]) !== 'off';
      for (const skill of await skillFolders(join(root, 'skills'), new Set(['synced']))) {
        items.push(skillItem(skill, { id: skill.name, origin: 'own', enabled: skillOn(skill.name) }));
      }
      for (const skill of await skillFolders(join(root, 'skills', 'synced'))) {
        items.push(skillItem(skill, { id: `synced:${skill.name}`, origin: 'managed', enabled: skillOn(skill.name) }));
      }

      return {
        provider: 'claude',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        items,
        ...(unread.length > 0 ? { unread } : {}),
        // The store files are Claude Code's own and undocumented as an interface.
        source: { kind: 'native-store', stability: 'experimental' },
      };
    },
  };
}
