/**
 * Kimi Code extensions (RFC 006 C1): the plugins, MCP servers and skills one
 * profile's `KIMI_CODE_HOME` holds, read from Kimi Code's own files.
 *
 * Kimi Code has no `plugin` or `mcp` command, and its local server (`kimi
 * web`) would be a Kimi Code process of its own, so neither is used: every read
 * here is a file. Layout per James's report of 2.0.2 and kimi-code be7d5f5
 * (puppeteer draft/KIMI-PLUGINS-SKILLS-MCP.md, 2026-09-24):
 * - `plugins/installed.json` is `{ version: 1, plugins: [{ id, root, source,
 *   enabled, capabilities: { mcpServers: { <name>: { enabled } } }, … }] }`;
 *   a `plugins` that is not an array fails Kimi Code's own load too. Each
 *   plugin is a copy under `plugins/managed/<id>/` whose manifest is
 *   `kimi.plugin.json`, else `.kimi-plugin/plugin.json`. Its `skills` entries
 *   are `./` folders that must stay inside the plugin after links resolve; with
 *   none, a root `SKILL.md` is its one skill. Its servers run as
 *   `plugin-<id>:<server>`, each on unless the record's per-server switch, else
 *   the manifest's own `enabled`, says off; a stdio command or cwd that leaves
 *   the plugin is dropped.
 * - `mcp.json` `{ mcpServers }`: stdio by `command`, http by `url`, sse only
 *   when `transport` says so; `enabled: false` keeps an entry off; a
 *   `bearerTokenEnvVar` names the variable an `Authorization` header is made
 *   from. An entry shadows a plugin's server of the same runtime name.
 * - Skills: the root's `skills/`, and `~/.agents/skills/`, which every profile
 *   reads (other agents too). A `<name>/SKILL.md` folder must name and describe
 *   itself; a flat `<name>.md` may do neither (its file name and first line
 *   stand in), and a folder beats a flat file of the same name. A `type` other
 *   than prompt, inline, flow or reference is not loaded. Kimi Code has no
 *   switch for one skill.
 * Not read: a repository's `.kimi-code/`, `.agents/skills/` and `.mcp.json`,
 * which belong to a workspace; the skills built into the binary; folders
 * `config.toml` adds with `extra_skill_dirs`; and whether an OAuth server is
 * signed in, which only the credential store under `credentials/mcp/` knows.
 */

import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  describeMcpCommand,
  describeMcpUrl,
  extensionActUnavailable,
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
  type McpServerItem,
  type McpTransport,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { kimiCredentialRoot } from './profiles.js';

export interface KimiExtensionOptions {
  /** Home directory the native default root and `~/.agents/skills` hang off; defaults to the process home. */
  home?: string;
  /**
   * Ambient environment: `KIMI_CODE_HOME` names the native default's root.
   * Defaults to this process's own, or to none when a `home` is injected, so a
   * test never follows the machine's.
   */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SKILLS_PER_FOLDER = 512;
const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const LOADED_SKILL_TYPES = new Set(['prompt', 'inline', 'flow', 'reference']);

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const names = (values: Iterable<string>, pattern: RegExp): string[] =>
  [...new Set(values)].filter((value) => pattern.test(value)).slice(0, 64);

/** Absent reads as undefined; a file that exists and cannot be parsed throws for the caller to report. */
async function readJson(path: string, limit: number): Promise<unknown> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
  if (size > limit) throw new Error(`${basename(path)} is larger than ${limit} bytes`);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readText(path: string, limit = MAX_MANIFEST_BYTES): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > limit) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The front matter block, when the first line opens one, and the body after it. */
