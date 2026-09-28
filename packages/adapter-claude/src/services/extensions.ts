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
 *   marketplace to `{ source, installLocation, lastUpdated }`, and
 *   `known_marketplaces_claudeai.json` the ones claude.ai added; plugins the
 *   claude.ai account turns on are downloaded to `plugins/synced/`. A
 *   plugin's folder holds `.claude-plugin/plugin.json`, `.mcp.json`,
 *   `skills/<name>/SKILL.md`, and the `commands/*.md`, `agents/*.md` and
 *   `hooks/hooks.json` whose names a listing shows.
 * - Personal skills are `<root>/skills/<name>/SKILL.md`; `skills/synced/` holds
 *   the account's. A linked skill folder is read from its target.
 * - A marketplace's catalog (C2) is the `.claude-plugin/marketplace.json` in
 *   its `installLocation`: a git source's clone under `plugins/marketplaces/`,
 *   or a folder Claude Code reads in place. Each entry installs as `<entry
 *   name>@<marketplace>`, the key `installed_plugins.json` keeps it by, and
 *   `plugins/flagged-plugins.json` names the ones Claude Code took out.
 * A project's `.mcp.json` and `.claude/` live in its working tree, not the
 * profile, and are not read here.
 */

import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  describeArgv,
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
  isExtensionSource,
  mcpServerDefinition,
  parseSkillFrontmatter,
  type AgentProfile,
  type CatalogAsk,
  type CatalogMarketplace,
  type CatalogParts,
  type CatalogPlugin,
  type CatalogSuggestion,
  type ExtensionActItem,
  type ExtensionActKind,
  type ExtensionActPlan,
  type ExtensionActPlanOptions,
  type ExtensionCatalog,
  type ExtensionFailure,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionProvider,
  type ExtensionReach,
  type ExtensionService,
  type MarketplaceItem,
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
/** A marketplace's catalog is read whole; past this it is not read. */
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
/**
 * Only a catalog's first entries have their folders read for what they bring
 * (Anthropic's own lists some 300); the rest show what their entry says.
 */
const MAX_CATALOG_FOLDERS = 400;
/** Core's bounds on one catalog. */
const MAX_CATALOG_MARKETPLACES = 256;
const MAX_CATALOG_PLUGINS = 8_192;
/** A remote server's address has a scheme; `claude mcp add` would read one starting with a hyphen as a flag. */
const REMOTE_ADDRESS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
/** One argument of Claude Code's own command: never a flag, never a space or a control character. */
const COMMAND_ARGUMENT = /^(?!-)[^\s\u0000-\u001f\u007f]{1,512}$/u;
/** Core's bound on a string a listing shows: a source, a location, a command line. */
const MAX_SHOWN = 8_192;
/** Core's bound on an item's id. */
const MAX_ID = 512;

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const isString = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isString) : []);
/**
 * A string a listing shows, or nothing when it is past Core's bound: a field
 * left out, where one too long would fail the whole read's schema.
 */
const bounded = (value: string | undefined): string | undefined =>
  value !== undefined && value.length <= MAX_SHOWN ? value : undefined;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** A store file that is absent reads as empty; one that exists and cannot be parsed is a failure the caller reports. */
