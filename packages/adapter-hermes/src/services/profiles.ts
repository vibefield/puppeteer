/**
 * Hermes account profiles, bound through the native `HERMES_HOME` variable
 * that already forms the provider's launch allow-list.
 *
 * Probed 2026-09-06 on Hermes 0.20.5: the native root holds `auth.json`,
 * `config.yaml`, `cache/`, and `cron/`, so binding the one variable isolates
 * credentials and state together. The adapter already runs the gateway with
 * `HOME` set to the same directory, so a bound profile also owns whatever the
 * agent reads from its home. The Python checkout and virtual environment the
 * wrapper script execs are addressed absolutely and stay shared.
 *
 * Hermes prints no structured identity document, so identity stays `none` and
 * verification is explicitly unsupported rather than scraped from the terminal.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ProfileProvider, ProfileService, TerminalSpec } from '@vibecook/puppeteer-core';
import { resolveHermesExecutable } from '../detection.js';
import { HERMES_HOME_ENV } from '../generated/detection.js';

/** Hermes's native root variable; also the provider's launch allow-list entry. */
export const HERMES_PROFILE_ROOT_VARIABLE = HERMES_HOME_ENV;

export interface HermesProfileServiceOptions {
  /** Injected so unit tests never read the real home directory. */
  home?: string;
  executable?: string;
}

export function createHermesProfileService(options: HermesProfileServiceOptions = {}): ProfileService {
  const home = options.home ?? homedir();
  const provider: ProfileProvider = {
    id: 'hermes',
    label: 'Hermes',
    support: {
      supported: true,
      identity: 'none',
      sharedSurfaces: ['the Hermes source checkout and virtual environment the wrapper script execs'],
      nativeDefaultRoot: join(home, '.hermes'),
    },
  };

  const bindingEnvironment = (profile: AgentProfile): Record<string, string> =>
    profile.kind === 'native-default' ? {} : { [HERMES_PROFILE_ROOT_VARIABLE]: profile.dataRoot };

  return {
    provider,
    bindingEnvironment,
    loginInvocation(profile: AgentProfile, { cwd }: { cwd: string }): TerminalSpec {
      // `hermes login` is the native interactive flow; it must own a real
      // terminal so the host never observes the credential exchange.
      return {
        command: resolveHermesExecutable(options.executable),
        args: ['login'],
        cwd,
        env: bindingEnvironment(profile),
      };
    },
    async verify(profile: AgentProfile) {
      return {
        status: 'unsupported' as const,
        provider: 'hermes',
        message: `Hermes exposes no structured identity document for ${profile.id}`,
        retryable: false,
      };
    },
  };
}
