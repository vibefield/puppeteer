/**
 * Hermes extensions (RFC 006 C1): the plugins, MCP servers and skills one
 * profile's `HERMES_HOME` holds, read from Hermes's own files in that root.
 * Never through `hermes plugins|skills|mcp`, which write config, clone
 * repositories and start OAuth; never `.env`, `auth.json` or `mcp-tokens/`
 * contents. A server's OAuth state is whether its token file exists.
 *
 * Read against the 0.21.4 source (`draft/HERMES-PLUGINS-SKILLS-MCP.md`, and the
 * loaders it names, 2026-09-25):
 * - `config.yaml` `mcp_servers.<name>`: `url` makes it HTTP even beside a
 *   `command` (`transport: sse` for SSE), else `command` / `args` / `env` make
 *   it stdio; `enabled` is on unless it reads false (`false`, `no`, `off`,
 *   `0`); `auth: oauth` signs in to `mcp-tokens/<safe name>.json`. `${VAR}` and
 *   `${env:VAR}` are filled from the environment and `.env`, so a definition
 *   reads the variables it references.
 * - Plugins: `plugins/<name>/` or `plugins/<category>/<name>/` holding
 *   `plugin.yaml`, `plugin.yml` or a portable `plugin.json`, keyed by manifest
 *   name (flat) or `<category>/<dir>`. `plugins.disabled` wins; an `exclusive`
 *   plugin (memory) loads when `memory.provider` names it; a `model-provider`
 *   always loads; the rest load when `plugins.enabled` names the key or the
 *   name. A portable package's `mcp.json` servers join unless `config.yaml`
 *   has the name, and its `skills/<name>/SKILL.md` come with it.
 * - Skills: `skills/` (only the active org's `_org/<id>/`), then
 *   `skills.create_dir`, then `skills.external_dirs`, walked as Hermes walks
 *   them; the first skill of a name wins. `skills.disabled` names the ones off
 *   (never `hermes-agent`). Hermes calls a skill in `skills/` bundled when
 *   `.bundled_manifest` lists it, hub-installed when `.hub/lock.json` does, and
 *   agent-created otherwise.
 * Bundled plugins live in the install checkout, which every root on it shares;
 * those the root's config names are listed as bundled, and the backends and
 * platforms that load with no allow-list entry are not. Plugins pip installed
 * into the install's environment are not listed either.
 */

import { lstat, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  describeMcpCommand,
  describeMcpUrl,
  parseSkillFrontmatter,
  type AgentProfile,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionProvider,
  type ExtensionService,
  type McpServerItem,
  type McpTransport,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';

export interface HermesExtensionOptions {
  /** Home directory the native default root hangs off; defaults to the process home. */
  home?: string;
  now?: () => Date;
}

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Hermes reads a skill's first 4000 characters for its name and description. */
const SKILL_HEAD_BYTES = 16 * 1024;
const MAX_SKILLS = 2_048;
const MAX_WALK_DEPTH = 8;
/** `MAX_NAME_LENGTH` in tools/skills_tool.py. */
const MAX_SKILL_NAME = 64;

const PLUGIN_SCHEMA_V1 = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA_V1 = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const PORTABLE_PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const PORTABLE_STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const PORTABLE_REMOTE_FIELDS = new Set(['type', 'url', 'headers']);
const FOREIGN_HARNESS_DIRS = new Set([
  '.claude-plugin',
  '.codex-plugin',
  '.cursor-plugin',
  '.devin-plugin',
  '.kimi-plugin',
]);
const PLUGIN_KINDS = new Set(['standalone', 'backend', 'exclusive', 'platform', 'model-provider']);
const EXCLUDED_SKILL_DIRS = new Set([
  '.git',
  '.github',
  '.hub',
  '.archive',
  '.curator_backups',
  '.locks',
  '.venv',
  'venv',
  'node_modules',
  'site-packages',
  '__pycache__',
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);
const SKILL_SUPPORT_DIRS = new Set(['references', 'templates', 'assets', 'scripts']);
const ESSENTIAL_SKILLS = new Set(['hermes-agent']);
/** `${…}` bodies Hermes fills from its own context, or a portable package's placeholders; none is a variable. */
const NOT_VARIABLES = new Set([
  'userHome',
  'workspaceFolder',
  'workspaceFolderBasename',
  'pathSeparator',
  '/',
  'PLUGIN_ROOT',
  'PLUGIN_DATA',
]);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const REFERENCE = /\$\{([^}]+)\}/gu;

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** A YAML scalar as the string a process would be handed: numbers and booleans spelled out. */
const scalarText = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined;

// ---------------------------------------------------------------------------
// The YAML Hermes and people write: PyYAML `safe_dump` block style (a list
// under a key may sit at the key's own indent, long scalars wrap onto deeper
// lines) and hand-written flow lists and maps, quotes, comments and block
// scalars. Anchors, aliases, tags other than the core ones and complex keys
// are refused, never guessed. Errors never quote the document: its values
// include secrets.
// ---------------------------------------------------------------------------

class YamlSubsetError extends Error {
  constructor() {
    super('the document is outside the YAML subset read here');
  }
}

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);
const BOOLEANS = new Map<string, boolean>(
  ['yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON']
    .map((word): [string, boolean] => [word, true])
    .concat(['no', 'No', 'NO', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF'].map((word) => [word, false])),
);
const INTEGER = /^[-+]?(?:0|[1-9][0-9_]*)$/u;
const FLOAT = /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?$/u;

/** A plain scalar resolved the way PyYAML's safe loader resolves it (YAML 1.1 booleans included). */
function resolvePlain(raw: string): unknown {
  const value = raw.trim();
  if (NULLS.has(value)) return null;
  const truth = BOOLEANS.get(value);
  if (truth !== undefined) return truth;
  if (INTEGER.test(value)) return Number(value.replaceAll('_', ''));
  if (FLOAT.test(value) && /[0-9]/u.test(value)) return Number(value.replaceAll('_', ''));
  return value;
}

function unescapeDouble(body: string): string {
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' };
  return body.replace(/\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/gu, (_, x, u, bigU, other) => {
    if (x || u || bigU) return String.fromCodePoint(parseInt(x ?? u ?? bigU, 16));
    const mapped = simple[other as string];
    if (mapped === undefined) throw new YamlSubsetError();
    return mapped;
  });
}

/** Index just past the quoted scalar that opens `source` at `start`, or -1 when it does not close. */
function quoteEnd(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote === '"' && char === '\\') {
      index += 1;
    } else if (char === quote) {
      if (quote === "'" && source[index + 1] === "'") index += 1;
      else return index + 1;
    }
  }
  return -1;
}