async function readJsonValue(path: string, limit = MAX_STORE_BYTES): Promise<unknown> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
      return undefined;
    throw error;
  }
  if (size > limit) throw new Error(`${path} is larger than ${limit} bytes`);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJson(path: string, limit = MAX_STORE_BYTES): Promise<Json | undefined> {
  const value = await readJsonValue(path, limit);
  if (value === undefined) return undefined;
  const document = rec(value);
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

/** A hook event as Claude Code names one: `PreToolUse`, `SessionStart`. */
const HOOK_EVENT = /^[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * Who made a plugin, as its manifest or its catalog entry says: a string, or
 * an object's `name`, and never an address. npm's `Name <email> (address)`
 * keeps the name alone, a parenthesised address or email goes, and so does any
 * other word with an `@` inside it. Each pattern stops at the next bracket of
 * its own kind, so text anyone may write is read in one pass however it is
 * crafted.
 */
function authorOf(manifest: Json | undefined): string | undefined {
  const author = manifest?.author;
  const name = typeof author === 'string' ? author : rec(author)?.name;
  if (typeof name !== 'string') return undefined;
  const shown = name
    .replace(/<[^<>]*>/gu, ' ')
    .replace(/\([^()]*\)/gu, (group) => (group.includes('://') || group.includes('@') ? ' ' : group))
    .split(/[\s\u0000-\u001f\u007f]+/u)
    .filter((word) => !word.slice(1, -1).includes('@'))
    .join(' ')
    .trim()
    .slice(0, 256)
    .trimEnd();
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

/** A path's real location when it lies inside a folder, else undefined: a link leading out of it is never followed. */
type Inside = (path: string) => Promise<string | undefined>;

/** Where paths may lead: inside `base`, itself a real path. */
function insideOf(base: string): Inside {
  return async (path) => {
    try {
      const real = await realpath(path);
      return real === base || real.startsWith(`${base}${sep}`) ? real : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Names as a listing shows them: each once, sorted, none empty or longer than Core takes. */
function partNames(found: readonly string[], max: number): string[] {
  return [...new Set(found.map((name) => name.trim()).filter((name) => name.length > 0 && name.length <= 256))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max);
}

/**
 * The events a hooks document runs on: `{ hooks: { <event>: […] } }`, or the
 * events at the top level. An event's hooks are a list, so a `description`
 * beside them is not one.
 */
function hookEvents(document: Json | undefined): string[] {
  const hooks = document === undefined ? {} : 'hooks' in document ? (rec(document.hooks) ?? {}) : document;
  return Object.entries(hooks)
    .filter(([name, value]) => HOOK_EVENT.test(name) && Array.isArray(value))
    .map(([name]) => name);
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
  const inside = insideOf(base);
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
    events = hookEvents(await readJson(hooksFile, MAX_MANIFEST_BYTES).catch(() => undefined));
  }
  const commands = partNames(await markdownNames('commands'), 256);
  const agents = partNames(await markdownNames('agents'), 256);
  const hooks = partNames(events, 64);
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

/**
 * A root's own installs by id (user scope): a project's or a local one belongs
 * to a working tree. An id past Core's bound is no key Claude Code's install
 * gives, and would fail the whole inventory's schema.
 */
function userInstalls(installed: Json | undefined): Map<string, Json> {
  const found = new Map<string, Json>();
  for (const [id, records] of Object.entries(rec(installed?.plugins) ?? {})) {
    const record = (Array.isArray(records) ? records : [])
      .map(rec)
      .find((candidate) => candidate && text(candidate.scope) === 'user');
    if (record && text(id) && id.length <= MAX_ID) found.set(id, record);
  }
  return found;
}

/** Claude Code's own marketplace, which it adds itself the first time it starts in a root. */
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
const OFFICIAL_REPOSITORY = 'anthropics/claude-plugins-official';
const OFFICIAL_ADDRESS = /^https:\/\/github\.com\/anthropics\/claude-plugins-official(?:\.git)?\/?$/iu;

interface KnownMarketplace {
  key: string;
  origin: 'own' | 'bundled' | 'managed';
  /** Where its catalog comes from, as a listing shows it: `owner/repo`, a folder, or a masked address. */
  source?: string;
  updatedAt?: string;
  /** Where Claude Code keeps what it fetched. */
  location?: string;
  /** A local source's own folder or file, which Claude Code reads in place. */
  path?: string;
}

/**
 * The marketplaces a root knows: the ones fetched for it, then the ones
 * claude.ai added, the first by a name kept. Claude Code's own is `bundled`
 * only from Anthropic's repository, since Claude Code refuses its name to any
 * other source. A list file that exists and cannot be read is named.
 */
async function knownMarketplaces(
  pluginsRoot: string,
): Promise<{ marketplaces: KnownMarketplace[]; unreadable: string[] }> {
  const marketplaces: KnownMarketplace[] = [];
  const unreadable: string[] = [];
  const named = new Set<string>();
  for (const [file, origin] of [
    ['known_marketplaces.json', 'own'],
    ['known_marketplaces_claudeai.json', 'managed'],
  ] as const) {
    let document: Json | undefined;
    try {
      document = await readJson(join(pluginsRoot, file), MAX_MANIFEST_BYTES * 4);
    } catch {
      unreadable.push(file);
    }
    for (const [key, value] of Object.entries(document ?? {})) {
      const entry = rec(value);
      if (!entry || !text(key) || key.length > MAX_ID || named.has(key)) continue;
      named.add(key);
      const source = rec(entry.source);
      const url = text(source?.url);
      const repo = text(source?.repo);
      const path = repo === undefined && url === undefined ? text(source?.path) : undefined;
      const from = bounded(repo ?? path ?? (url ? describeMcpUrl(url) : undefined));
      // a listing shows where the clone is; no path past Core's bound is one a disk takes anyway
      const location = bounded(text(entry.installLocation));
      const updatedAt = text(entry.lastUpdated);
      const official =
        origin === 'own' &&
        key === OFFICIAL_MARKETPLACE &&
        (repo !== undefined
          ? repo.toLowerCase() === OFFICIAL_REPOSITORY
          : url !== undefined && OFFICIAL_ADDRESS.test(url));
      marketplaces.push({
        key,
        origin: official ? 'bundled' : origin,
        ...(from ? { source: from } : {}),
        ...(updatedAt && ISO_WITH_OFFSET.test(updatedAt) ? { updatedAt } : {}),
        ...(location ? { location } : {}),
        ...(path ? { path } : {}),
      });
    }
  }
  return { marketplaces, unreadable };
}

type CatalogRead = { document: Json; folder: string } | { unread: string };

/**
 * One marketplace's catalog as Claude Code last fetched it: the
 * `.claude-plugin/marketplace.json` in its clone or its folder, or the file
 * itself for a source that is one (its plugins' folders are beside that
 * `.claude-plugin/`). One that is not there, too large or no catalog is said
 * in words, never thrown.
 */
async function readCatalog(location: string | undefined): Promise<CatalogRead> {
  const notFetched = { unread: 'Claude Code has not fetched its catalog' };
  if (location === undefined || !isAbsolute(location)) return notFetched;
  let file = join(location, '.claude-plugin', 'marketplace.json');
  let folder = location;
  let size: number;
  try {
    if (location.endsWith('.json') && (await stat(location)).isFile()) {
      file = location;
      folder = dirname(location);
      if (basename(folder) === '.claude-plugin') folder = dirname(folder);
    }
    size = (await stat(file)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? notFetched : { unread: 'Its catalog could not be read' };
  }
  if (size > MAX_CATALOG_BYTES) return { unread: 'Its catalog is larger than 4 MiB' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    return { unread: error instanceof SyntaxError ? 'Its catalog is not valid JSON' : 'Its catalog could not be read' };
  }
  const document = rec(parsed);
  return document && Array.isArray(document.plugins)
    ? { document, folder }
    : { unread: 'Its catalog has no list of plugins' };
}

/** Sources Claude Code fetches from elsewhere at install: offline, only the entry says anything of them. */
const REMOTE_SOURCES = new Set(['github', 'url', 'git', 'git-subdir', 'npm', 'command', 'archive']);
const COMMIT = /^[0-9a-f]{40}$/iu;

type EntrySource = { kind: 'folder'; path: string } | { kind: 'remote'; sha?: string; asks: CatalogAsk[] };

/**
 * Where a listed plugin comes from: a folder inside the marketplace (a path,
 * `./review`, or an object naming one), or somewhere Claude Code fetches it
 * from at install, with the commit the entry pins and what Claude Code asks
 * first.
 */
function entrySource(value: unknown): EntrySource | undefined {
  const path = text(value);
  if (path !== undefined) return { kind: 'folder', path };
  const source = rec(value);
  const type = text(source?.source);
  if (!source || type === undefined) return undefined;
  if (!REMOTE_SOURCES.has(type) && text(source.path) !== undefined) return { kind: 'folder', path: text(source.path)! };
  const sha = text(source.sha);
  return {
    kind: 'remote',
    ...(sha !== undefined && COMMIT.test(sha) ? { sha: sha.toLowerCase() } : {}),
    asks: sourceAsks(type, source),
  };
}

/**
 * What Claude Code asks, or runs, before a remote plugin's code is there: a
 * command source's command, which it shows and asks the person to accept, and
 * an npm package, which npm fetches with its install scripts.
 */
function sourceAsks(type: string, source: Json): CatalogAsk[] {
  if (type === 'command') {
    // Claude Code still asks when the command is one this read cannot show
    return [{ kind: 'command', command: sourceCommand(source) ?? 'a command its catalog names' }];
  }
  const name = type === 'npm' ? text(source.package) : undefined;
  if (name === undefined) return [];
  const version = text(source.version);
  const command = describeMcpCommand('npm', ['install', version === undefined ? name : `${name}@${version}`]);
  return [{ kind: 'fetch', command: command.slice(0, MAX_SHOWN) }];
}

/**
 * A command source's command as a person reads it before accepting it: a line
 * word by word, or the catalog's own arguments — word by word where a word
 * inside one is masked, so nothing secret shows in a quoted argument.
 */
function sourceCommand(source: Json): string | undefined {
  const argv = Array.isArray(source.command)
    ? strings(source.command)
    : text(source.command) !== undefined
      ? [text(source.command)!, ...strings(source.args)]
      : [];
  const words = argv.flatMap((arg) => arg.split(/\s+/u)).filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  const byWord = describeMcpCommand(words[0]!, words.slice(1));
  const shown =
    argv.length === 1 || byWord !== describeArgv(words) ? byWord : describeMcpCommand(argv[0]!, argv.slice(1));
  return shown.slice(0, MAX_SHOWN);
}

type ListedParts = Partial<Record<keyof CatalogParts, readonly string[] | undefined>>;

const serverNames = (servers: Json): string[] =>
  Object.entries(servers)
    .filter(([, definition]) => rec(definition) !== undefined)
    .map(([name]) => name);

/**
 * What a catalog entry names itself: its commands and agents by file
 * (`./commands/ship.md`; a folder names none) or by key where it maps names,
 * the events of its inline hooks and its inline servers — all a remote entry
 * says before it is fetched, and what an entry adds to its folder.
 */
function entryParts(entry: Json): ListedParts {
  const files = (value: unknown): string[] =>
    rec(value) !== undefined
      ? Object.keys(rec(value)!)
      : (typeof value === 'string' ? [value] : strings(value))
          .map((path) => basename(path.trim()))
          .filter((file) => file.endsWith('.md') && !file.startsWith('.'))
          .map((file) => file.slice(0, -'.md'.length));
  return {
    commands: files(entry.commands),
    agents: files(entry.agents),
    hooks: hookEvents(rec(entry.hooks)),
    servers: serverNames(pluginServers(entry, undefined)),
  };
}

/** The skills a plugin's folder brings, by folder name: each `skills/<name>/SKILL.md` that stays inside it. */
async function skillNames(folder: string, inside: Inside): Promise<string[]> {
  const skills = await inside(join(folder, 'skills'));
  if (skills === undefined) return [];
  let entries: string[];
  try {
    entries = (await readdir(skills)).slice(0, MAX_SKILLS_PER_FOLDER);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const markdown = await inside(join(skills, name, 'SKILL.md'));
    const isFile =
      markdown === undefined
        ? false
        : await stat(markdown).then(
            (found) => found.isFile(),
            () => false,
          );
    if (isFile) names.push(name);
  }
  return names;
}

/**
 * A listed plugin's folder inside its marketplace, read before it is
 * installed: its manifest, and the names of what it brings — commands, agents,
 * hook events, servers and skills. Only a folder inside the marketplace's is
 * read, and inside it nothing that leads out of it.
 */
async function listedFolder(folder: string, marketplace: Inside): Promise<{ manifest?: Json; parts: ListedParts }> {
  const real = await marketplace(folder);
  if (real === undefined) return { parts: {} };
  const inside = insideOf(real);
  const json = async (path: string): Promise<Json | undefined> => {
    const found = await inside(path);
    return found === undefined ? undefined : readJson(found, MAX_MANIFEST_BYTES).catch(() => undefined);
  };
  const manifest = await json(join(real, '.claude-plugin', 'plugin.json'));
  const dotMcp = await json(join(real, '.mcp.json'));
  return {
    ...(manifest ? { manifest } : {}),
    parts: {
      ...(await pluginParts(real)),
      servers: serverNames(pluginServers(manifest, dotMcp)),
      skills: await skillNames(real, inside),
    },
  };
}

const PART_BOUNDS: Record<keyof CatalogParts, number> = {
  commands: 256,
  agents: 256,
  hooks: 64,
  servers: 64,
  skills: 256,
  tools: 256,
};

/** What a listed plugin brings, as a listing shows it: each kind's names once, sorted, within Core's bounds. */
function catalogParts(...found: ListedParts[]): CatalogParts | undefined {
  const parts: CatalogParts = {};
  for (const kind of Object.keys(PART_BOUNDS) as Array<keyof CatalogParts>) {
    const names = partNames(
      found.flatMap((one) => [...(one[kind] ?? [])]),
      PART_BOUNDS[kind],
    );
    if (names.length > 0) parts[kind] = names;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

/** Claude Code's version of a plugin: its manifest's or its entry's, else a 12-hex digest of what it fetched, or `unknown`. */
const DIGEST = /^[0-9a-f]{12}$/iu;
const versionKind = (version: string): 'digest' | 'unknown' | 'version' =>
  version === 'unknown' ? 'unknown' : DIGEST.test(version) ? 'digest' : 'version';

/**
 * Whether the copy a root holds is older than its catalog's, by Claude Code's
 * own rule: `claude plugin update` takes any version that is not the one
 * installed. A commit the entry pins decides against the commit installed;
 * else two versions of one kind (two semvers, two digests) that differ — a
 * digest against a semver, or `unknown`, says nothing.
 */
function newerListed(version: string | undefined, sha: string | undefined, record: Json): boolean {
  const commit = text(record.gitCommitSha)?.toLowerCase();
  if (sha !== undefined && commit !== undefined && /^[0-9a-f]{7,40}$/u.test(commit)) return !sha.startsWith(commit);
  const held = text(record.version);
  if (version === undefined || held === undefined) return false;
  const kind = versionKind(version);
  return kind !== 'unknown' && kind === versionKind(held) && version !== held;
}

/**
 * The plugins Claude Code took out because their marketplace flagged them
 * (`plugins/flagged-plugins.json`), by id. Its shape is not documented: a list
 * of ids or of `{ plugin }` rows, or an object keyed by id, alone or under
 * `plugins`.
 */
function flaggedPlugins(value: unknown): Set<string> {
  const ids = new Set<string>();
  const add = (candidate: unknown) => {
    const id = text(candidate) ?? text(rec(candidate)?.plugin) ?? text(rec(candidate)?.id);
    if (id !== undefined) ids.add(id);
  };
  const listed = Array.isArray(value) ? value : (rec(value)?.plugins ?? value);
  if (Array.isArray(listed)) listed.forEach(add);
  else Object.keys(rec(listed) ?? {}).forEach(add);
  return ids;
}

/**
 * A declared marketplace's source as Claude Code's own add takes it: a
 * repository or a git address with the ref it names, or an absolute folder —
 * never an address a listing would mask.
 */
function addableSource(source: Json | undefined): string | undefined {
  const ref = text(source?.ref);
  const pinned = (from: string) => (ref === undefined ? from : `${from}#${ref}`);
  const repo = text(source?.repo);
  const url = text(source?.url);
  const path = text(source?.path);
  const candidate =
    repo !== undefined
      ? pinned(repo)
      : url !== undefined
        ? describeMcpUrl(url) === url
          ? pinned(url)
          : undefined
        : path !== undefined && isAbsolute(path)
          ? path
          : undefined;
  return candidate !== undefined && isExtensionSource(candidate) ? candidate : undefined;
}

interface CatalogContext {
  /** The root's own installs by id. */
  installed: ReadonlyMap<string, Json>;
  /** The plugins Claude Code flagged and took out, by id. */
  flagged: ReadonlySet<string>;
}

/**
 * The plugins one catalog lists, each by the key Claude Code installs it by
 * (`<entry name>@<marketplace>`): an entry needs a name and a source, and a
 * second by one name is skipped. Only the first entries' folders are read,
 * and every held one's, whose version decides `newer`; the rest show what
 * their entry says. A catalog that lists more than `room` plugins does not fit
 * beside the others: undefined, known one entry past the room, before any
 * folder is read.
 */
async function listedPlugins(
  key: string,
  read: { document: Json; folder: string },
  context: CatalogContext,
  room: number,
): Promise<CatalogPlugin[] | undefined> {
  const entries: Array<{ entry: Json; name: string; id: string; source: EntrySource }> = [];
  const seen = new Set<string>();
  for (const value of read.document.plugins as unknown[]) {
    const entry = rec(value);
    const name = text(entry?.name);
    const source = entry === undefined ? undefined : entrySource(entry.source);
    if (entry === undefined || name === undefined || source === undefined) continue;
    const id = `${name}@${key}`;
    if (name.length > 256 || id.length > MAX_ID || seen.has(id)) continue;
    seen.add(id);
    entries.push({ entry, name, id, source });
    if (entries.length > room) return undefined;
  }
  const real = await realpath(read.folder).catch(() => undefined);
  const marketplace: Inside = real === undefined ? async () => undefined : insideOf(real);
  // `metadata.pluginRoot` goes before every relative source
  const pluginRoot = text(rec(read.document.metadata)?.pluginRoot) ?? '.';
  const listed: CatalogPlugin[] = [];
  for (let start = 0; start < entries.length; start += 16) {
    const batch = entries
      .slice(start, start + 16)
      .map(async ({ entry, name, id, source }, offset): Promise<CatalogPlugin> => {
        const record = context.installed.get(id);
        const folder: { manifest?: Json; parts: ListedParts } =
          source.kind === 'folder' && (start + offset < MAX_CATALOG_FOLDERS || record !== undefined)
            ? await listedFolder(resolve(read.folder, pluginRoot, source.path), marketplace)
            : { parts: {} };
        const manifest = folder.manifest;
        // the manifest's version is Claude Code's first choice, the entry's its next
        const version = [text(manifest?.version), text(entry.version)].find(
          (candidate) => candidate !== undefined && candidate.length <= 128,
        );
        // the entry speaks for the listing; the manifest where it is silent
        const description = text(entry.description) ?? text(manifest?.description);
        const category = text(entry.category);
        const author = authorOf(entry) ?? authorOf(manifest);
        const homepage = homepageOf(entry) ?? homepageOf(manifest);
        const brings = catalogParts(folder.parts, entryParts(entry));
        const asks = source.kind === 'remote' ? source.asks : [];
        const newer =
          record !== undefined && newerListed(version, source.kind === 'remote' ? source.sha : undefined, record);
        return {
          id,
          name,
          marketplace: key,
          ...(description ? { description: description.slice(0, 2_048) } : {}),
          ...(author ? { author } : {}),
          ...(category && category.length <= 64 ? { category } : {}),
          ...(version ? { version } : {}),
          ...(homepage ? { homepage } : {}),
          ...(brings ? { brings } : {}),
          ...(asks.length > 0 ? { asks } : {}),
          ...(context.flagged.has(id) ? { blocked: 'Claude Code flagged it and took it out' } : {}),
          ...(record !== undefined ? { held: id } : {}),
          ...(newer ? { newer: true as const } : {}),
        };
      });
    listed.push(...(await Promise.all(batch)));
  }
  return listed;
}

/** Claude Code extensions capability: its own store files, per profile root. */
export function createClaudeExtensionService(options: ClaudeExtensionOptions = {}): ExtensionService {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());

  const provider: ExtensionProvider = {
    id: 'claude',
    label: 'Claude',
    support: {
      // installed only from a marketplace, whose catalog it keeps: `--plugin-dir` loads a folder for one
      // session, never into a root
      plugins: { store: 'profile', changes: 'command', read: true, catalog: true },
      marketplaces: {
        store: 'profile',
        changes: 'command',
        read: true,
        sources: 'A GitHub repository (owner/repo), a git address, a folder, or the address of a marketplace.json',
      },
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
  //
  // A plugin a catalog lists installs with `claude plugin install <name>@<marketplace>`.
  // An install and an update take `-y`, which Claude Code requires "when stdin
  // or stdout is not a TTY" (RFC 006's resolved question 6, from 2.1.263's
  // help); without it, an act the runtime runs is refused. `-y` is a blanket
  // yes, though: it would also accept, unseen, the command a marketplace runs
  // to fetch a plugin, so a plugin with that source installs in a terminal
  // without it, where the person answers Claude Code's own prompt. A marketplace
  // is added with `claude plugin marketplace add <source>`, fetched again with
  // `update <name>` and removed with `remove <name>`, which uninstalls the
  // plugins installed from it — the report's forms, not probed, and given no
  // `-y`, which an option parser would refuse where the command has none.
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

  function planPlugin(
    profile: AgentProfile,
    item: PluginItem,
    act: ExtensionActKind,
    options: ExtensionActPlanOptions,
  ): ExtensionActPlan {
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
    if (act === 'install' && options.source !== undefined) {
      return extensionActUnavailable(
        target,
        act,
        'unsupported',
        'Claude Code installs a plugin from a marketplace; `--plugin-dir` loads a folder for one session only',
      );
    }
    if (!EXTENSION_PLUGIN_NAME.test(item.id)) {
      return extensionActUnavailable(
        target,
        act,
        act === 'install' ? 'unsupported' : 'no-command',
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
    const env = profileEnv(profile);
    // Grok loads every plugin in the home's own ~/.claude/plugins/installed_plugins.json, in each of its
    // profiles and whatever enabledPlugins says: an install, an uninstall or an update in the native default
    // reaches it, a switch does not. A managed root's plugins are its own.
    const shared: ExtensionReach[] = profile.kind === 'managed' ? [] : ['shared-folder'];
    if (act === 'install') {
      // a marketplace that fetches it by running a command: the person accepts that command at Claude Code's prompt
      if (options.listed?.asks?.some((ask) => ask.kind === 'command') === true) {
        return extensionTerminalPlan({ target, act, argv: scoped('install'), env, reaches: shared });
      }
      return extensionCommandPlan({ target, act, argv: scoped('install', '-y'), env, reaches: shared });
    }
    const argv =
      act === 'remove'
        ? scoped('uninstall', '--keep-data')
        : act === 'purge'
          ? scoped('uninstall')
          : act === 'update'
            ? scoped('update', '-y')
            : scoped(act);
    const reaches = act === 'remove' || act === 'purge' || act === 'update' ? shared : [];
    return extensionCommandPlan({ target, act, argv, env, reaches });
  }

  /** A marketplace is added from a source, fetched again or removed, each with Claude Code's own command. */
  function planMarketplace(profile: AgentProfile, item: MarketplaceItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (act !== 'add' && act !== 'update' && act !== 'remove') {
      return extensionActUnavailable(
        target,
        act,
        'unsupported',
        'Claude Code adds, fetches and removes a marketplace; it has no switch for one',
      );
    }
    const env = profileEnv(profile);
    const marketplace = (verb: string, argument: string) => [executable, 'plugin', 'marketplace', verb, argument];
    // Grok lists the git marketplaces in the home's own ~/.claude/plugins/known_marketplaces.json in every
    // profile of its own; a managed root's are its own.
    const shared: ExtensionReach[] = profile.kind === 'managed' ? [] : ['shared-folder'];
    if (act === 'add') {
      // the runtime names a marketplace it adds by its source, until Claude Code names it from its catalog
      if (item.source === undefined || !isExtensionSource(item.source)) {
        return extensionActUnavailable(
          target,
          act,
          'unsupported',
          'Claude Code adds a marketplace from a repository, a git address, a folder or an address',
        );
      }
      return extensionCommandPlan({ target, act, argv: marketplace('add', item.source), env, reaches: shared });
    }
    if (item.origin === 'managed') {
      return extensionActUnavailable(
        target,
        act,
        'not-own',
        'It comes with your Claude account, from claude.ai, and changes there',
      );
    }
    // Claude Code's own marketplace is the person's to fetch or remove like any other
    if (item.origin !== 'own' && item.origin !== 'bundled') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Claude Code', item));
    }
    if (!COMMAND_ARGUMENT.test(item.id)) {
      return extensionActUnavailable(
        target,
        act,
        'unsupported',
        "Claude Code's commands do not take this marketplace's name",
      );
    }
    if (act === 'update') {
      return extensionCommandPlan({ target, act, argv: marketplace('update', item.id), env, reaches: shared });
    }
    // a marketplace's removal uninstalls every plugin installed from it
    return extensionCommandPlan({
      target,
      act,
      argv: marketplace('remove', item.id),
      env,
      reaches: ['plugins', ...shared],
    });
  }

  /** Installed, updated, and removed with its data: a plugin's acts alone. */
  const PLUGIN_ONLY: Partial<Record<ExtensionActKind, string>> = {
    install: 'Claude Code installs only plugins',
    update: 'Claude Code updates only plugins',
    purge: 'Claude Code removes only a plugin with its data',
  };

  function plan(
    profile: AgentProfile,
    item: ExtensionActItem,
    act: ExtensionActKind,
    options: ExtensionActPlanOptions = {},
  ): ExtensionActPlan {
    if (item.kind === 'plugin') return planPlugin(profile, item, act, options);
    if (item.kind === 'marketplace') return planMarketplace(profile, item, act);
    const pluginOnly = PLUGIN_ONLY[act];
    if (pluginOnly !== undefined) {
      return extensionActUnavailable({ kind: item.kind, id: item.id }, act, 'unsupported', pluginOnly);
    }
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
      const known = await knownMarketplaces(pluginsRoot);
      for (const file of known.unreadable) cannotRead('marketplace', file);
      for (const marketplace of known.marketplaces) {
        items.push({
          kind: 'marketplace',
          id: marketplace.key,
          name: marketplace.key.slice(0, 256),
          origin: marketplace.origin,
          enabled: true,
          ...(marketplace.source ? { source: marketplace.source } : {}),
          ...(marketplace.updatedAt ? { updatedAt: marketplace.updatedAt } : {}),
          ...(marketplace.location ? { location: marketplace.location } : {}),
        });
      }

      // Plugins installed for this root (user scope), and the account's synced ones.
      const plugins: Array<{ item: PluginItem; folder?: string }> = [];
      let installed: Json | undefined;
      try {
        installed = await readJson(join(pluginsRoot, 'installed_plugins.json'), MAX_MANIFEST_BYTES * 8);
      } catch {
        cannotRead('plugin', 'installed_plugins.json');
      }
      for (const [id, record] of userInstalls(installed)) {
        const [name, marketplace] = id.split('@');
        const version = text(record.version);
        const location = bounded(text(record.installPath));
        plugins.push({
          item: {
            kind: 'plugin',
            id,
            name: (name || id).slice(0, 256),
            origin: 'own',
            enabled: enabledPlugins[id] === true,
            ...(version ? { version: version.slice(0, 128) } : {}),
            ...(marketplace ? { marketplace } : {}),
            ...(location ? { location } : {}),
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

    /**
     * What the root could install, from the catalogs Claude Code already
     * fetched: file reads only, so a catalog is as fresh as its marketplace's
     * `updatedAt`. A catalog that cannot be read is its marketplace's `unread`;
     * the list of marketplaces itself unread is a failure, since what the root
     * knows is that list.
     */
    async catalog(profile: AgentProfile): Promise<ExtensionCatalog | ExtensionFailure> {
      const root = profile.dataRoot;
      const pluginsRoot = join(root, 'plugins');
      const known = await knownMarketplaces(pluginsRoot);
      if (known.unreadable.length > 0) {
        return {
          status: 'unavailable',
          provider: 'claude',
          message: `${known.unreadable[0]} could not be read`,
          retryable: true,
        };
      }
      const settings = await readJson(join(root, 'settings.json'), MAX_MANIFEST_BYTES * 4).catch(() => undefined);
      const installed = await readJson(join(pluginsRoot, 'installed_plugins.json'), MAX_MANIFEST_BYTES * 8).catch(
        () => undefined,
      );
      const flagged = await readJsonValue(join(pluginsRoot, 'flagged-plugins.json'), MAX_MANIFEST_BYTES * 4).catch(
        () => undefined,
      );
      const context: CatalogContext = { installed: userInstalls(installed), flagged: flaggedPlugins(flagged) };

      const marketplaces: CatalogMarketplace[] = [];
      const plugins: CatalogPlugin[] = [];
      for (const marketplace of known.marketplaces.slice(0, MAX_CATALOG_MARKETPLACES)) {
        const listing: CatalogMarketplace = {
          id: marketplace.key,
          name: marketplace.key.slice(0, 256),
          origin: marketplace.origin,
          ...(marketplace.source ? { source: marketplace.source } : {}),
          ...(marketplace.updatedAt ? { updatedAt: marketplace.updatedAt } : {}),
        };
        // a folder or a marketplace.json source is read in place
        const read = await readCatalog(marketplace.location ?? marketplace.path);
        if ('unread' in read) {
          marketplaces.push({ ...listing, unread: read.unread });
          continue;
        }
        const listed = await listedPlugins(marketplace.key, read, context, MAX_CATALOG_PLUGINS - plugins.length);
        if (listed === undefined) {
          marketplaces.push({ ...listing, unread: 'It lists more plugins than can be shown beside the others' });
          continue;
        }
        marketplaces.push(listing);
        plugins.push(...listed);
      }

      // What Claude Code adds by itself when it next starts in this root, which the root does not know yet.
      const knownNames = new Set(known.marketplaces.map((marketplace) => marketplace.key));
      const suggested: CatalogSuggestion[] = knownNames.has(OFFICIAL_MARKETPLACE)
        ? []
        : [
            {
              name: OFFICIAL_MARKETPLACE,
              source: OFFICIAL_REPOSITORY,
              message: 'Claude Code adds claude-plugins-official the first time it starts in this profile',
            },
          ];
      for (const [name, declared] of Object.entries(rec(settings?.extraKnownMarketplaces) ?? {})) {
        if (suggested.length >= 4) break;
        if (!text(name) || name.length > 256 || knownNames.has(name) || suggested.some((one) => one.name === name)) {
          continue;
        }
        const source = addableSource(rec(rec(declared)?.source));
        suggested.push({
          name,
          ...(source ? { source } : {}),
          message: 'Claude Code fetches it the next time it starts',
        });
      }

      return {
        provider: 'claude',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        marketplaces,
        plugins,
        ...(suggested.length > 0 ? { suggested } : {}),
        // a marketplace.json is Claude Code's documented format for a catalog
        source: { kind: 'native-store', stability: 'documented' },
      };
    },
  };
}
