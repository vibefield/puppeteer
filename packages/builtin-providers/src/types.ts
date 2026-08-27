import type { CreateAcpSessionOptions } from '@vibecook/puppeteer-adapter-acp';
import type { ClaudeHookDiagnostic, ClaudeSettingSource } from '@vibecook/puppeteer-adapter-claude';
import type { CreateCodexTuiSessionOptions } from '@vibecook/puppeteer-adapter-codex';
import type { CreateGrokSessionOptions } from '@vibecook/puppeteer-adapter-grok';
import type { CreateHermesTuiSessionOptions } from '@vibecook/puppeteer-adapter-hermes';
import type { CreateKimiTuiSessionOptions } from '@vibecook/puppeteer-adapter-kimi';
import type { CreateOpenCodeTuiSessionOptions } from '@vibecook/puppeteer-adapter-opencode';
import type {
  AgentRuntime,
  CreateAgentSessionResult,
  PrepareAgentSessionResult,
  SpawnAgentOptions,
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
  fileChangeMatcher?: string;
  onDiagnostic?: (diagnostic: ClaudeHookDiagnostic) => void;
}

export type CodexAgentOptions = Pick<
  CreateCodexTuiSessionOptions,
  'model' | 'sandbox' | 'approvalPolicy' | 'onApproval'
>;

export type AcpAgentOptions = Omit<CreateAcpSessionOptions, 'cwd' | 'resume' | 'connector'> & {
  connector?: CreateAcpSessionOptions['connector'];
};

export type GrokAgentOptions = Pick<
  CreateGrokSessionOptions,
  'model' | 'permissionMode' | 'sandbox' | 'clientCapabilities' | 'onApproval' | 'onElicitation'
>;

export type KimiAgentOptions = Pick<
  CreateKimiTuiSessionOptions,
  'model' | 'permissionMode' | 'plan' | 'agent' | 'agentFile' | 'promptConfirmationTimeoutMs'
>;
export type OpenCodeAgentOptions = Pick<
  CreateOpenCodeTuiSessionOptions,
  'agent' | 'model' | 'permission' | 'contextWindowCapacityTokens' | 'promptConfirmationTimeoutMs'
>;
export type HermesAgentOptions = Pick<CreateHermesTuiSessionOptions, 'yolo' | 'promptConfirmationTimeoutMs'>;

type BuiltinCreateBase = Omit<SpawnAgentOptions, 'agent' | 'agentOptions'>;

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
