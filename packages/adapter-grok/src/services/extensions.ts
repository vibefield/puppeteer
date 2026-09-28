/**
 * Grok extensions (RFC 006 C1): the plugins, MCP servers and skills one
 * profile's `GROK_HOME` loads, read from the files Grok reads — never from
 * `grok mcp doctor`, which connects, and never from `mcp_credentials.json`.
 *
 * Per James's probe of Grok 1.0.41 (puppeteer draft/GROK-PLUGINS-SKILLS-MCP.md,
 * 2026-09-24). `GROK_HOME` isolates Grok's own set: `config.toml`
 * (`[mcp_servers.<name>]`, `disabled_mcp_servers`, `[plugins] disabled`,
 * `[skills] disabled` and `ignore`, `[compat.claude]` and `[compat.cursor]`),
 * `skills/`, `bundled/skills/`, `installed-plugins/<id>/` and `plugins/<name>/`.
 * It does not isolate what Grok borrows from the home around it, which every
 * profile reads from one place:
 * - `~/.agents/skills/`, which other agents read too.
 * - Claude Code's user skills (`~/.claude/skills/`, `synced/` included) and its
 *   `~/.claude.json` servers, each under its `[compat.claude]` cell; Cursor's
 *   `~/.cursor/skills/` and `~/.cursor/mcp.json` under `[compat.cursor]`. A
 *   cell that is off leaves the items listed and out of use.
 * - Every plugin in Claude's `plugins/installed_plugins.json`, from its
 *   `installPath`, whatever Claude's `enabledPlugins` says. A plugin folder that
 *   holds nothing (an LSP cache with only `.in_use/`) is not one. The Claude
 *   skills cell also switches off those plugins' skills (68 = 65 plugin + 3
 *   user rows in the probe), never their servers.
 * A plugin's servers are the `mcpServers` wrapper of its `.mcp.json`; a
 * top-level server map is counted on the plugin and never admitted. A folder in
 * `plugins/` is listed as a plugin, but neither its skills nor its servers
 * activated in the probe, so none are read. Plugins are on unless `[plugins]
 * disabled` names them, as every discovered plugin was in the probe.
 * An install of Grok's or Claude's also says who made it and its homepage, from
 * its manifest, and what it brings, by name only: its `commands/*.md`, its
 * `agents/*.md` and the events its `hooks/hooks.json` runs on. A command is
 * never listed as a skill. Project files (`.grok/`, `.mcp.json`) and `[plugins]
 * paths` are not read; neither are the `GROK_CLAUDE_*_ENABLED` overrides, which
 * belong to a launch environment rather than the profile.
 *
 * Acts (RFC 006 C2): a server of the root's own config turns on and off with
 * `grok mcp enable|disable <name>` and goes with `grok mcp remove <name>
 * --scope user`, which write the profile's `config.toml`. A borrowed server
 * changes in the agent it comes from; a skill's switch (`[skills] disabled`)
 * has no command. A server a host keeps comes in with `grok mcp add --scope
 * user` into the same file, stdio or HTTP (never SSE), each variable it reads
 * written as `${NAME}` for Grok to expand when it loads the server. A skill a
 * host keeps is placed in the root's `skills/` as a link to the host's folder,
 * and one of the root's own there goes: a link is taken away, a real folder
 * moves to where the host keeps it. A plugin Grok installed turns on and off,
 * is uninstalled with or without the data it keeps, and updates, with `grok
 * plugin`; Claude Code's installs, and a folder in `plugins/`, change where
 * they are.
 */

import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
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
  extensionSkillFolderPlan,
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
  type ExtensionService,
  type McpServerDefinition,
  type McpServerItem,
  type McpTransport,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { resolveGrokExecutable } from '../detection.js';
import { GROK_PROFILE_ROOT_VARIABLE } from './profiles.js';

export interface GrokExtensionOptions {
  /** Home directory the native default root and every borrowed store hang off; defaults to the process home. */
  home?: string;
  now?: () => Date;
  /** The `grok` an act runs; the adapter's own resolution when absent. */
  executable?: string;
  env?: NodeJS.ProcessEnv;
}

/** The agents Grok borrows from, by the names a person knows them by. */
const LENDERS: Record<string, string> = { claude: 'Claude Code', cursor: 'Cursor' };

