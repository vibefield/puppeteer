/**
 * Grok account profiles: one native data root per account, bound through
 * Grok's own `GROK_HOME` variable.
 *
 * The variable is already the provider's launch allow-list, so a bound profile
 * reaches the CLI exactly as a shell-forwarded launch would. Grok exposes no
 * structured identity document (no `--json` auth status on 1.0.13, probed
 * 2026-09-06), so identity stays `none` and verification is explicitly
 * unsupported rather than scraped from terminal text.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ProfileProvider, ProfileService } from '@vibecook/puppeteer-core';
import type { TerminalSpec } from '@vibecook/puppeteer-core';
import { resolveGrokExecutable } from '../detection.js';

/** Grok's native root variable; also the provider's launch allow-list entry. */
export const GROK_PROFILE_ROOT_VARIABLE = 'GROK_HOME';

export interface GrokProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
}

export function createGrokProfileService(options: GrokProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const provider: ProfileProvider = {
    id: 'grok',
    label: 'Grok',
    support: {
      supported: true,
      identity: 'none',
      sharedSurfaces: [],
      nativeDefaultRoot: join(home, '.grok'),
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [GROK_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  return {
    provider,
    bindingEnvironment,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // `grok login` is the native interactive flow; it must run in a real
      // terminal so the host never sees the credential exchange.
      return {
        command: resolveGrokExecutable(options.executable),
        args: ['login'],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile) {
      return {
        status: 'unsupported' as const,
        provider: 'grok',
        message: `Grok exposes no structured identity document for ${profile.id}`,
        retryable: false,
      };
    },
  };
}
