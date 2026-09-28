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
 *   agent-created otherwise; a skill folder there that is a link, which Hermes
 *   never makes, is the person's own.
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
  EXTENSION_COMMAND_NAME,
  EXTENSION_PLUGIN_NAME,
  extensionActUnavailable,
  extensionCommandPlan,
  extensionNotOwnWords,
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
  type ExtensionActItem,
  type ExtensionActKind,
  type ExtensionActPlan,
  type ExtensionActPlanOptions,
  type ExtensionCatalog,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionProvider,
  type ExtensionService,
  type McpServerItem,
  type McpTransport,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { resolveHermesExecutable } from '../detection.js';
import { hermesCheckoutFromWrapper, readHermesWrapper, type HermesWrapperRead } from './distribution.js';
import { HERMES_PROFILE_ROOT_VARIABLE } from './profiles.js';

export interface HermesExtensionOptions {
  /** Home directory the native default root hangs off; defaults to the process home. */
  home?: string;
  now?: () => Date;
  /** The executable an act runs; the adapter's own resolution when absent. */
  executable?: string;
  /** Where the `hermes` wrapper is looked up on PATH; the process's environment when absent. */
  env?: NodeJS.ProcessEnv;
  /** Injected so unit tests never read a real install: the wrapper names the checkout that ships the catalog. */
  readWrapper?: HermesWrapperRead;
  /** The platform a catalog entry must name, as Python's `sys.platform` does; this process's when absent. */
  platform?: NodeJS.Platform;
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

/**
 * Where an open quote closes, read piece by piece as a scalar's lines arrive:
 * each character once, and never the text before — a growing string indexed
 * afresh would be copied whole for every line it gains.
 */
class QuoteScan {
  /** 1 when a `\` ended the last piece, so the next piece's first character is escaped. */
  private carry = 0;

  constructor(private readonly quote: string) {}

  /** Index just past the closing quote in `piece`, reading from `from`, or -1 while the quote stays open. */
  close(piece: string, from: number): number {
    let index = from + this.carry;
    this.carry = 0;
    for (; index < piece.length; index += 1) {
      const char = piece[index];
      if (this.quote === '"' && char === '\\') {
        index += 1;
      } else if (char === this.quote) {
        // a quote a piece ends on closes: the next piece starts with the character that joined the lines
        if (this.quote === "'" && piece[index + 1] === "'") index += 1;
        else return index + 1;
      }
    }
    this.carry = index - piece.length;
    return -1;
  }
}

/** Index just past the quoted scalar that opens `source` at `start`, or -1 when it does not close. */
function quoteEnd(source: string, start: number): number {
  return new QuoteScan(source[start] ?? '').close(source, start + 1);
}

/**
 * Each run of whitespace that holds a line break, as one space: how a
 * scalar's lines join. Found run by run — `\s*\n\s*` would scan a long run
 * with no break again from each of its characters.
 */
function foldLines(text: string): string {
  return text.replace(/\s+/gu, (run) => (run.includes('\n') ? ' ' : run));
}

function quotedValue(raw: string): string {
  const folded = foldLines(raw);
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

/** Whether a flow collection's brackets close, read piece by piece as its lines arrive: each character once. */
class FlowScan {
  private depth = 0;
  private quote: QuoteScan | undefined;

  /** Reads the next piece: whether every bracket opened so far is closed, and no quote is open. */
  balanced(piece: string): boolean {
    let index = 0;
    while (index < piece.length) {
      if (this.quote !== undefined) {
        const end = this.quote.close(piece, index);
        if (end < 0) return false;
        this.quote = undefined;
        index = end;
        continue;
      }
      const char = piece[index]!;
      if (char === '"' || char === "'") this.quote = new QuoteScan(char);
      else if (char === '[' || char === '{') this.depth += 1;
      else if (char === ']' || char === '}') this.depth -= 1;
      index += 1;
    }
    return this.quote === undefined && this.depth <= 0;
  }
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
      const pieces = [content];
      const flow = new FlowScan();
      let balanced = flow.balanced(content);
      while (!balanced) {
        const next = this.peek();
        if (!next || next.indent <= owner) throw new YamlSubsetError();
        const piece = ` ${next.content}`;
        pieces.push(piece);
        balanced = flow.balanced(piece);
        this.position += 1;
      }
      return new FlowReader(pieces.join('')).read();
    }
    const value = this.scalar(content, owner);
    return tag?.[1] === 'str' && value !== null ? String(value) : value;
  }