function splitFrontmatter(markdown: string): { block?: string; body: string } {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return { body: markdown };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return { body: markdown };
  return { block: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

/** Kimi Code loads `prompt` (the default), `inline`, `flow` and `reference` skills, and skips any other type. */
function loadedType(block: string | undefined): boolean {
  const line = block?.split('\n').find((entry) => /^type\s*:/u.test(entry));
  if (line === undefined) return true;
  const value = line
    .replace(/^type\s*:/u, '')
    .replace(/\s+#.*$/u, '')
    .trim()
    .replace(/^(['"])(.*)\1$/u, '$2')
    .trim();
  return value === '' || LOADED_SKILL_TYPES.has(value);
}

interface FoundSkill {
  /** The folder or file name, unique within one scanned folder. */
  key: string;
  name: string;
  location: string;
  description?: string;
  linkTarget?: string;
}

/** A `SKILL.md` folder, when it declares a loaded type and names and describes itself. */
async function folderSkill(folder: string, key: string, linkTarget?: string): Promise<FoundSkill | undefined> {
  const markdown = await readText(join(folder, 'SKILL.md'));
  if (markdown === undefined || !loadedType(splitFrontmatter(markdown).block)) return undefined;
  const { name, description } = parseSkillFrontmatter(markdown);
  if (!name || !description) return undefined;
  return {
    key,
    name,
    location: folder,
    description: description.slice(0, 2_048),
    ...(linkTarget ? { linkTarget } : {}),
  };
}

/** A flat `<name>.md`: its front matter's name and description, else its file name and first line. */
async function flatSkill(file: string, key: string): Promise<FoundSkill | undefined> {
  const markdown = await readText(file);
  if (markdown === undefined) return undefined;
  const { block, body } = splitFrontmatter(markdown);
  if (!loadedType(block)) return undefined;
  const parsed = parseSkillFrontmatter(markdown);
  const firstLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 240);
  const description = parsed.description?.slice(0, 2_048) ?? firstLine;
  return { key, name: parsed.name ?? key, location: file, ...(description ? { description } : {}) };
}

/**
 * The skills directly in one scanned folder: `<name>/SKILL.md` folders
 * (followed when linked) and flat `<name>.md` files, a folder beating a flat
 * file of the same name.
 */
async function skillsIn(parent: string): Promise<FoundSkill[]> {
  let entries: string[];
  try {
    entries = (await readdir(parent)).sort().slice(0, MAX_SKILLS_PER_FOLDER);
  } catch {
    return [];
  }
  const folders: FoundSkill[] = [];
  const folderKeys = new Set<string>();
  const flats: FoundSkill[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const path = join(parent, entry);
    let linkTarget: string | undefined;
    let isFolder: boolean;
    try {
      if ((await lstat(path)).isSymbolicLink()) linkTarget = resolve(dirname(path), await readlink(path));
      const found = await stat(path);
      isFolder = found.isDirectory();
      if (!isFolder && !found.isFile()) continue;
    } catch {
      continue;
    }
    if (isFolder) {
      if (!(await exists(join(path, 'SKILL.md')))) continue;
      folderKeys.add(entry);
      const skill = await folderSkill(path, entry, linkTarget);
      if (skill) folders.push(skill);
    } else if (entry.toLowerCase().endsWith('.md')) {
      const skill = await flatSkill(path, entry.slice(0, -'.md'.length));
      if (skill) flats.push(skill);
    }
  }
  return [...folders, ...flats.filter((flat) => !folderKeys.has(flat.key))];
}

/** Whether a manifest path, once links resolve, stays inside the plugin. */
async function inside(root: string, path: string): Promise<boolean> {
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    return realPath === realRoot || realPath.startsWith(`${realRoot}${sep}`);
  } catch {
    return false;
  }
}

/** A plugin's skills: its `./` skill folders, or with none declared its root `SKILL.md`, else `skills/`. */
async function pluginSkills(pluginRoot: string, manifest: Json): Promise<FoundSkill[]> {
  const declared = typeof manifest.skills === 'string' ? [manifest.skills] : strings(manifest.skills);
  if (manifest.skills === undefined) {
    if (await exists(join(pluginRoot, 'SKILL.md'))) {
      const skill = await folderSkill(pluginRoot, basename(pluginRoot));
      return skill ? [skill] : [];
    }
    return skillsIn(join(pluginRoot, 'skills'));
  }
  const found: FoundSkill[] = [];
  for (const entry of declared) {
    if (!entry.startsWith('./')) continue;
    const folder = resolve(pluginRoot, entry);
    if (!(await inside(pluginRoot, folder))) continue;
    found.push(...(await skillsIn(folder)));
  }
  return found;
}

/** One server definition as Kimi Code reads it; one it would not load yields nothing. */
function serverItem(
  name: string,
  definition: unknown,
  fields: Pick<McpServerItem, 'id' | 'origin' | 'location'> & Partial<Pick<McpServerItem, 'plugin'>>,
  enabled: (definition: Json) => boolean,
): McpServerItem | undefined {
  const server = rec(definition);
  const shown = text(name);
  if (!server || !shown || shown.length > 256 || fields.id.length > 512) return undefined;
  const declared = text(server.transport);
  const command = text(server.command);
  const url = text(server.url);
  let transport: McpTransport;
  if (declared === 'stdio' || (declared === undefined && command)) transport = 'stdio';
  else if (declared === 'http' || (declared === undefined && url)) transport = 'http';
  else if (declared === 'sse') transport = 'sse';
  else return undefined;
  const target =
    transport === 'stdio' ? command && describeMcpCommand(command, strings(server.args)) : url && describeMcpUrl(url);
  if (!target || target.length > 8_192) return undefined;
  const bearer = text(server.bearerTokenEnvVar);
  const env = names([...Object.keys(rec(server.env) ?? {}), ...(bearer ? [bearer] : [])], ENVIRONMENT_NAME);
  const sent = [...Object.keys(rec(server.headers) ?? {}), ...(bearer ? ['Authorization'] : [])];
  const headers = names(sent, HEADER_NAME);
  // Only mcp.json's own travel: a plugin's server runs from the plugin's
  // folder. A stdio `cwd` is a folder a definition cannot carry.
  const whole = fields.origin === 'own' && (transport !== 'stdio' || text(server.cwd) === undefined);
  const travels = whole
    ? mcpServerDefinition(
        transport === 'stdio'
          ? { transport, command, args: strings(server.args), env: Object.keys(rec(server.env) ?? {}) }
          : { transport, url, headers: sent },
      )
    : undefined;
  return {
    kind: 'mcp-server',
    ...fields,
    name: shown,
    enabled: enabled(server),
    transport,
    target,
    ...(env.length > 0 ? { env } : {}),
    ...(headers.length > 0 ? { headers } : {}),
    ...(travels ? { definition: travels } : {}),
  };
}

/** A plugin's stdio command or cwd must be a bare name or a `./` path; any other slash leaves the plugin. */
function staysInPlugin(definition: unknown): boolean {
  const server = rec(definition);
  const command = text(server?.command);
  const cwd = text(server?.cwd);
  if (command && command.includes('/') && !command.startsWith('./')) return false;
  return cwd === undefined || cwd.startsWith('./');
}

/** Kimi Code extensions capability: its own files, per profile root. */
export function createKimiExtensionService(options: KimiExtensionOptions = {}): ExtensionService {
  const home = options.home ?? homedir();
  const ambient = options.env ?? (options.home !== undefined ? {} : process.env);
  const now = options.now ?? (() => new Date());

  const provider: ExtensionProvider = {
    id: 'kimi',
    label: 'Kimi',
    support: {
      // Installed, switched and removed only inside Kimi Code (`/plugins`, or its local server); kept per root.
      plugins: { store: 'profile', changes: 'in-app', read: true },
      // The root's `mcp.json`, edited by `/mcp-config` or the local server; Kimi Code has no `mcp` command.
      mcpServers: { store: 'profile', changes: 'in-app', read: true },
      // The root's `skills/` and the `~/.agents/skills/` every profile reads; a skill is a folder or file there.
      skills: { store: 'mixed', changes: 'folder', read: true },
    },
  };

  // Acts (RFC 006 C2): Kimi has no command for either kind — its servers are
  // added and changed only inside the app (`/mcp-config`), so an add answers as
  // every server act does, and one skill has no switch. A skill is a folder
  // where Kimi looks, though, so one is placed there and taken away (planSkill).
  function plan(
    profile: AgentProfile,
    item: McpServerItem | SkillItem,
    act: ExtensionActKind,
    { keepIn }: ExtensionActPlanOptions = {},
  ): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own')
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Kimi', item));
    if (item.kind === 'skill')
      return act === 'add' || act === 'remove'
        ? planSkill(profile, item, act, keepIn)
        : extensionActUnavailable(target, act, 'no-command', 'Kimi has no switch for one skill');
    return act === 'sign-in' || act === 'sign-out'
      ? extensionActUnavailable(
          target,
          act,
          'in-app',
          'Kimi signs in to a server only inside the app, with /mcp-config',
        )
      : extensionActUnavailable(
          target,
          act,
          'in-app',
          'Kimi changes its servers only inside the app, with /mcp-config',
        );
  }

  /**
   * A person's skills in a profile are the root's `skills/`
   * (`$KIMI_CODE_HOME/skills`), a folder skill keyed by its folder's name and
   * a flat one by its file's name without `.md`. A skill the host keeps is
   * linked in there as a folder, and a folder skill there goes: a link is
   * taken away, a real folder moves to where the host keeps it or, with
   * nowhere to keep it, stays. A flat skill is one file, which only a folder's
   * move could keep, so it stays. Whether Kimi Code itself loads a skill whose
   * folder is a link is unproven — its source was read, never probed; the read
   * here follows links and records where they point, and the runtime's second
   * read is the receipt. `~/.agents/skills` is not the root's to change.
   */
  function planSkill(
    profile: AgentProfile,
    item: SkillItem,
    act: 'add' | 'remove',
    keepIn: string | undefined,
  ): ExtensionActPlan {
    const folder = join(kimiCredentialRoot(profile, ambient, home), 'skills');
    const flat =
      item.location !== undefined && dirname(item.location) === folder && basename(item.location) !== item.id;
    if (act === 'remove' && flat) {
      return extensionActUnavailable(
        { kind: 'skill', id: item.id },
        act,
        'no-command',
        `${item.name} is a flat skill, one file in Kimi's skills folder, and only a skill's folder is taken away`,
      );
    }
    return extensionSkillFolderPlan({
      label: 'Kimi',
      folder,
      item,
      act,
      ...(keepIn === undefined ? {} : { keepIn }),
      home,
    });
  }

  return {
    provider,
    plan,
    async inventory(profile: AgentProfile): Promise<ExtensionInventory> {
      // The root identity and usage read: a managed root, else what Kimi Code resolves with nothing bound.
      const root = kimiCredentialRoot(profile, ambient, home);
      const plugins: PluginItem[] = [];
      const servers: McpServerItem[] = [];
      const pluginServers: McpServerItem[] = [];
      const skills: SkillItem[] = [];
      const unread: Array<{ kind: ExtensionKind; message: string }> = [];

      let records: unknown[] = [];
      try {
        const installed = await readJson(join(root, 'plugins', 'installed.json'), MAX_STORE_BYTES);
        if (installed !== undefined) {
          const listed = rec(installed)?.plugins;
          if (!Array.isArray(listed)) throw new Error('installed.json lists no plugins array');
          records = listed;
        }
      } catch {
        unread.push({ kind: 'plugin', message: 'plugins/installed.json could not be read' });
      }

      const seenPlugins = new Set<string>();
      for (const raw of records) {
        const record = rec(raw);
        const id = text(record?.id);
        if (!record || !id || !PLUGIN_ID.test(id) || seenPlugins.has(id)) continue;
        seenPlugins.add(id);
        const recorded = text(record.root);
        const pluginRoot = recorded && isAbsolute(recorded) ? recorded : join(root, 'plugins', 'managed', id);
        const manifestPath = (await exists(join(pluginRoot, 'kimi.plugin.json')))
          ? join(pluginRoot, 'kimi.plugin.json')
          : join(pluginRoot, '.kimi-plugin', 'plugin.json');
        const manifest = rec(await readJson(manifestPath, MAX_MANIFEST_BYTES).catch(() => undefined)) ?? {};
        const enabled = record.enabled !== false;
        const version = text(manifest.version);
        const description = text(rec(manifest.interface)?.shortDescription) ?? text(manifest.description);
        plugins.push({
          kind: 'plugin',
          id,
          name: (text(manifest.name) ?? id).slice(0, 256),
          origin: 'own',
          enabled,
          location: pluginRoot,
          ...(version && version.length <= 128 ? { version } : {}),
          ...(description ? { description: description.slice(0, 2_048) } : {}),
        });

        const toggles = rec(rec(record.capabilities)?.mcpServers) ?? {};
        for (const [name, definition] of Object.entries(rec(manifest.mcpServers) ?? {})) {
          if (!staysInPlugin(definition)) continue;
          const item = serverItem(
            name,
            definition,
            { id: `plugin-${id}:${name}`, origin: 'plugin', plugin: id, location: manifestPath },
            (server) => {
              const toggle = rec(toggles[name])?.enabled;
              return enabled && (typeof toggle === 'boolean' ? toggle : server.enabled !== false);
            },
          );
          if (item) pluginServers.push(item);
        }

        const seenSkills = new Set<string>();
        for (const skill of await pluginSkills(pluginRoot, manifest)) {
          const skillId = `plugin:${id}:${skill.name}`;
          if (seenSkills.has(skillId) || skill.name.length > 256 || skillId.length > 512) continue;
          seenSkills.add(skillId);
          skills.push(skillItem(skill, { id: skillId, origin: 'plugin', plugin: id, enabled }));
        }
      }

      const mcpPath = join(root, 'mcp.json');
      try {
        const document = await readJson(mcpPath, MAX_STORE_BYTES);
        for (const [name, definition] of Object.entries(rec(rec(document)?.mcpServers) ?? {})) {
          const item = serverItem(
            name,
            definition,
            { id: name, origin: 'own', location: mcpPath },
            (server) => server.enabled !== false,
          );
          if (item) servers.push(item);
        }
      } catch {
        unread.push({ kind: 'mcp-server', message: 'mcp.json could not be read' });
      }
      // A file entry shadows a plugin's server of the same runtime name.
      const fileNames = new Set(servers.map((server) => server.id));
      servers.push(...pluginServers.filter((server) => !fileNames.has(server.id)));

      for (const skill of await skillsIn(join(root, 'skills'))) {
        skills.push(skillItem(skill, { id: skill.key, origin: 'own', enabled: true }));
      }
      for (const skill of await skillsIn(join(home, '.agents', 'skills'))) {
        skills.push(skillItem(skill, { id: `shared:${skill.key}`, origin: 'own', shared: true, enabled: true }));
      }

      const items: ExtensionItem[] = [...plugins, ...servers];
      const seenSkillIds = new Set<string>();
      for (const skill of skills) {
        if (skill.name.length > 256 || skill.id.length > 512 || seenSkillIds.has(skill.id)) continue;
        seenSkillIds.add(skill.id);
        items.push(skill);
      }

      return {
        provider: 'kimi',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        items,
        ...(unread.length > 0 ? { unread } : {}),
        source: { kind: 'native-store', stability: 'experimental' },
      };
    },
  };
}

function skillItem(
  skill: FoundSkill,
  fields: Pick<SkillItem, 'id' | 'origin' | 'enabled'> & Partial<Pick<SkillItem, 'plugin' | 'shared'>>,
): SkillItem {
  return {
    kind: 'skill',
    ...fields,
    name: skill.name,
    location: skill.location,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.linkTarget ? { linkTarget: skill.linkTarget } : {}),
  };
}
