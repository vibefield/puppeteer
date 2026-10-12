import type { EnvironmentEvent } from '@vibefield/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str } from './types.js';

/** Codex cwd evidence normalized for the Core environment service. */
export class CodexEnvironmentNormalizer {
  normalize(input: CodexNormalizationInput): CategoryNormalization<EnvironmentEvent> {
    const events: EnvironmentEvent[] = [];
    const { method, params } = input;

    switch (method) {
      case 'thread/started': {
        const currentCwd = str(rec(params.thread)?.cwd);
        if (currentCwd) events.push({ type: 'environment:updated', currentCwd });
        return { handled: true, events };
      }

      case 'thread/settings/updated': {
        const settings = rec(params.threadSettings) ?? params;
        const currentCwd = str(settings.cwd);
        if (currentCwd) events.push({ type: 'environment:updated', currentCwd });
        return { handled: true, events };
      }

      default:
        return { handled: false, events };
    }
  }
}
