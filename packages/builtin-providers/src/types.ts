import type { CreateAcpSessionOptions } from '@vibecook/puppeteer-adapter-acp';
import type { ClaudeHookDiagnostic, ClaudeSettingSource } from '@vibecook/puppeteer-adapter-claude';
import type { CreateCodexTuiSessionOptions } from '@vibecook/puppeteer-adapter-codex';
import type { CreateGrokSessionOptions } from '@vibecook/puppeteer-adapter-grok';
import type { CreateHermesTuiSessionOptions } from '@vibecook/puppeteer-adapter-hermes';
import type { CreateKimiTuiSessionOptions } from '@vibecook/puppeteer-adapter-kimi';
import type { CreateOpenCodeTuiSessionOptions } from '@vibecook/puppeteer-adapter-opencode';
import type {
  AgentRuntime,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PrepareAgentSessionResult,
  SpawnAgentResult,
} from '@vibecook/puppeteer-runtime';

/** Provider ids bundled by the optional turn-key composition package. */
export type BuiltinAgentKind = 'claude' | 'codex' | 'acp' | 'grok' | 'kimi' | 'opencode' | 'hermes';
export type BuiltinExecutableAgentKind = Exclude<BuiltinAgentKind, 'acp'>;

export interface ClaudeAgentOptions {
  permissionMode?: string;
  model?: string;
  effort?: string;
  settingSources?: readonly ClaudeSettingSource[];
  configDir?: string;
  fileChangeMatcher?: string;
  onDiagnostic?: (diagnostic: ClaudeHookDiagnostic) => void;
  resumeInvocation?: string[];
  /** Per-session binary override, including a native-compatible Imposter executable. */
  executable?: string;
}

export type CodexAgentOptions = Pick<
  CreateCodexTuiSessionOptions,
  'model' | 'sandbox' | 'approvalPolicy' | 'onApproval' | 'resumeInvocation' | 'executable' | 'appServerEnv'
>;

export type AcpAgentOptions = Omit<CreateAcpSessionOptions, 'cwd' | 'resume' | 'connector'> & {
  connector?: CreateAcpSessionOptions['connector'];
};

export type GrokAgentOptions = Omit<CreateGrokSessionOptions, 'cwd' | 'resume'> & {
  executable?: string;
  appServerEnv?: Record<string, string>;
};

export type KimiAgentOptions = Omit<CreateKimiTuiSessionOptions, 'cwd' | 'resume' | 'host'>;
export type OpenCodeAgentOptions = Omit<CreateOpenCodeTuiSessionOptions, 'cwd' | 'resume' | 'title' | 'host'>;
export type HermesAgentOptions = Omit<CreateHermesTuiSessionOptions, 'cwd' | 'resume' | 'host' | 'transport'>;

type BuiltinCreateBase = Omit<CreateAgentSessionOptions, 'agent' | 'agentOptions'>;

export type BuiltinCreateAgentSessionOptions =
  | (BuiltinCreateBase & { agent: 'claude'; agentOptions?: ClaudeAgentOptions })
  | (BuiltinCreateBase & { agent: 'codex'; agentOptions?: CodexAgentOptions })
  | (BuiltinCreateBase & { agent: 'acp'; agentOptions?: AcpAgentOptions })
  | (BuiltinCreateBase & { agent: 'grok'; agentOptions?: GrokAgentOptions })
  | (BuiltinCreateBase & { agent: 'kimi'; agentOptions?: KimiAgentOptions })
  | (BuiltinCreateBase & { agent: 'opencode'; agentOptions?: OpenCodeAgentOptions })
  | (BuiltinCreateBase & { agent: 'hermes'; agentOptions?: HermesAgentOptions });

/** Runtime facade whose provider discriminator narrows its native launch options. */
export type BuiltinAgentRuntime = Omit<AgentRuntime, 'spawn' | 'createSession' | 'prepareSession'> & {
  spawn(options: BuiltinCreateAgentSessionOptions): Promise<SpawnAgentResult>;
  createSession(options: BuiltinCreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  prepareSession(options: BuiltinCreateAgentSessionOptions): Promise<PrepareAgentSessionResult>;
};
