/**
 * OpenCode extensions (RFC 006 C1): the plugins, MCP servers and skills an
 * OpenCode profile loads, read from OpenCode's own config documents and skill
 * folders. Never from `opencode mcp list`, which connects every server to draw
 * its view, nor `opencode debug config` or `debug skill`, which print resolved
 * secrets and skill bodies.
 *
 * A profile binds only `XDG_DATA_HOME` (profiles.ts), so every item here is
 * `shared`: the config under the XDG config root and every skill folder are
 * what all of OpenCode's profiles read. The one thing a profile keeps apart
 * for these kinds, its MCP OAuth tokens in `mcp-auth.json`, is a credential
 * store and is not opened, so no server says whether it is signed in.
 *
 * Per James's reading of the 1.18.32 loader (draft/OPENCODE-PLUGINS-SKILLS-MCP.md,
 * 2026-09-24):
 * - Config documents merge in this order, later winning: `config.json`,
 *   `opencode.json` and `opencode.jsonc` in the config root; the file
 *   `OPENCODE_CONFIG` names; `opencode.json` and `opencode.jsonc` in
 *   `~/.opencode` and in `OPENCODE_CONFIG_DIR`; then `OPENCODE_CONFIG_CONTENT`.
 *   `mcp` merges deeply, so a later `{ enabled: false }` switches off a server an
 *   earlier document defined; `plugin` specs accumulate and dedupe by package
 *   name, or by the exact file URL for a path, the last declaration winning.
 * - `{env:NAME}` is substituted into a document's text before it is parsed,
 *   and `{file:path}` pulls in a file's text. Neither is resolved here: a
 *   target keeps `{env:NAME}` as written, and NAME is listed among the
 *   server's environment.
 * - Skills: Claude Code's `~/.claude/skills` (borrowed) and `~/.agents/skills`,
 *   then every `SKILL.md` below a `skill` or `skills` folder of each config
 *   directory, then `skills.paths`; a later skill of the same name replaces an
 *   earlier one. OpenCode keeps a skill with no description but never offers
 *   it to the model, so it reads as off.
 * - Plugins: the specs, and the `.ts` and `.js` files directly inside a
 *   `plugin` or `plugins` folder of each config directory. A package whose
 *   only entry is the TUI's is listed in the TUI's own documents instead:
 *   `tui.json` and `tui.jsonc` in the config root, the file
 *   `OPENCODE_TUI_CONFIG` names, and those two in `~/.opencode` and in
 *   `OPENCODE_CONFIG_DIR` (the 1.18.32 TuiConfig loader). Their plugin lists
 *   are read by the same rules, and nothing else in them is.
 * Not read here: a project's documents and skills, which belong to the
 * project; the documents OpenCode fetches when it starts (a `wellknown`
 * organization's, the active Console org's), which take the network and a
 * token; the managed config directory and macOS managed preferences; the
 * TUI's plugin switches (`plugin_enabled`, which the TUI's own key-value store
 * overrides, keyed by an id a plugin's code may declare), so a TUI plugin
 * reads as on; the plugins and the skill built into the binary; and the
 * skills `skills.urls` downloads at start, which mark the skill kind unread.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  describeMcpCommand,
  describeMcpUrl,
  EXTENSION_COMMAND_NAME,
  extensionActUnavailable,
  extensionCommandPlan,
  extensionNotOwnWords,
  extensionSignInAbsentWords,
  extensionSkillFolderPlan,
  extensionTerminalPlan,
  isExtensionSource,
  isNormalizedAbsolutePath,
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
  type McpServerItem,
  type PluginItem,
  type SkillItem,
} from '@vibefield/puppeteer-core';
import { resolveOpenCodeExecutable } from '../detection.js';
import { OPENCODE_PROFILE_ROOT_VARIABLE, openCodeDataHome } from './profiles.js';

export interface OpenCodeExtensionOptions {
  /** Home directory every path hangs off; defaults to the process home. */
  home?: string;
  /**
   * The environment OpenCode would start with, for the variables that move its
   * config (`XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
   * `OPENCODE_CONFIG_CONTENT`) or switch skill folders off. Defaults to this
   * process's own, or to none when a `home` is injected, so a test never
   * follows the machine's.
   */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The `opencode` a sign-in runs; the adapter's own resolution when absent. */
  executable?: string;
}

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_SKILLS_PER_ROOT = 512;
const MAX_DIRECTORIES_PER_ROOT = 4_096;
const MAX_SKILL_DEPTH = 8;
const MAX_PLUGIN_FILES = 256;

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u;
/** Keys a merge must never copy onto an object. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Auth flows OpenCode now builds in; the loader drops these packages. */
const DEPRECATED_PLUGINS = new Set(['opencode-openai-codex-auth', 'opencode-copilot-auth']);

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const flag = (value: string | undefined): boolean => value === '1' || value?.toLowerCase() === 'true';
const absent = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** The end of the JSON string that opens at `start`, one past its closing quote. */
function stringEnd(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') index += 2;
    else if (source[index] === '"') return index + 1;
    else index += 1;
  }
  return source.length;
}

