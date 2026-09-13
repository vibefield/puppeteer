import type { AgentSessionInfo } from '../protocol.js';
import { folderName } from './folder-name.js';

export type { AgentVisualStatus } from '@vibecook/puppeteer-views';
export { classifyTerminalStatus } from '@vibecook/puppeteer-views';

/** The project a run shows as: its current directory, else its workspace, else the provider's label. */
export function projectLabel(info: AgentSessionInfo, currentCwd?: string): string {
  const path = currentCwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || '';
  return folderName(path, info.provider.label);
}
