/**
 * Antigravity account profiles.
 *
 * Support is declared false, on probe evidence rather than on absence of
 * effort. Antigravity 1.1.21 ships no login or auth subcommand: `agy help`
 * lists only agent, agents, changelog, help, install, mcp, mic-serve, models,
 * plugin, plugins, and update, and `agy help login` answers
 * "unknown subcommand: login" (probed 2026-09-06). A managed root can therefore
 * be allocated but never onboarded, so hosts must not offer one.
 *
 * The binding itself is real and is still declared, so a host that already
 * holds a profile binds it correctly: `PUPPETEER_ANTIGRAVITY_HOME` is the
 * adapter-owned HOME redirection the driver turns into `HOME`, and the native
 * store lands under `<root>/.gemini/antigravity-cli`. That indirection is the
 * second reason support is false: the bound root is a home directory, not the
 * data root that `nativeDefaultRoot` names.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ProfileProvider, ProfileService, TerminalSpec } from '@vibecook/puppeteer-core';
import { resolveAntigravityExecutable } from '../detection.js';

/** The adapter-owned HOME redirection; also a provider launch allow-list entry. */
export const ANTIGRAVITY_PROFILE_ROOT_VARIABLE = 'PUPPETEER_ANTIGRAVITY_HOME';

export interface AntigravityProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
}

export function createAntigravityProfileService(options: AntigravityProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const provider: ProfileProvider = {
    id: 'antigravity',
    label: 'Antigravity',
    support: {
      supported: false,
      identity: 'none',
      sharedSurfaces: [],
      nativeDefaultRoot: join(home, '.gemini', 'antigravity-cli'),
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  return {
    provider,
    bindingEnvironment,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // No native login exists, so the agent itself runs in the bound root and
      // whatever it writes on first authentication lands there.
      return {
        command: resolveAntigravityExecutable(options.executable),
        args: [],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile) {
      return {
        status: 'unsupported' as const,
        provider: 'antigravity',
        message: `Antigravity exposes no identity or login surface for ${profile.id}`,
        retryable: false,
      };
    },
  };
}