  private scalar(first: string, owner: number): unknown {
    const pieces = [first];
    const quote = first[0] === '"' || first[0] === "'" ? new QuoteScan(first[0]) : undefined;
    let end = quote ? quote.close(first, 1) : -1;
    let length = first.length;
    // A quoted scalar may run onto following lines; a plain one continues on deeper lines.
    for (;;) {
      if (quote && end >= 0) break;
      const next = this.peek();
      if (!next || next.indent <= owner) break;
      if (!quote && (isSequenceItem(next.content) || keyEnd(next.content) >= 0)) break;
      const piece = `\n${next.content}`;
      pieces.push(piece);
      if (quote) {
        const closed = quote.close(piece, 0);
        if (closed >= 0) end = length + closed;
      }
      length += piece.length;
      this.position += 1;
    }
    const source = pieces.join('');
    if (quote) {
      if (end < 0 || source.slice(end).trim().length > 0) throw new YamlSubsetError();
      return quotedValue(source);
    }
    return source.includes('\n') ? foldLines(source).trim() : resolvePlain(source);
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
  // no reference closes past the last `}`: cut there, so no `${` after it is scanned to the end, one by one
  for (const match of value.slice(0, value.lastIndexOf('}') + 1).matchAll(REFERENCE)) {
    let name = match[1]!.trim();
    if (name.startsWith('env:')) name = name.slice(4).trim();
    if (!NOT_VARIABLES.has(name) && ENVIRONMENT_NAME.test(name)) found.push(name);
  }
  return found;
}

/** `_safe_filename` in tools/mcp_oauth.py: the token file a server's OAuth state lives in. */
function tokenFileName(server: string): string {
  const safe = stripEnds(server.replace(/[^\p{L}\p{N}_-]/gu, '_'), '_').slice(0, 128);
  return `${safe || 'default'}.json`;
}

/**
 * `text` without `char` at either end, as Python's `str.strip(char)`: found
 * by index, since `x+$` would scan a long run of it again from each character.
 */
function stripEnds(text: string, char: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === char) start += 1;
  while (end > start && text[end - 1] === char) end -= 1;
  return text.slice(start, end);
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
  // Only config.yaml's own travel: a package's server comes and goes with the
  // package and may count on its folder. A stdio `cwd` is a folder a
  // definition cannot carry. The server reads the `env` keys, never what fills them.
  const whole = fields.origin === 'own' && (transport !== 'stdio' || text(definition.cwd) === undefined);
  const travels = whole
    ? mcpServerDefinition(
        transport === 'stdio'
          ? { transport, command, args, env: Object.keys(env) }
          : { transport, url, headers: Object.keys(headers) },
      )
    : undefined;
  return {
    kind: 'mcp-server',
    ...fields,
    name: name.slice(0, 256),
    transport,
    target,
    ...(envNames.length > 0 ? { env: envNames } : {}),
    ...(headerNames.length > 0 ? { headers: headerNames } : {}),
    ...(auth ? { auth } : {}),
    ...(travels ? { definition: travels } : {}),
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

// ---------------------------------------------------------------------------
// The plugin catalog (RFC 006 C2), as `hermes_cli/plugin_catalog.py` (0.21.4)
// reads it: one YAML file per entry in the checkout's `plugin-catalog/`, its
// `removed.yaml` the kill list, and the published copy Hermes fetches into the
// root's `cache/plugin-catalog.json` whenever its copy is six hours old. Read
// here, never fetched: the catalog is as new as Hermes's last fetch.
// ---------------------------------------------------------------------------

/** `_NAME_RE`: a catalog key, which is also what `hermes plugins install` takes. */
const CATALOG_NAME = /^[a-z0-9_-]{1,64}$/u;
const CATALOG_SHA = /^[0-9a-f]{40}$/u;
const CATALOG_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/u;
const CATALOG_TIERS = new Set(['official', 'community']);
const CATALOG_CATEGORIES = new Set([
  'desktop',
  'memory',
  'platform',
  'web',
  'tools',
  'voice',
  'automation',
  'models',
  'general',
]);
/** `LIVE_CATALOG_MAX_STALE_SECONDS`: past a day the fetched copy supplies no pins; its removals still count. */
const LIVE_CATALOG_MAX_STALE_MS = 24 * 60 * 60 * 1000;
/** `_MAX_LIVE_BYTES`: the most Hermes takes from the network for its copy. */
const HERMES_LIVE_FETCH_BYTES = 2 * 1024 * 1024;
/**
 * Hermes writes what it parsed back with `json.dumps`, which spaces its
 * separators and escapes every non-ASCII character, so its copy can be larger
 * than what it took: twice that is room for it, and a larger file is not one.
 */
const MAX_LIVE_CATALOG_BYTES = 2 * HERMES_LIVE_FETCH_BYTES;
/** A catalog lists at most as many plugins as Core carries; one shipped file is one entry. */
const MAX_CATALOG_ENTRIES = 8_192;
const MAX_CATALOG_FILE_BYTES = 256 * 1024;
const MAX_INSTALL_RECORDS_BYTES = 4 * 1024 * 1024;
/** `_PLATFORM_ALIASES`: the catalog's words for the platforms Python's `sys.platform` names otherwise. */
const PLATFORM_ALIASES: Record<string, string> = { windows: 'win32', macos: 'darwin' };
const PLATFORM_WORDS: Record<string, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };
const HERMES_CATALOG = {
  id: 'hermes-catalog',
  name: 'Hermes plugin catalog',
  origin: 'bundled',
  source: 'hermes-agent.nousresearch.com',
} as const satisfies CatalogMarketplace;

interface CatalogEntry {
  name: string;
  repo: string;
  /** The commit the catalog pins, lower case. */
  sha: string;
  description: string;
  maintainer: string;
  category: string;
  docsUrl: string;
  /** The label for the pinned commit, when it has a valid one. */
  version: string;
  platforms: string[];
  title: string;
  tools: string[];
  hooks: string[];
  env: string[];
}

interface Removal {
  name: string;
  /** Its repository as `_normalize_repo` spells it; absent when it names none. */
  repo?: string;
  reason: string;
}

/** Python's `str(value or "")` over a scalar: what Hermes's entry reader makes of a field. */
function pyText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value === 0 ? '' : String(value);
  return value === true ? 'True' : '';
}

/** `_str_list`: a list's scalars, spelled as Python spells them. */
function pyList(value: unknown): string[] {
  return list(value).flatMap((item) =>
    typeof item === 'string'
      ? [item]
      : typeof item === 'number'
        ? [String(item)]
        : typeof item === 'boolean'
          ? [item ? 'True' : 'False']
          : [],
  );
}

