import type { AgentView } from '@vibefield/puppeteer-view-sdk';
import { projectName } from '@vibefield/puppeteer-view-sdk/toolkit';

type MarkedRow = Pick<AgentView, 'kind' | 'project' | 'provider' | 'mark'>;

/** A row's name where a view prints its project's: the host's mark's name (`HostMark.name`), else the project's. */
export function rowName(row: MarkedRow): string {
  return row.mark?.name || projectName(row);
}

/** A row's name as a screen reader hears it: the host's spoken words (`HostMark.spoken`), else its printed name. */
export function rowSpoken(row: MarkedRow): string {
  return row.mark?.spoken || rowName(row);
}
