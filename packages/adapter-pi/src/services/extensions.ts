/**
 * Pi extensions (RFC 006 C1): the packages, loose extensions and skills one
 * profile's agent directory holds, read from Pi's own files. Never by starting
 * Pi, `pi list` or `pi config`: Pi's startup `resolve()` installs a missing npm
 * or git package unless it is offline, and `pi config` is an interactive
 * screen.
 *
 * Pi 0.87.1, per James's report (draft/PI-PLUGINS-SKILLS-MCP.md) and the
 * installed package's dist/core/package-manager.js, skills.js and
 * settings-manager.js:
 * - `<agent>/settings.json` (`PI_CODING_AGENT_DIR`; `~/.pi/agent` for the native
 *   default) lists `packages` — a source string, or `{ source, extensions?,
 *   skills?, prompts?, themes?, autoload? }` — and extra `extensions` and
 *   `skills` paths. Filter entries ride in the same arrays: `!glob` excludes,
 *   `+path` and `-path` force one exact path on or off (what `pi config`
 *   writes), and a bare glob narrows the paths listed beside it.
 * - A package installs into `<agent>/npm/node_modules/<name>` (npm) or
 *   `<agent>/git/<host>/<path>` (git); a local source is used where it is. Its
 *   skills come from `package.json` `pi.skills`, else its `skills/` folder.
 * - Loose extensions are `<agent>/extensions/*.ts|js`, and subfolders with an
 *   index or a `pi.extensions` manifest.
 * - Skills are a folder holding `SKILL.md`, or a loose `.md` with a
 *   description — at the top of `<agent>/skills/`, and only below the top of
 *   `~/.agents/skills/`, which every Pi profile and other agents read. A skill
 *   needs a description; its name is the frontmatter's, else its folder's; the
 *   first of a name wins, in Pi's order: settings paths, the agent's folder,
 *   the shared folder, then packages.
 * Pi has no MCP client and no marketplace: MCP arrives through third-party
 * extensions whose files are theirs, and a package comes from npm, git or a
 * path. Its per-skill switch is a `+path`/`-path` entry that only `pi config`
 * writes, so no skill here is `switchable`.
 *
 * A file listing does not see: an npm package Pi would find in the legacy
 * global npm root (asking npm where that is starts a process), skills an
 * extension adds at run time (`resources_discover`), `.gitignore`, `.ignore`
 * and `.fdignore` rules inside a skill tree, and a repository's `.pi/`.
 */

import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  extensionActUnavailable,
  extensionCommandPlan,
  extensionNotOwnWords,
  extensionSkillFolderPlan,
  isExtensionSource,
  isNormalizedAbsolutePath,
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
  type PluginItem,
  type SkillItem,
} from '@vibefield/puppeteer-core';
import { resolvePiExecutable } from '../detection.js';
import { PI_PROFILE_ROOT_VARIABLE, piAgentDir } from './profiles.js';

export interface PiExtensionOptions {
  /** Home directory the native default root and the shared skills folder hang off; defaults to the process home. */
  home?: string;
  now?: () => Date;
  /** The executable an act runs; the adapter's own resolution when absent. */
  executable?: string;
  env?: NodeJS.ProcessEnv;
}

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 1024 * 1024;
/** Directory entries one inventory may visit, and how deep a tree it follows. */
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 12;
const RESOURCE_KINDS = ['extensions', 'skills', 'prompts', 'themes'] as const;
const NPM_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
};
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
const bounded = (value: string | undefined, max: number): string | undefined =>
  value !== undefined && value.length <= max ? value : undefined;
const posix = (path: string): string => path.split(sep).join('/');

/** Why a kind could not be read completely; the inventory names it in `unread`. */
class Unread extends Error {
  constructor(
    readonly kind: ExtensionKind,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Globs: the part of minimatch Pi's filters use — `*`, `**`, `?`, classes and
// braces. Anything else (extglobs, ranges, POSIX classes, a second negation)
// makes the kind unread rather than guessed.

function unsupported(kind: ExtensionKind): Unread {
  return new Unread(kind, 'a filter in settings.json uses glob syntax this reader does not evaluate');
}

function expandBraces(pattern: string, kind: ExtensionKind, budget = { left: 64 }): string[] {
  for (let open = 0; open < pattern.length; open++) {
    if (pattern[open] === '\\') {
      open++;
      continue;
    }
    if (pattern[open] !== '{') continue;
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let index = open; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === '\\') index++;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        close = index;
        break;
      } else if (char === ',' && depth === 1) commas.push(index);
    }
    if (close < 0) return [pattern];
    if (commas.length === 0) {
      if (pattern.slice(open + 1, close).includes('..')) throw unsupported(kind);
      continue;
    }
    const head = pattern.slice(0, open);
    const tail = pattern.slice(close + 1);
    const bounds = [open, ...commas, close];
    const expanded: string[] = [];
    for (let part = 0; part < bounds.length - 1; part++) {
      for (const alternative of expandBraces(
        head + pattern.slice(bounds[part]! + 1, bounds[part + 1]) + tail,
        kind,
        budget,
      )) {
        if (--budget.left < 0) throw unsupported(kind);
        expanded.push(alternative);
      }
    }
    return expanded;
  }
  return [pattern];
}

/** Index of the `]` that closes the class opening at `open`, or -1: a `]` first in it is its own. */
function classEnd(chars: readonly string[], open: number): number {
  let index = open + 1;
  if (chars[index] === '!' || chars[index] === '^') index++;
  if (chars[index] === ']') index++;
  for (; index < chars.length; index++) {
    if (chars[index] === '\\') index++;
    else if (chars[index] === ']') return index;
  }
  return -1;
}

const STAR = Symbol('star');
const GLOBSTAR = Symbol('globstar');

/** One segment of a glob: what each character must be, and `*` for any run of them. */
interface SegmentGlob {
  parts: Array<((char: string) => boolean) | typeof STAR>;
  /** A wildcard it opens with never matches a leading dot, as minimatch without `dot`. */
  hidesDot: boolean;
}

/** A glob, segment by segment; `**` is any number of whole segments. */
type PathGlob = Array<SegmentGlob | typeof GLOBSTAR>;

/** A path as a glob reads it: its segments, each as its characters. */
type Segments = string[][];
type GlobTest = (segments: Segments) => boolean;

const splitPath = (path: string): Segments => path.split('/').map((segment) => Array.from(segment));