/**
 * OpenCode parses every config document as JSONC: comments, and a comma
 * before a closing bracket. Both are dropped outside strings, then the rest is
 * plain JSON.
 */
function parseJsonc(source: string): unknown {
  let uncommented = '';
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (char === '"') {
      const end = stringEnd(source, index);
      uncommented += source.slice(index, end);
      index = end;
    } else if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new SyntaxError('unterminated comment');
      uncommented += ' ';
      index = end + 2;
    } else {
      uncommented += char;
      index += 1;
    }
  }
  let json = '';
  for (let index = 0; index < uncommented.length;) {
    const char = uncommented[index]!;
    if (char === '"') {
      const end = stringEnd(uncommented, index);
      json += uncommented.slice(index, end);
      index = end;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (next < uncommented.length && /\s/u.test(uncommented[next]!)) next += 1;
      if (uncommented[next] === '}' || uncommented[next] === ']') {
        index += 1;
        continue;
      }
    }
    json += char;
    index += 1;
  }
  return JSON.parse(json);
}

/** Objects merge key by key; anything else from the later document replaces. */
function mergeDeep(target: Json, source: Json): Json {
  const merged: Json = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const earlier = rec(merged[key]);
    const later = rec(value);
    merged[key] = earlier && later ? mergeDeep(earlier, later) : value;
  }
  return merged;
}

interface ConfigDocument {
  /** Where it was read from; absent for `OPENCODE_CONFIG_CONTENT`. */
  path?: string;
  body: Json;
}

type DocumentRead = ConfigDocument | 'absent' | 'unreadable';

