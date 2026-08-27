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
import type { MonitorParameterGroup, MonitorParameters } from './parameters.js';

/** The agent half of a monitored session; absent while a terminal holds no agent. */
export interface MonitorAgentFacet {
  provider: AgentProviderDescriptor;
  model?: string;
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
  agent?: MonitorAgentFacet;
}

export interface MonitorActions {
  /** Mount this session in the active pane. */
  select(agent: MonitorAgent): void;
  /** Open a terminal; spatial views pass where the gesture happened. */
  createAt(position?: { x: number; y: number }): void | Promise<void>;
}

export type AgentMonitorProps = PortableAgentMonitorViewProps<MonitorAgent, MonitorActions, MonitorParameters>;

/**
 * A way of looking at the running agents. Adding one is a file plus a line in
 * the registry — deliberately the same shape as adding a built-in provider in
 * `packages/builtin-providers`.
 *
 * A view is a pure function of these props. It never reaches the runtime, the
 * workspace, or a terminal, which is what keeps it structurally unable to break
 * the invariant that semantics never come from terminal text (DESIGN ADR-003).
 */
export interface AgentMonitorView extends AgentMonitorViewDefinition<MonitorAgent, MonitorActions, MonitorParameters> {
  readonly parameterGroups: readonly MonitorParameterGroup[];
}