function segmentGlob(segment: string, kind: ExtensionKind): SegmentGlob {
  const chars = Array.from(segment);
  const parts: SegmentGlob['parts'] = [];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char === '\\') {
      const next = chars[index + 1] ?? '\\';
      parts.push((found) => found === next);
      index++;
    } else if (char === '*') {
      if (parts.at(-1) !== STAR) parts.push(STAR);
    } else if (char === '?') {
      parts.push(() => true);
    } else if (char === '[') {
      const close = classEnd(chars, index);
      if (close < 0) {
        parts.push((found) => found === '[');
        continue;
      }
      let body = chars.slice(index + 1, close).join('');
      if (body.includes('[:')) throw unsupported(kind);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      const escaped = body.replace(/[\\\]^[]/gu, (found, offset: number) =>
        found === '^' && offset > 0 ? '^' : `\\${found}`,
      );
      let set: RegExp;
      try {
        set = new RegExp(`^[${negated ? '^/' : ''}${escaped}]$`, 'u');
      } catch {
        // a class JavaScript does not read, such as a range written backwards
        throw unsupported(kind);
      }
      parts.push((found) => set.test(found));
      index = close;
    } else {
      parts.push((found) => found === char);
    }
  }
  return { parts, hidesDot: /^[*?[]/u.test(segment) };
}

function pathGlob(pattern: string, kind: ExtensionKind): PathGlob {
  const parts: PathGlob = [];
  for (const segment of pattern.split('/')) {
    if (segment !== '**') parts.push(segmentGlob(segment, kind));
    else if (parts.at(-1) !== GLOBSTAR) parts.push(GLOBSTAR);
  }
  return parts;
}

/**
 * Whether one segment matches, by the greedy scan that comes back only to its
 * last `*`: each star retries a run at most once, never the backtracking that
 * several `[^/]*` in one pattern make over a long name.
 */
function segmentMatches(glob: SegmentGlob, text: readonly string[], walk: Walk): boolean {
  if (glob.hidesDot && text[0] === '.') return false;
  const { parts } = glob;
  let at = 0;
  let part = 0;
  let star = -1;
  let resume = 0;
  while (at < text.length) {
    spend(walk);
    const want = parts[part];
    if (want === STAR) {
      star = part;
      part += 1;
      resume = at;
    } else if (want !== undefined && want(text[at]!)) {
      part += 1;
      at += 1;
    } else if (star >= 0) {
      part = star + 1;
      resume += 1;
      at = resume;
    } else {
      return false;
    }
  }
  while (parts[part] === STAR) part += 1;
  return part === parts.length;
}

/**
 * Whether a path matches, segment by segment, each pair of places in the glob
 * and the path visited once: `**` takes whole segments that do not start with
 * a dot — none or more, and at least one when it ends the glob.
 */
function pathMatches(glob: PathGlob, segments: Segments, walk: Walk): boolean {
  const known = new Map<number, boolean>();
  const visit = (part: number, at: number): boolean => {
    if (part === glob.length) return at === segments.length;
    const key = part * (segments.length + 1) + at;
    const answer = known.get(key);
    if (answer !== undefined) return answer;
    spend(walk);
    const want = glob[part]!;
    let found = false;
    if (want === GLOBSTAR) {
      const least = part === glob.length - 1 ? 1 : 0;
      for (let taken = 0; at + taken <= segments.length; taken += 1) {
        if (taken >= least && visit(part + 1, at + taken)) {
          found = true;
          break;
        }
        const next = segments[at + taken];
        if (next === undefined || next.length === 0 || next[0] === '.') break;
      }
    } else {
      found = at < segments.length && segmentMatches(want, segments[at]!, walk) && visit(part + 1, at + 1);
    }
    known.set(key, found);
    return found;
  };
  return visit(0, 0);
}

const compiled = new Map<string, PathGlob[]>();
/** Patterns come from every package read: past this many, the cache is dropped rather than grown. */
const MAX_COMPILED = 1_024;

/** A minimatch-compatible test for one pattern; a comment (`#…`) matches nothing, as in minimatch. */
function globTest(pattern: string, walk: Walk): GlobTest {
  if (pattern.startsWith('#')) return () => false;
  if (pattern.startsWith('!') || /[@!+*?]\(/u.test(pattern)) throw unsupported(walk.kind);
  let globs = compiled.get(pattern);
  if (globs === undefined) {
    globs = expandBraces(pattern, walk.kind).map((alternative) => pathGlob(alternative, walk.kind));
    if (compiled.size >= MAX_COMPILED) compiled.clear();
    compiled.set(pattern, globs);
  }
  const alternatives = globs;
  return (segments) => {
    spend(walk);
    return alternatives.some((glob) => pathMatches(glob, segments, walk));
  };
}

/** Matching steps one read takes per kind: past them the kind is unread, never read slowly. */
const MAX_MATCH_STEPS = 20_000_000;

function spend(walk: Walk): void {
  walk.steps -= 1;
  if (walk.steps < 0) {
    throw new Unread(walk.kind, 'filters in settings.json or a package take more matching than this reader does');
  }
}

// ---------------------------------------------------------------------------
// Pi's filter semantics (package-manager.js), over the globs above. Each list
// is read once for all the files it filters.

/** The names Pi matches a file's filters against: from the base, its own, its whole path — a skill's folder too. */
function globCandidates(filePath: string, baseDir: string): Segments[] {
  const name = basename(filePath);
  const candidates = [posix(relative(baseDir, filePath)), name, posix(filePath)];
  if (name === 'SKILL.md') {
    const folder = dirname(filePath);
    candidates.push(posix(relative(baseDir, folder)), basename(folder), posix(folder));
  }
  return candidates.map(splitPath);
}

/** Each pattern's test, compiled the first time a file needs it, then kept for the files after. */
function globTests(patterns: readonly string[], walk: Walk): GlobTest[] {
  return patterns.map((pattern) => {
    let test: GlobTest | undefined;
    return (segments) => (test ??= globTest(posix(pattern), walk))(segments);
  });
}

function matchesAnyPattern(filePath: string, tests: readonly GlobTest[], baseDir: string): boolean {
  if (tests.length === 0) return false;
  const candidates = globCandidates(filePath, baseDir);
  return tests.some((test) => candidates.some((segments) => test(segments)));
}

/** Exact force entries as the names they give: `./` dropped, separators as `/`. */
function exactNames(patterns: readonly string[]): Set<string> {
  return new Set(
    patterns.map((pattern) =>
      posix(pattern.startsWith('./') || pattern.startsWith('.\\') ? pattern.slice(2) : pattern),
    ),
  );
}

/** The names an exact entry can give a file: from the base, and whole — a skill's folder too. */
function exactCandidates(filePath: string, baseDir: string): Set<string> {
  const candidates = new Set([posix(relative(baseDir, filePath)), posix(filePath)]);
  if (basename(filePath) === 'SKILL.md') {
    candidates.add(posix(relative(baseDir, dirname(filePath))));
    candidates.add(posix(dirname(filePath)));
  }
  return candidates;
}

function matchesAnyExactPattern(filePath: string, names: ReadonlySet<string>, baseDir: string): boolean {
  if (names.size === 0) return false;
  for (const candidate of exactCandidates(filePath, baseDir)) if (names.has(candidate)) return true;
  return false;
}

const isOverride = (entry: string): boolean => entry.startsWith('!') || entry.startsWith('+') || entry.startsWith('-');
const isPattern = (entry: string): boolean => isOverride(entry) || entry.includes('*') || entry.includes('?');

/** A settings list's exclusions and exact force entries. */
interface Overrides {
  excludes: GlobTest[];
  forceIncludes: Set<string>;
  forceExcludes: Set<string>;
}

function overridesOf(entries: readonly string[], walk: Walk): Overrides {
  const after = (prefix: string): string[] =>
    entries.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(1));
  return {
    excludes: globTests(after('!'), walk),
    forceIncludes: exactNames(after('+')),
    forceExcludes: exactNames(after('-')),
  };
}