async function readDocument(path: string): Promise<DocumentRead> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    return absent(error) ? 'absent' : 'unreadable';
  }
  if (size > MAX_CONFIG_BYTES) return 'unreadable';
  try {
    // A parser's message can quote the text around a fault, secrets and all: it is never kept.
    const body = rec(parseJsonc((await readFile(path, 'utf8')).replace(/^﻿/u, '')));
    return body ? { path, body } : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function contentDocument(content: string): DocumentRead {
  try {
    const body = rec(parseJsonc(content));
    return body ? { body } : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

// Core's describers keep `${NAME}` and mask what follows a secret-named flag.
// OpenCode writes `{env:NAME}`, so each reference rides through as a `${…}`
// sentinel and is written back afterwards.
const REFERENCE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const SENTINEL = /\$\{PUPPETEER_OPENCODE_ENV_([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const toSentinel = (value: string): string => value.replace(REFERENCE, '$${PUPPETEER_OPENCODE_ENV_$1}');
const fromSentinel = (value: string): string => value.replace(SENTINEL, '{env:$1}');

/**
 * Every `{env:NAME}` a definition reads, wherever it sits: what OpenCode's own
 * `/\{env:([^}]+)\}/g` finds, found by scanning. That pattern runs every
 * `{env:` it meets to the end of the text when no `}` follows, which a crafted
 * config makes a wait as long as the file squared; past the last `}` there is
 * nothing more to find.
 */
function references(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    for (let from = 0; ;) {
      const start = value.indexOf('{env:', from);
      if (start < 0) break;
      const end = value.indexOf('}', start + 5);
      if (end < 0) break;
      if (end > start + 5) into.push(value.slice(start + 5, end).trim());
      from = end + 1;
    }
  } else if (Array.isArray(value)) {
    for (const item of value) references(item, into);
  } else {
    const object = rec(value);
    if (object) for (const item of Object.values(object)) references(item, into);
  }
}

const names = (values: Iterable<string>, pattern: RegExp): string[] =>
  [...new Set(values)].filter((value) => pattern.test(value)).slice(0, 64);

/** `{env:…}` or `{file:…}`: filled in by OpenCode alone, so meaningless in another agent's settings. */
const OWN_REFERENCE = /\{(?:env|file):/u;

/**
 * One merged `mcp` entry as a listing may show it; a value with no known `type` is one OpenCode skips.
 * Its definition, when Core's rules let it travel, comes from the raw values — never the sentinel form —
 * and not at all when the command line or address holds an OpenCode reference, or a local server runs in
 * a folder of its own (`cwd`), which a definition cannot carry.
 */
function serverItem(name: string, definition: Json, location: string | undefined): McpServerItem | undefined {
  const referenced: string[] = [];
  references(definition, referenced);
  let fields: Pick<McpServerItem, 'transport' | 'target' | 'env' | 'headers' | 'definition'>;
  if (definition.type === 'local') {
    const command = definition.command;
    if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) return undefined;
    const [executable, ...args] = command as string[];
    if (!text(executable)) return undefined;
    // What the server reads is what `environment` sets; a `{env:…}` inside a value is OpenCode's to read.
    const environment = Object.keys(rec(definition.environment) ?? {});
    const env = names([...environment, ...referenced], ENVIRONMENT_NAME);
    const travels =
      text(definition.cwd) === undefined && !(command as string[]).some((part) => OWN_REFERENCE.test(part))
        ? mcpServerDefinition({ transport: 'stdio', command: executable, args, env: environment })
        : undefined;
    fields = {
      transport: 'stdio',
      target: fromSentinel(describeMcpCommand(toSentinel(executable!), args.map(toSentinel))),
      ...(env.length > 0 ? { env } : {}),
      ...(travels ? { definition: travels } : {}),
    };
  } else if (definition.type === 'remote') {
    const url = text(definition.url);
    if (!url) return undefined;
    // OpenCode tries Streamable HTTP first and falls back to SSE on its own.
    const env = names(referenced, ENVIRONMENT_NAME);
    const declared = Object.keys(rec(definition.headers) ?? {});
    const headers = names(declared, HEADER_NAME);
    const travels = OWN_REFERENCE.test(url)
      ? undefined
      : mcpServerDefinition({ transport: 'http', url, headers: declared });
    fields = {
      transport: 'http',
      target: fromSentinel(describeMcpUrl(toSentinel(url))),
      ...(env.length > 0 ? { env } : {}),
      ...(headers.length > 0 ? { headers } : {}),
      ...(travels ? { definition: travels } : {}),
    };
  } else {
    return undefined;
  }
  if (fields.target.length > 8_192) return undefined;
  return {
    kind: 'mcp-server',
    id: name,
    name,
    origin: 'own',
    shared: true,
    enabled: definition.enabled !== false,
    ...(location ? { location } : {}),
    ...fields,
  };
}

interface PluginEntry {
  identity: string;
  name: string;
  version?: string;
  location?: string;
}

const stem = (path: string): string => basename(path, extname(path));

/**
 * A `plugin` spec: an npm package (`name`, `name@version`, `@scope/name@tag`),
 * a path relative to the document that declared it, an absolute path, or a
 * `file://` URL. A path's identity is its file URL.
 */
function pluginFromSpec(spec: string, declaredIn: string | undefined): PluginEntry | undefined {
  const value = spec.trim();
  if (!value) return undefined;
  if (value.startsWith('file://')) {
    let path: string | undefined;
    try {
      path = fileURLToPath(value);
    } catch {
      path = undefined;
    }
    return { identity: value, name: stem(path ?? value), ...(path ? { location: path } : {}) };
  }
  if (value.startsWith('./') || value.startsWith('../') || isAbsolute(value)) {
    const path = isAbsolute(value) ? value : declaredIn ? resolve(dirname(declaredIn), value) : undefined;
    return path
      ? { identity: pathToFileURL(path).href, name: stem(path), location: path }
      : { identity: value, name: stem(value) };
  }
  const at = value.startsWith('@') ? value.indexOf('@', 1) : value.indexOf('@');
  const name = at > 0 ? value.slice(0, at) : value;
  const version = at > 0 ? value.slice(at + 1) : undefined;
  return {
    identity: name,
    name,
    // A tag or a range names no installed version.
    ...(version && EXACT_VERSION.test(version) ? { version } : {}),
    ...(declaredIn ? { location: declaredIn } : {}),
  };
}

/** The plugins one document's `plugin` list declares: each a spec, or a `[spec, options]` pair. */
function declaredPlugins(document: ConfigDocument): PluginEntry[] {
  const specs = document.body.plugin;
  if (!Array.isArray(specs)) return [];
  return specs.flatMap((spec) => {
    const declared = typeof spec === 'string' ? spec : Array.isArray(spec) ? spec[0] : undefined;
    const entry = typeof declared === 'string' ? pluginFromSpec(declared, document.path) : undefined;
    return entry ? [entry] : [];
  });
}

/** A package as `opencode plugin` takes one: `name` or `@scope/name`, then a version or a tag after `@`. */
const NPM_SPEC = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9][A-Za-z0-9._+-]*)?$/u;
/** npm's longest package name, its scope included. */
const NPM_NAME_LENGTH = 214;
/** A spec npm fetches from a repository or an address instead of its registry. */
const REPOSITORY_SPEC = /^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/u;

const SOURCE_WORDS = {
  other: 'OpenCode installs a plugin from an npm package, by its name, or from a folder, by its whole path',
  relative: "Give the folder's whole path: OpenCode would read a relative one from its config's folder",
  home: "Give the folder's whole path, from `/`",
  unnormalized: "Give the folder's whole path, with no `.` or `..` in it and no `/` at its end",
  address: "Give the folder's whole path instead of this `file://` address",
  repository: 'OpenCode installs a plugin from npm or a folder, not from a repository or an address',
  range: 'Name one version or tag of the package, not a range',
} as const;

/**
 * What `opencode plugin` would install from a source a person gave, keyed as
 * the inventory holds what it installs — a package by its name, its scope kept
 * and its version dropped, a folder by its `file://` URL — or why OpenCode
 * would not take it as given. OpenCode writes the source into its config as it
 * is and loads it from there: a relative folder would be read from the
 * config's folder, not from where it was given, so a folder is only its whole
 * path; and a package is only its registry's, by one version or tag.
 */
function installSource(source: string): { key: string; shown: string } | { refused: string } {
  if (!isExtensionSource(source)) return { refused: SOURCE_WORDS.other };
  if (source.startsWith('file://')) {
    let path: string | undefined;
    try {
      path = fileURLToPath(source);
    } catch {
      path = undefined;
    }
    // Only the address a whole path makes: the inventory keys a `file://` spec as it is written, and an
    // address resolves its own `.` and `..`.
    return path !== undefined && isNormalizedAbsolutePath(path) && pathToFileURL(path).href === source
      ? { key: source, shown: path }
      : { refused: SOURCE_WORDS.address };
  }
  if (source.startsWith('/')) {
    return isAbsolute(source) && isNormalizedAbsolutePath(source)
      ? { key: pathToFileURL(source).href, shown: source }
      : { refused: SOURCE_WORDS.unnormalized };
  }
  if (source.startsWith('.')) return { refused: SOURCE_WORDS.relative };
  if (source.startsWith('~')) return { refused: SOURCE_WORDS.home };
  if (REPOSITORY_SPEC.test(source)) return { refused: SOURCE_WORDS.repository };
  const at = source.indexOf('@', 1);
  const name = at < 0 ? source : source.slice(0, at);
  if (at >= 0 && /[\^~<>=|*]/u.test(source.slice(at + 1))) return { refused: SOURCE_WORDS.range };
  if (!NPM_SPEC.test(source) || name.length > NPM_NAME_LENGTH) return { refused: SOURCE_WORDS.other };
  return { key: name, shown: name };
}

async function pluginFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const folder of ['plugin', 'plugins']) {
    let entries: string[];
    try {
      entries = (await readdir(join(directory, folder))).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_PLUGIN_FILES) return files;
      if (!/\.(?:ts|js)$/u.test(entry)) continue;
      const path = join(directory, folder, entry);
      try {
        if ((await stat(path)).isFile()) files.push(path);
      } catch {
        // A dangling link loads nothing.
      }
    }
  }
  return files;
}

