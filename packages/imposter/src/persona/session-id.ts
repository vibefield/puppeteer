import { substitute } from '../session/template.ts';
import type { Persona } from './types.ts';

/** Mint an identity using the persona's native convention, never a caller guess. */
export function mintPersonaSessionId(persona: Pick<Persona, 'vendor' | 'document'>): string {
  const sessionId = persona.document.sessionIdTemplate
    ? substitute(persona.document.sessionIdTemplate, { uuids: new Map() })
    : crypto.randomUUID();
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`persona ${persona.vendor} sessionIdTemplate must resolve to a non-empty string`);
  }
  return sessionId;
}