/** An auto-discovered resource: on unless an exclusion matches, then the exact force entries decide. */
function isEnabledByOverrides(filePath: string, overrides: Overrides, baseDir: string): boolean {
  let enabled = !matchesAnyPattern(filePath, overrides.excludes, baseDir);
  if (matchesAnyExactPattern(filePath, overrides.forceIncludes, baseDir)) enabled = true;
  if (matchesAnyExactPattern(filePath, overrides.forceExcludes, baseDir)) enabled = false;
  return enabled;
}

/** Listed resources: bare globs narrow them, then `!`, `+` and `-` as above. */
function applyPatterns(
  allPaths: readonly string[],
  patterns: readonly string[],
  baseDir: string,
  walk: Walk,
): Set<string> {
  const { excludes, forceIncludes, forceExcludes } = overridesOf(patterns, walk);
  const includes = globTests(
    patterns.filter((pattern) => !isOverride(pattern)),
    walk,
  );
  let result =
    includes.length === 0 ? [...allPaths] : allPaths.filter((path) => matchesAnyPattern(path, includes, baseDir));
  if (excludes.length > 0) result = result.filter((path) => !matchesAnyPattern(path, excludes, baseDir));
  // beside the list, a set: asking the list for each path would scan it once per path
  const kept = new Set(result);
  for (const path of allPaths) {
    if (!kept.has(path) && matchesAnyExactPattern(path, forceIncludes, baseDir)) {
      kept.add(path);
      result.push(path);
    }
  }
  if (forceExcludes.size > 0) result = result.filter((path) => !matchesAnyExactPattern(path, forceExcludes, baseDir));
  return new Set(result);
}

/** A package entry with `autoload: false`: only what its patterns name, on or off. */
function applyAutoloadDisabledPatterns(
  allPaths: readonly string[],
  patterns: readonly string[],
  baseDir: string,
  walk: Walk,
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  // the files each exact name gives, so an exact entry finds its files without asking every file
  const named = new Map<string, string[]>();
  for (const path of allPaths) {
    for (const name of exactCandidates(path, baseDir)) {
      const paths = named.get(name);
      if (paths) paths.push(path);
      else named.set(name, [path]);
    }
  }
  for (const pattern of patterns) {
    const target = isOverride(pattern) ? pattern.slice(1) : pattern;
    const enabled = !pattern.startsWith('-') && !pattern.startsWith('!');
    if (pattern.startsWith('+') || pattern.startsWith('-')) {
      for (const name of exactNames([target])) for (const path of named.get(name) ?? []) result.set(path, enabled);
      continue;
    }
    const tests = globTests([target], walk);
    for (const path of allPaths) if (matchesAnyPattern(path, tests, baseDir)) result.set(path, enabled);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pi's collectors, over a bounded walk. Links are followed, as Pi follows them.

interface Walk {
  left: number;
  kind: ExtensionKind;
  /** Matching steps left before the kind is unread. */
  steps: number;
}

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
}

async function entriesOf(dir: string, walk: Walk): Promise<Entry[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const dirent of dirents) {
    if (--walk.left < 0) throw new Unread(walk.kind, 'a folder holds more entries than this reader visits');
    const path = join(dir, dirent.name);
    let isDir = dirent.isDirectory();
    let isFile = dirent.isFile();
    if (dirent.isSymbolicLink()) {
      try {
        const target = await stat(path);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue;
      }
    }
    entries.push({ name: dirent.name, path, isDir, isFile });
  }
  return entries;
}

async function kindOf(path: string): Promise<'file' | 'dir' | undefined> {
  try {
    const found = await stat(path);
    return found.isFile() ? 'file' : found.isDirectory() ? 'dir' : undefined;
  } catch {
    return undefined;
  }
}

/** A folder holding `SKILL.md` is one skill; loose `.md` files count at the top (`pi`) or below it (`agents`). */
async function collectSkillEntries(
  dir: string,
  mode: 'pi' | 'agents',
  walk: Walk,
  root = dir,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const entries = await entriesOf(dir, walk);
  const declared = entries.find((entry) => entry.name === 'SKILL.md' && entry.isFile);
  if (declared) return [declared.path];
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.isFile && entry.name.endsWith('.md') && (mode === 'pi' ? dir === root : dir !== root)) {
      found.push(entry.path);
    } else if (entry.isDir) {
      found.push(...(await collectSkillEntries(entry.path, mode, walk, root, depth + 1)));
    }
  }
  return found;
}

interface Manifest {
  pi?: Partial<Record<(typeof RESOURCE_KINDS)[number], string[]>>;
  name?: string;
  version?: string;
  description?: string;
}

async function readManifest(packageJsonPath: string): Promise<Manifest | undefined> {
  try {
    if ((await stat(packageJsonPath)).size > MAX_MANIFEST_BYTES) return undefined;
    const document = rec(JSON.parse((await readFile(packageJsonPath, 'utf8')).replace(/^﻿/u, '')));
    if (!document) return undefined;
    const pi = rec(document.pi);
    const manifest: Manifest = {};
    if (pi) {
      manifest.pi = {};
      for (const kind of RESOURCE_KINDS) {
        const entries = strings(pi[kind]);
        if (entries) manifest.pi[kind] = entries;
      }
    }
    const name = bounded(text(document.name), 256);
    const version = bounded(text(document.version), 128);
    const description = text(document.description)?.slice(0, 2_048);
    return {
      ...manifest,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
    };
  } catch {
    return undefined;
  }
}

