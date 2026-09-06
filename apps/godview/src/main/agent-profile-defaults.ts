import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Which account a new terminal binds to when the user names none.
 *
 * The map is host preference, not runtime state: the runtime owns the profile
 * registry, and this file only remembers the one profile per provider that
 * Godview seeds into a pane. Ids are validated on load because a hand-edited or
 * truncated file must never widen what gets merged into a child environment.
 *
 * Godview has no Zod dependency, so the schema is expressed the way this app
 * already validates persisted documents (`restore-snapshot.ts`,
 * `appearance-profiles.ts`): a tolerant reader that drops anything it cannot
 * verify rather than throwing at start-up.
 */

export const AGENT_PROFILE_DEFAULTS_VERSION = 1 as const;

const MAX_DEFAULTS_FILE_BYTES = 256 * 1024;
const MAX_DEFAULT_ENTRIES = 64;
const TEMP_PREFIX = '.agent-profile-defaults-';

// Mirrors AgentProviderIdSchema and AgentProfileIdSchema in
// @vibecook/puppeteer-core; a profile id additionally carries the ':' that
// separates a provider from its synthetic default.
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;

/** Provider id -> the profile id new terminals bind to. */
export type ProfileDefaults = Record<string, string>;

interface ProfileDefaultsDocument {
  version: typeof AGENT_PROFILE_DEFAULTS_VERSION;
  defaults: ProfileDefaults;
}

export interface ProfileDefaultsStore {
  path: string;
  read(): ProfileDefaults;
  /** Persist a complete map; returns what was written. */
  write(defaults: ProfileDefaults): ProfileDefaults;
  /** Set or clear one provider's default and persist the result. */
  set(providerId: string, profileId: string | null): ProfileDefaults;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts only well-formed provider/profile id pairs; everything else is dropped. */
export function parseProfileDefaults(value: unknown): ProfileDefaults {
  const document = isRecord(value) ? value : undefined;
  if (!document || document.version !== AGENT_PROFILE_DEFAULTS_VERSION) return {};
  const defaults = isRecord(document.defaults) ? document.defaults : undefined;
  if (!defaults) return {};
  const parsed: ProfileDefaults = {};
  for (const [providerId, profileId] of Object.entries(defaults)) {
    if (Object.keys(parsed).length >= MAX_DEFAULT_ENTRIES) break;
    if (!PROVIDER_ID.test(providerId)) continue;
    if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) continue;
    parsed[providerId] = profileId;
  }
  return parsed;
}

export function serializeProfileDefaults(defaults: ProfileDefaults): string {
  const ordered: ProfileDefaults = {};
  for (const providerId of Object.keys(defaults).sort()) ordered[providerId] = defaults[providerId]!;
  const document: ProfileDefaultsDocument = { version: AGENT_PROFILE_DEFAULTS_VERSION, defaults: ordered };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A null profile id clears the provider's entry rather than storing an empty value. */
export function applyProfileDefault(
  defaults: ProfileDefaults,
  providerId: string,
  profileId: string | null,
): ProfileDefaults {
  if (!PROVIDER_ID.test(providerId)) return { ...defaults };
  const next = { ...defaults };
  if (profileId === null) {
    delete next[providerId];
    return next;
  }
  if (!PROFILE_ID.test(profileId)) return next;
  next[providerId] = profileId;
  return next;
}

/** Drop entries whose profile is no longer registered, so a removed account stops binding panes. */
export function retainKnownProfileDefaults(
  defaults: ProfileDefaults,
  knownProfileIds: Iterable<string>,
): ProfileDefaults {
  const known = new Set(knownProfileIds);
  const next: ProfileDefaults = {};
  for (const [providerId, profileId] of Object.entries(defaults)) {
    if (known.has(profileId)) next[providerId] = profileId;
  }
  return next;
}

/** The profile ids to bind, one per provider, in a stable order. */
export function profileDefaultIds(defaults: ProfileDefaults): string[] {
  return Object.keys(defaults)
    .sort()
    .map((providerId) => defaults[providerId]!);
}

function readDefaultsFile(path: string): ProfileDefaults {
  try {
    if (!existsSync(path)) return {};
    if (statSync(path).size > MAX_DEFAULTS_FILE_BYTES) return {};
    return parseProfileDefaults(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    // A corrupt or unreadable preference file must not stop Godview from
    // opening terminals; it simply means no profile is bound.
    return {};
  }
}

function writeDefaultsFile(path: string, defaults: ProfileDefaults): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `${TEMP_PREFIX}${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, serializeProfileDefaults(defaults), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/** File-backed defaults with an in-memory copy, so pane creation never blocks on disk. */
export function createProfileDefaultsStore(path: string): ProfileDefaultsStore {
  let current = readDefaultsFile(path);
  return {
    path,
    read: () => ({ ...current }),
    write(defaults) {
      const next = parseProfileDefaults({ version: AGENT_PROFILE_DEFAULTS_VERSION, defaults });
      writeDefaultsFile(path, next);
      current = next;
      return { ...current };
    },
    set(providerId, profileId) {
      return this.write(applyProfileDefault(current, providerId, profileId));
    },
  };
}