/** `entry_from_mapping`: one entry, or nothing where Hermes drops it with a warning. */
function catalogEntry(data: unknown): CatalogEntry | undefined {
  const entry = rec(data);
  if (!entry) return undefined;
  const name = pyText(entry.name);
  const repo = pyText(entry.repo);
  const sha = pyText(entry.sha).trim().toLowerCase();
  const category = pyText(entry.category) || 'desktop';
  if (
    !CATALOG_NAME.test(name) ||
    !repo.startsWith('https://') ||
    !CATALOG_SHA.test(sha) ||
    !CATALOG_TIERS.has(pyText(entry.tier) || 'community') ||
    !CATALOG_CATEGORIES.has(category)
  ) {
    return undefined;
  }
  const capabilities = rec(entry.capabilities) ?? {};
  const version = pyText(entry.version).trim();
  return {
    name,
    repo,
    sha,
    description: pyText(entry.description).trim(),
    maintainer: pyText(entry.maintainer).trim(),
    category,
    docsUrl: pyText(entry.docs_url).trim(),
    version: CATALOG_VERSION.test(version) ? version : '',
    platforms: pyList(entry.platforms),
    title: pyText(entry.title).trim(),
    tools: pyList(capabilities.provides_tools),
    hooks: pyList(capabilities.provides_hooks),
    env: pyList(capabilities.requires_env),
  };
}

/** `_removed_from_list`: the kill list's mappings that name what they remove. */
function removals(value: unknown): Removal[] {
  return list(value).flatMap((item) => {
    const removal = rec(item);
    const name = removal === undefined ? '' : pyText(removal.name);
    if (removal === undefined || name === '') return [];
    const repo = pyText(removal.repo);
    return [
      {
        name,
        ...(repo === '' ? {} : { repo: normalizeRepo(repo) }),
        reason: pyText(removal.reason).replace(/\s+/gu, ' ').trim(),
      },
    ];
  });
}

/** `_normalize_repo`: a repository as `host/path`, whatever scheme, user, `www.` or `.git` spells it. */
function normalizeRepo(address: string): string {
  const text = address.trim();
  let host = '';
  let path = text;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/u.exec(text);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else if (text.includes('://')) {
    try {
      const url = new URL(text);
      host = url.hostname;
      path = url.pathname;
    } catch {
      path = '';
    }
  }
  host = host.toLowerCase().replace(/^www\./u, '');
  // `path.strip("/").removesuffix(".git").rstrip("/")`
  path = stripEnds(path, '/');
  path = stripEnds(path.endsWith('.git') ? path.slice(0, -4) : path, '/').toLowerCase();
  return host ? `${host}/${path}` : path;
}

/**
 * `match_removed` over each candidate in turn — a name, or a repository
 * however it is spelled — as a lookup: the first removal in the list that
 * matches either way, as Hermes walks it.
 */
function killList(removed: readonly Removal[]): (candidates: readonly string[]) => Removal | undefined {
  const byName = new Map<string, number>();
  const byRepo = new Map<string, number>();
  removed.forEach((removal, index) => {
    if (!byName.has(removal.name)) byName.set(removal.name, index);
    if (removal.repo !== undefined && !byRepo.has(removal.repo)) byRepo.set(removal.repo, index);
  });
  return (candidates) => {
    for (const candidate of candidates) {
      const text = candidate.trim();
      if (text === '') continue;
      const index = Math.min(byName.get(text) ?? Infinity, byRepo.get(normalizeRepo(text)) ?? Infinity);
      if (index !== Infinity) return removed[index];
    }
    return undefined;
  };
}

/** `packaging.version.VERSION_PATTERN`: the labels Hermes compares when two copies pin one entry differently. */
const PEP440 =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/iu;
const PRE_RELEASE: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

/** A label as `packaging.Version` orders it (`_cmpkey`), with its infinities. */
interface VersionKey {
  epoch: number;
  release: number[];
  pre: [number, number];
  post: number;
  dev: number;
  local?: Array<number | string>;
}

function versionKey(label: string): VersionKey | undefined {
  const match = PEP440.exec(label);
  if (!match) return undefined;
  const [, epoch, release, preLetter, preNumber, postBare, postLetter, postNumber, devLetter, devNumber, local] = match;
  const post =
    postBare !== undefined ? Number(postBare) : postLetter !== undefined ? Number(postNumber ?? 0) : undefined;
  const dev = devLetter !== undefined ? Number(devNumber ?? 0) : undefined;
  return {
    epoch: Number(epoch ?? 0),
    release: release!.split('.').map(Number),
    // a dev release of nothing else sorts before every pre-release, and a final one after them
    pre:
      preLetter !== undefined
        ? [PRE_RELEASE[preLetter.toLowerCase()]!, Number(preNumber ?? 0)]
        : post === undefined && dev !== undefined
          ? [-Infinity, 0]
          : [Infinity, 0],
    post: post ?? -Infinity,
    dev: dev ?? Infinity,
    ...(local !== undefined
      ? { local: local.split(/[-_.]/u).map((part) => (/^\d+$/u.test(part) ? Number(part) : part.toLowerCase())) }
      : {}),
  };
}