/** A folder of extensions resolves through its `pi.extensions`, else `index.ts`, else `index.js`. */
async function resolveExtensionEntries(dir: string): Promise<string[] | undefined> {
  const manifest = await readManifest(join(dir, 'package.json'));
  const listed = manifest?.pi?.extensions ?? [];
  if (listed.length > 0) {
    const entries: string[] = [];
    for (const path of listed.map((entry) => resolve(dir, entry))) if (await kindOf(path)) entries.push(path);
    if (entries.length > 0) return entries;
  }
  for (const index of ['index.ts', 'index.js']) if (await kindOf(join(dir, index))) return [join(dir, index)];
  return undefined;
}

/** Each entry with the unit a person added: the top-level file or folder it belongs to. */
async function collectAutoExtensionEntries(dir: string, walk: Walk): Promise<Array<{ path: string; unit: string }>> {
  if ((await kindOf(dir)) !== 'dir') return [];
  const own = await resolveExtensionEntries(dir);
  if (own) return own.map((path) => ({ path, unit: dir }));
  const found: Array<{ path: string; unit: string }> = [];
  for (const entry of await entriesOf(dir, walk)) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.isFile && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      found.push({ path: entry.path, unit: entry.path });
    } else if (entry.isDir) {
      for (const path of (await resolveExtensionEntries(entry.path)) ?? []) found.push({ path, unit: entry.path });
    }
  }
  return found;
}

async function collectSkillFilesFromPaths(paths: readonly string[], walk: Walk): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    const found = await kindOf(path);
    if (found === 'file') files.push(path);
    else if (found === 'dir') files.push(...(await collectSkillEntries(path, 'pi', walk)));
  }
  return files;
}

/** A manifest glob's matches under the package root, walking from its literal prefix, dot segments skipped. */
async function expandPackageGlob(pattern: string, root: string, walk: Walk): Promise<string[]> {
  const normalized = posix(pattern).replace(/^\.\//u, '');
  const test = globTest(normalized, walk);
  const segments = normalized.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[{\\]/u.test(segment)) break;
    literal.push(segment);
  }
  const reach = segments.includes('**') ? MAX_DEPTH : segments.length - literal.length;
  const matches: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > reach) return;
    for (const entry of await entriesOf(dir, walk)) {
      if (entry.name.startsWith('.')) continue;
      const rel = posix(relative(root, entry.path));
      if (test(splitPath(rel))) matches.push(entry.path);
      if (entry.isDir) await visit(entry.path, depth + 1);
    }
  };
  const start = join(root, ...literal);
  if (literal.length === segments.length) return (await kindOf(start)) ? [start] : [];
  if ((await kindOf(start)) === 'dir') await visit(start, 1);
  return matches.sort();
}

/**
 * Every skill file a package declares for Pi, its manifest's own filters
 * applied. Which of `pi.skills` and the `skills/` folder counts follows Pi's
 * three paths: a plain source takes the manifest whenever the package has a
 * `pi` key; an object source without skill patterns, whenever `pi.skills` is
 * set; one with patterns, only when `pi.skills` lists something.
 */
async function packageSkillFiles(
  packageRoot: string,
  manifest: Manifest | undefined,
  walk: Walk,
  entry: 'plain' | 'default' | 'filtered',
): Promise<string[]> {
  const entries = manifest?.pi?.skills;
  const fromManifest =
    entry === 'plain'
      ? manifest?.pi !== undefined
      : entry === 'default'
        ? entries !== undefined
        : (entries?.length ?? 0) > 0;
  if (fromManifest) {
    if (!entries || entries.length === 0) return [];
    const sources: string[] = [];
    for (const entry of entries.filter((candidate) => !isOverride(candidate))) {
      if (entry.includes('*') || entry.includes('?'))
        sources.push(...(await expandPackageGlob(entry, packageRoot, walk)));
      else sources.push(resolve(packageRoot, entry));
    }
    const all = await collectSkillFilesFromPaths(sources, walk);
    const patterns = entries.filter(isOverride);
    return patterns.length > 0 ? [...applyPatterns(all, patterns, packageRoot, walk)] : all;
  }
  const convention = join(packageRoot, 'skills');
  return (await kindOf(convention)) === 'dir' ? collectSkillEntries(convention, 'pi', walk) : [];
}

// ---------------------------------------------------------------------------
// Package sources, as Pi's `parseSource` and `getPackageIdentity` read them.

interface PackageRef {
  id: string;
  name: string;
  type: 'npm' | 'git' | 'local';
  /** Where Pi keeps or finds it. */
  path: string;
  /** A git ref pinned in the source. */
  ref?: string;
}

const HOSTED: Record<string, string> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };

function resolvePiPath(input: string, baseDir: string, home: string): string {
  const trimmed = input.trim();
  let path = trimmed;
  if (trimmed === '~') path = home;
  else if (trimmed.startsWith('~/')) path = join(home, trimmed.slice(2));
  else if (/^file:\/\//u.test(trimmed)) {
    try {
      path = fileURLToPath(trimmed);
    } catch {
      path = trimmed;
    }
  }
  return isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
}

