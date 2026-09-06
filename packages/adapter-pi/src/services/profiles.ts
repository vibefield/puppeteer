/**
 * Pi account profiles, bound through the native `PI_CODING_AGENT_DIR` variable
 * that already forms part of the provider's launch allow-list.
 *
 * Probed 2026-09-06 on Pi 0.84.3: the native root holds `auth.json`,
 * `settings.json`, `models-store.json`, and `sessions/`, so binding the one
 * variable isolates credentials and history together.
 *
 * Pi has no interactive login subcommand. `pi auth` offers only
 * `print-api-key`, `print-bearer-token`, and `check` — commands that emit
 * credentials, which a host must never run. Onboarding therefore opens the
 * agent itself inside the profile root and the user authenticates in its own
 * interface; identity stays `none` and verification is explicitly unsupported.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ProfileProvider, ProfileService, TerminalSpec } from '@vibecook/puppeteer-core';
import { resolvePiExecutable } from '../detection.js';

/** Pi's native root variable; also a provider launch allow-list entry. */
export const PI_PROFILE_ROOT_VARIABLE = 'PI_CODING_AGENT_DIR';

export interface PiProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
}

export function createPiProfileService(options: PiProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const provider: ProfileProvider = {
    id: 'pi',
    label: 'Pi',
    support: {
      supported: true,
      identity: 'none',
      // Provider API keys read from the ambient environment reach every profile.
      sharedSurfaces: ['provider API keys supplied through environment variables'],
      nativeDefaultRoot: join(home, '.pi', 'agent'),
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [PI_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  return {
    provider,
    bindingEnvironment,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // No native login command exists, so the agent itself runs in the profile
      // root: whatever it writes on first authentication lands in that root.
      return {
        command: resolvePiExecutable(options.executable),
        args: [],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile) {
      return {
        status: 'unsupported' as const,
        provider: 'pi',
        message: `Pi exposes no credential-free identity document for ${profile.id}`,
        retryable: false,
      };
    },
  };
}