interface SkillFile {
  file: string;
  folder: string;
  linkTarget?: string;
}

/** Every `SKILL.md` under a root, dotfolders and linked folders included, within bounds. */
async function skillFiles(root: string): Promise<SkillFile[]> {
  const found: SkillFile[] = [];
  const visited = new Set<string>();
  const walk = async (directory: string, depth: number, linkTarget?: string): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH || visited.size >= MAX_DIRECTORIES_PER_ROOT || found.length >= MAX_SKILLS_PER_ROOT)
      return;
    let real: string;
    try {
      real = await realpath(directory);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: Dirent[];
    try {
      entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === 'SKILL.md' && !entry.isDirectory())) {
      found.push({ file: join(directory, 'SKILL.md'), folder: directory, ...(linkTarget ? { linkTarget } : {}) });
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isSymbolicLink()) {
        let target: string;
        try {
          if (!(await stat(path)).isDirectory()) continue;
          target = resolve(directory, await readlink(path));
        } catch {
          continue;
        }
        await walk(path, depth + 1, target);
      }
    }
  };
  await walk(root, 0);
  return found;
}

interface SkillRoot {
  path: string;
  origin: 'own' | 'borrowed';
}

async function readSkill(found: SkillFile, root: SkillRoot): Promise<SkillItem | undefined> {
  let body: string;
  try {
    if ((await stat(found.file)).size > MAX_SKILL_BYTES) return undefined;
    body = await readFile(found.file, 'utf8');
  } catch {
    return undefined;
  }
  const frontmatter = parseSkillFrontmatter(body);
  // OpenCode's loader needs a string `name`; nothing else in the frontmatter is required.
  const name = frontmatter.name;
  if (!name || name.length > 256) return undefined;
  const description = frontmatter.description?.slice(0, 2_048);
  return {
    kind: 'skill',
    id: name,
    name,
    origin: root.origin,
    ...(root.origin === 'borrowed' ? { lender: 'claude' } : {}),
    shared: true,
    // Undescribed, it stays in OpenCode's map and out of the list the model is offered.
    enabled: description !== undefined,
    location: found.folder,
    ...(description ? { description } : {}),
    ...(found.linkTarget ? { linkTarget: found.linkTarget } : {}),
  };
}

