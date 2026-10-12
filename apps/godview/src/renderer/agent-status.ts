import type { AgentSessionInfo } from '../protocol.js';
import { folderName } from '@vibefield/puppeteer-views';

export type { AgentVisualStatus } from '@vibefield/puppeteer-views';
export { classifyTerminalStatus } from '@vibefield/puppeteer-views';

/** The project a run shows as: its current directory, else its workspace, else the provider's label. */
export function projectLabel(info: AgentSessionInfo, currentCwd?: string): string {
  const path = currentCwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || '';
  return folderName(path, info.provider.label);
}