function compareVersionKeys(a: VersionKey, b: VersionKey): number {
  const order = (x: number | string, y: number | string): number => (x < y ? -1 : x > y ? 1 : 0);
  let found = order(a.epoch, b.epoch);
  for (let index = 0; found === 0 && index < Math.max(a.release.length, b.release.length); index += 1) {
    found = order(a.release[index] ?? 0, b.release[index] ?? 0);
  }
  found ||= order(a.pre[0], b.pre[0]) || order(a.pre[1], b.pre[1]) || order(a.post, b.post) || order(a.dev, b.dev);
  if (found !== 0 || a.local === b.local) return found;
  if (a.local === undefined || b.local === undefined) return a.local === undefined ? -1 : 1;
  for (let index = 0; index < Math.min(a.local.length, b.local.length); index += 1) {
    const [x, y] = [a.local[index]!, b.local[index]!];
    // a number segment sorts after a word
    if (typeof x !== typeof y) return typeof x === 'number' ? 1 : -1;
    if (x !== y) return order(x, y);
  }
  return order(a.local.length, b.local.length);
}

/**
 * `_prefer_in_tree_entry`, for an entry the checkout and the fetched copy pin
 * differently: the newer copy supplies it. Hermes dates the checkout's catalog
 * by its git history, which no file gives, so the entries' version labels
 * decide, and without two that parse the fetched copy does — as it does for an
 * install that is not a checkout.
 */
function shippedPinIsNewer(shipped: CatalogEntry, fetched: CatalogEntry): boolean {
  if (shipped.sha === fetched.sha || shipped.version === '' || fetched.version === '') return false;
  const ours = versionKey(shipped.version);
  const theirs = versionKey(fetched.version);
  return ours !== undefined && theirs !== undefined && compareVersionKeys(ours, theirs) > 0;
}

async function readCatalogYaml(path: string): Promise<unknown> {
  const source = await readWhole(path, MAX_CATALOG_FILE_BYTES);
  if (source === undefined || source === 'too-large') return undefined;
  try {
    return parseHermesYaml(source) ?? {};
  } catch {
    return undefined;
  }
}

/** `load_catalog` and `load_removed_list` over the checkout's `plugin-catalog/`; undefined when it cannot be listed. */
async function readShippedCatalog(
  directory: string,
): Promise<{ entries: CatalogEntry[]; removed: Removal[] } | undefined> {
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.yaml')).sort();
  } catch {
    return undefined;
  }
  const entries: CatalogEntry[] = [];
  for (const file of files.slice(0, MAX_CATALOG_ENTRIES)) {
    if (file === 'removed.yaml') continue;
    const entry = catalogEntry(await readCatalogYaml(join(directory, file)));
    if (entry) entries.push(entry);
  }
  const removed = files.includes('removed.yaml')
    ? removals(rec(await readCatalogYaml(join(directory, 'removed.yaml')))?.removed)
    : [];
  return { entries, removed };
}

