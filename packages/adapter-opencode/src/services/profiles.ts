/**
 * OpenCode account profiles.
 *
 * OpenCode has no root variable of its own. Verified 2026-09-06 on 1.18.23, it
 * keys credentials, history, and logs off the XDG data root:
 * `$XDG_DATA_HOME/opencode/{auth.json,opencode.db,log,snapshot}`, defaulting to
 * `~/.local/share/opencode`. Binding `XDG_DATA_HOME` to `<dataRoot>/data`
 * therefore isolates an account while config, plugins, and cache — which live
 * under the XDG config and cache roots — stay shared, exactly as RFC 006
 * decided.
 *
 * The variable is generic, so two consequences are documented rather than
 * hidden: tools the agent spawns inherit it, and the profile root gains one
 * `data` level so the binding never collides with the profile's own metadata.
 *
 * OpenCode prints no structured identity document, so identity stays `none`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ProfileProvider, ProfileService, TerminalSpec } from '@vibecook/puppeteer-core';
import { resolveOpenCodeExecutable } from '../detection.js';

/** The XDG variable OpenCode reads its data root from. */
export const OPENCODE_PROFILE_ROOT_VARIABLE = 'XDG_DATA_HOME';

export interface OpenCodeProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
}

/** The XDG data root a managed profile binds: one `data` level inside the profile root. */
export function openCodeDataHome(profile: AgentProfile): string {
  return join(profile.dataRoot, 'data');
}

export function createOpenCodeProfileService(options: OpenCodeProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const provider: ProfileProvider = {
    id: 'opencode',
    label: 'OpenCode',
    support: {
      supported: true,
      identity: 'none',
      sharedSurfaces: [
        'the OpenCode config directory under the XDG config root',
        'plugins and the model cache under the XDG cache root',
        'tools the agent spawns inherit XDG_DATA_HOME',
      ],
      nativeDefaultRoot: join(home, '.local', 'share', 'opencode'),
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [OPENCODE_PROFILE_ROOT_VARIABLE]: openCodeDataHome(profile) };

  return {
    provider,
    bindingEnvironment,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // `opencode auth login` is the native interactive flow; it must own a real
      // terminal so the host never observes the credential exchange.
      return {
        command: resolveOpenCodeExecutable(options.executable),
        args: ['auth', 'login'],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile) {
      return {
        status: 'unsupported' as const,
        provider: 'opencode',
        message: `OpenCode exposes no structured identity document for ${profile.id}`,
        retryable: false,
      };
    },
  };
}
