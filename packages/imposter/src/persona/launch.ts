/**
 * Managed process recipe for one Imposter persona.
 *
 * Vendor argv aliases and native-store roots belong to the persona. A control
 * center selects a persona; it must not reproduce those conventions itself.
 */
import { loadPersona } from './load.ts';

export interface PersonaLaunchSpec {
  args: string[];
  env: Record<string, string>;
}

/** Resolve the persona-owned session flag and native-root environment. */
export function createPersonaLaunchSpec(vendor: string, sessionId: string, nativeRoot: string): PersonaLaunchSpec {
  const persona = loadPersona(vendor);
  const sessionFlags = persona.flagsFor('sessionId', '--session-id');
  const sessionFlag = sessionFlags.find((flag) => flag.startsWith('--')) ?? sessionFlags[0];
  if (!sessionFlag) throw new Error(`persona ${vendor} has no session identity flag`);

  const nativeRootVariable = persona.document.nativeStore?.rootEnv;
  return {
    args: [sessionFlag, sessionId],
    env: {
      AI_PERSONA: vendor,
      PUPPETEER_IMPOSTER_TUI: 'off',
      PUPPETEER_IMPOSTER_HOME: nativeRoot,
      ...(nativeRootVariable ? { [nativeRootVariable]: nativeRoot } : {}),
    },
  };
}
