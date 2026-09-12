/**
 * Copilot CLI account profiles, bound through the native `COPILOT_HOME`
 * variable that already forms the provider's launch allow-list.
 *
 * Copilot 1.0.80 prints no structured identity document (`copilot login` is
 * interactive and there is no `--json` status), so identity stays `none` and
 * verification is explicitly unsupported rather than scraped from the terminal.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ProfileProvider, ProfileService, TerminalSpec } from '@vibecook/puppeteer-core';
import { resolveCopilotExecutable } from '../detection.js';

/** Copilot's native root variable; also the provider's launch allow-list entry. */
export const COPILOT_PROFILE_ROOT_VARIABLE = 'COPILOT_HOME';

export interface CopilotProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
}

export function createCopilotProfileService(options: CopilotProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const provider: ProfileProvider = {
    id: 'copilot',
    label: 'GitHub Copilot',
    support: {
      supported: true,
      identity: 'none',
      // Copilot reads the cross-agent personal skills directory (`copilot skill
      // list --json` labels it `personal-agents`, verified 2026-09-06 on 1.0.80),
      // which no root variable redirects.
      sharedSurfaces: [join(home, '.agents', 'skills')],
      nativeDefaultRoot: join(home, '.copilot'),
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [COPILOT_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  return {
    provider,
    bindingEnvironment,
    // COPILOT_HOME names the layout root itself: unlike Pi and OpenCode, the
    // bound root is the directory an indexer applies Copilot's layout to.
    observationRoot: (profile: AgentProfile): string =>
      profile.kind === 'native-default' ? (provider.support.nativeDefaultRoot ?? profile.dataRoot) : profile.dataRoot,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // `copilot login` is the native interactive device flow; it must run in a
      // real terminal so the host never observes the credential exchange.
      return {
        command: resolveCopilotExecutable(options.executable),
        args: ['login'],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile) {
      return {
        status: 'unsupported' as const,
        provider: 'copilot',
        message: `Copilot exposes no structured identity document for ${profile.id}`,
        retryable: false,
      };
    },
  };
}