/** OpenCode extension capability: its shared config documents and skill folders, read as files. */
export function createOpenCodeExtensionService(options: OpenCodeExtensionOptions = {}): ExtensionService {
  const home = options.home ?? homedir();
  const env = options.env ?? (options.home !== undefined ? {} : process.env);
  const now = options.now ?? (() => new Date());

  const provider: ExtensionProvider = {
    id: 'opencode',
    label: 'OpenCode',
    support: {
      // `opencode plugin <module>` installs a package from npm, or takes a folder, and writes its spec into the one
      // config every profile reads; no command removes one. It has no marketplace to install from. A session this
      // runtime hosts starts `--pure` (OPENCODE_LAUNCH_FLAGS.pure, in launch/backend.ts and driver.ts), which loads
      // OpenCode's built-in plugins alone: one the read lists loads only when a person runs OpenCode themselves.
      plugins: {
        store: 'shared',
        changes: 'command',
        read: true,
        hostedSkips: true,
        sources: 'An npm package, or a folder with a package.json',
      },
      // `opencode mcp add` adds one, but nothing turns a server off or removes it except an edit to that config;
      // the instance's connect and disconnect last only as long as the process.
      mcpServers: { store: 'shared', changes: 'in-app', read: true },
      skills: { store: 'shared', changes: 'folder', read: true },
    },
  };

  const shown = (path: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

  /** The global config directory, first of those OpenCode scans: read per call, as `env` may be the process's. */
  const configRootOf = (): string => {
    const configHome = text(env.XDG_CONFIG_HOME);
    return join(configHome && isAbsolute(configHome) ? configHome : join(home, '.config'), 'opencode');
  };

  const executable = resolveOpenCodeExecutable(options.executable);

  // A managed profile binds only its data home, where its sign-ins are: a command that reads them reads the profile's.
  const profileEnv = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [OPENCODE_PROFILE_ROOT_VARIABLE]: openCodeDataHome(profile) };

  // Acts (RFC 006 C2): OpenCode has no command that turns a server off or a
  // skill out — both are keys of its one config, which serves every profile.
  // A remote server's sign-in is the profile's own, though: `mcp-auth.json`
  // under the data home it binds. `opencode mcp auth <name>` signs in (it
  // opens a browser and waits on a local callback, so a terminal) and
  // `opencode mcp logout <name>` forgets it.
  // An add is `opencode mcp add <name>` in the non-interactive form the report
  // reads from the 1.18.32 source (not probed): `--url` for a remote server,
  // HTTP or SSE alike, the command after `--` for a local one, and each
  // variable as `--env NAME={env:NAME}`, so the config names it and OpenCode
  // fills it from its own environment when it loads. That form always writes
  // the one global config, so it needs no profile variable and reaches every
  // profile.
  // A skill a host keeps is placed as a link in the global config's `skills/`,
  // the one folder of OpenCode's own, which every profile reads. OpenCode keys
  // a skill by its frontmatter `name`, not its folder: the link is named for
  // the host's name for it, and a removal goes by the folder the read found.
  // Only a skill directly in that folder is taken away — the link goes, or the
  // person's own folder moves to where the host keeps it; one in `skill/`
  // beside it, `~/.opencode`, `OPENCODE_CONFIG_DIR`, `skills.paths` or
  // `~/.agents/skills` changes where it is.
  const skillPlan = (item: SkillItem, act: 'add' | 'remove', keepIn: string | undefined): ExtensionActPlan =>
    extensionSkillFolderPlan({
      label: 'OpenCode',
      folder: join(configRootOf(), 'skills'),
      item,
      act,
      ...(keepIn === undefined ? {} : { keepIn }),
      reaches: ['every-profile'],
      home,
    });

  // A plugin is a spec in the plugin list of the one config every profile
  // reads, or a `.ts` or `.js` file in a config folder's `plugin(s)/`.
  // `opencode plugin <module>` adds a spec (`installPlan`); no command
  // switches, removes or updates one, since OpenCode loads every plugin it
  // finds and installs an npm spec's package as it starts: a version moves
  // only when the config pins another. The runtime answers a plugin's add and
  // its sign-ins itself; asked anyway, this answers them too.
  function pluginPlan(item: PluginItem, act: Exclude<ExtensionActKind, 'install'>): ExtensionActPlan {
    const unavailable = (reason: 'no-command' | 'unsupported', message: string): ExtensionActPlan =>
      extensionActUnavailable({ kind: 'plugin', id: item.id }, act, reason, message);
    // A `file://` plugin is a file OpenCode loads where it is — a path in the list, or a file in a plugins
    // folder — so it has no package to install again and changes where the file is.
    const file = item.id.startsWith('file://');
    switch (act) {
      case 'enable':
      case 'disable':
        return unavailable(
          'no-command',
          file
            ? 'OpenCode has no switch for a plugin: it loads every plugin file it finds'
            : "OpenCode has no switch for a plugin: it loads every plugin in its config's plugin list",
        );
      case 'remove':
      case 'purge':
        return unavailable(
          'no-command',
          file
            ? 'OpenCode has no command that removes a plugin: this one is a file, and changes where it is'
            : 'OpenCode has no command that removes a plugin: it is an entry in the plugin list of its one config, which every profile reads',
        );
      case 'update':
        return unavailable(
          'no-command',
          file
            ? 'OpenCode loads this plugin from a file as it is, and it changes where it is'
            : "OpenCode installs a plugin's package as it starts; a pinned version changes only in its config",
        );
      case 'add':
        return unavailable(
          'unsupported',
          'OpenCode adds a plugin only with `opencode plugin`, from a package a person names',
        );
      case 'sign-in':
      case 'sign-out':
        return unavailable('unsupported', 'OpenCode has no sign-in for a plugin: only a remote server has one');
    }
  }

  /**
   * `opencode plugin <source> --global` installs a package from npm into the
   * one package cache, or takes a folder where it is, and adds the source as
   * written to the plugin list of the config every profile reads —
   * `opencode.json`, or `tui.json` for a package whose only entry is the TUI's.
   * `--global` keeps it out of a project: without it, the command would write a
   * `.opencode/` into the folder it runs in, the profile's root. Like every
   * command it boots OpenCode first, which runs every plugin already listed
   * unless `--pure` says not to, and it never prompts. A package it already
   * lists, at any version, is left as it is with exit 0, so a held one is not
   * planned; the runtime's second read is the receipt either way.
   */
  function installPlan(profile: AgentProfile, item: PluginItem, options: ExtensionActPlanOptions): ExtensionActPlan {
    const target = { kind: 'plugin' as const, id: item.id };
    const unavailable = (reason: 'held' | 'unsupported', message: string): ExtensionActPlan =>
      extensionActUnavailable(target, 'install', reason, message);
    if (options.source === undefined) {
      return unavailable(
        'unsupported',
        'OpenCode has no marketplace: it installs a plugin from a package a person names',
      );
    }
    const source = installSource(options.source);
    if ('refused' in source) return unavailable('unsupported', source.refused);
    if (DEPRECATED_PLUGINS.has(source.key)) {
      return unavailable('unsupported', `OpenCode has ${source.shown} built in, and skips the package`);
    }
    if (options.holds?.includes(source.key) === true) {
      return unavailable(
        'held',
        `OpenCode already lists ${source.shown} in its plugin list; its own command leaves that entry as it is`,
      );
    }
    return extensionCommandPlan({
      target,
      act: 'install',
      argv: [executable, 'plugin', options.source, '--global', '--pure'],
      env: profileEnv(profile),
      reaches: ['every-profile'],
    });
  }

  function plan(
    profile: AgentProfile,
    item: ExtensionActItem,
    act: ExtensionActKind,
    options: ExtensionActPlanOptions = {},
  ): ExtensionActPlan {
    if (item.kind === 'plugin') return act === 'install' ? installPlan(profile, item, options) : pluginPlan(item, act);
    const target = { kind: item.kind, id: item.id };
    if (item.kind === 'marketplace') {
      return extensionActUnavailable(target, act, 'unsupported', 'OpenCode has no marketplaces');
    }
    if (act === 'install') return extensionActUnavailable(target, act, 'unsupported', 'Only a plugin is installed');
    if (act === 'add') {
      if (item.kind === 'skill') return skillPlan(item, act, undefined);
      if (item.definition === undefined) {
        return extensionActUnavailable(target, act, 'unsupported', 'OpenCode adds a server only from its definition');
      }
      if (!EXTENSION_COMMAND_NAME.test(item.id)) {
        return extensionActUnavailable(target, act, 'no-command', "OpenCode's commands do not take this server's name");
      }
      const { definition } = item;
      return extensionCommandPlan({
        target,
        act,
        argv:
          definition.transport === 'stdio'
            ? [
                executable,
                'mcp',
                'add',
                item.id,
                ...(definition.env ?? []).flatMap((name) => ['--env', `${name}={env:${name}}`]),
                '--',
                definition.command,
                ...definition.args,
              ]
            : [executable, 'mcp', 'add', item.id, '--url', definition.url],
        reaches: ['every-profile'],
      });
    }
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('OpenCode', item, 'Claude Code'));
    }
    if (item.kind === 'skill' && act === 'remove') return skillPlan(item, act, options.keepIn);
    if (item.kind === 'mcp-server' && (act === 'sign-in' || act === 'sign-out')) {
      const absent = extensionSignInAbsentWords('OpenCode', item);
      if (absent !== undefined) return extensionActUnavailable(target, act, 'no-sign-in', absent);
      if (!EXTENSION_COMMAND_NAME.test(item.id)) {
        return extensionActUnavailable(target, act, 'no-command', "OpenCode's commands do not take this server's name");
      }
      const fields = {
        target,
        act,
        argv: [executable, 'mcp', act === 'sign-in' ? 'auth' : 'logout', item.id],
        env: profileEnv(profile),
      };
      return act === 'sign-in' ? extensionTerminalPlan(fields) : extensionCommandPlan(fields);
    }
    return item.kind === 'mcp-server'
      ? extensionActUnavailable(
          target,
          act,
          'no-command',
          'OpenCode has no command that turns a server off: its one config serves every profile',
        )
      : extensionActUnavailable(target, act, 'no-command', 'OpenCode leaves a skill out only in its config');
  }

  return {
    provider,
    plan,

    async inventory(profile: AgentProfile): Promise<ExtensionInventory> {
      const configRoot = configRootOf();
      const configFile = text(env.OPENCODE_CONFIG);
      const extraDirectory = text(env.OPENCODE_CONFIG_DIR);
      const content = text(env.OPENCODE_CONFIG_CONTENT);
      const configDirectories = [
        ...new Set([
          configRoot,
          join(home, '.opencode'),
          ...(extraDirectory && isAbsolute(extraDirectory) ? [extraDirectory] : []),
        ]),
      ];

      const sources: Array<{ label: string; read: () => Promise<DocumentRead> }> = [
        ...['config.json', 'opencode.json', 'opencode.jsonc'].map((file) => join(configRoot, file)),
        // A relative OPENCODE_CONFIG resolves against the session's directory, which a profile has none of.
        ...(configFile && isAbsolute(configFile) ? [configFile] : []),
        ...configDirectories
          .slice(1)
          .flatMap((directory) => [join(directory, 'opencode.json'), join(directory, 'opencode.jsonc')]),
      ].map((path) => ({ label: shown(path), read: () => readDocument(path) }));
      if (content) sources.push({ label: 'OPENCODE_CONFIG_CONTENT', read: async () => contentDocument(content) });

      const unread = new Map<ExtensionKind, string>();
      const missed = (kind: ExtensionKind, message: string) => {
        if (!unread.has(kind)) unread.set(kind, message.slice(0, 512));
      };

      const documents: ConfigDocument[] = [];
      for (const source of sources) {
        const read = await source.read();
        if (read === 'absent') continue;
        if (read === 'unreadable') {
          // One document feeds all three kinds: its servers, its plugin specs and its skill paths.
          for (const kind of ['plugin', 'mcp-server', 'skill'] as const)
            missed(kind, `${source.label} could not be read`);
          continue;
        }
        documents.push(read);
      }

      // The TUI's documents, in its loader's order; only their plugin lists are OpenCode's to read here.
      const tuiFile = text(env.OPENCODE_TUI_CONFIG);
      const tuiDocuments: ConfigDocument[] = [];
      for (const path of [
        ...['tui.json', 'tui.jsonc'].map((file) => join(configRoot, file)),
        ...(tuiFile && isAbsolute(tuiFile) ? [tuiFile] : []),
        ...configDirectories
          .slice(1)
          .flatMap((directory) => [join(directory, 'tui.json'), join(directory, 'tui.jsonc')]),
      ]) {
        const read = await readDocument(path);
        if (read === 'unreadable') missed('plugin', `${shown(path)} could not be read`);
        else if (read !== 'absent') tuiDocuments.push(read);
      }

      // MCP servers: the deep merge, and the last document that defined each one.
      let servers: Json = {};
      const definedIn = new Map<string, string | undefined>();
      for (const document of documents) {
        const mcp = rec(document.body.mcp);
        if (!mcp) continue;
        for (const [name, value] of Object.entries(mcp)) {
          const server = rec(value);
          if (!server || UNSAFE_KEYS.has(name)) continue;
          servers = mergeDeep(servers, { [name]: server });
          if (server.type !== undefined || !definedIn.has(name)) definedIn.set(name, document.path);
        }
      }
      const serverItems = Object.entries(servers).flatMap(([name, value]) => {
        const item = name.length <= 256 ? serverItem(name, rec(value) ?? {}, definedIn.get(name)) : undefined;
        return item ? [item] : [];
      });

      // Plugins: every declared spec, then the files in each config directory's plugin folders, then what only
      // the TUI lists — a package with a server entry too is declared in both, and keeps the server's.
      const plugins = new Map<string, PluginEntry>();
      for (const document of documents) {
        for (const entry of declaredPlugins(document)) plugins.set(entry.identity, entry);
      }
      for (const directory of configDirectories) {
        for (const path of await pluginFiles(directory)) {
          const identity = pathToFileURL(path).href;
          plugins.set(identity, { identity, name: stem(path), location: path });
        }
      }
      const tuiPlugins = new Map<string, PluginEntry>();
      for (const document of tuiDocuments) {
        for (const entry of declaredPlugins(document)) tuiPlugins.set(entry.identity, entry);
      }
      for (const [identity, entry] of tuiPlugins) if (!plugins.has(identity)) plugins.set(identity, entry);
      const pluginItems: PluginItem[] = [...plugins.values()].flatMap((entry) =>
        DEPRECATED_PLUGINS.has(entry.identity) || entry.identity.length > 512 || entry.name.length > 256
          ? []
          : [
              {
                kind: 'plugin' as const,
                id: entry.identity,
                name: entry.name,
                origin: 'own' as const,
                shared: true as const,
                enabled: true,
                ...(entry.version ? { version: entry.version } : {}),
                ...(entry.location ? { location: entry.location } : {}),
              },
            ],
      );

      // Skills, in OpenCode's scan order; a later one of the same name replaces an earlier.
      const merged = documents.reduce<Json>((config, document) => mergeDeep(config, document.body), {});
      const skillsConfig = rec(merged.skills);
      const roots: SkillRoot[] = [];
      if (!flag(env.OPENCODE_DISABLE_EXTERNAL_SKILLS)) {
        if (!flag(env.OPENCODE_DISABLE_CLAUDE_CODE) && !flag(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)) {
          roots.push({ path: join(home, '.claude', 'skills'), origin: 'borrowed' });
        }
        roots.push({ path: join(home, '.agents', 'skills'), origin: 'own' });
      }
      for (const directory of configDirectories) {
        roots.push(
          { path: join(directory, 'skill'), origin: 'own' },
          { path: join(directory, 'skills'), origin: 'own' },
        );
      }
      for (const entry of Array.isArray(skillsConfig?.paths) ? skillsConfig.paths : []) {
        const path = text(entry);
        if (!path) continue;
        // A relative path resolves against the session's directory, which a profile has none of.
        if (path === '~' || path.startsWith('~/')) roots.push({ path: join(home, path.slice(1)), origin: 'own' });
        else if (isAbsolute(path)) roots.push({ path, origin: 'own' });
      }
      const skills = new Map<string, SkillItem>();
      for (const root of roots) {
        for (const found of await skillFiles(root.path)) {
          const skill = await readSkill(found, root);
          if (!skill) continue;
          skills.delete(skill.id);
          skills.set(skill.id, skill);
        }
      }
      if (Array.isArray(skillsConfig?.urls) && skillsConfig.urls.some((url) => text(url))) {
        missed('skill', 'skills from `skills.urls` are downloaded when OpenCode starts and are not read here');
      }

      const items: ExtensionItem[] = [...pluginItems, ...serverItems, ...skills.values()];
      return {
        provider: 'opencode',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        items,
        ...(unread.size > 0 ? { unread: [...unread].map(([kind, message]) => ({ kind, message })) } : {}),
        source: { kind: 'native-store', stability: 'documented' },
      };
    },
  };
}