function quotedValue(raw: string): string {
  const folded = raw.replace(/\s*\n\s*/gu, ' ');
  return folded.startsWith('"') ? unescapeDouble(folded.slice(1, -1)) : folded.slice(1, -1).replaceAll("''", "'");
}

/** The text of a line up to its comment: a `#` at the start or after a space, outside quotes. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === '\\') index += 1;
      else if (char === quote) {
        if (quote === "'" && line[index + 1] === "'") index += 1;
        else quote = undefined;
      }
    } else if ((char === '"' || char === "'") && (index === 0 || /[\s:[{,-]/u.test(line[index - 1]!))) {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/u.test(line[index - 1]!))) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

class FlowReader {
  private index = 0;
  constructor(private readonly source: string) {}

  read(): unknown {
    const value = this.value();
    this.space();
    if (this.index !== this.source.length) throw new YamlSubsetError();
    return value;
  }

  private space(): void {
    while (this.index < this.source.length && /\s/u.test(this.source[this.index]!)) this.index += 1;
  }

  private value(): unknown {
    this.space();
    const char = this.source[this.index];
    if (char === '[') return this.sequence();
    if (char === '{') return this.mapping();
    if (char === '"' || char === "'") {
      const end = quoteEnd(this.source, this.index);
      if (end < 0) throw new YamlSubsetError();
      const raw = this.source.slice(this.index, end);
      this.index = end;
      return quotedValue(raw);
    }
    if (char === '&' || char === '*' || char === '!' || char === '?') throw new YamlSubsetError();
    const start = this.index;
    while (this.index < this.source.length) {
      const next = this.source[this.index]!;
      if (next === ',' || next === ']' || next === '}') break;
      if (next === ':' && /[\s,\]}]/u.test(this.source[this.index + 1] ?? ' ')) break;
      this.index += 1;
    }
    return resolvePlain(this.source.slice(start, this.index));
  }

  private sequence(): unknown[] {
    this.index += 1;
    const items: unknown[] = [];
    for (;;) {
      this.space();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return items;
      }
      items.push(this.value());
      this.space();
      const next = this.source[this.index];
      if (next === ',') this.index += 1;
      else if (next !== ']') throw new YamlSubsetError();
    }
  }

  private mapping(): Json {
    this.index += 1;
    const map: Json = Object.create(null) as Json;
    for (;;) {
      this.space();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return map;
      }
      const key = this.value();
      this.space();
      let value: unknown = null;
      if (this.source[this.index] === ':') {
        this.index += 1;
        value = this.value();
        this.space();
      }
      if (key === null || typeof key === 'object') throw new YamlSubsetError();
      map[String(key)] = value;
      const next = this.source[this.index];
      if (next === ',') this.index += 1;
      else if (next !== '}') throw new YamlSubsetError();
    }
  }
}

function flowBalanced(source: string): boolean {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'") {
      const end = quoteEnd(source, index);
      if (end < 0) return false;
      index = end - 1;
    } else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
  }
  return depth <= 0;
}

/** Where a `key: value` line's key ends, or -1 when the line is not a mapping entry. */
function keyEnd(content: string): number {
  let index = 0;
  if (content[0] === '"' || content[0] === "'") {
    index = quoteEnd(content, 0);
    if (index < 0) return -1;
    return content[index] === ':' && (index + 1 === content.length || content[index + 1] === ' ') ? index : -1;
  }
  if ('[{&*!?|>%@`'.includes(content[0] ?? '')) return -1;
  for (; index < content.length; index += 1) {
    if (content[index] === ':' && (index + 1 === content.length || content[index + 1] === ' ')) return index;
  }
  return -1;
}

