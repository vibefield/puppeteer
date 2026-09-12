/**
 * Kimi Code account profiles, bound through the native `KIMI_CODE_HOME`
 * variable that already forms the provider's launch allow-list.
 *
 * Kimi 0.37.1 logs in with a device code and prints no structured identity
 * document, so identity stays `none` and verification is explicitly
 * unsupported rather than scraped from the terminal.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ProfileProvider, ProfileService, TerminalSpec } from '@vibecook/puppeteer-core';
import { resolveKimiExecutable } from '../detection.js';

/** Kimi's native root variable; also the provider's launch allow-list entry. */
export const KIMI_PROFILE_ROOT_VARIABLE = 'KIMI_CODE_HOME';

export interface KimiProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
}

export function createKimiProfileService(options: KimiProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const provider: ProfileProvider = {
    id: 'kimi',
    label: 'Kimi',
    support: {
      supported: true,
      identity: 'none',
      sharedSurfaces: [],
      nativeDefaultRoot: join(home, '.kimi-code'),
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [KIMI_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  return {
    provider,
    bindingEnvironment,
    // KIMI_CODE_HOME names the layout root itself: unlike Pi and OpenCode, the
    // bound root is the directory an indexer applies Kimi's layout to.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'native-default' ? (provider.support.nativeDefaultRoot ?? profile.dataRoot) : profile.dataRoot,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // `kimi login` runs the native device-code flow; it must own a real
      // terminal so the host never observes the credential exchange.
      return {
        command: resolveKimiExecutable(options.executable),
        args: ['login'],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile) {
      return {
        status: 'unsupported' as const,
        provider: 'kimi',
        message: `Kimi exposes no structured identity document for ${profile.id}`,
        retryable: false,
      };
    },
  };
}
