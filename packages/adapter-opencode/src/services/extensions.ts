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
 *   `plugin` or `plugins` folder of each config directory.
 * Not read here: a project's documents and skills, which belong to the
 * project; the documents OpenCode fetches when it starts (a `wellknown`
 * organization's, the active Console org's), which take the network and a
 * token; the managed config directory and macOS managed preferences;
 * `tui.json`; the plugins and the skill built into the binary; and the skills
 * `skills.urls` downloads at start, which mark the skill kind unread.
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
  extensionTerminalPlan,
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
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
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

/** Every `{env:NAME}` a definition reads, wherever it sits. */
function references(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{env:([^}]+)\}/gu)) into.push(match[1]!.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) references(item, into);
  } else {
    const object = rec(value);
    if (object) for (const item of Object.values(object)) references(item, into);
  }
}

const names = (values: Iterable<string>, pattern: RegExp): string[] =>
  [...new Set(values)].filter((value) => pattern.test(value)).slice(0, 64);

/** One merged `mcp` entry as a listing may show it; a value with no known `type` is one OpenCode skips. */
function serverItem(name: string, definition: Json, location: string | undefined): McpServerItem | undefined {
  const referenced: string[] = [];
  references(definition, referenced);
  let fields: Pick<McpServerItem, 'transport' | 'target' | 'env' | 'headers'>;
  if (definition.type === 'local') {
    const command = definition.command;
    if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) return undefined;
    const [executable, ...args] = command as string[];
    if (!text(executable)) return undefined;
    const env = names([...Object.keys(rec(definition.environment) ?? {}), ...referenced], ENVIRONMENT_NAME);
    fields = {
      transport: 'stdio',
      target: fromSentinel(describeMcpCommand(toSentinel(executable!), args.map(toSentinel))),
      ...(env.length > 0 ? { env } : {}),
    };
  } else if (definition.type === 'remote') {
    const url = text(definition.url);
    if (!url) return undefined;
    // OpenCode tries Streamable HTTP first and falls back to SSE on its own.
    const env = names(referenced, ENVIRONMENT_NAME);
    const headers = names(Object.keys(rec(definition.headers) ?? {}), HEADER_NAME);
    fields = {
      transport: 'http',
      target: fromSentinel(describeMcpUrl(toSentinel(url))),
      ...(env.length > 0 ? { env } : {}),
      ...(headers.length > 0 ? { headers } : {}),
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
      // `opencode plugin <module>` writes a spec into the one config every profile reads; no command removes one.
      plugins: { store: 'shared', changes: 'command', read: true },
      // `opencode mcp add` adds one, but nothing turns a server off or removes it except an edit to that config;
      // the instance's connect and disconnect last only as long as the process.
      mcpServers: { store: 'shared', changes: 'in-app', read: true },
      skills: { store: 'shared', changes: 'folder', read: true },
    },
  };

  const shown = (path: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

  const executable = resolveOpenCodeExecutable(options.executable);

  // Acts (RFC 006 C2): OpenCode has no command that turns a server off or a
  // skill out — both are keys of its one config, which serves every profile.
  // A remote server's sign-in is the profile's own, though: `mcp-auth.json`
  // under the data home it binds. `opencode mcp auth <name>` signs in (it
  // opens a browser and waits on a local callback, so a terminal) and
  // `opencode mcp logout <name>` forgets it.
  function plan(profile: AgentProfile, item: McpServerItem | SkillItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (item.origin !== 'own') {
      return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('OpenCode', item, 'Claude Code'));
    }
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
        env: profile.kind === 'native-default' ? {} : { [OPENCODE_PROFILE_ROOT_VARIABLE]: openCodeDataHome(profile) },
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
      const configHome = text(env.XDG_CONFIG_HOME);
      const configRoot = join(configHome && isAbsolute(configHome) ? configHome : join(home, '.config'), 'opencode');
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

      // Plugins: every declared spec, then the files in each config directory's plugin folders.
      const plugins = new Map<string, PluginEntry>();
      for (const document of documents) {
        const specs = document.body.plugin;
        if (!Array.isArray(specs)) continue;
        for (const spec of specs) {
          const declared = typeof spec === 'string' ? spec : Array.isArray(spec) ? spec[0] : undefined;
          const entry = typeof declared === 'string' ? pluginFromSpec(declared, document.path) : undefined;
          if (entry) plugins.set(entry.identity, entry);
        }
      }
      for (const directory of configDirectories) {
        for (const path of await pluginFiles(directory)) {
          const identity = pathToFileURL(path).href;
          plugins.set(identity, { identity, name: stem(path), location: path });
        }
      }
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