const MAX_CONFIG_BYTES = 1024 * 1024;
/** Claude's app-state file grows with project history; past this it is not parsed. */
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRIES_PER_FOLDER = 512;
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

// ---------------------------------------------------------------------------
// config.toml: the subset Grok writes. Anything else is an error the caller
// reports, never a guess.
// ---------------------------------------------------------------------------

type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
interface TomlTable {
  [key: string]: TomlValue;
}

const isTable = (value: TomlValue | undefined): value is TomlTable =>
  value !== undefined && typeof value === 'object' && !Array.isArray(value);
// Tables have no prototype, so a key such as `__proto__` is only a key.
const newTable = (): TomlTable => Object.create(null) as TomlTable;

export function parseGrokConfig(source: string): TomlTable {
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
// Files
// ---------------------------------------------------------------------------

/** A file that is absent reads as nothing; one that exists and cannot be read is an error the caller reports. */
async function readSized(path: string, limit: number): Promise<string | undefined> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
  if (size > limit) throw new Error(`${path} is larger than ${limit} bytes`);
  return readFile(path, 'utf8');
}

async function readJson(path: string, limit = MAX_MANIFEST_BYTES): Promise<Json | undefined> {
  const source = await readSized(path, limit);
  if (source === undefined) return undefined;
  const document = rec(JSON.parse(source));
  if (!document) throw new Error(`${path} is not a JSON object`);
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

/** Folders directly under `parent`, linked ones included, in name order. */
async function folders(parent: string): Promise<Array<{ name: string; path: string; linkTarget?: string }>> {
  let entries: string[];
  try {
    entries = (await readdir(parent)).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
  const found: Array<{ name: string; path: string; linkTarget?: string }> = [];
  for (const name of entries.slice(0, MAX_ENTRIES_PER_FOLDER)) {
    const path = join(parent, name);
    try {
      const linked = (await lstat(path)).isSymbolicLink();
      if (!(await stat(path)).isDirectory()) continue;
      found.push({ name, path, ...(linked ? { linkTarget: resolve(parent, await readlink(path)) } : {}) });
    } catch {
      continue;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Grok's skill names are lowercase with hyphens: spaces and underscores become hyphens. */
const skillName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-');

/** A skill without a `description` is described by its first paragraph; headings are not paragraphs. */
function firstParagraph(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/u);
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (close < 0) return undefined;
    start = close + 1;
  }
  let paragraph: string[] = [];
  for (const line of [...lines.slice(start), '']) {
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      paragraph.push(trimmed);
      continue;
    }
    if (paragraph.length > 0) return paragraph.join(' ').replace(/\s+/gu, ' ');
    paragraph = [];
  }
  return undefined;
}

interface SkillFolder {
  folder: string;
  directory: string;
  name: string;
  description?: string;
  linkTarget?: string;
}

async function skillFolders(parent: string, skip: ReadonlySet<string> = new Set()): Promise<SkillFolder[]> {
  const found: SkillFolder[] = [];
  for (const entry of await folders(parent)) {
    if (skip.has(entry.name)) continue;
    let markdown: string | undefined;
    try {
      markdown = await readSized(join(entry.path, 'SKILL.md'), MAX_MANIFEST_BYTES);
    } catch {
      markdown = undefined;
    }
    if (markdown === undefined) continue;
    const frontmatter = parseSkillFrontmatter(markdown);
    const name = skillName(frontmatter.name ?? entry.name);
    const description = frontmatter.description ?? firstParagraph(markdown);
    if (!name) continue;
    found.push({
      folder: entry.path,
      directory: entry.name,
      name,
      ...(description ? { description: description.slice(0, 2_048) } : {}),
      ...(entry.linkTarget ? { linkTarget: entry.linkTarget } : {}),
    });
  }
  return found;
}

function skillItem(
  skill: SkillFolder,
  fields: Pick<SkillItem, 'id' | 'origin' | 'enabled'> & Partial<Pick<SkillItem, 'plugin' | 'lender' | 'shared'>>,
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

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/**
 * One definition as Grok reads it from TOML or from a borrowed JSON file:
 * `command` (with `args`, `env`) is stdio; `url` (with `headers`) is HTTP, or
 * SSE when its `type` says so.
 */
function transportOf(definition: Json): McpTransport | undefined {
  const declared = (text(definition.type) ?? text(definition.transport))?.toLowerCase();
  if (text(definition.command) && (declared === undefined || declared === 'stdio')) return 'stdio';
  if (!text(definition.url)) return undefined;
  if (declared === 'sse') return 'sse';
  if (declared === 'ws' || declared === 'websocket') return 'ws';
  if (declared === undefined || ['http', 'streamable-http', 'streamable_http', 'streamablehttp'].includes(declared)) {
    return 'http';
  }
  return undefined;
}

function serverItem(
  name: string,
  definition: unknown,
  fields: Pick<McpServerItem, 'id' | 'origin' | 'enabled'> &
    Partial<Pick<McpServerItem, 'plugin' | 'lender' | 'shared' | 'location'>>,
): McpServerItem | undefined {
  const server = rec(definition);
  const label = text(name);
  if (!server || !label || label.length > 256 || fields.id.length > 512) return undefined;
  const transport = transportOf(server);
  if (!transport) return undefined;
  const target =
    transport === 'stdio'
      ? describeMcpCommand(text(server.command)!, strings(server.args))
      : describeMcpUrl(text(server.url)!);
  if (target.length > 8_192) return undefined;
  const env = Object.keys(rec(server.env) ?? {}).filter((key) => ENVIRONMENT_NAME.test(key));
  const headers = Object.keys(rec(server.headers) ?? {}).filter((key) => HEADER_NAME.test(key));
  // A plugin's server comes and goes with its plugin, so only the root's own and the borrowed ones travel.
  const portable =
    fields.origin === 'own' || fields.origin === 'borrowed' ? definitionOf(server, transport) : undefined;
  return {
    kind: 'mcp-server',
    ...fields,
    name: label,
    transport,
    target,
    ...(env.length > 0 ? { env: env.slice(0, 64) } : {}),
    ...(headers.length > 0 ? { headers: headers.slice(0, 64) } : {}),
    ...(portable === undefined ? {} : { definition: portable }),
  };
}

/**
 * The server as another agent could take it, which Core decides from the
 * values as Grok keeps them, before any masking. Every `env` and `headers` key
 * goes in, not only the ones a listing shows, and `args` must be all text: a
 * definition that dropped anything would not be the server Grok runs.
 */
function definitionOf(server: Json, transport: McpTransport): McpServerDefinition | undefined {
  const args = server.args ?? [];
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) return undefined;
  return mcpServerDefinition({
    transport,
    command: text(server.command),
    args,
    url: text(server.url),
    env: Object.keys(rec(server.env) ?? {}),
    headers: Object.keys(rec(server.headers) ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const PLUGIN_MANIFESTS = [['.grok-plugin', 'plugin.json'], ['plugin.json'], ['.claude-plugin', 'plugin.json']] as const;
const PLUGIN_PARTS = ['skills', 'commands', 'agents', join('hooks', 'hooks.json'), '.mcp.json', '.lsp.json'] as const;

/** A plugin folder's manifest, when it has one; undefined when the folder holds no plugin at all. */
async function pluginAt(folder: string): Promise<{ manifest?: Json } | undefined> {
  for (const parts of PLUGIN_MANIFESTS) {
    const manifest = await readJson(join(folder, ...parts)).catch(() => undefined);
    if (manifest) return { manifest };
  }
  for (const part of PLUGIN_PARTS) if (await exists(join(folder, part))) return {};
  return undefined;
}

/** An event a hook runs on, as a hooks file keys it: `PreToolUse`, `SessionStart`. */
const HOOK_EVENT = /^[A-Za-z][A-Za-z0-9_]{0,255}$/u;

/** A part's name as a person may read it: one line, no control character, as long as Core allows. */
const partName = (name: string): boolean =>
  name.length > 0 && name.length <= 256 && name.trim() === name && !/[\u0000-\u001f\u007f]/u.test(name);

/**
 * Who made a plugin, as its manifest says: `author` as text, or an object's
 * `name`. An address never shows — npm's `Name <email> (url)` keeps the name
 * alone, and any other email-shaped word goes.
 */
function authorOf(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : rec(value)?.name;
  if (typeof raw !== 'string') return undefined;
  const author = raw
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\([^)]*(?::\/\/|@)[^)]*\)/gu, ' ')
    .replace(/\S+@\S+/gu, ' ')
    .replace(/[\s\u0000-\u001f\u007f]+/gu, ' ')
    .trim();
  return author.length > 0 && author.length <= 256 ? author : undefined;
}

/**
 * A plugin's homepage, else its repository (text or `{ url }`): the first that
 * is an http(s) address, as {@link describeMcpUrl} renders one, so a key in its
 * userinfo or query never shows.
 */
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

/** The names of the regular `.md` files in one of a plugin's folders, as its commands or agents are named. */
async function partNames(folder: string, limit: number): Promise<string[]> {
  try {
    const found = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .filter(partName);
    return [...new Set(found)].sort().slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * The events a plugin's `hooks/hooks.json` runs on: the keys of its `hooks`
 * object, or of the file itself without one, whose handlers are a list — so a
 * `description` beside them is no event.
 */
async function hookEvents(file: string): Promise<string[]> {
  const document = await readJson(file).catch(() => undefined);
  const table = document === undefined ? undefined : Object.hasOwn(document, 'hooks') ? rec(document.hooks) : document;
  const events = Object.entries(table ?? {})
    .filter(([event, handlers]) => HOOK_EVENT.test(event) && Array.isArray(handlers))
    .map(([event]) => event);
  return [...new Set(events)].sort().slice(0, 64);
}

/**
 * What a plugin says of itself beside its name: who made it and its homepage,
 * from its manifest, and what it brings, from its folder — names only, and
 * nothing for a part it does not have.
 */
async function pluginDetails(
  folder: string,
  manifest: Json | undefined,
): Promise<Pick<PluginItem, 'author' | 'homepage' | 'brings'>> {
  const author = authorOf(manifest?.author);
  const homepage = homepageOf(manifest);
  const commands = await partNames(join(folder, 'commands'), 256);
  const agents = await partNames(join(folder, 'agents'), 256);
  const hooks = await hookEvents(join(folder, 'hooks', 'hooks.json'));
  const brings = {
    ...(commands.length > 0 ? { commands } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
  };
  return {
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(Object.keys(brings).length > 0 ? { brings } : {}),
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Grok extension capability: its own root's files and the ones it borrows from the home. */
export function createGrokExtensionService(options: GrokExtensionOptions = {}): ExtensionService {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const executable = resolveGrokExecutable(options.executable, options.env ?? process.env);
  const profileEnv = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [GROK_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  function plan(
    profile: AgentProfile,
    item: ExtensionActItem,
    act: ExtensionActKind,
    { keepIn }: ExtensionActPlanOptions = {},
  ): ExtensionActPlan {
    if (item.kind === 'plugin') return planPlugin(profile, item, act);
    if (act === 'update' || act === 'purge') {
      return extensionActUnavailable(
        { kind: item.kind, id: item.id },
        act,
        'unsupported',
        act === 'update' ? 'Only a plugin is updated' : 'Only a plugin is removed with its data',
      );
    }
    if (item.kind === 'skill') return planSkill(profile, item, act, keepIn);
    if (act === 'add') return planAdd(profile, item);
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') return notOwn(item, act);
    if (act === 'sign-in' || act === 'sign-out') {
      return item.transport === 'stdio'
        ? extensionActUnavailable(target, act, 'no-sign-in', `${item.name} runs on this machine and has no sign-in`)
        : extensionActUnavailable(
            target,
            act,
            'in-app',
            'Grok signs in to a server inside the app, in /mcps, or the first time a session uses it',
          );
    }
    if (!EXTENSION_COMMAND_NAME.test(item.id)) {
      return extensionActUnavailable(target, act, 'no-command', "Grok's commands do not take this server's name");
    }
    return extensionCommandPlan({
      target,
      act,
      argv:
        act === 'remove'
          ? [executable, 'mcp', 'remove', item.id, '--scope', 'user']
          : [executable, 'mcp', act, item.id],
      env: profileEnv(profile),
      reaches: act === 'remove' ? ['definition'] : [],
    });
  }

  /** What another agent lends, a plugin brings or Grok ships changes where it comes from. */
  function notOwn(item: ExtensionActItem, act: ExtensionActKind): ExtensionActPlan {
    const lender = item.lender === undefined ? undefined : (LENDERS[item.lender] ?? item.lender);
    return extensionActUnavailable(
      { kind: item.kind, id: item.id },
      act,
      'not-own',
      extensionNotOwnWords('Grok', item, lender),
    );
  }

  /**
   * A plugin in Grok's own install registry (`installed-plugins/`) turns on
   * and off with `grok plugin enable|disable <name>`, is uninstalled with
   * `grok plugin uninstall <name> --confirm` — keeping the data it stored apart
   * from its files with `--keep-data`, or deleting it too without — and updates
   * with `grok plugin update <name>`. These are the report's forms, not probed
   * as acts. `--confirm` answers the question the uninstall would otherwise
   * ask, since an act runs with no stdin, and the name is always given, since
   * `update` without one updates every plugin. Claude Code's installs, which
   * Grok loads from `~/.claude/plugins`, are Claude Code's to change, and a
   * folder in the root's `plugins/` is in no registry a command reads.
   */
  function planPlugin(profile: AgentProfile, item: PluginItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') return notOwn(item, act);
    if (item.id.startsWith('plugins:')) {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        "It is a folder in Grok's plugins folder, and changes there",
      );
    }
    if (act === 'add') {
      return extensionActUnavailable(target, act, 'unsupported', 'Grok installs a plugin from its marketplace');
    }
    if (act === 'sign-in' || act === 'sign-out') {
      return extensionActUnavailable(target, act, 'unsupported', 'Grok has no sign-in for a plugin');
    }
    if (!EXTENSION_PLUGIN_NAME.test(item.id)) {
      return extensionActUnavailable(target, act, 'no-command', "Grok's commands do not take this plugin's name");
    }
    const command =
      act === 'remove'
        ? ['uninstall', item.id, '--confirm', '--keep-data']
        : act === 'purge'
          ? ['uninstall', item.id, '--confirm']
          : [act, item.id];
    return extensionCommandPlan({
      target,
      act,
      argv: [executable, 'plugin', ...command],
      env: profileEnv(profile),
      reaches: [],
    });
  }

  /**
   * A person's skills in a profile are the folders in its root's `skills/`
   * (`$GROK_HOME/skills`), each keyed by its folder's name rather than the
   * lowercase name Grok gives it. A skill the host keeps is linked in there
   * under that key, and one there goes: a link is taken away, a real folder
   * moves to where the host keeps it or, with nowhere to keep it, stays.
   * Whether Grok itself loads a skill whose folder is a link is unproven — the
   * report says only that Grok reloads skills when those files change; the
   * read here follows links, and the runtime's second read is the receipt.
   * `~/.agents/skills`, and what Grok borrows, ships or a plugin brings, are
   * not the root's to place or take away.
   */
  function planSkill(
    profile: AgentProfile,
    item: SkillItem,
    act: ExtensionActKind,
    keepIn: string | undefined,
  ): ExtensionActPlan {
    if (act !== 'add' && act !== 'remove') {
      return extensionActUnavailable(
        { kind: 'skill', id: item.id },
        act,
        'no-command',
        'Grok switches a skill only in its config.toml, with no command',
      );
    }
    if (item.origin !== 'own') return notOwn(item, act);
    return extensionSkillFolderPlan({
      label: 'Grok',
      folder: join(profile.dataRoot, 'skills'),
      item,
      act,
      ...(keepIn === undefined ? {} : { keepIn }),
      home,
    });
  }

  /**
   * `grok mcp add --scope user` writes `[mcp_servers.<name>]` to the profile's
   * config.toml: stdio, or HTTP when the positional after the name is an
   * http(s) address, so an SSE server has no add. Each variable the server
   * reads goes in as `--env NAME=${NAME:-}`, literal text Grok expands from its
   * own environment when it loads the server, so the value stays with whoever
   * starts Grok — and one started without it gives the server an empty value
   * rather than a config it cannot load. The form is the report's, not probed as a whole; the `--`
   * before the command is how a command line with flags of its own reaches the
   * server instead of `grok mcp add`.
   */
  function planAdd(profile: AgentProfile, item: McpServerItem): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    const unsupported = (message: string) => extensionActUnavailable(target, 'add', 'unsupported', message);
    if (item.definition === undefined) return unsupported('Grok adds only a server, from its definition');
    if (!EXTENSION_COMMAND_NAME.test(item.id)) {
      return extensionActUnavailable(target, 'add', 'no-command', "Grok's commands do not take this server's name");
    }
    // Its catalog keys a tool `<server>__<tool>` and skips a server whose name
    // would make that ambiguous: the add would write a server no session loads.
    if (!/^[A-Za-z_]/u.test(item.id) || item.id.includes('__') || item.id.endsWith('_')) {
      return unsupported(
        'Grok loads no server whose name starts with a digit, holds a double underscore or ends in an underscore',
      );
    }
    const { definition } = item;
    let server: string[];
    if (definition.transport === 'stdio') {
      server = [
        ...(definition.env ?? []).flatMap((name) => ['--env', `${name}=\${${name}:-}`]),
        item.id,
        '--',
        definition.command,
        ...definition.args,
      ];
    } else if (definition.transport === 'sse') {
      return unsupported('Grok adds a remote server by its command only over HTTP');
    } else if (!/^https?:\/\//u.test(definition.url)) {
      // Any other positional is a command to Grok's add.
      return unsupported('Grok adds a remote server only at an http(s) address');
    } else {
      server = [item.id, definition.url];
    }
    return extensionCommandPlan({
      target,
      act: 'add',
      argv: [executable, 'mcp', 'add', '--scope', 'user', ...server],
      env: profileEnv(profile),
      reaches: [],
    });
  }

  const provider: ExtensionProvider = {
    id: 'grok',
    label: 'Grok',
    support: {
      // `grok plugin install|uninstall|enable|disable|update` for its own; Claude's installs load in every profile.
      plugins: { store: 'mixed', changes: 'command', read: true },
      // `[[marketplace.sources]]` per root, plus Claude's git sources; not read yet.
      marketplaces: { store: 'mixed', changes: 'command', read: false },
      // `grok mcp add|remove|enable|disable` for the root's config; Claude's and plugins' servers are shared.
      mcpServers: { store: 'mixed', changes: 'command', read: true },
      // The root's own and bundled skills, beside shared folders; `[skills] disabled` has no command.
      skills: { store: 'mixed', changes: 'folder', read: true },
    },
  };

  return {
    provider,
    plan,
    async inventory(profile: AgentProfile): Promise<ExtensionInventory> {
      const root = profile.dataRoot;
      const claudeRoot = join(home, '.claude');
      const cursorRoot = join(home, '.cursor');
      const items: ExtensionItem[] = [];
      const unread: Array<{ kind: ExtensionKind; message: string }> = [];
      const cannotRead = (what: string, ...kinds: ExtensionKind[]) => {
        for (const kind of kinds) {
          if (!unread.some((entry) => entry.kind === kind)) unread.push({ kind, message: `${what} could not be read` });
        }
      };
      const ids = new Set<string>();
      const add = (item: ExtensionItem | undefined) => {
        if (!item || ids.has(`${item.kind} ${item.id}`)) return;
        ids.add(`${item.kind} ${item.id}`);
        items.push(item);
      };

      // The switches: config.toml's own lists, and the cells that let Grok borrow.
      const configPath = join(root, 'config.toml');
      let config = newTable();
      try {
        const source = await readSized(configPath, MAX_CONFIG_BYTES);
        if (source !== undefined) config = parseGrokConfig(source);
      } catch {
        cannotRead('config.toml', 'mcp-server', 'plugin', 'skill');
      }
      const disabledServers = new Set([
        ...strings(config.disabled_mcp_servers),
        ...strings(rec(config.mcp)?.disabled_mcp_servers),
      ]);
      const disabledPlugins = new Set(strings(rec(config.plugins)?.disabled));
      const skillsTable = rec(config.skills);
      const disabledSkills = new Set(strings(skillsTable?.disabled).map(skillName));
      const ignoredSkills = strings(skillsTable?.ignore)
        .map((path) => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path))
        .filter((path) => path.startsWith(sep) || /^[A-Za-z]:[\\/]/u.test(path))
        .map((path) => resolve(path));
      const compat = rec(config.compat);
      const cell = (vendor: string, name: string) => rec(compat?.[vendor])?.[name] !== false;
      const claudeSkills = cell('claude', 'skills');
      const claudeMcps = cell('claude', 'mcps');
      const cursorSkills = cell('cursor', 'skills');
      const cursorMcps = cell('cursor', 'mcps');

      const serverOn = (name: string) => !disabledServers.has(name);
      const skillOn = (skill: SkillFolder) => !disabledSkills.has(skill.name);
      const ignored = (skill: SkillFolder) =>
        ignoredSkills.some((path) => skill.folder === path || skill.folder.startsWith(`${path}${sep}`));

      // Plugins: Grok's own installs, the folders in its `plugins/`, and Claude's installs.
      const plugins: Array<{ item: PluginItem; folder: string; active: boolean; claude: boolean }> = [];
      const pluginNames = new Set<string>();
      for (const entry of await folders(join(root, 'installed-plugins'))) {
        const plugin = await pluginAt(entry.path);
        if (!plugin) continue;
        // An install without a manifest name is listed under its folder's name.
        const name = text(plugin.manifest?.name) ?? entry.name;
        if (name.length > 256 || pluginNames.has(name)) continue;
        pluginNames.add(name);
        const version = text(plugin.manifest?.version);
        const description = text(plugin.manifest?.description);
        plugins.push({
          item: {
            kind: 'plugin',
            id: name,
            name,
            origin: 'own',
            enabled: !disabledPlugins.has(name),
            location: entry.path,
            ...(version && version.length <= 128 ? { version } : {}),
            ...(description ? { description: description.slice(0, 2_048) } : {}),
            ...(await pluginDetails(entry.path, plugin.manifest)),
          },
          folder: entry.path,
          active: true,
          claude: false,
        });
      }
      for (const entry of await folders(join(root, 'plugins'))) {
        const plugin = await pluginAt(entry.path);
        if (!plugin) continue;
        const name = text(plugin.manifest?.name) ?? entry.name;
        if (name.length > 256) continue;
        const description = text(plugin.manifest?.description);
        plugins.push({
          item: {
            kind: 'plugin',
            id: `plugins:${entry.name}`,
            name,
            origin: 'own',
            enabled: !disabledPlugins.has(name),
            location: entry.path,
            ...(description ? { description: description.slice(0, 2_048) } : {}),
          },
          folder: entry.path,
          active: false,
          claude: false,
        });
      }
      let installed: Json | undefined;
      try {
        installed = await readJson(join(claudeRoot, 'plugins', 'installed_plugins.json'), MAX_MANIFEST_BYTES * 8);
      } catch {
        cannotRead('~/.claude/plugins/installed_plugins.json', 'plugin', 'mcp-server', 'skill');
      }
      const claudeNames = new Set<string>();
      for (const [id, records] of Object.entries(rec(installed?.plugins) ?? {})) {
        const candidates = (Array.isArray(records) ? records : [])
          .map(rec)
          .filter((record): record is Json => record !== undefined);
        const record = candidates.find((candidate) => text(candidate.scope) === 'user') ?? candidates[0];
        const folder = text(record?.installPath);
        if (!record || !folder || !text(id) || id.length > 512) continue;
        const plugin = await pluginAt(folder);
        if (!plugin) continue;
        const [idName, idMarketplace] = id.split('@');
        const marketplace = text(idMarketplace);
        const name = text(plugin.manifest?.name) ?? text(idName) ?? id;
        // Two installs of one name: Grok loads one of them.
        if (name.length > 256 || claudeNames.has(name)) continue;
        claudeNames.add(name);
        const version = text(record.version) ?? text(plugin.manifest?.version);
        const description = text(plugin.manifest?.description);
        plugins.push({
          item: {
            kind: 'plugin',
            id,
            name,
            origin: 'borrowed',
            lender: 'claude',
            shared: true,
            enabled: !disabledPlugins.has(name),
            location: folder,
            ...(version && version.length <= 128 ? { version } : {}),
            ...(marketplace && marketplace.length <= 512 ? { marketplace } : {}),
            ...(description ? { description: description.slice(0, 2_048) } : {}),
            ...(await pluginDetails(folder, plugin.manifest)),
          },
          folder,
          active: true,
          claude: true,
        });
      }
      for (const { item, folder, active, claude } of plugins) {
        add(item);
        if (!active) continue;
        const dotMcp = await readJson(join(folder, '.mcp.json')).catch(() => undefined);
        // Only the `mcpServers` wrapper is admitted; a bare server map is not.
        for (const [name, definition] of Object.entries(rec(dotMcp?.mcpServers) ?? {})) {
          add(
            serverItem(name, definition, {
              id: `plugin:${item.id}:${name}`,
              origin: 'plugin',
              plugin: item.id,
              enabled: item.enabled && serverOn(name),
            }),
          );
        }
        for (const skill of await skillFolders(join(folder, 'skills'))) {
          if (ignored(skill)) continue;
          add(
            skillItem(skill, {
              id: `plugin:${item.id}:${skill.directory}`,
              origin: 'plugin',
              plugin: item.id,
              enabled: item.enabled && skillOn(skill) && (!claude || claudeSkills),
            }),
          );
        }
      }

      // Servers: the root's own, then the ones Grok borrows from Claude and Cursor.
      for (const [name, definition] of Object.entries(rec(config.mcp_servers) ?? {})) {
        const table = rec(definition);
        add(
          serverItem(name, definition, {
            id: name,
            origin: 'own',
            enabled: table?.enabled !== false && serverOn(name),
            location: configPath,
          }),
        );
      }
      for (const [lender, file, on] of [
        ['claude', join(home, '.claude.json'), claudeMcps],
        ['cursor', join(cursorRoot, 'mcp.json'), cursorMcps],
      ] as const) {
        let document: Json | undefined;
        try {
          document = await readJson(file, MAX_STORE_BYTES);
        } catch {
          cannotRead(lender === 'claude' ? '~/.claude.json' : '~/.cursor/mcp.json', 'mcp-server');
        }
        for (const [name, definition] of Object.entries(rec(document?.mcpServers) ?? {})) {
          add(
            serverItem(name, definition, {
              id: `${lender}:${name}`,
              origin: 'borrowed',
              lender,
              shared: true,
              enabled: on && serverOn(name),
              location: file,
            }),
          );
        }
      }

      // Skills: the root's own and bundled ones, the shared folder, then Claude's and Cursor's.
      const skillSources: Array<{
        parent: string;
        skip?: ReadonlySet<string>;
        id: (skill: SkillFolder) => string;
        fields: Pick<SkillItem, 'origin'> & Partial<Pick<SkillItem, 'lender' | 'shared'>>;
        on: boolean;
      }> = [
        { parent: join(root, 'skills'), id: (skill) => skill.directory, fields: { origin: 'own' }, on: true },
        {
          parent: join(home, '.agents', 'skills'),
          id: (skill) => `agents:${skill.directory}`,
          fields: { origin: 'own', shared: true },
          on: true,
        },
        {
          parent: join(claudeRoot, 'skills'),
          skip: new Set(['synced']),
          id: (skill) => `claude:${skill.directory}`,
          fields: { origin: 'borrowed', lender: 'claude', shared: true },
          on: claudeSkills,
        },
        {
          parent: join(claudeRoot, 'skills', 'synced'),
          id: (skill) => `claude:synced:${skill.directory}`,
          fields: { origin: 'borrowed', lender: 'claude', shared: true },
          on: claudeSkills,
        },
        {
          parent: join(cursorRoot, 'skills'),
          id: (skill) => `cursor:${skill.directory}`,
          fields: { origin: 'borrowed', lender: 'cursor', shared: true },
          on: cursorSkills,
        },
        {
          parent: join(root, 'bundled', 'skills'),
          id: (skill) => `bundled:${skill.directory}`,
          fields: { origin: 'bundled' },
          on: true,
        },
      ];
      for (const source of skillSources) {
        for (const skill of await skillFolders(source.parent, source.skip)) {
          if (ignored(skill)) continue;
          add(skillItem(skill, { id: source.id(skill), ...source.fields, enabled: source.on && skillOn(skill) }));
        }
      }

      return {
        provider: 'grok',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        items,
        ...(unread.length > 0 ? { unread } : {}),
        // Grok's files and the ones it borrows are undocumented as an interface.
        source: { kind: 'native-store', stability: 'experimental' },
      };
    },
  };
}