/** A git source's host and repository path; never its userinfo, which can hold a token. */
function gitSource(source: string): { host: string; path: string; ref?: string } | undefined {
  // Pi reads `git://host/path` as its `git:` prefix before `//host/path`, which resolves only through its https
  // fallback, to `git:<host>/<path>`: the address it is.
  const prefixed = source.startsWith('git:') && !source.startsWith('git://');
  let rest = prefixed ? source.slice(4).trim() : source;
  if (!prefixed && !/^(?:https?|ssh|git):\/\//iu.test(rest)) return undefined;
  let host: string | undefined;
  let path: string | undefined;
  let ref: string | undefined;
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/u.exec(rest);
  if (shorthand) {
    host = HOSTED[shorthand[1]!];
    rest = shorthand[2]!;
  }
  const scp = /^git@([^:]+):(.+)$/u.exec(rest);
  if (scp) {
    host = scp[1];
    rest = scp[2]!;
  } else if (rest.includes('://')) {
    try {
      const url = new URL(rest);
      host = url.hostname;
      rest = decodeURIComponent(url.pathname);
      if (url.hash.length > 1) ref = url.hash.slice(1);
    } catch {
      return undefined;
    }
  } else if (!host) {
    const slash = rest.indexOf('/');
    const first = slash < 0 ? '' : rest.slice(0, slash);
    // `owner/repo` is GitHub shorthand; a first segment with a dot is a host.
    if (first.includes('.') || first === 'localhost') {
      host = first;
      rest = rest.slice(slash + 1);
    } else {
      host = 'github.com';
    }
  }
  const at = rest.indexOf('@');
  if (at > 0) {
    ref ??= rest.slice(at + 1) || undefined;
    rest = rest.slice(0, at);
  }
  path = rest.replace(/^\/+/u, '').replace(/\.git$/u, '');
  if (!host || path.split('/').length < 2 || path.split('/').includes('..') || path.includes('\\')) return undefined;
  return { host: host.toLowerCase(), path, ...(ref ? { ref } : {}) };
}

/**
 * Pi's `parseNpmSpec` — `^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$` — read in one
 * pass: the name runs to the first `@` after a scope's own, and what follows
 * that `@` is the version, one or more characters with no line break. Where
 * the pattern would not match, undefined. (Its two overlapping runs would try
 * each `/` against the rest of a long spec.)
 */
function npmSpec(spec: string): { name: string; version?: string } | undefined {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  const name = at < 0 ? spec : spec.slice(0, at);
  const version = at < 0 ? undefined : spec.slice(at + 1);
  if (name.replace(/^@/u, '') === '') return undefined;
  if (version === undefined) return { name };
  return version === '' || /[\n\r\u2028\u2029]/u.test(version) ? undefined : { name, version };
}

function packageRef(source: string, agentDir: string, home: string): PackageRef | undefined {
  const trimmed = source.trim();
  if (trimmed.startsWith('npm:')) {
    const spec = trimmed.slice(4).trim();
    const name = npmSpec(spec)?.name ?? spec;
    if (!NPM_NAME.test(name)) return undefined;
    return { id: `npm:${name}`, name, type: 'npm', path: join(agentDir, 'npm', 'node_modules', name) };
  }
  const nonLocal = ['git:', 'github:', 'http:', 'https:', 'ssh:'].some((prefix) => trimmed.startsWith(prefix));
  if (nonLocal) {
    const git = gitSource(trimmed);
    // Pi reads anything else as a path that does not exist, and loads nothing from it.
    if (!git) return undefined;
    const installRoot = join(agentDir, 'git');
    const path = resolve(installRoot, git.host, git.path);
    if (!path.startsWith(`${installRoot}${sep}`)) return undefined;
    return {
      id: `git:${git.host}/${git.path}`,
      name: git.path.split('/').at(-1)!,
      type: 'git',
      path,
      ...(git.ref ? { ref: git.ref } : {}),
    };
  }
  const path = resolvePiPath(trimmed, agentDir, home);
  return { id: `local:${path}`, name: basename(path).replace(/\.(?:ts|js)$/u, ''), type: 'local', path };
}

/**
 * The source Pi's own commands take for a package the read keyed: an `npm:`
 * or `git:` identity as it is, a local package's absolute path. Nothing for a
 * source a command could misread — nothing to name, a leading hyphen (a flag,
 * to Pi or to the npm or git it runs), a control character — or a local path
 * that is not absolute.
 */
function packageSource(id: string): string | undefined {
  const [, form, rest] = /^(npm|git|local):(.*)$/su.exec(id) ?? [];
  if (rest === undefined || rest.trim() === '' || rest.startsWith('-') || CONTROL_CHARACTER.test(rest)) {
    return undefined;
  }
  if (form === 'local') return isAbsolute(rest) ? rest : undefined;
  return id;
}

/** node-semver's `valid`, not loose: an exact version, never a range or a tag. */
const EXACT_NPM_VERSION =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

/**
 * Whether a configured source keeps its package where `pi update` never moves
 * it (0.87.1 `updateConfiguredSources`): an exact npm version, which it skips,
 * or a git commit, which it fetches and resets to again. A git branch or tag
 * it fetches again too, and a branch moves.
 */
function sourcePins(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith('npm:')) {
    const version = npmSpec(trimmed.slice(4).trim())?.version?.trim();
    return version !== undefined && EXACT_NPM_VERSION.test(version);
  }
  const ref = gitSource(trimmed)?.ref;
  return ref !== undefined && GIT_COMMIT.test(ref);
}

/** npm's rule for a package's name, without a leading `.`, `_` or `-`, which npm refuses or reads as a flag. */
const NPM_INSTALL_NAME = /^(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~][A-Za-z0-9._~-]*$/u;
/** A version, range or tag after the name: never another kind of source (`file:`, `git+ssh:`, an address). */
const NPM_VERSION_SPEC = /^[A-Za-z0-9._~^<>=|*+-]{1,128}$/u;
const PI_SOURCES = "Pi installs npm:<name>, git:<host>/<path>, an https or ssh address, or a folder's whole path";

/**
 * A source a person gives, as `pi install` reads it (0.87.1 `parseSource` and
 * `utils/git.js`), and the argument that gives Pi that source: `npm:` and a
 * name with an optional version; `git:` and a repository; an https, ssh or git
 * address; a folder or file by its whole path, with no `.` or `..` in it. A
 * folder goes as its absolute path, `~` at the home Pi sees, since Pi resolves
 * any other from wherever it runs; `git@host:path`, which Pi reads as a
 * folder, takes the `git:` it needs.
 */
function installArgument(source: string, home: string): { argument: string } | { refused: string } {
  if (!isExtensionSource(source)) return { refused: PI_SOURCES };
  if (source.startsWith('npm:')) {
    const spec = npmSpec(source.slice(4));
    return spec !== undefined &&
      spec.name.length <= 214 &&
      NPM_INSTALL_NAME.test(spec.name) &&
      (spec.version === undefined || NPM_VERSION_SPEC.test(spec.version))
      ? { argument: source }
      : { refused: 'Pi installs an npm package by its name: npm:<name>, or npm:<name>@<version>' };
  }
  if (source.startsWith('http:')) return { refused: 'Pi fetches a repository over https or ssh' };
  // Pi takes a host's shorthand only after `git:`; alone, it is a folder that is not there
  if (/^(?:github|gitlab|bitbucket):/u.test(source)) {
    return { refused: `Pi reads ${source} as a folder: give git:${source}` };
  }
  const argument = source.startsWith('git@') ? `git:${source}` : source;
  if (argument.startsWith('git:') || /^(?:https|ssh):\/\//u.test(argument)) {
    return gitSource(argument) !== undefined
      ? { argument }
      : { refused: 'Pi takes a repository as git:<host>/<path>, or as its https or ssh address' };
  }
  if (source.startsWith('~/') || isAbsolute(source)) {
    const fromHome = source.startsWith('~/');
    // as a person wrote it, it names one folder: never one a `.` or `..` would move it off
    if (!isNormalizedAbsolutePath(fromHome ? source.slice(1) : source)) {
      return { refused: "Give the folder's whole path, with no `.` or `..` in it and no `/` at its end" };
    }
    return { argument: fromHome ? join(home, source.slice(2)) : source };
  }
  if (source.startsWith('file:')) return { refused: "Give the folder's whole path" };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)) return { refused: PI_SOURCES };
  return { refused: "Give the folder's whole path" };
}

