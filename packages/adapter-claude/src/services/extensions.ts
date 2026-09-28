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
 *   plugin's folder holds `.claude-plugin/plugin.json`, `.mcp.json`,
 *   `skills/<name>/SKILL.md`, and the `commands/*.md`, `agents/*.md` and
 *   `hooks/hooks.json` whose names a listing shows.
 * - Personal skills are `<root>/skills/<name>/SKILL.md`; `skills/synced/` holds
 *   the account's. A linked skill folder is read from its target.
 * A project's `.mcp.json` and `.claude/` live in its working tree, not the
 * profile, and are not read here.
 */

import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  describeMcpCommand,
  describeMcpUrl,
  EXTENSION_COMMAND_NAME,
  EXTENSION_PLUGIN_NAME,
  extensionActUnavailable,
  extensionCommandPlan,
  extensionNotOwnWords,
  extensionSignInAbsentWords,
  extensionSkillFolderPlan,
  extensionTerminalPlan,
  mcpServerDefinition,
  parseSkillFrontmatter,
  type AgentProfile,
  type ExtensionActItem,
  type ExtensionActKind,
  type ExtensionActPlan,
  type ExtensionActPlanOptions,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionProvider,
  type ExtensionReach,
  type ExtensionService,
  type McpServerItem,
  type McpTransport,
  type PluginItem,
  type PluginParts,
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
/** A remote server's address has a scheme; `claude mcp add` would read one starting with a hyphen as a flag. */
const REMOTE_ADDRESS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const isString = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isString) : []);
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
  value: unknown,
  fields: Pick<McpServerItem, 'id' | 'origin' | 'enabled'> &
    Partial<Pick<McpServerItem, 'plugin' | 'project' | 'location'>>,
): McpServerItem | undefined {
  const server = rec(value);
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
  const envNames = Object.keys(rec(server.env) ?? {});
  const headerNames = Object.keys(rec(server.headers) ?? {});
  const env = envNames.filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key));
  const headers = headerNames.filter((key) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(key));
  // What another agent could take is decided from the server as Claude Code
  // keeps it, before any masking and with every name it keeps: an argument that
  // is not a string, or a name the listing drops, would make it another server.
  const argsKept = server.args === undefined || (Array.isArray(server.args) && server.args.every(isString));
  const definition = argsKept
    ? mcpServerDefinition({
        transport,
        command: text(server.command),
        args: strings(server.args),
        url: text(server.url),
        env: envNames,
        headers: headerNames,
      })
    : undefined;
  return {
    kind: 'mcp-server',
    ...fields,
    name: name.trim().slice(0, 256),
    transport,
    target,
    ...(env.length > 0 ? { env: env.slice(0, 64) } : {}),
    ...(headers.length > 0 ? { headers: headers.slice(0, 64) } : {}),
    ...(definition ? { definition } : {}),
  };
}

/** A plugin's servers: `.mcp.json`, whose top level is `mcpServers` or the map itself, or an inline `mcpServers` in its manifest. */
function pluginServers(manifest: Json | undefined, dotMcp: Json | undefined): Json {
  const inline = rec(manifest?.mcpServers);
  const file = dotMcp ? (rec(dotMcp.mcpServers) ?? dotMcp) : undefined;
  return { ...(file ?? {}), ...(inline ?? {}) };
}

/** npm's `Name <email> (address)` person form, and any word shaped like an email: an author shows its name alone. */
const PERSON_EXTRAS = /<[^>]*>|\([^)]*:\/\/[^)]*\)|[^\s<>()]+@[^\s<>()]+/gu;
/** A hook event as Claude Code names one: `PreToolUse`, `SessionStart`. */
const HOOK_EVENT = /^[A-Za-z][A-Za-z0-9_]*$/u;

/** Who made a plugin, as its manifest says: a string, or an object's `name` — never its email. */
function authorOf(manifest: Json | undefined): string | undefined {
  const author = manifest?.author;
  const name = typeof author === 'string' ? author : rec(author)?.name;
  if (typeof name !== 'string') return undefined;
  const shown = name.replace(PERSON_EXTRAS, ' ').replace(/\s+/gu, ' ').trim().slice(0, 256).trimEnd();
  return shown.length > 0 ? shown : undefined;
}

