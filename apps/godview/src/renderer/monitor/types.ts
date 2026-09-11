import type { ComponentType } from 'react';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type {
  AgentMonitorViewDefinition,
  AgentMonitorViewProps as PortableAgentMonitorViewProps,
} from '@vibecook/puppeteer-react';
import type {
  AgentProviderDescriptor,
  AgentMonitorState,
  AgentMonitorTeamAggregate,
  MonitorContextState,
  MonitorRecency,
} from '@vibecook/puppeteer-core';
import type { AgentSessionInfo } from '../../protocol.js';
import type { AgentVisualStatus } from '../agent-status.js';
import type { PaneAttachment } from '../pane-attachments.js';
import type { MonitorPalette } from './monitor-palette.js';
import type { MonitorParameterGroup, MonitorParameters } from './parameters.js';

/** The agent half of a monitored session; absent while a terminal holds no agent. */
export interface MonitorAgentFacet {
  provider: AgentProviderDescriptor;
  model?: string;
  /** Label of the account this run is bound to; absent when it is not registered. */
  account?: string;
  branch?: string;
  contextWindow?: MonitorContextState;
  monitor: AgentMonitorState;
  teamAggregate?: AgentMonitorTeamAggregate;
  recency: MonitorRecency;
  /** The runtime identity and canonical monitor projection behind this view row. */
  info: AgentSessionInfo;
}

/**
 * One monitored session in the only shape a view ever sees.
 *
 * Agent-ness is a facet rather than a separate variant, so a view reads
 * `agent?.model` instead of re-deriving which kind of thing it is holding.
 */
export interface MonitorAgent {
  /** Stable when a terminal is promoted to an agent, so view-local placement survives it. */
  id: string;
  session: SessionSummary;
  status: AgentVisualStatus;
  project: string;
  detail: string;
  /** A §2.6 organizational accent, resolved from the live tokens by the slot
   * this session's id hashes to. It groups and labels; it never signals state. */
  color: string;
  /** Evidence recency is presentation metadata, never a fourth status. */
  stale?: boolean;
  /** Mounted in the pane the user is working in. */
  active: boolean;
  /** Colors of the panes showing this session; absent when it is mounted nowhere. */
  attachment?: PaneAttachment;
  cwd?: string;
  /** Where the user asked for it, for views that place new arrivals spatially. */
  spawnHint?: { x: number; y: number };
  /** Finished something while another pane was active (`monitor/unread.ts`). */
  unread?: boolean;
  agent?: MonitorAgentFacet;
}

export interface MonitorActions {
  /** Mount this session in the active pane. */
  select(agent: MonitorAgent): void;
  /** Open a terminal; spatial views pass where the gesture happened. */
  createAt(position?: { x: number; y: number }): void | Promise<void>;
}

export type AgentMonitorProps = PortableAgentMonitorViewProps<MonitorAgent, MonitorActions, MonitorParameters> & {
  /** The live tokens (`monitor-palette.ts`). Passed rather than read because two
   * of the three views paint into a canvas, which cannot inherit a custom
   * property — and a view that resolved its own would be a second reader of the
   * design system with its own idea of when to re-read it. */
  readonly palette: MonitorPalette;
};

/**
 * A way of looking at the running agents. Adding one is a file plus a line in
 * the registry — deliberately the same shape as adding a built-in provider in
 * `packages/builtin-providers`.
 *
 * A view is a pure function of these props. It never reaches the runtime, the
 * workspace, or a terminal, which is what keeps it structurally unable to break
 * the invariant that semantics never come from terminal text (DESIGN ADR-003).
 */
export interface AgentMonitorView extends Omit<
  AgentMonitorViewDefinition<MonitorAgent, MonitorActions, MonitorParameters>,
  'Component'
> {
  readonly parameterGroups: readonly MonitorParameterGroup[];
  /** Set when a view's defaults were re-decided: the tunables are stored under
   * the revision, so every installation lands on the new defaults instead of
   * keeping the values the old design had saved. Later tunes persist as before. */
  readonly parametersRevision?: string;
  /** The portable contract's component, plus the palette the shell resolves for it. */
  readonly Component: ComponentType<AgentMonitorProps>;
}