/** Whether a package entry, as configured, loads anything at all. */
function packageLoadsSomething(entry: string | Json): boolean {
  if (typeof entry === 'string') return true;
  if (entry.autoload === false) {
    return RESOURCE_KINDS.some((kind) =>
      (strings(entry[kind]) ?? []).some((pattern) => !pattern.startsWith('-') && !pattern.startsWith('!')),
    );
  }
  // Every kind set to `[]` loads none of them.
  return !RESOURCE_KINDS.every((kind) => strings(entry[kind])?.length === 0);
}

// ---------------------------------------------------------------------------

type SkillSource = 'settings' | 'agent' | 'shared' | 'package';

interface SkillResource {
  path: string;
  enabled: boolean;
  source: SkillSource;
  plugin?: string;
}

/** Pi's precedence: settings paths, then auto-discovered folders, then packages. */
const RANK: Record<SkillSource, number> = { settings: 2, agent: 3, shared: 3, package: 4 };

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function linkTargetOf(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return undefined;
    return resolve(dirname(path), await readlink(path));
  } catch {
    return undefined;
  }
}

async function readSkill(path: string): Promise<{ name: string; description: string } | undefined> {
  if (!path.endsWith('.md')) return undefined;
  try {
    if ((await stat(path)).size > MAX_SKILL_BYTES) return undefined;
    const frontmatter = parseSkillFrontmatter((await readFile(path, 'utf8')).replace(/^﻿/u, ''));
    const description = text(frontmatter.description);
    if (!description) return undefined;
    return { name: frontmatter.name ?? basename(dirname(path)), description };
  } catch {
    return undefined;
  }
}

async function readSettings(agentDir: string): Promise<Json | undefined> {
  const path = join(agentDir, 'settings.json');
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return {};
  }
  if (size > MAX_SETTINGS_BYTES) return undefined;
  try {
    const content = (await readFile(path, 'utf8')).replace(/^﻿/u, '');
    if (!content) return {};
    const settings = rec(JSON.parse(content));
    if (!settings) return undefined;
    // Pi migrates the old `skills: { customDirectories }` object to the array.
    const legacy = rec(settings.skills);
    if (legacy) settings.skills = strings(legacy.customDirectories) ?? [];
    return settings;
  } catch {
    return undefined;
  }
}