/** `_live_generated_time`: the published copy's ISO time, one with no zone read as UTC. */
function isoTime(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?$/u.exec(text);
  if (!match) return undefined;
  const time = new Date(`${match[1]}T${match[2]}${match[3] ?? 'Z'}`);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

interface FetchedCatalog {
  generatedAt?: string;
  /** Its entries beside the mappings they came from; none from a copy past a day old. */
  entries: Array<{ entry: CatalogEntry; raw: Json }>;
  removed: Removal[];
}

/**
 * The root's `cache/plugin-catalog.json` as `_stale_live_cache` reads it with
 * no network: its entries only while it is under a day old, its removals
 * always. Undefined when it is absent or not a document Hermes wrote.
 */
async function readFetchedCatalog(path: string, now: Date): Promise<FetchedCatalog | undefined> {
  let modified: number;
  try {
    const found = await stat(path);
    if (!found.isFile() || found.size > MAX_LIVE_CATALOG_BYTES) return undefined;
    modified = found.mtimeMs;
  } catch {
    return undefined;
  }
  let document: Json | undefined;
  try {
    document = rec(JSON.parse((await readHead(path, MAX_LIVE_CATALOG_BYTES)) ?? ''));
  } catch {
    return undefined;
  }
  if (!document) return undefined;
  const entries =
    now.getTime() - modified <= LIVE_CATALOG_MAX_STALE_MS
      ? list(document.entries)
          .slice(0, MAX_CATALOG_ENTRIES)
          .flatMap((raw) => {
            const entry = catalogEntry(raw);
            return entry ? [{ entry, raw: rec(raw)! }] : [];
          })
      : [];
  const generatedAt = isoTime(document.generated_at);
  return { ...(generatedAt ? { generatedAt } : {}), entries, removed: removals(document.removed) };
}

/**
 * The installer's own `.install-metadata.json`: a record per folder in the
 * root's `plugins/` — where it came from, at what commit, and whether it is
 * pinned there. Unreadable, it records nothing, as Hermes reads it.
 */
async function installRecords(pluginsDirectory: string): Promise<Map<string, Json>> {
  const records = new Map<string, Json>();
  const source = await readWhole(join(pluginsDirectory, '.install-metadata.json'), MAX_INSTALL_RECORDS_BYTES);
  if (source === undefined || source === 'too-large') return records;
  let document: Json | undefined;
  try {
    document = rec(JSON.parse(source));
  } catch {
    return records;
  }
  for (const [folder, record] of Object.entries(document ?? {})) {
    const found = rec(record);
    if (found) records.set(folder, found);
  }
  return records;
}

/**
 * `read_catalog_sidecar`: the catalog entry a record says its folder was
 * installed from, and `at_catalog_pin`'s commits — the one checked out, and
 * the tag object a tag pin names. Never the `.hermes-catalog.json` inside a
 * plugin's tree, which its repository could forge.
 */
function catalogBlock(record: Json): { name: string; commits: string[] } | undefined {
  const block = rec(record.catalog);
  const name = block === undefined ? '' : pyText(block.name);
  return block === undefined || name === ''
    ? undefined
    : { name, commits: [pyText(block.sha).toLowerCase(), pyText(block.pin).toLowerCase()] };
}

/**
 * `_pull_plugin_update`'s refusal: a repository installed at one commit
 * (`--ref`) is pinned there, and Hermes's update never moves it. A catalog
 * install is recorded pinned too, but its update moves it to the catalog's
 * pin — as it may one from before the record named its entry, whose tree
 * still holds the provenance file Hermes then adopts; neither is pinned here.
 */
async function pinnedInstall(record: Json | undefined, folder: string): Promise<boolean> {
  return (
    record?.pinned === true &&
    catalogBlock(record) === undefined &&
    !(await isFile(join(folder, '.hermes-catalog.json')))
  );
}

/** The platforms an entry names, as a person reads them: "Linux and Windows". */
function spokenPlatforms(platforms: readonly string[]): string {
  const words = [...new Set(platforms.map((platform) => PLATFORM_WORDS[platform.toLowerCase()] ?? platform))];
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');
}

/**
 * An email address in a maintainer, with a bracket that holds it. It is tried
 * only where a word starts (the lookbehind), so a long word with no `@` is
 * scanned once, never again from each of its characters.
 */
const MAINTAINER_EMAIL = /[<(]?(?<![^\s<>()@])[^\s<>()@]+@[^\s<>()@]+[>)]?/gu;

/** A maintainer as a name: an email address in it is left out. */
function maintainerName(maintainer: string): string | undefined {
  const name = maintainer.replace(MAINTAINER_EMAIL, ' ').replace(/\s+/gu, ' ').trim();
  return name === '' ? undefined : name.slice(0, 256);
}

/** Its docs, else its repository, as an address a listing may show. */
function catalogHomepage(entry: CatalogEntry): string | undefined {
  for (const address of [entry.docsUrl, entry.repo]) {
    if (!/^https?:\/\//iu.test(address)) continue;
    const shown = describeMcpUrl(address);
    // a masked address, or one with a masked sign-in, is no page to open
    if (/^https?:\/\/[^/•]/u.test(shown) && shown.length <= 2_048) return shown;
  }
  return undefined;
}

/** Names a listing shows: trimmed, each once, bounded. */
function partNames(names: readonly string[], max: number, length = 256): string[] {
  return [...new Set(names.map((name) => name.trim()).filter((name) => name !== '' && name.length <= length))].slice(
    0,
    max,
  );
}

/** One entry as the catalog shows it, against the kill list, this platform, and what the root holds. */
function catalogPlugin(
  entry: CatalogEntry,
  context: {
    /** The kill list, as `killList` looks an entry up in it. */
    removed: (candidates: readonly string[]) => Removal | undefined;
    platform: string;
    /** The inventory id of the plugin installed from this entry, and the commits it is at. */
    held?: { id: string; commits: readonly string[] };
  },
): CatalogPlugin {
  const removal = context.removed([entry.name, entry.repo]);
  const platforms = new Set(
    entry.platforms.map((platform) => PLATFORM_ALIASES[platform.toLowerCase()] ?? platform.toLowerCase()),
  );
  // `install_catalog_entry` refuses a removal before a platform
  const blocked =
    removal !== undefined
      ? `It was removed from the Hermes plugin catalog${removal.reason ? `: ${removal.reason.slice(0, 1_024)}` : ''}`
      : platforms.size > 0 && !platforms.has(context.platform)
        ? `Hermes offers it only on ${spokenPlatforms(entry.platforms)}`
        : undefined;
  const tools = partNames(entry.tools, 256);
  const hooks = partNames(entry.hooks, 64);
  const brings: CatalogParts = { ...(tools.length > 0 ? { tools } : {}), ...(hooks.length > 0 ? { hooks } : {}) };
  const values = partNames(entry.env, 32, 128);
  // its host capabilities are in its own manifest, known only once it is cloned
  const asks: CatalogAsk[] = [
    { kind: 'scan' },
    ...(values.length > 0 ? [{ kind: 'values' as const, names: values }] : []),
    { kind: 'consent' },
  ];
  const description = entry.description.slice(0, 2_048);
  const author = maintainerName(entry.maintainer);
  const homepage = catalogHomepage(entry);
  const { held } = context;
  return {
    id: entry.name,
    name: (entry.title || entry.name).slice(0, 256),
    marketplace: HERMES_CATALOG.id,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    category: entry.category,
    // `pin_label`
    version: entry.version ? `${entry.version} @ ${entry.sha.slice(0, 8)}` : entry.sha.slice(0, 8),
    ...(homepage ? { homepage } : {}),
    ...(Object.keys(brings).length > 0 ? { brings } : {}),
    asks,
    ...(blocked ? { blocked } : {}),
    ...(held ? { held: held.id } : {}),
    ...(held && !held.commits.includes(entry.sha) ? { newer: true as const } : {}),
  };
}

/** A whole address: a host (and port), a path of one segment or more, and the folder in it after `#`. */
const REPOSITORY_ADDRESS =
  /^(?:https|ssh):\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?(?:\/[A-Za-z0-9_.~-]+)+\/?(?:#[A-Za-z0-9_./-]+)?$/u;
/** `git@host:path`, its path as whole as an address's and never from `/`. */
const REPOSITORY_SCP =
  /^git@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*\/?(?:#[A-Za-z0-9_./-]+)?$/u;
/** GitHub's `owner/repo`, and a folder in it after `/` or `#`. */
const REPOSITORY_SHORTHAND =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:#[A-Za-z0-9_./-]+)?$/u;

/**
 * A source `hermes plugins install` clones (`_resolve_git_url`): GitHub's
 * `owner/repo`, with a folder in it after `/` or `#`, or an https, ssh or
 * `git@host:path` address. Not a bare name, which Hermes reads as its
 * catalog's; not an http or file address, which it only warns about; and not
 * a folder on this Mac, which it would read as `owner/repo`.
 */
function isHermesRepository(source: string): boolean {
  if (!isExtensionSource(source) || source.split(/[/#:]/u).some((part) => part === '.' || part === '..')) return false;
  return [REPOSITORY_ADDRESS, REPOSITORY_SCP, REPOSITORY_SHORTHAND].some((form) => form.test(source));
}

/** Hermes extension capability: one pass over the root's files per inventory. */
export function createHermesExtensionService(options: HermesExtensionOptions = {}): ExtensionService {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const readWrapper = options.readWrapper ?? readHermesWrapper;
  const platform = options.platform ?? process.platform;

  const provider: ExtensionProvider = {
    id: 'hermes',
    label: 'Hermes',
    support: {
      // `hermes plugins install|enable|disable|remove`; the root's own plugins,
      // beside the bundled ones in the install every root shares. It installs
      // from its one catalog by name, or clones a repository it is given.
      plugins: {
        store: 'mixed',
        changes: 'command',
        read: true,
        sources: 'A GitHub repository (owner/repo) or a git address',
        catalog: true,
      },
      // `hermes mcp add|remove` edit config.yaml. There is no command for
      // `enabled: false`, so a host's "off" is a removal, as with Claude Code.
      mcpServers: { store: 'profile', changes: 'command', read: true },
      // A skill is a folder under the root's `skills/`, or in a folder its
      // config names. `skills.disabled` has only the interactive editor, so no
      // skill is switchable by a host.
      skills: { store: 'profile', changes: 'folder', read: true },
    },
  };

  const executable = resolveHermesExecutable(options.executable);
  // The native default is Hermes's own root, whatever path the profile carries.
  const rootOf = (profile: AgentProfile): string =>
    profile.kind === 'native-default' ? join(home, '.hermes') : profile.dataRoot;
  const profileEnv = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [HERMES_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  // Acts (RFC 006 C2): Hermes turns a server off only in its config.yaml
  // (`enabled: false`), so a server of the profile's own is only removed —
  // `hermes mcp remove <name>`. A skill's switch is a config key too. A server
  // its config marks `auth: oauth` signs in with `hermes mcp login <name>`,
  // which opens a browser or asks for a pasted code (so a terminal), into the
  // root's `mcp-tokens/`; no command forgets that sign-in. `hermes mcp add`
  // (0.21.4 `cmd_mcp_add`) connects to the server and asks which of its tools
  // to use, and about signing in to an address, before it saves anything:
  // without a person's answers it saves nothing, so no host adds a server.
  // Hermes has no marketplaces: one catalog, which it fetches again by itself.
  function plan(
    profile: AgentProfile,
    item: ExtensionActItem,
    act: ExtensionActKind,
    options: ExtensionActPlanOptions = {},
  ): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (item.kind === 'marketplace') {
      return extensionActUnavailable(
        target,
        act,
        'unsupported',
        'Hermes installs plugins from its one reviewed catalog or from a repository; it has no marketplaces to add',
      );
    }
    if (item.kind === 'plugin') {
      return act === 'install' ? planInstall(profile, item, options) : planPlugin(profile, item, act);
    }
    if (act === 'install') return extensionActUnavailable(target, act, 'unsupported', 'Hermes installs only plugins');
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Hermes', item));
    }
    if (item.kind === 'skill') return planSkill(profile, item, act);
    if (act === 'add') {
      return extensionActUnavailable(
        target,
        act,
        'in-app',
        'Hermes adds a server only in its own terminal: `hermes mcp add` connects to it and asks which of its tools to use',
      );
    }
    if (act === 'sign-in' || act === 'sign-out') {
      // the read says "signed in" or "asks" only for a server marked `auth: oauth`
      if (item.auth === undefined) {
        return extensionActUnavailable(
          target,
          act,
          'no-sign-in',
          'Hermes signs in only to a server its config marks auth: oauth',
        );
      }
      if (act === 'sign-out') {
        return extensionActUnavailable(
          target,
          act,
          'no-command',
          'Hermes has no command that forgets a sign-in: it keeps it in mcp-tokens',
        );
      }
      if (!EXTENSION_COMMAND_NAME.test(item.id)) {
        return extensionActUnavailable(target, act, 'no-command', "Hermes's commands do not take this server's name");
      }
      return extensionTerminalPlan({
        target,
        act,
        argv: [executable, 'mcp', 'login', item.id],
        env: profileEnv(profile),
      });
    }
    if (act !== 'remove') {
      return extensionActUnavailable(target, act, 'no-command', 'Hermes turns a server off only in its config.yaml');
    }
    if (!EXTENSION_COMMAND_NAME.test(item.id)) {
      return extensionActUnavailable(target, act, 'no-command', "Hermes's commands do not take this server's name");
    }
    return extensionCommandPlan({
      target,
      act,
      argv: [executable, 'mcp', 'remove', item.id],
      env: profileEnv(profile),
      reaches: ['definition'],
    });
  }

  /**
   * A plugin's acts are Hermes's own `hermes plugins` commands (0.21.4, as its
   * source reads, 2026-09-27; not probed as acts), each naming the plugin by
   * its key. A bundled plugin's code is the install's, which every root on it
   * shares, so only its place in this root's config is the host's: `enable`
   * and `disable` write config.yaml alone, and `remove` refuses a bundled name.
   * For one of the root's own:
   * - `enable` installs its Python requirements into the install's shared venv
   *   and asks, at a terminal, to allow each capability it declares — with no
   *   one to answer, nothing is granted — so it runs in a terminal the person
   *   answers;
   * - `disable` only writes config;
   * - `remove` deletes its folder, its install record and its config entries,
   *   and keeps `plugin-data/` and `.env`. No removal of Hermes's deletes
   *   those, so there is no purge;
   * - `update` moves a catalog install to the catalog's pin, and refuses a
   *   repository pinned with `--ref`, which the read marks pinned. A new
   *   commit that adds tools, hooks, requirements or capabilities asks y/N
   *   first, and with no one to answer it changes nothing, so it runs in a
   *   terminal too.
   */
  function planPlugin(profile: AgentProfile, item: PluginItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (act === 'add') {
      return extensionActUnavailable(
        target,
        act,
        'unsupported',
        'Hermes installs a plugin from its catalog or a repository',
      );
    }
    if (act === 'sign-in' || act === 'sign-out') {
      return extensionActUnavailable(target, act, 'unsupported', 'Hermes has no sign-in for a plugin');
    }
    const bundled = item.origin === 'bundled';
    if (item.origin !== 'own' && !(bundled && (act === 'enable' || act === 'disable'))) {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Hermes', item));
    }
    if (act === 'purge') {
      return extensionActUnavailable(
        target,
        act,
        'unsupported',
        "Hermes keeps a plugin's data in plugin-data when it removes it, and has no way to delete it",
      );
    }
    // The read keys a bundled plugin `bundled:<name>`. A key a command could read as a path or a flag — a
    // category plugin's `<category>/<dir>` — is never passed.
    const key = bundled ? item.id.replace(/^bundled:/u, '') : item.id;
    if (!EXTENSION_PLUGIN_NAME.test(key)) {
      return extensionActUnavailable(target, act, 'no-command', "Hermes's commands do not take this plugin's name");
    }
    if (act === 'update' && item.pinned === true) {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        `Hermes keeps ${item.name} pinned to the commit it was installed at; its update never moves it`,
      );
    }
    const asks = act === 'update' || (act === 'enable' && !bundled);
    return (asks ? extensionTerminalPlan : extensionCommandPlan)({
      target,
      act,
      argv: [executable, 'plugins', act, key],
      env: profileEnv(profile),
    });
  }

  /**
   * An install is Hermes's own `hermes plugins install` (0.21.4 `cmd_install`,
   * as its source reads; not probed as an act), in a terminal the person
   * answers: it asks there for the values the plugin reads, whether to turn it
   * on now, and to allow what it may do — with no one to answer it saves no
   * value, leaves the plugin off and grants nothing. A catalog entry installs
   * at the commit the catalog pins, whose scan Hermes accepts; a repository is
   * cloned as it is, and a scan that finds anything asks too, and refuses
   * without an answer. Never `--force`, which also accepts that scan, and
   * never `--allow-removed`.
   */
  function planInstall(profile: AgentProfile, item: PluginItem, options: ExtensionActPlanOptions): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    const install = (identifier: string): ExtensionActPlan =>
      extensionTerminalPlan({
        target,
        act: 'install',
        argv: [executable, 'plugins', 'install', identifier],
        env: profileEnv(profile),
      });
    if (options.source !== undefined) {
      // No `holds` check: Hermes names the plugin from the manifest it clones (`_install_plugin_core`), which the
      // address does not tell, and refuses a name it already has itself.
      return isHermesRepository(options.source)
        ? install(options.source)
        : extensionActUnavailable(
            target,
            'install',
            'unsupported',
            'Hermes installs from its catalog by name, or from a GitHub repository or a git address',
          );
    }
    const { listed } = options;
    if (listed?.held !== undefined) {
      return extensionActUnavailable(target, 'install', 'held', `Hermes already has ${listed.name}; update it instead`);
    }
    if (listed?.blocked !== undefined) return extensionActUnavailable(target, 'install', 'blocked', listed.blocked);
    // a bare name is what Hermes reads as its catalog's (anything else it would clone), and never a flag
    if (!CATALOG_NAME.test(item.id) || item.id.startsWith('-')) {
      return extensionActUnavailable(
        target,
        'install',
        'unsupported',
        `Hermes's catalog has no plugin named ${item.id}`,
      );
    }
    return install(item.id);
  }

  /**
   * A skill a host keeps is placed as a link directly in the root's `skills/`,
   * which Hermes's index walk follows (`iter_skill_index_files` walks with
   * `os.walk(followlinks=True)`), and taking one away takes only such a link.
   * A real folder there is Hermes's own — its hub's, which `.hub/lock.json`
   * tracks, or its curator's — so it never moves, whatever keep a host offers;
   * a skill in a category folder beneath is not the host's to take either.
   */
  function planSkill(profile: AgentProfile, item: SkillItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (act !== 'add' && act !== 'remove') {
      return extensionActUnavailable(target, act, 'no-command', 'Hermes switches a skill only in its config.yaml');
    }
    const folder = join(rootOf(profile), 'skills');
    if (act === 'add' && (EXCLUDED_SKILL_DIRS.has(item.id) || item.id === '_org')) {
      // its walk prunes these, and `_org` is the org mirror's: a link by such a name never reads as the person's skill
      return extensionActUnavailable(target, act, 'unsupported', `Hermes passes over a skills folder named ${item.id}`);
    }
    if (
      act === 'remove' &&
      item.linkTarget === undefined &&
      item.location !== undefined &&
      dirname(item.location) === folder
    ) {
      // the only real folder there the read calls own is one the hub installed
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        `Hermes's skills hub installed ${item.name} and keeps track of it, so its folder stays where Hermes put it`,
      );
    }
    return extensionSkillFolderPlan({ label: 'Hermes', folder, item, act, home });
  }

  /** The checkout the `hermes` wrapper execs, which ships the catalog; undefined when the wrapper does not name one. */
  async function checkoutOf(): Promise<string | undefined> {
    try {
      const wrapper = await readWrapper(executable, env);
      return wrapper === undefined ? undefined : hermesCheckoutFromWrapper(wrapper);
    } catch {
      return undefined;
    }
  }

  return {
    provider,
    plan,

    /**
     * `load_catalog_live` from files: while the root's fetched copy is under a
     * day old its entries are the catalog, each taken from the checkout where
     * the checkout pins it newer; otherwise the checkout's are. Either copy's
     * removals block. An entry is held when the installer's record names it,
     * by the id the inventory gives the folder it went into.
     */
    async catalog(profile: AgentProfile): Promise<ExtensionCatalog> {
      const root = rootOf(profile);
      const time = now();
      const checkout = await checkoutOf();
      const shipped = checkout === undefined ? undefined : await readShippedCatalog(join(checkout, 'plugin-catalog'));
      const fetched = await readFetchedCatalog(join(root, 'cache', 'plugin-catalog.json'), time);
      const live = fetched !== undefined && fetched.entries.length > 0;
      const shippedByName = new Map(shipped?.entries.map((entry) => [entry.name, entry]));
      const entries = live
        ? fetched.entries.map(({ entry, raw }) => {
            const inTree = shippedByName.get(entry.name);
            if (inTree === undefined) return entry;
            if (shippedPinIsNewer(inTree, entry)) return inTree;
            // `_with_curated_fields`: a copy published before an entry had a title takes the checkout's, at one pin
            return inTree.sha === entry.sha && !Object.hasOwn(raw, 'title') ? { ...entry, title: inTree.title } : entry;
          })
        : (shipped?.entries ?? []);
      const removed = killList([...(shipped?.removed ?? []), ...(fetched?.removed ?? [])]);

      // `installed_catalog_state`: a plugin the root has, whose record names the entry, holds it — by the
      // inventory's id for its folder: the manifest's name, else the folder's
      const plugins = join(root, 'plugins');
      const installs = [...(await installRecords(plugins))].flatMap(([folder, record]) => {
        const block = catalogBlock(record);
        return block === undefined ? [] : [{ folder, ...block }];
      });
      const held = new Map<string, { id: string; commits: readonly string[] }>();
      if (installs.length > 0) {
        const ids = new Map<string, string>();
        for (const found of await scanPlugins(plugins)) {
          if (dirname(found.folder) === plugins && found.key.length <= 512) ids.set(basename(found.folder), found.key);
        }
        for (const { name, folder, commits } of installs) {
          const id = ids.get(folder);
          if (id !== undefined) held.set(name, { id, commits });
        }
      }
      const listed: CatalogPlugin[] = [];
      const names = new Set<string>();
      for (const entry of entries) {
        // `get_live_catalog_entry`: the first of a name is the one an install takes
        if (names.has(entry.name)) continue;
        names.add(entry.name);
        const holding = held.get(entry.name);
        listed.push(catalogPlugin(entry, { removed, platform, ...(holding ? { held: holding } : {}) }));
      }
      return {
        provider: 'hermes',
        profileId: profile.id,
        fetchedAt: time.toISOString(),
        marketplaces: [
          {
            ...HERMES_CATALOG,
            ...(live && fetched.generatedAt !== undefined ? { updatedAt: fetched.generatedAt } : {}),
            ...(shipped === undefined && !live
              ? { unread: "Hermes's catalog could not be read from its install" }
              : {}),
          },
        ],
        plugins: listed,
        // The layout is read from the source, not a documented contract.
        source: { kind: 'native-store', stability: 'experimental' },
      };
    },

    async inventory(profile: AgentProfile): Promise<ExtensionInventory> {
      const root = rootOf(profile);
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
      const pluginsDirectory = join(root, 'plugins');
      const records = await installRecords(pluginsDirectory);
      const winners = new Map<string, FoundPlugin>();
      for (const plugin of await scanPlugins(pluginsDirectory)) winners.set(plugin.key, plugin);
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
        // the installer keeps a record only for a folder directly in `plugins/`
        const pinned =
          dirname(plugin.folder) === pluginsDirectory &&
          (await pinnedInstall(records.get(basename(plugin.folder)), plugin.folder));
        items.push({
          kind: 'plugin',
          id: plugin.key,
          name: plugin.name,
          origin: 'own',
          enabled,
          location: plugin.folder,
          ...(version ? { version } : {}),
          ...(plugin.description ? { description: plugin.description.slice(0, 2_048) } : {}),
          ...(pinned ? { pinned: true as const } : {}),
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
          const linkTarget = await linkTargetOf(folder);
          let origin: SkillItem['origin'];
          if (directory.own) origin = 'own';
          else if (file.startsWith(orgRoot)) origin = 'managed';
          // A link is the person's, placed there: skill_manage and the hub
          // write real folders, and the curator, which ages only skills marked
          // `created_by: agent`, walks with `rglob`, which never follows a link.
          else if (linkTarget) origin = 'own';
          else if (ledgers.bundled.has(name) || ledgers.bundled.has(basename(folder))) origin = 'bundled';
          else if (ledgers.hub.has(name) || ledgers.hub.has(basename(folder))) origin = 'own';
          // Hermes's own word for every other folder in `skills/`: the curator ages those skill_manage wrote.
          else origin = 'agent';
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
