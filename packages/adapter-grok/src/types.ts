import type { CreateAcpSessionOptions } from '@vibefield/puppeteer-adapter-acp';
import type {
  AgentAdapterBinding,
  AgentHost,
  AgentBriefingRefusalPolicy,
  AgentBriefingWithheld,
  AgentRunBriefing,
  HostIngress,
  TerminalSpec,
} from '@vibefield/puppeteer-core';

export interface CreateGrokBackendOptions {
  /** Grok executable (default `grok`). */
  executable?: string | undefined;
  /** The host terminal capability the TUI is spawned through. */
  host: AgentHost;
  /** Extra environment shared by leader, ACP controller, TUI, and log observer. */
  appServerEnv?: Record<string, string> | undefined;
}

export interface GrokBackend {
  createSession(options: CreateGrokSessionOptions): Promise<AgentAdapterBinding>;
  prepareSession(options: CreateGrokSessionOptions): Promise<PreparedGrokSession>;
  /** Resolves once the shared leader and every run's leader have exited and adapter-owned state is removed. */
  dispose(): Promise<void>;
}

export interface CreateGrokSessionOptions extends AgentRunBriefing {
  cwd: string;
  /** The host's ear for a briefed run's own leader (`onHelperProcess`). A shared leader is named to nobody. */
  ingress?: HostIngress | undefined;
  /** What to do with a briefing field this launch cannot honour. Absent = refuse. */
  briefingRefusal?: AgentBriefingRefusalPolicy | undefined;
  resume?: string | undefined;
  resumeLatest?: boolean | undefined;
  model?: string | undefined;
  permissionMode?: string | undefined;
  sandbox?: string | undefined;
  clientCapabilities?: CreateAcpSessionOptions['clientCapabilities'] | undefined;
  onApproval?: CreateAcpSessionOptions['onApproval'] | undefined;
  onElicitation?: CreateAcpSessionOptions['onElicitation'] | undefined;
}

export interface PreparedGrokSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  /** What of the briefing this launch goes ahead without, under `briefingRefusal: 'withhold'`. */
  readonly briefingWithheld?: readonly AgentBriefingWithheld[] | undefined;
  adopt(runtimeSessionId: string): Promise<AgentAdapterBinding>;
  dispose(): Promise<void>;
}