/** Pi extension capability: a listing of the agent directory's files and the shared skills folder. */
export function createPiExtensionService(options: PiExtensionOptions = {}): ExtensionService {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const nativeDefaultRoot = join(home, '.pi', 'agent');
  const sharedSkills = join(home, '.agents', 'skills');

  const provider: ExtensionProvider = {
    id: 'pi',
    label: 'Pi',
    support: {
      // Pi calls them packages: `pi install|remove|update` edit the agent directory's `packages`. A loose extension
      // is a file in its `extensions/`. It has no catalog: a person gives the source.
      plugins: {
        store: 'profile',
        changes: 'command',
        read: true,
        label: 'Packages',
        sources:
          'An npm package (npm:name), a git repository (git:host/path, or its https or ssh address), or a folder on this Mac',
      },
      // The agent directory's `skills/` per profile, `~/.agents/skills` shared by every profile.
      skills: { store: 'mixed', changes: 'folder', read: true },
    },
  };

  const executable = resolvePiExecutable(options.executable, options.env ?? process.env);
  const agentDirOf = (profile: AgentProfile): string =>
    profile.kind === 'native-default' ? nativeDefaultRoot : piAgentDir(profile);
  const profileEnv = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [PI_PROFILE_ROOT_VARIABLE]: agentDirOf(profile) };

  // Acts (RFC 006 C2): Pi filters its skills only with `pi config`, inside the
  // app. A skill a host keeps is placed as a link in the profile's own
  // `skills/` (Pi follows links there), and only a skill's folder directly in
  // it is taken away: the link goes, or the person's own folder moves to where
  // the host keeps it. A loose `.md` skill beside those folders is one file,
  // not a folder a host keeps, so it stays; one nested deeper, in
  // `~/.agents/skills` (every profile's, and other agents'), on a settings path
  // or in a package changes where it is. Pi has no marketplaces.
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
        'Pi installs packages from npm, git or a folder; it has no marketplaces',
      );
    }
    if (item.kind === 'plugin') {
      return act === 'install' ? planInstall(profile, item, options) : planPlugin(profile, item, act);
    }
    if (act === 'install') return extensionActUnavailable(target, act, 'unsupported', 'Pi installs only packages');
    if (item.kind === 'skill' && (act === 'add' || act === 'remove')) {
      const folder = join(agentDirOf(profile), 'skills');
      // A loose skill's location is its `.md` file; a folder skill's is the folder that holds `SKILL.md`.
      if (
        act === 'remove' &&
        item.origin === 'own' &&
        item.location !== undefined &&
        dirname(item.location) === folder &&
        item.location.endsWith('.md')
      ) {
        return extensionActUnavailable(
          target,
          act,
          'no-command',
          `${item.name} is a loose file in Pi's skills folder, and only a skill's folder is taken away`,
        );
      }
      return extensionSkillFolderPlan({
        label: 'Pi',
        folder,
        item,
        act,
        ...(options.keepIn === undefined ? {} : { keepIn: options.keepIn }),
        home,
      });
    }
    if (item.origin !== 'own') return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Pi', item));
    return extensionActUnavailable(target, act, 'in-app', 'Pi filters its skills only with pi config');
  }

  /**
   * Pi calls its plugins packages, and names one to its own commands by the
   * source it keys it with — the forms of the report's command table
   * (draft/PI-PLUGINS-SKILLS-MCP.md), not probed as acts: `npm:<name>` and
   * `git:<host>/<path>` as the read gives them, a local package by its
   * absolute path (`packageSource`). A loose extension is no package: it is a
   * file Pi finds where it is. Pi switches a package's parts only with the
   * filters `pi config` writes, on an interactive screen, and `pi remove`,
   * which takes the package's entry out of settings.json, is its one way to
   * take it out. Pi installs any configured npm or git package it finds
   * missing whenever it resolves its packages, so the removal runs with
   * `PI_OFFLINE=1` and installs nothing on the way; an update has to fetch, so
   * it cannot. An update always names its package: a bare `pi update` updates
   * Pi itself. One the read marks pinned — its source names an exact npm
   * version or a git commit — has none: Pi's update leaves it there and says
   * it updated.
   */
  function planPlugin(profile: AgentProfile, item: PluginItem, act: ExtensionActKind): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (act === 'add') {
      return extensionActUnavailable(target, act, 'unsupported', 'Pi installs a package from npm, git or a path');
    }
    if (act === 'sign-in' || act === 'sign-out') {
      return extensionActUnavailable(target, act, 'unsupported', 'Pi has no sign-in for a package');
    }
    if (item.origin !== 'own') return extensionActUnavailable(target, act, 'not-own', extensionNotOwnWords('Pi', item));
    if (item.id.startsWith('extension:')) {
      // an extension Pi loads from a file or folder, not a package: `pi config` filters it, and it changes where it is
      return act === 'enable' || act === 'disable'
        ? extensionActUnavailable(target, act, 'in-app', 'Pi turns an extension on and off only in `pi config`')
        : extensionActUnavailable(
            target,
            act,
            'no-command',
            'It is an extension Pi loads from where it is, and changes there',
          );
    }
    if (act === 'enable' || act === 'disable') {
      return extensionActUnavailable(
        target,
        act,
        'in-app',
        "Pi turns a package's parts on and off only in `pi config`",
      );
    }
    if (act === 'purge') {
      return extensionActUnavailable(target, act, 'unsupported', "Pi's remove is its one way to take a package out");
    }
    // a package from a folder on this Mac is used where it is: there is nothing newer to fetch
    if (act === 'update' && item.id.startsWith('local:')) {
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        'A package from a folder on this Mac changes where it is',
      );
    }
    if (act === 'update' && item.pinned === true) {
      const where = item.version === undefined ? 'where its source pins it' : `at ${item.version}`;
      return extensionActUnavailable(
        target,
        act,
        'no-command',
        `Pi keeps ${item.id} ${where}; its update never moves a pinned version`,
      );
    }
    const source = packageSource(item.id);
    if (source === undefined) {
      return extensionActUnavailable(target, act, 'no-command', "Pi's commands do not take this package's source");
    }
    const env = profileEnv(profile);
    return extensionCommandPlan({
      target,
      act,
      argv: [executable, act, source],
      env: act === 'remove' ? { ...env, PI_OFFLINE: '1' } : env,
    });
  }

  /**
   * An install is Pi's own `pi install <source> --no-approve` (0.87.1, as its
   * package reads; not probed as an act): `--no-approve` keeps Pi from asking
   * whether to trust the folder it runs in, and from loading extensions to
   * ask them; a profile's install is never a project's `-l`. Nothing else
   * asks — npm and git ask nothing of a public source, and a private one
   * fails at once with no terminal — so it runs as a command, never offline,
   * which would not stop it anyway. npm runs the package's install scripts,
   * and a repository's own, as the person. Pi keys a package by its source's
   * identity, so one it holds already is updated instead: installing it again
   * replaces its entry and, for git, resets the clone.
   */
  function planInstall(profile: AgentProfile, item: PluginItem, options: ExtensionActPlanOptions): ExtensionActPlan {
    const target = { kind: item.kind, id: item.id };
    if (options.source === undefined) {
      return extensionActUnavailable(
        target,
        'install',
        'unsupported',
        'Pi has no catalog of its own: find packages at pi.dev/packages and add one by its source',
      );
    }
    const given = installArgument(options.source, home);
    if ('refused' in given) return extensionActUnavailable(target, 'install', 'unsupported', given.refused);
    const ref = packageRef(given.argument, agentDirOf(profile), home);
    if (ref === undefined) return extensionActUnavailable(target, 'install', 'unsupported', PI_SOURCES);
    if (options.holds?.includes(ref.id)) {
      return extensionActUnavailable(
        target,
        'install',
        'held',
        ref.type === 'local'
          ? `Pi already has ${ref.id}, and loads it where it is`
          : `Pi already has ${ref.id}; update it instead`,
      );
    }
    return extensionCommandPlan({
      target,
      act: 'install',
      argv: [executable, 'install', given.argument, '--no-approve'],
      env: profileEnv(profile),
    });
  }

  return {
    provider,
    plan,

    async inventory(profile: AgentProfile): Promise<ExtensionInventory> {
      const agentDir = agentDirOf(profile);
      const unread = new Map<ExtensionKind, string>();
      const note = (error: unknown): void => {
        if (!(error instanceof Unread)) throw error;
        if (!unread.has(error.kind)) unread.set(error.kind, error.message);
      };
      const settings = await readSettings(agentDir);
      if (!settings) {
        note(new Unread('plugin', 'settings.json could not be read'));
        note(new Unread('skill', 'settings.json could not be read'));
      }
      const configured = settings ?? {};
      const skillEntries = strings(configured.skills) ?? [];
      const extensionEntries = strings(configured.extensions) ?? [];
      const plugins: PluginItem[] = [];
      const skillResources: SkillResource[] = [];
      const skillWalk: Walk = { left: MAX_ENTRIES, kind: 'skill', steps: MAX_MATCH_STEPS };
      const pluginWalk: Walk = { left: MAX_ENTRIES, kind: 'plugin', steps: MAX_MATCH_STEPS };

      // Packages, first configured of an identity winning.
      const seen = new Set<string>();
      for (const entry of Array.isArray(configured.packages) ? configured.packages : []) {
        const filter = rec(entry);
        const source = typeof entry === 'string' ? entry : text(filter?.source);
        if (!source) continue;
        const ref = packageRef(source, agentDir, home);
        if (!ref || seen.has(ref.id)) continue;
        seen.add(ref.id);
        const found = await kindOf(ref.path);
        if (!found && ref.type !== 'local') {
          note(
            new Unread(
              'skill',
              'a configured npm or git package is not installed in this profile, so its skills are not listed',
            ),
          );
        }
        const manifest = found === 'dir' ? await readManifest(join(ref.path, 'package.json')) : undefined;
        const version = manifest?.version ?? bounded(ref.ref, 128);
        const name = manifest?.name ?? bounded(ref.name, 256);
        if (!name || ref.id.length > 512) continue;
        plugins.push({
          kind: 'plugin',
          id: ref.id,
          name,
          origin: 'own',
          // A local source that is not there loads nothing; a missing npm or git one is installed at start.
          enabled: packageLoadsSomething(filter ?? source) && (found !== undefined || ref.type !== 'local'),
          ...(version ? { version } : {}),
          ...(manifest?.description ? { description: manifest.description } : {}),
          ...(found ? { location: ref.path } : {}),
          ...(sourcePins(source) ? { pinned: true as const } : {}),
        });
        if (found !== 'dir') continue;
        try {
          const patterns = filter ? strings(filter.skills) : undefined;
          const all = await packageSkillFiles(
            ref.path,
            manifest,
            skillWalk,
            !filter ? 'plain' : filter.autoload === false || patterns !== undefined ? 'filtered' : 'default',
          );
          let states: Map<string, boolean>;
          if (filter?.autoload === false) {
            states = applyAutoloadDisabledPatterns(all, patterns ?? [], ref.path, skillWalk);
          } else if (patterns !== undefined) {
            const on = patterns.length === 0 ? new Set<string>() : applyPatterns(all, patterns, ref.path, skillWalk);
            states = new Map(all.map((path) => [path, on.has(path)]));
          } else {
            states = new Map(all.map((path) => [path, true]));
          }
          for (const [path, enabled] of states)
            skillResources.push({ path, enabled, source: 'package', plugin: ref.id });
        } catch (error) {
          note(error);
        }
      }

      // Skills: settings paths, then the agent's folder, then the shared one.
      try {
        const plain = skillEntries
          .filter((entry) => !isPattern(entry))
          .map((entry) => resolvePiPath(entry, agentDir, home));
        const listed = await collectSkillFilesFromPaths(plain, skillWalk);
        const on = applyPatterns(listed, skillEntries.filter(isPattern), agentDir, skillWalk);
        const overrides = overridesOf(skillEntries, skillWalk);
        for (const path of listed) skillResources.push({ path, enabled: on.has(path), source: 'settings' });
        for (const path of await collectSkillEntries(join(agentDir, 'skills'), 'pi', skillWalk)) {
          skillResources.push({
            path,
            enabled: isEnabledByOverrides(path, overrides, agentDir),
            source: 'agent',
          });
        }
        for (const path of await collectSkillEntries(sharedSkills, 'agents', skillWalk)) {
          skillResources.push({
            path,
            enabled: isEnabledByOverrides(path, overrides, dirname(sharedSkills)),
            source: 'shared',
          });
        }
      } catch (error) {
        note(error);
      }

      // Loose extensions: settings paths, then the agent's `extensions/`.
      const units = new Map<string, { enabled: boolean }>();
      try {
        const fromSettings: Array<{ path: string; unit: string }> = [];
        for (const entry of extensionEntries.filter((candidate) => !isPattern(candidate))) {
          const unit = resolvePiPath(entry, agentDir, home);
          const found = await kindOf(unit);
          if (found === 'file') fromSettings.push({ path: unit, unit });
          else if (found === 'dir') fromSettings.push(...(await collectAutoExtensionEntries(unit, pluginWalk)));
        }
        const on = applyPatterns(
          fromSettings.map(({ path }) => path),
          extensionEntries.filter(isPattern),
          agentDir,
          pluginWalk,
        );
        const overrides = overridesOf(extensionEntries, pluginWalk);
        const claimed = new Set<string>();
        const add = async (path: string, unit: string, enabled: boolean): Promise<void> => {
          const key = await canonical(path);
          if (claimed.has(key)) return;
          claimed.add(key);
          const current = units.get(unit);
          units.set(unit, { enabled: (current?.enabled ?? false) || enabled });
        };
        for (const { path, unit } of fromSettings) await add(path, unit, on.has(path));
        for (const { path, unit } of await collectAutoExtensionEntries(join(agentDir, 'extensions'), pluginWalk)) {
          await add(path, unit, isEnabledByOverrides(path, overrides, agentDir));
        }
      } catch (error) {
        note(error);
      }
      for (const [unit, { enabled }] of units) {
        const id = `extension:${unit}`;
        const name = bounded(basename(unit).replace(/\.(?:ts|js)$/u, ''), 256);
        if (!name || id.length > 512 || seen.has(id)) continue;
        seen.add(id);
        plugins.push({ kind: 'plugin', id, name, origin: 'own', enabled, location: unit });
      }

      // One skill per name: Pi loads the first enabled one and drops the rest; a
      // skill switched off shows only where no loaded skill has its name.
      // Pi keeps the first source to add a path, then orders by precedence and drops a path it reached twice.
      const firstAdded = new Map<string, SkillResource>();
      for (const resource of skillResources)
        if (!firstAdded.has(resource.path)) firstAdded.set(resource.path, resource);
      const ordered = [...firstAdded.values()]
        .map((resource, order) => ({ resource, order }))
        .sort((a, b) => RANK[a.resource.source] - RANK[b.resource.source] || a.order - b.order)
        .map(({ resource }) => resource);
      const distinct: SkillResource[] = [];
      const paths = new Set<string>();
      for (const resource of ordered) {
        const key = await canonical(resource.path);
        if (paths.has(key)) continue;
        paths.add(key);
        distinct.push(resource);
      }
      const skills: SkillItem[] = [];
      const names = new Set<string>();
      const ids = new Set<string>();
      for (const pass of [true, false]) {
        for (const resource of distinct.filter(({ enabled }) => enabled === pass)) {
          const skill = await readSkill(resource.path);
          if (!skill || names.has(skill.name)) continue;
          const declared = basename(resource.path) === 'SKILL.md';
          const location = declared ? dirname(resource.path) : resource.path;
          const id =
            resource.source === 'package'
              ? `plugin:${resource.plugin}:${skill.name}`
              : resource.source === 'agent'
                ? posix(relative(join(agentDir, 'skills'), location))
                : resource.source === 'shared'
                  ? `shared:${posix(relative(sharedSkills, location))}`
                  : `path:${location}`;
          const name = bounded(skill.name, 256);
          if (!name || id.length > 512 || ids.has(id)) continue;
          names.add(skill.name);
          ids.add(id);
          const linkTarget = await linkTargetOf(location);
          skills.push({
            kind: 'skill',
            id,
            name,
            origin: resource.source === 'package' ? 'plugin' : 'own',
            ...(resource.source === 'package' ? { plugin: resource.plugin! } : {}),
            ...(resource.source === 'shared' ? { shared: true as const } : {}),
            enabled: pass,
            description: skill.description.slice(0, 2_048),
            location,
            ...(linkTarget ? { linkTarget } : {}),
          });
        }
      }

      const items: ExtensionItem[] = [...plugins, ...skills];
      return {
        provider: 'pi',
        profileId: profile.id,
        fetchedAt: now().toISOString(),
        items,
        ...(unread.size > 0 ? { unread: [...unread].map(([kind, message]) => ({ kind, message })) } : {}),
        // docs/packages.md, docs/skills.md and docs/settings.md describe these files and folders.
        source: { kind: 'native-store', stability: 'documented' },
      };
    },
  };
}
