import type { CreateAcpSessionOptions } from '@vibecook/puppeteer-adapter-acp';
import type { AgentAdapterSession, AgentHost, TerminalSpec } from '@vibecook/puppeteer-core';

export interface CreateGrokBackendOptions {
  /** Grok executable (default `grok`). */
  executable?: string;
  /** The host terminal capability the TUI is spawned through. */
  host: AgentHost;
  /** Extra environment shared by leader, ACP controller, TUI, and log observer. */
  appServerEnv?: Record<string, string>;
}

export interface GrokBackend {
  createSession(options: CreateGrokSessionOptions): Promise<AgentAdapterSession>;
  prepareSession(options: CreateGrokSessionOptions): Promise<PreparedGrokSession>;
  dispose(): void;
}

export interface CreateGrokSessionOptions {
  cwd: string;
  resume?: string;
  resumeLatest?: boolean;
  model?: string;
  permissionMode?: string;
  sandbox?: string;
  clientCapabilities?: CreateAcpSessionOptions['clientCapabilities'];
  onApproval?: CreateAcpSessionOptions['onApproval'];
  onElicitation?: CreateAcpSessionOptions['onElicitation'];
}

export interface PreparedGrokSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<AgentAdapterSession>;
  dispose(): Promise<void>;
}