const isSequenceItem = (content: string): boolean => content === '-' || content.startsWith('- ');

class YamlReader {
  private readonly lines: string[];
  private position = 0;

  constructor(source: string) {
    this.lines = source.replace(/^﻿/u, '').split(/\r?\n/u);
  }

  read(): unknown {
    const first = this.peek();
    if (!first) return null;
    if (first.content === '---') {
      this.position += 1;
      if (!this.peek()) return null;
    }
    const start = this.peek()!;
    const value = this.node(start.indent, -1, 0);
    const rest = this.peek();
    if (rest && rest.content !== '...') throw new YamlSubsetError();
    return value;
  }

  /** The next line that holds content, with its indent; comments and blank lines are skipped. */
  private peek(): { indent: number; content: string } | undefined {
    while (this.position < this.lines.length) {
      const raw = this.lines[this.position]!;
      const indent = raw.length - raw.trimStart().length;
      if (raw.slice(0, indent).includes('\t')) throw new YamlSubsetError();
      const content = stripComment(raw.slice(indent));
      if (content.length > 0) return { indent, content };
      this.position += 1;
    }
    return undefined;
  }

  private replaceCurrent(indent: number, content: string): void {
    this.lines[this.position] = `${' '.repeat(indent)}${content}`;
  }

  /** A block node whose first line sits at `indent`; scalars continue on lines deeper than `owner`. */
  private node(indent: number, owner: number, depth: number): unknown {
    if (depth > 64) throw new YamlSubsetError();
    const line = this.peek()!;
    if (isSequenceItem(line.content)) return this.sequence(indent, depth);
    if (keyEnd(line.content) >= 0) return this.mapping(indent, depth);
    this.position += 1;
    return this.value(line.content, owner, depth);
  }

  private mapping(indent: number, depth: number): Json {
    const map: Json = Object.create(null) as Json;
    for (let line = this.peek(); line && line.indent >= indent; line = this.peek()) {
      if (line.indent > indent) throw new YamlSubsetError();
      if (isSequenceItem(line.content) || line.content === '...') break;
      const end = keyEnd(line.content);
      if (end < 0) throw new YamlSubsetError();
      const rawKey = line.content.slice(0, end).trim();
      const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? quotedValue(rawKey) : rawKey;
      const rest = line.content.slice(end + 1).trim();
      this.position += 1;
      map[key] = this.value(rest, indent, depth);
    }
    return map;
  }

  private sequence(indent: number, depth: number): unknown[] {
    const items: unknown[] = [];
    for (let line = this.peek(); line && line.indent === indent && isSequenceItem(line.content); line = this.peek()) {
      const after = line.content === '-' ? '' : line.content.slice(2);
      const itemContent = after.trimStart();
      if (itemContent.length === 0) {
        this.position += 1;
        const next = this.peek();
        items.push(next && next.indent > indent ? this.node(next.indent, indent, depth + 1) : null);
        continue;
      }
      // The item's content becomes a line of its own at its column, so a
      // `- key: value` item continues as a mapping with the keys below it.
      const column = indent + (line.content.length - itemContent.length);
      this.replaceCurrent(column, itemContent);
      items.push(this.itemValue(column, indent, depth + 1));
    }
    const after = this.peek();
    if (after && after.indent > indent) throw new YamlSubsetError();
    return items;
  }

  private itemValue(column: number, owner: number, depth: number): unknown {
    const line = this.peek()!;
    if (isSequenceItem(line.content) || keyEnd(line.content) >= 0) return this.node(column, owner, depth);
    this.position += 1;
    return this.value(line.content, owner, depth);
  }

