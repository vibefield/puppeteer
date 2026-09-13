import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState } from '@vibecook/puppeteer-core';
import type {
  MonitorAgent as ViewsMonitorAgent,
  MonitorAgentFacet as ViewsMonitorAgentFacet,
} from '@vibecook/puppeteer-views';
import type { AgentSessionInfo } from '../../protocol.js';

// Godview's rows are the views package's rows with two facts the app keeps
// beside them: a Ghosttea session (which is a `MonitorSession` already, with
// more) and the runtime identity behind an agent facet. Views see the package
// type; the app reads the extension through these.
export type {
  AgentMonitorProps,
  AgentMonitorView,
  MonitorActions,
  MonitorTheme,
  PaneAttachment,
} from '@vibecook/puppeteer-views';

export interface MonitorAgentFacet extends ViewsMonitorAgentFacet {
  /** Always present here: a row is assembled only once its first state arrived. */
  monitor: AgentMonitorState;
  /** The runtime identity and canonical monitor projection behind this view row. */
  info: AgentSessionInfo;
}

export interface MonitorAgent extends Omit<ViewsMonitorAgent, 'session' | 'agent'> {
  session: SessionSummary;
  agent?: MonitorAgentFacet | undefined;
}
