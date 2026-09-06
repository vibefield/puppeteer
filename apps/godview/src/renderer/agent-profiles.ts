import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentProfile, ProfileDefaults } from '../protocol.js';
import { profileLabelIndex } from './agents-drawer.js';

export interface AgentProfilesState {
  profiles: readonly AgentProfile[];
  defaults: ProfileDefaults;
  /** Account id -> label, for surfaces that carry only the id a session was bound to. */
  labels: ReadonlyMap<string, string>;
  /** Persist which account new terminals of one provider bind to; null clears it. */
  setDefault(providerId: string, profileId: string | null): Promise<void>;
  reload(): void;
}

/**
 * One subscription to the account registry for the whole shell.
 *
 * Main pushes the list whenever the runtime's registry changes, so a login, a
 * verification, or a removal reaches every panel without polling.
 */
export function useAgentProfiles(): AgentProfilesState {
  const [profiles, setProfiles] = useState<readonly AgentProfile[]>([]);
  const [defaults, setDefaults] = useState<ProfileDefaults>({});
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    const unsubscribe = window.puppeteer.onProfiles((next) => {
      if (alive) setProfiles(next);
    });
    void window.puppeteer.profiles().then(
      (next) => {
        if (alive) setProfiles(next);
      },
      () => undefined,
    );
    void window.puppeteer.profileDefaults().then(
      (next) => {
        if (alive) setDefaults(next);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [generation]);

  const labels = useMemo(() => profileLabelIndex(profiles), [profiles]);
  const reload = useCallback((): void => setGeneration((current) => current + 1), []);
  const setDefault = useCallback(async (providerId: string, profileId: string | null): Promise<void> => {
    setDefaults(await window.puppeteer.setProfileDefault({ providerId, profileId }));
  }, []);

  return { profiles, defaults, labels, setDefault, reload };
}
