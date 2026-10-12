import type { EnvironmentEvent } from '@vibefield/puppeteer-core';
import { openCodeText } from './wire.js';

/** OpenCode session snapshots → deduplicated environment events. */
export class OpenCodeEnvironmentNormalizer {
  private currentDirectory: string | undefined;

  normalize(info: Record<string, unknown>): EnvironmentEvent[] {
    const directory = openCodeText(info.directory);
    const changedDirectory = directory !== undefined && directory !== this.currentDirectory;
    if (!changedDirectory) return [];
    if (changedDirectory) this.currentDirectory = directory;
    return [{ type: 'environment:updated', currentCwd: directory! }];
  }
}