/** A plugin's homepage, else its repository, as {@link describeMcpUrl} shows an address: only an http(s) one. */
function homepageOf(manifest: Json | undefined): string | undefined {
  const repository = manifest?.repository;
  for (const candidate of [manifest?.homepage, typeof repository === 'string' ? repository : rec(repository)?.url]) {
    const address = text(candidate);
    if (address === undefined || !/^https?:\/\//iu.test(address)) continue;
    const shown = describeMcpUrl(address);
    if (/^https?:\/\//u.test(shown) && shown.length <= 8_192) return shown;
  }
  return undefined;
}

/**
 * The names of what a plugin runs beside its servers and skills: its commands
 * (`commands/*.md`), its agents (`agents/*.md`) and the events its hooks run on
 * (`hooks/hooks.json`). Read only inside its folder, so a part that is a link
 * leading out of it is never followed; a link among the files is not taken.
 */
async function pluginParts(folder: string): Promise<PluginParts | undefined> {
  let base: string;
  try {
    base = await realpath(folder);
  } catch {
    return undefined;
  }
  const inside = async (path: string): Promise<string | undefined> => {
    try {
      const real = await realpath(path);
      return real === base || real.startsWith(`${base}${sep}`) ? real : undefined;
    } catch {
      return undefined;
    }
  };
  const markdownNames = async (part: string): Promise<string[]> => {
    const dir = await inside(join(folder, part));
    if (dir === undefined) return [];
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
        .map((entry) => entry.name.slice(0, -'.md'.length).trim());
    } catch {
      return [];
    }
  };
  let events: string[] = [];
  const hooksFile = await inside(join(folder, 'hooks', 'hooks.json'));
  if (hooksFile !== undefined) {
    const document = await readJson(hooksFile, MAX_MANIFEST_BYTES).catch(() => undefined);
    // `{ hooks: { <event>: […] } }`, or the events at the top level; an event's hooks are a list, so a
    // `description` beside them is not one
    const hooks = document === undefined ? {} : 'hooks' in document ? (rec(document.hooks) ?? {}) : document;
    events = Object.entries(hooks)
      .filter(([name, value]) => HOOK_EVENT.test(name) && Array.isArray(value))
      .map(([name]) => name);
  }
  const names = (found: string[], max: number): string[] =>
    [...new Set(found.filter((name) => name.length > 0 && name.length <= 256))]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, max);
  const commands = names(await markdownNames('commands'), 256);
  const agents = names(await markdownNames('agents'), 256);
  const hooks = names(events, 64);
  if (commands.length === 0 && agents.length === 0 && hooks.length === 0) return undefined;
  return {
    ...(commands.length > 0 ? { commands } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
  };
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

/** The folder Claude Code reads a person's skills from in one profile, the account's `synced/` inside it. */
function skillsFolder(profile: AgentProfile): string {
  return join(profile.dataRoot, 'skills');
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
  // a remote server's stored sign-in. A skill's switch is a settings key. A
  // remote server signs in with `claude mcp login <name>` (a browser, so a
  // terminal) and out with `claude mcp logout <name>`: the report's shell
  // forms, not probed. The sign-in lands in the root's own keychain item, and
  // no read here can see it (the keychain is never opened).
  //
  // An add is the report's `claude mcp add <name> -- <command> [args…]`, or
  // `<name> <url>` with `--transport http|sse`, at user scope, the name first
  // because `-e` takes every word after it; each variable goes in as
  // `-e NAME=${NAME:-}`, never its value, since Claude Code expands `${VAR}` in
  // command, args, env, url and headers from its own environment when it loads
  // the server. The empty default is there because Claude Code refuses a config
  // naming a variable it has no value and no default for: a Claude started
  // without the host's values keeps its other servers, and this one gets none.
  // The report's forms, not probed.
  //
  // A skill a host keeps is linked into the root's `skills/`, which Claude Code
  // follows ("Symlinked skill folders in those three locations are read from
  // the target and loaded once", its skills docs); a person's own goes as a
  // link taken away, or a folder moved to where the host keeps it.
  //
  // A plugin the root installed turns on and off with `claude plugin
  // enable|disable <id>`, updates to the newest its marketplace has with
  // `claude plugin update <id>`, and goes with `claude plugin uninstall <id>`,
  // which, once no scope holds it, deletes what it stored in
  // `plugins/data/<id>/` unless given `--keep-data`: a remove keeps that data,
  // a purge does not. The forms are the report's
  // (draft/CLAUDE-PLUGINS-SKILLS-MCP.md: `claude plugin
  // install|uninstall|enable|disable|update`, the data folder's `--keep-data`,
  // the install scopes), not probed. Each runs at `--scope user`, since only
  // the root's own user-scope install is the profile's; a project's or a local
  // one belongs to a working tree.
  const profileEnv = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'managed' ? { [CLAUDE_PROFILE_ROOT_VARIABLE]: profile.dataRoot } : {};

  // Grok and OpenCode also load the skills in the home's `~/.claude/skills`
  // whatever their own profile, so a skill placed in or taken from the native
  // default's reaches them; a managed root's folder is its own.
  const borrowedSkills = join(home, '.claude', 'skills');

  function planSkill(
    profile: AgentProfile,
    item: SkillItem,
    act: 'add' | 'remove',
    keepIn: string | undefined,
  ): ExtensionActPlan {
    // `skills/synced` is the account's synced skills, which Claude Code writes
    // itself; a case-folding disk (macOS's, Windows') takes `Synced` for it too.
    if (act === 'add' && item.id.toLowerCase() === 'synced') {
      return extensionActUnavailable(
        { kind: 'skill', id: item.id },
        act,
        'unsupported',
        "Claude Code keeps your account's synced skills in skills/synced",
      );
    }
    const folder = skillsFolder(profile);
    return extensionSkillFolderPlan({
      label: 'Claude Code',
      folder,
      item,
      act,
      ...(keepIn === undefined ? {} : { keepIn }),
      reaches: folder === borrowedSkills ? ['shared-folder'] : [],
      home,
    });
  }

  /** A user server lands in the profile's own app state, which no other profile reads. */
  function planAdd(profile: AgentProfile, item: McpServerItem): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    const unsupported = (message: string) => extensionActUnavailable(target, 'add', 'unsupported', message);
    const definition = item.definition;
    if (definition === undefined) return unsupported('Claude Code adds a server only from its command line or address');
    if (!EXTENSION_COMMAND_NAME.test(item.id)) {
      return extensionActUnavailable(
        target,
        'add',
        'no-command',
        "Claude Code's commands do not take this server's name",
      );
    }
    const add = [executable, 'mcp', 'add', item.id];
    let argv: string[];
    switch (definition.transport) {
      case 'stdio':
        argv = [
          ...add,
          '--scope',
          'user',
          ...(definition.env ?? []).flatMap((name) => ['-e', `${name}=\${${name}:-}`]),
          '--',
          definition.command,
          ...definition.args,
        ];
        break;
      case 'http':
      case 'sse':
        if (!REMOTE_ADDRESS.test(definition.url)) {
          return unsupported('Claude Code reaches a remote server only at an address');
        }
        argv = [...add, definition.url, '--scope', 'user', '--transport', definition.transport];
        break;
      default:
        return unsupported("Claude Code's mcp add takes a stdio, HTTP or SSE server");
    }
    return extensionCommandPlan({ target, act: 'add', argv, env: profileEnv(profile), reaches: [] });
  }

  function planPlugin(profile: AgentProfile, item: PluginItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') {
      // `<folder>@synced`: the account's, downloaded from claude.ai with no install record of the root's
      return extensionActUnavailable(
        target,
        act,
        'not-own',
        item.origin === 'managed'
          ? 'It comes with your Claude account, from claude.ai, and changes there'
          : extensionNotOwnWords('Claude Code', item),
      );
    }
    if (act === 'add') {
      return extensionActUnavailable(target, act, 'unsupported', 'Claude Code installs a plugin from its marketplace');
    }
    if (act === 'sign-in' || act === 'sign-out') {
      return extensionActUnavailable(target, act, 'unsupported', 'Claude Code has no sign-in for a plugin');
    }
    if (!EXTENSION_PLUGIN_NAME.test(item.id)) {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        "Claude Code's commands do not take this plugin's name",
      );
    }
    const scoped = (verb: string, ...flags: string[]) => [
      executable,
      'plugin',
      verb,
      item.id,
      '--scope',
      'user',
      ...flags,
    ];
    const argv =
      act === 'remove' ? scoped('uninstall', '--keep-data') : act === 'purge' ? scoped('uninstall') : scoped(act);
    // Grok loads every plugin in the home's own ~/.claude/plugins/installed_plugins.json, in each of its
    // profiles and whatever enabledPlugins says: an uninstall or an update in the native default reaches
    // it, a switch does not. A managed root's plugins are its own.
    const reaches: ExtensionReach[] =
      profile.kind !== 'managed' && (act === 'remove' || act === 'purge' || act === 'update') ? ['shared-folder'] : [];
    return extensionCommandPlan({ target, act, argv, env: profileEnv(profile), reaches });
  }

  function plan(
    profile: AgentProfile,
    item: ExtensionActItem,
    act: ExtensionActKind,
    options: ExtensionActPlanOptions = {},
  ): ExtensionActPlan {
    if (item.kind === 'plugin') return planPlugin(profile, item, act);
    if (item.kind === 'skill') {
      if (act === 'add' || act === 'remove') return planSkill(profile, item, act, options.keepIn);
    } else if (act === 'add') {
      // an add plans from the server as Claude Code would hold it once added, always its own
      return planAdd(profile, item);
    }
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Claude Code', item));
    }
    if (item.kind === 'skill') {
      return extensionActUnavailable(target, act, 'no-command', 'Claude Code turns a skill off only in its settings');
    }
    if (act === 'enable' || act === 'disable') {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        'Claude Code has no switch for a whole profile: /mcp turns a server off one project at a time',
      );
    }
    const absent = act === 'remove' ? undefined : extensionSignInAbsentWords('Claude Code', item);
    if (absent !== undefined) return extensionActUnavailable(target, act, 'no-sign-in', absent);
    if (!EXTENSION_COMMAND_NAME.test(item.id)) {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        "Claude Code's commands do not take this server's name",
      );
    }
    const env = profileEnv(profile);
    if (act === 'remove') {
      return extensionCommandPlan({
        target,
        act,
        argv: [executable, 'mcp', 'remove', '--scope', 'user', item.id],
        env,
        reaches: item.transport === 'stdio' ? ['definition'] : ['definition', 'sign-in'],
      });
    }
    const fields = { target, act, argv: [executable, 'mcp', act === 'sign-in' ? 'login' : 'logout', item.id], env };
    return act === 'sign-in' ? extensionTerminalPlan(fields) : extensionCommandPlan(fields);
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
        const author = authorOf(manifest);
        const homepage = homepageOf(manifest);
        const brings = folder ? await pluginParts(folder) : undefined;
        items.push({
          ...item,
          ...(description ? { description: description.slice(0, 2_048) } : {}),
          ...(author ? { author } : {}),
          ...(homepage ? { homepage } : {}),
          ...(brings ? { brings } : {}),
        });
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
      // the folder an act plans in, so a remove finds the skill a read found in it
      const skills = skillsFolder(profile);
      for (const skill of await skillFolders(skills, new Set(['synced']))) {
        items.push(skillItem(skill, { id: skill.name, origin: 'own', enabled: skillOn(skill.name) }));
      }
      for (const skill of await skillFolders(join(skills, 'synced'))) {
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