  /** The value after `key:` (or of a sequence item), owned by the line at `owner`. */
  private value(rest: string, owner: number, depth: number): unknown {
    if (rest.length === 0) {
      const next = this.peek();
      if (next && next.indent > owner) return this.node(next.indent, owner, depth + 1);
      if (next && next.indent === owner && isSequenceItem(next.content)) return this.sequence(owner, depth + 1);
      return null;
    }
    let content = rest;
    const tag = /^!!(str|int|float|bool|null|seq|map)\s+/u.exec(content);
    if (tag) content = content.slice(tag[0].length);
    if (/^[&*!?%@`]/u.test(content)) throw new YamlSubsetError();
    if (content[0] === '|' || content[0] === '>') return this.blockScalar(content, owner);
    if (content[0] === '[' || content[0] === '{') {
      let source = content;
      while (!flowBalanced(source)) {
        const next = this.peek();
        if (!next || next.indent <= owner) throw new YamlSubsetError();
        source = `${source} ${next.content}`;
        this.position += 1;
      }
      return new FlowReader(source).read();
    }
    const value = this.scalar(content, owner);
    return tag?.[1] === 'str' && value !== null ? String(value) : value;
  }

  private scalar(first: string, owner: number): unknown {
    let source = first;
    const quoted = source[0] === '"' || source[0] === "'";
    // A quoted scalar may run onto following lines; a plain one continues on deeper lines.
    for (;;) {
      if (quoted && quoteEnd(source, 0) >= 0) break;
      const next = this.peek();
      if (!next || next.indent <= owner) break;
      if (!quoted && (isSequenceItem(next.content) || keyEnd(next.content) >= 0)) break;
      source = `${source}\n${next.content}`;
      this.position += 1;
    }
    if (quoted) {
      const end = quoteEnd(source, 0);
      if (end < 0 || source.slice(end).trim().length > 0) throw new YamlSubsetError();
      return quotedValue(source);
    }
    return source.includes('\n') ? source.replace(/\s*\n\s*/gu, ' ').trim() : resolvePlain(source);
  }

  private blockScalar(header: string, owner: number): string {
    const match = /^([|>])([-+]?)([1-9]?)([-+]?)$/u.exec(header);
    if (!match) throw new YamlSubsetError();
    const literal = match[1] === '|';
    const chomp = match[2] || match[4];
    const collected: string[] = [];
    let contentIndent = match[3] ? owner + Number(match[3]) : -1;
    while (this.position < this.lines.length) {
      const raw = this.lines[this.position]!;
      const indent = raw.length - raw.trimStart().length;
      if (raw.trim().length === 0) {
        collected.push('');
        this.position += 1;
        continue;
      }
      if (indent <= owner) break;
      if (contentIndent < 0) contentIndent = indent;
      if (indent < contentIndent) break;
      collected.push(raw.slice(contentIndent));
      this.position += 1;
    }
    while (collected.length > 0 && collected.at(-1) === '' && chomp !== '+') collected.pop();
    const body = literal
      ? collected.join('\n')
      : collected.reduce(
          (joined, line, index) => (index === 0 ? line : line === '' ? `${joined}\n` : `${joined} ${line}`),
          '',
        );
    return chomp === '-' ? body : `${body}\n`;
  }
}

/** A YAML document from the subset above, or a thrown error that says nothing of its contents. */
function parseHermesYaml(source: string): unknown {
  return new YamlReader(source).read();
}

// ---------------------------------------------------------------------------
// Reading the root.
// ---------------------------------------------------------------------------

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** At most `limit` bytes from the start of a file, or undefined when it cannot be read. */
async function readHead(path: string, limit: number): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** A whole file within `limit`; undefined when absent or unreadable, `'too-large'` past the limit. */
async function readWhole(path: string, limit: number): Promise<string | 'too-large' | undefined> {
  try {
    if ((await stat(path)).size > limit) return 'too-large';
  } catch {
    return undefined;
  }
  return readHead(path, limit);
}

async function linkTargetOf(folder: string): Promise<string | undefined> {
  try {
    if (!(await lstat(folder)).isSymbolicLink()) return undefined;
    return resolve(dirname(folder), await readlink(folder));
  } catch {
    return undefined;
  }
}

/** Absent reads as empty, as Hermes starts from defaults; present and unparsable is `undefined`. */
async function readConfig(root: string): Promise<Json | undefined> {
  const path = join(root, 'config.yaml');
  try {
    await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? {} : undefined;
  }
  const source = await readWhole(path, MAX_CONFIG_BYTES);
  if (source === undefined || source === 'too-large') return undefined;
  try {
    const document = parseHermesYaml(source);
    if (document === null) return {};
    return rec(document);
  } catch {
    return undefined;
  }
}

/** `mcp_server_enabled`: absent, null or unparseable is on. */
function boolish(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(word)) return false;
  }
  return true;
}

/** The variables a string reads through `${VAR}` or `${env:VAR}`. */
function references(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const found: string[] = [];
  for (const match of value.matchAll(REFERENCE)) {
    let name = match[1]!.trim();
    if (name.startsWith('env:')) name = name.slice(4).trim();
    if (!NOT_VARIABLES.has(name) && ENVIRONMENT_NAME.test(name)) found.push(name);
  }
  return found;
}

/** `_safe_filename` in tools/mcp_oauth.py: the token file a server's OAuth state lives in. */
function tokenFileName(server: string): string {
  const safe = server
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 128);
  return `${safe || 'default'}.json`;
}

interface ServerFields {
  id: string;
  origin: McpServerItem['origin'];
  enabled: boolean;
  plugin?: string;
  location?: string;
}

async function serverItem(
  name: string,
  definition: Json,
  fields: ServerFields,
  root: string,
): Promise<McpServerItem | undefined> {
  const url = text(definition.url);
  const command = text(definition.command);
  const args = list(definition.args).flatMap((arg) => scalarText(arg) ?? []);
  const env = rec(definition.env) ?? {};
  const headers = rec(definition.headers) ?? {};
  let transport: McpTransport;
  let target: string;
  if (url) {
    transport = definition.transport === 'sse' ? 'sse' : 'http';
    target = describeMcpUrl(url);
  } else if (command) {
    transport = 'stdio';
    target = describeMcpCommand(command, args);
  } else {
    return undefined;
  }
  if (target.length > 8_192) return undefined;
  const variables = [
    ...(transport === 'stdio' ? Object.keys(env) : []),
    ...(transport === 'stdio' ? [command, ...args] : [url]).flatMap(references),
    ...Object.values(transport === 'stdio' ? env : headers).flatMap(references),
  ];
  const envNames = [...new Set(variables)].filter((variable) => ENVIRONMENT_NAME.test(variable)).slice(0, 64);
  const headerNames =
    transport === 'stdio'
      ? []
      : [...new Set(Object.keys(headers))].filter((header) => HEADER_NAME.test(header)).slice(0, 64);
  let auth: McpServerItem['auth'];
  if (
    transport !== 'stdio' &&
    String(definition.auth ?? '')
      .trim()
      .toLowerCase() === 'oauth'
  ) {
    // Whether the token file exists; it is never opened.
    auth = (await isFile(join(root, 'mcp-tokens', tokenFileName(name)))) ? 'signed-in' : 'needs-sign-in';
  }
  return {
    kind: 'mcp-server',
    ...fields,
    name: name.slice(0, 256),
    transport,
    target,
    ...(envNames.length > 0 ? { env: envNames } : {}),
    ...(headerNames.length > 0 ? { headers: headerNames } : {}),
    ...(auth ? { auth } : {}),
  };
}

interface FoundPlugin {
  key: string;
  name: string;
  kind: string;
  folder: string;
  portable: boolean;
  version?: string;
  description?: string;
}

/** `_detect_kind_from_source`: an undeclared memory, cron or model provider, by the markers in its `__init__.py`. */
async function detectedKind(folder: string): Promise<string | undefined> {
  const source = await readHead(join(folder, '__init__.py'), 8_192);
  if (!source) return undefined;
  if (
    ['register_memory_provider', 'MemoryProvider', 'register_cron_scheduler', 'CronScheduler'].some((marker) =>
      source.includes(marker),
    )
  )
    return 'exclusive';
  if (source.includes('register_provider') && source.includes('ProviderProfile')) return 'model-provider';
  return undefined;
}

async function readManifest(folder: string, dirName: string, prefix: string): Promise<FoundPlugin | undefined> {
  const yamlFile = (await isFile(join(folder, 'plugin.yaml')))
    ? join(folder, 'plugin.yaml')
    : (await isFile(join(folder, 'plugin.yml')))
      ? join(folder, 'plugin.yml')
      : undefined;
  if (yamlFile) {
    const source = await readWhole(yamlFile, MAX_MANIFEST_BYTES);
    if (source === undefined || source === 'too-large') return undefined;
    let data: Json | undefined;
    try {
      const document = parseHermesYaml(source);
      data = document === null ? {} : rec(document);
    } catch {
      return undefined;
    }
    if (!data) return undefined;
    const name = scalarText(data.name)?.trim() || dirName;
    const declared = typeof data.kind === 'string' ? data.kind.trim().toLowerCase() : 'standalone';
    let kind = PLUGIN_KINDS.has(declared) ? declared : 'standalone';
    if (kind === 'standalone' && !('kind' in data)) kind = (await detectedKind(folder)) ?? kind;
    const version = scalarText(data.version)?.trim();
    const description = text(data.description);
    return {
      key: prefix ? `${prefix}/${dirName}` : name,
      name,
      kind,
      folder,
      portable: false,
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
    };
  }
  const portableFile = join(folder, 'plugin.json');
  if (!(await isFile(portableFile))) return undefined;
  const source = await readWhole(portableFile, MAX_MANIFEST_BYTES);
  if (source === undefined || source === 'too-large') return undefined;
  let data: Json | undefined;
  try {
    data = rec(JSON.parse(source));
  } catch {
    return undefined;
  }
  const name = typeof data?.name === 'string' ? data.name : undefined;
  if (!data || data.$schema !== PLUGIN_SCHEMA_V1 || !name || name.length > 64 || !PORTABLE_PLUGIN_NAME.test(name))
    return undefined;
  const version = text(data.version);
  const description = text(data.description);
  return {
    key: prefix ? `${prefix}/${dirName}` : name,
    name,
    kind: 'standalone',
    folder,
    portable: true,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
  };
}

/** `scan_directory`: flat plugins, or one category level of them. */
async function scanPlugins(directory: string, prefix = '', depth = 0): Promise<FoundPlugin[]> {
  let children: string[];
  try {
    children = (await readdir(directory)).sort();
  } catch {
    return [];
  }
  const found: FoundPlugin[] = [];
  for (const child of children) {
    if ((child.startsWith('__') && child.endsWith('__')) || FOREIGN_HARNESS_DIRS.has(child)) continue;
    const folder = join(directory, child);
    if (!(await isDirectory(folder))) continue;
    const manifest = await readManifest(folder, child, prefix);
    if (manifest) found.push(manifest);
    // A folder with no manifest at all is a category, walked one level; one whose manifest fails is skipped.
    else if (depth === 0 && !(await manifestFileExists(folder))) found.push(...(await scanPlugins(folder, child, 1)));
  }
  return found;
}

async function manifestFileExists(folder: string): Promise<boolean> {
  for (const file of ['plugin.yaml', 'plugin.yml', 'plugin.json']) {
    if (await isFile(join(folder, file))) return true;
  }
  return false;
}

/** A portable package's servers, as `_discover_mcp` accepts them: stdio and streamable HTTP, no SSE. */
async function portableServers(folder: string): Promise<Array<[string, Json]>> {
  const source = await readWhole(join(folder, 'mcp.json'), MAX_MANIFEST_BYTES);
  if (source === undefined || source === 'too-large') return [];
  let document: Json | undefined;
  try {
    document = rec(JSON.parse(source));
  } catch {
    return [];
  }
  const keys = Object.keys(document ?? {});
  const servers = rec(document?.mcpServers);
  if (!document || keys.length !== 2 || document.$schema !== MCP_SCHEMA_V1 || !servers) return [];
  const accepted: Array<[string, Json]> = [];
  for (const [name, raw] of Object.entries(servers)) {
    const server = rec(raw);
    if (!name || !server) continue;
    const fields = Object.keys(server);
    if (server.type === 'stdio' && fields.every((field) => PORTABLE_STDIO_FIELDS.has(field))) {
      accepted.push([name, server]);
    } else if (
      server.type === 'streamable-http' &&
      fields.every((field) => PORTABLE_REMOTE_FIELDS.has(field)) &&
      text(server.url)
    ) {
      accepted.push([name, server]);
    }
  }
  return accepted;
}

/** A portable package's skills: `skills/<name>/SKILL.md` whose front matter names that folder. */
async function portableSkills(folder: string): Promise<Array<{ name: string; description: string; folder: string }>> {
  let children: string[];
  try {
    children = (await readdir(join(folder, 'skills'))).sort();
  } catch {
    return [];
  }
  const skills: Array<{ name: string; description: string; folder: string }> = [];
  for (const child of children) {
    const skillFolder = join(folder, 'skills', child);
    const head = await readHead(join(skillFolder, 'SKILL.md'), SKILL_HEAD_BYTES);
    if (head === undefined) continue;
    const { name, description } = parseSkillFrontmatter(head);
    if (name !== child || !description || description.length > 1_024) continue;
    skills.push({ name: child, description, folder: skillFolder });
  }
  return skills;
}

/** `parse_config_string_list`: a list, a JSON-array string, or one name. */
function stringList(value: unknown): string[] {
  let items: unknown[] = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      items = list(new FlowReader(value.trim()).read());
    } catch {
      items = [value];
    }
  } else if (typeof value === 'string') items = [value];
  return items.flatMap((item) => scalarText(item)?.trim() || []);
}

/** `SKILL.md` files under one skills directory, as `iter_skill_index_files` walks it. */
async function skillFiles(base: string): Promise<string[]> {
  const activeOrg = (await readHead(join(base, '_org', '.active_org'), 1_024))?.trim() || undefined;
  const orgRoot = join(base, '_org');
  const found: string[] = [];
  const visited = new Set<string>();
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (found.length >= MAX_SKILLS || depth > MAX_WALK_DEPTH) return;
    let real: string;
    try {
      real = await realpath(directory);
    } catch {
      return;
    }
    // Hermes follows links; a link back up the tree is walked once.
    if (visited.has(real)) return;
    visited.add(real);
    let children: string[];
    try {
      children = (await readdir(directory)).sort();
    } catch {
      return;
    }
    const hasSkill = children.includes('SKILL.md') && (await isFile(join(directory, 'SKILL.md')));
    if (hasSkill) found.push(join(directory, 'SKILL.md'));
    for (const child of children) {
      if (directory === base && child === '_org' && activeOrg === undefined) continue;
      if (directory === orgRoot && child !== activeOrg) continue;
      if (EXCLUDED_SKILL_DIRS.has(child) || (hasSkill && SKILL_SUPPORT_DIRS.has(child))) continue;
      const path = join(directory, child);
      if (await isDirectory(path)) await walk(path, depth + 1);
    }
  };
  await walk(base, 0);
  return found.sort();
}

async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Names a skills ledger lists: `.bundled_manifest` is `name:hash` lines; `.hub/lock.json` keys `installed`. */
async function ledgerNames(skillsDirectory: string): Promise<{ bundled: Set<string>; hub: Set<string> }> {
  const manifest = await readHead(join(skillsDirectory, '.bundled_manifest'), MAX_MANIFEST_BYTES);
  const bundled = new Set(
    (manifest ?? '')
      .split('\n')
      .map((line) => line.split(':', 1)[0]!.trim())
      .filter((name) => name.length > 0),
  );
  const hub = new Set<string>();
  const lock = await readWhole(join(skillsDirectory, '.hub', 'lock.json'), MAX_MANIFEST_BYTES);
  if (lock !== undefined && lock !== 'too-large') {
    try {
      const installed = rec(rec(JSON.parse(lock))?.installed) ?? {};
      for (const [name, entry] of Object.entries(installed)) {
        hub.add(name);
        const path = text(rec(entry)?.install_path);
        if (path) hub.add(basename(path));
      }
    } catch {
      // An unreadable lock names nothing; Hermes reads it the same way.
    }
  }
  return { bundled, hub };
}

/** Hermes extension capability: one pass over the root's files per inventory. */
export function createHermesExtensionService(options: HermesExtensionOptions = {}): ExtensionService {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());

  const provider: ExtensionProvider = {
    id: 'hermes',
    label: 'Hermes',
    support: {
      // `hermes plugins install|enable|disable|remove`; the root's own plugins,
      // beside the bundled ones in the install every root shares.
      plugins: { store: 'mixed', changes: 'command', read: true },
      // `hermes mcp add|remove` edit config.yaml. There is no command for
      // `enabled: false`, so a host's "off" is a removal, as with Claude Code.
      mcpServers: { store: 'profile', changes: 'command', read: true },
      // A skill is a folder under the root's `skills/`, or in a folder its
      // config names. `skills.disabled` has only the interactive editor, so no
      // skill is switchable by a host.
      skills: { store: 'profile', changes: 'folder', read: true },
    },
  };

  return {
    provider,

    async inventory(profile: AgentProfile): Promise<ExtensionInventory> {
      // The native default is Hermes's own root, whatever path the profile carries.
      const root = profile.kind === 'native-default' ? join(home, '.hermes') : profile.dataRoot;
      // Puppeteer runs a managed root's Hermes with HOME set to the root, so
      // its `~` is the root; the native default's is the person's home.
      const tildeBase = profile.kind === 'managed' ? root : home;
      const inventory = (items: ExtensionItem[], unread?: ExtensionInventory['unread']): ExtensionInventory => ({
        provider: 'hermes',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        items,
        ...(unread ? { unread } : {}),
        // The layout is read from the source, not a documented contract.
        source: { kind: 'native-store', stability: 'experimental' },
      });

      if (!(await isDirectory(root))) return inventory([]);
      const config = await readConfig(root);
      if (!config) {
        // Every kind depends on it: which servers exist, which plugins load, which skills are off.
        const message = 'config.yaml could not be read';
        return inventory(
          [],
          [
            { kind: 'plugin', message },
            { kind: 'mcp-server', message },
            { kind: 'skill', message },
          ],
        );
      }
      const configFile = join(root, 'config.yaml');
      const items: ExtensionItem[] = [];

      // Plugins.
      const pluginsConfig = rec(config.plugins) ?? {};
      // `_get_enabled_plugins`: a list, or nothing is enabled; names match exactly, as Python's set does.
      const exact = (value: unknown): string[] =>
        list(value).filter((item): item is string => typeof item === 'string');
      const allowed = Array.isArray(pluginsConfig.enabled) ? new Set(exact(pluginsConfig.enabled)) : undefined;
      const denied = new Set(exact(pluginsConfig.disabled));
      const memoryProvider = scalarText(rec(config.memory)?.provider)?.trim();
      const winners = new Map<string, FoundPlugin>();
      for (const plugin of await scanPlugins(join(root, 'plugins'))) winners.set(plugin.key, plugin);
      const loads = (plugin: FoundPlugin): boolean => {
        const names = [plugin.key, plugin.name];
        if (names.some((name) => denied.has(name))) return false;
        if (plugin.kind === 'exclusive') return memoryProvider !== undefined && names.includes(memoryProvider);
        if (plugin.kind === 'model-provider') return true;
        return allowed !== undefined && names.some((name) => allowed.has(name));
      };
      const claimed = new Set<string>();
      const portable: Array<{ plugin: FoundPlugin; enabled: boolean }> = [];
      for (const plugin of winners.values()) {
        claimed.add(plugin.key);
        claimed.add(plugin.name);
        const enabled = loads(plugin);
        if (plugin.key.length > 512 || plugin.name.length > 256) continue;
        const version = plugin.version && plugin.version.length <= 128 ? plugin.version : undefined;
        items.push({
          kind: 'plugin',
          id: plugin.key,
          name: plugin.name,
          origin: 'own',
          enabled,
          location: plugin.folder,
          ...(version ? { version } : {}),
          ...(plugin.description ? { description: plugin.description.slice(0, 2_048) } : {}),
        } satisfies PluginItem);
        if (plugin.portable) portable.push({ plugin, enabled });
      }
      // Names the config gives that no folder in the root answers: the install's own plugins.
      for (const name of [...(allowed ?? []), ...denied]) {
        if (claimed.has(name) || name.length > 256) continue;
        claimed.add(name);
        items.push({
          kind: 'plugin',
          id: `bundled:${name}`,
          name,
          origin: 'bundled',
          enabled: (allowed?.has(name) ?? false) && !denied.has(name),
        } satisfies PluginItem);
      }

      // MCP servers: config.yaml's, then the portable packages' whose names are still free.
      const servers = rec(config.mcp_servers) ?? {};
      const taken = new Set<string>();
      for (const [name, raw] of Object.entries(servers)) {
        const definition = rec(raw);
        if (!definition || name.trim().length === 0) continue;
        const item = await serverItem(
          name,
          definition,
          { id: name.slice(0, 512), origin: 'own', enabled: boolish(definition.enabled), location: configFile },
          root,
        );
        if (item) {
          taken.add(name);
          items.push(item);
        }
      }
      for (const { plugin, enabled } of portable) {
        for (const [name, definition] of await portableServers(plugin.folder)) {
          if (taken.has(name)) continue;
          const item = await serverItem(
            name,
            definition,
            {
              id: `plugin:${plugin.key}:${name}`.slice(0, 512),
              origin: 'plugin',
              plugin: plugin.key,
              enabled,
              location: join(plugin.folder, 'mcp.json'),
            },
            root,
          );
          if (item) {
            taken.add(name);
            items.push(item);
          }
        }
      }

      // Skills: the root's, then create_dir, then external_dirs; the first of a name wins.
      const skillsConfig = rec(config.skills) ?? {};
      const disabled = new Set(stringList(skillsConfig.disabled).filter((name) => !ESSENTIAL_SKILLS.has(name)));
      const local = join(root, 'skills');
      const localReal = await realOrResolved(local);
      const expand = (entry: string): string | undefined => {
        // `${VAR}` and `$VAR` would need Hermes's environment to expand.
        if (entry.includes('$')) return undefined;
        if (entry === '~') return tildeBase;
        if (entry.startsWith('~/')) return join(tildeBase, entry.slice(2));
        if (entry.startsWith('~')) return undefined;
        return isAbsolute(entry) ? entry : join(root, entry);
      };
      const directories: Array<{ path: string; own: boolean }> = [{ path: local, own: false }];
      const seenDirectories = new Set([localReal]);
      const createDirectory = text(skillsConfig.create_dir);
      const configured = [
        ...(createDirectory ? [createDirectory] : []),
        ...stringList(
          typeof skillsConfig.external_dirs === 'string' ? [skillsConfig.external_dirs] : skillsConfig.external_dirs,
        ),
      ];
      for (const entry of configured) {
        const path = expand(entry);
        if (!path || !(await isDirectory(path))) continue;
        const real = await realOrResolved(path);
        if (seenDirectories.has(real)) continue;
        seenDirectories.add(real);
        directories.push({ path, own: true });
      }
      const ledgers = await ledgerNames(local);
      const orgRoot = join(local, '_org') + sep;
      const names = new Set<string>();
      for (const directory of directories) {
        for (const file of await skillFiles(directory.path)) {
          if (file.split(sep).some((part) => EXCLUDED_SKILL_DIRS.has(part))) continue;
          if (names.size >= MAX_SKILLS) break;
          const folder = dirname(file);
          const head = await readHead(file, SKILL_HEAD_BYTES);
          if (head === undefined) continue;
          const frontmatter = parseSkillFrontmatter(head.slice(0, 4_000));
          const name = (frontmatter.name ?? basename(folder)).slice(0, MAX_SKILL_NAME).trim();
          if (!name || names.has(name)) continue;
          names.add(name);
          let origin: SkillItem['origin'];
          if (directory.own) origin = 'own';
          else if (file.startsWith(orgRoot)) origin = 'managed';
          else if (ledgers.bundled.has(name) || ledgers.bundled.has(basename(folder))) origin = 'bundled';
          else if (ledgers.hub.has(name) || ledgers.hub.has(basename(folder))) origin = 'own';
          // Hermes's own word for everything else in `skills/`: the curator ages these.
          else origin = 'agent';
          const linkTarget = await linkTargetOf(folder);
          items.push({
            kind: 'skill',
            id: name,
            name,
            origin,
            enabled: !disabled.has(name),
            location: folder,
            ...(frontmatter.description ? { description: frontmatter.description.slice(0, 2_048) } : {}),
            ...(linkTarget ? { linkTarget } : {}),
          } satisfies SkillItem);
        }
      }
      for (const { plugin, enabled } of portable) {
        for (const skill of await portableSkills(plugin.folder)) {
          items.push({
            kind: 'skill',
            id: `plugin:${plugin.key}:${skill.name}`.slice(0, 512),
            name: skill.name,
            origin: 'plugin',
            plugin: plugin.key,
            enabled,
            location: skill.folder,
            description: skill.description,
          } satisfies SkillItem);
        }
      }

      return inventory(items);
    },
  };
}
