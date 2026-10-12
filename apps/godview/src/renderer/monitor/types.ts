import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorState } from '@vibefield/puppeteer-core';
import type {
  MonitorAgent as ViewsMonitorAgent,
  MonitorAgentFacet as ViewsMonitorAgentFacet,
} from '@vibefield/puppeteer-views';
import type { AgentSessionInfo } from '../../protocol.js';

// The chrome's rows (M19) are the views package's chrome shape with two facts
// the app keeps beside it: a Ghosttea session (which is a `MonitorSession`
// already, with more) and the runtime identity behind an agent facet. The
// views read the model's `AgentView`; the chrome reads these.
export type { MonitorTheme, PaneAttachment } from '@vibefield/puppeteer-views';

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
