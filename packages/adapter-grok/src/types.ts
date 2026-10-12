import type { CreateAcpSessionOptions } from '@vibefield/puppeteer-adapter-acp';
import type { AgentAdapterBinding, AgentHost, TerminalSpec } from '@vibefield/puppeteer-core';

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
  dispose(): void;
}

export interface CreateGrokSessionOptions {
  cwd: string;
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
  adopt(runtimeSessionId: string): Promise<AgentAdapterBinding>;
  dispose(): Promise<void>;
}
