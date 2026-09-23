import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_PROFILE_SET_ID, ProfileSetIdSchema } from '@vibecook/puppeteer-core';

/**
 * Managed profile folders.
 *
 * A profile set owns one directory, `<rootsDirectory>/<set id>/`, named once
 * from the set's first name; each account in the set gets a root inside it,
 * `<set directory>/<provider>-<8 hex>/`. Both are created exclusively, 0700,
 * because they hold credential stores.
 *
 * A root never moves and is never handed out twice: native credential stores
 * key on the directory path (Claude Code derives its Keychain service name
 * from it, Codex its keyring account), so renaming a set changes a label and
 * never a path, and an account signed out and added again lands on a new path
 * that no credential left behind can answer for.
 */

const DIRECTORY_MODE = 0o700;
const MAX_SLUG_LENGTH = 40;
const MAX_SET_SUFFIX = 999;
const MAX_ACCOUNT_ATTEMPTS = 8;

export function defaultProfileRootsDirectory(home = homedir()): string {
  return join(home, '.puppeteer', 'profiles');
}

/**
 * The directory-safe id a set's name suggests: lowercase ASCII letters and
 * digits joined by single hyphens, accents folded, at most 40 characters.
 * A name with nothing to keep suggests `profile`.
 */
export function profileSetSlug(label: string): string {
  const folded = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const trimmed = folded.slice(0, MAX_SLUG_LENGTH).replace(/-+$/u, '');
  return trimmed.length > 0 ? trimmed : 'profile';
}

/** The first id from `base`, `base-2`, `base-3`, … that `taken` does not hold and is not the native set's. */
export function uniqueProfileSetId(base: string, taken: ReadonlySet<string>): string {
  for (let suffix = 1; suffix <= MAX_SET_SUFFIX; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (
      candidate !== NATIVE_PROFILE_SET_ID &&
      !taken.has(candidate) &&
      ProfileSetIdSchema.safeParse(candidate).success
    ) {
      return candidate;
    }
  }
  throw new Error(`no free profile set id for ${JSON.stringify(base)}`);
}

export interface AllocatedProfileSet {
  id: string;
  directory: string;
}

export interface AllocatedProfileRoot {
  /** Account profile id. */
  id: string;
  dataRoot: string;
}

export interface ProfileRootAllocatorOptions {
  /** Defaults to ~/.puppeteer/profiles. */
  rootsDirectory?: string;
  /** Injected for deterministic tests. */
  newId?: () => string;
}

export interface ProfileRootAllocator {
  readonly rootsDirectory: string;
  /**
   * Create a set's directory from its name. `taken` holds the ids the registry
   * already knows; a directory that exists on disk without being registered is
   * skipped too, so an allocation never adopts a folder it did not make.
   */
  allocateSet(label: string, taken: ReadonlySet<string>): Promise<AllocatedProfileSet>;
  /** Create an account root for one provider inside a set's directory. */
  allocateAccount(directory: string, providerId: string): Promise<AllocatedProfileRoot>;
}

function exists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

export function createProfileRootAllocator(options: ProfileRootAllocatorOptions = {}): ProfileRootAllocator {
  const rootsDirectory = options.rootsDirectory ?? defaultProfileRootsDirectory();
  const newId = options.newId ?? randomUUID;
  return {
    rootsDirectory,

    async allocateSet(label, taken) {
      await mkdir(rootsDirectory, { recursive: true, mode: DIRECTORY_MODE });
      const skipped = new Set(taken);
      const base = profileSetSlug(label);
      for (;;) {
        const id = uniqueProfileSetId(base, skipped);
        const directory = join(rootsDirectory, id);
        try {
          // Not recursive: the leaf must be ours alone.
          await mkdir(directory, { mode: DIRECTORY_MODE });
          return { id, directory };
        } catch (error) {
          if (!exists(error)) throw error;
          skipped.add(id);
        }
      }
    },

    async allocateAccount(directory, providerId) {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt += 1) {
        const id = newId();
        const dataRoot = join(directory, `${providerId}-${id.replace(/-/gu, '').slice(0, 8)}`);
        try {
          await mkdir(dataRoot, { mode: DIRECTORY_MODE });
          return { id, dataRoot };
        } catch (error) {
          if (!exists(error)) throw error;
        }
      }
      throw new Error(`no free account root for ${providerId} in ${directory}`);
    },
  };
}
