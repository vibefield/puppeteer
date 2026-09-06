import { randomUUID } from 'node:crypto';
import { mkdir as mkdirNative } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Managed profile roots.
 *
 * A root is allocated once and never moves: native credential stores key on
 * the directory path (Claude Code derives its Keychain service name from it,
 * Codex derives its keyring account from it), so renaming a profile changes a
 * label and never a path. Roots are 0700 because they hold those stores.
 */

const ROOT_MODE = 0o700;

export function defaultProfileRootsDirectory(home = homedir()): string {
  return join(home, '.puppeteer', 'profiles');
}

export interface AllocatedProfileRoot {
  /** Profile id; the allocated directory name. */
  id: string;
  dataRoot: string;
}

export interface ProfileRootAllocatorOptions {
  /** Defaults to ~/.puppeteer/profiles. */
  rootsDirectory?: string;
  /** Injected for deterministic tests. */
  newId?: () => string;
  mkdir?: (path: string, mode: number) => Promise<void>;
}

export interface ProfileRootAllocator {
  readonly rootsDirectory: string;
  allocate(providerId: string): Promise<AllocatedProfileRoot>;
}

export function createProfileRootAllocator(options: ProfileRootAllocatorOptions = {}): ProfileRootAllocator {
  const rootsDirectory = options.rootsDirectory ?? defaultProfileRootsDirectory();
  const newId = options.newId ?? randomUUID;
  const mkdir = options.mkdir ?? ((path, mode) => mkdirNative(path, { recursive: true, mode }).then(() => undefined));
  return {
    rootsDirectory,
    async allocate(providerId) {
      const id = newId();
      const dataRoot = join(rootsDirectory, providerId, id);
      await mkdir(dataRoot, ROOT_MODE);
      return { id, dataRoot };
    },
  };
}
