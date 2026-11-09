import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentProfile, ProfileService } from '@vibefield/puppeteer-core';
import { nativeDefaultProfileId } from '@vibefield/puppeteer-runtime';

/**
 * Which registered account a session's pushed usage belongs to: the one rule every provider that pushes reads, so a
 * reading lands on its own account's row and never on another's.
 *
 * The root is the adapter's to name (Claude's `claudeConfigRoot`): where the launched process keeps its sign-in. A
 * bound profile owns the session when its observation root is that root; else the native default account owns it
 * when the root is the provider's own; else no registered account names it (a typed root no profile names). An
 * imposter launch has no account.
 */
export interface SessionAccountOptions {
  /** The root the session's process keeps its account under, by the adapter's own root rule. */
  root: string;
  /** The profile the session was bound to, if any. */
  profile: AgentProfile | undefined;
  /** The provider's profile service: a profile's observation root, and the provider's native default root. */
  profiles: ProfileService;
  /** The launch environment, where an imposter launch is marked. */
  env: Readonly<Record<string, string>> | undefined;
}

export interface SessionAccount {
  profileId: string;
}

/** Where a path really is, or undefined when it is not there. */
function realPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Two roots are one when they resolve alike, or when both exist and are the same directory (a link to it). */
function sameRoot(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  const realLeft = realPath(resolvedLeft);
  return realLeft !== undefined && realLeft === realPath(resolvedRight);
}

export function sessionAccount(options: SessionAccountOptions): SessionAccount | undefined {
  const { root, profile, profiles, env } = options;
  if (env?.PUPPETEER_IMPOSTER_HOME !== undefined || env?.AI_PERSONA !== undefined) return undefined;
  if (profile && sameRoot(profiles.observationRoot(profile), root)) return { profileId: profile.id };
  const nativeRoot = profiles.provider.support.nativeDefaultRoot;
  if (nativeRoot !== undefined && sameRoot(nativeRoot, root)) {
    return { profileId: nativeDefaultProfileId(profiles.provider.id) };
  }
  return undefined;
}
