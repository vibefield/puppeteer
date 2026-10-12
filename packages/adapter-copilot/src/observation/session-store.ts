import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureJsonlBoundary } from '@vibefield/puppeteer-native-observation';

export interface CopilotSessionLocation {
  sessionId: string;
  sessionDir: string;
  eventsPath: string;
}
export function resolveCopilotHome(explicit?: string): string {
  return resolve(explicit ?? process.env.COPILOT_HOME ?? join(homedir(), '.copilot'));
}
export function copilotSessionLocation(home: string, sessionId: string): CopilotSessionLocation {
  const sessionDir = join(home, 'session-state', sessionId);
  return { sessionId, sessionDir, eventsPath: join(sessionDir, 'events.jsonl') };
}
export async function captureCopilotReplayBoundary(location: CopilotSessionLocation): Promise<number> {
  return captureJsonlBoundary(location.eventsPath);
}
