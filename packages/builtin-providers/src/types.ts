import type { CreateAcpSessionOptions } from '@vibefield/puppeteer-adapter-acp';
import type { CreateAntigravityTuiSessionOptions } from '@vibefield/puppeteer-adapter-antigravity';
import type { ClaudeHookDiagnostic, ClaudeSettingSource } from '@vibefield/puppeteer-adapter-claude';
import type { CreateCodexTuiSessionOptions } from '@vibefield/puppeteer-adapter-codex';
import type { CreateCopilotTuiSessionOptions } from '@vibefield/puppeteer-adapter-copilot';
import type { CreateGrokSessionOptions } from '@vibefield/puppeteer-adapter-grok';
import type { CreateHermesTuiSessionOptions } from '@vibefield/puppeteer-adapter-hermes';
import type { CreateKimiTuiSessionOptions } from '@vibefield/puppeteer-adapter-kimi';
import type { CreateOpenCodeTuiSessionOptions } from '@vibefield/puppeteer-adapter-opencode';
import type { CreatePiTuiSessionOptions } from '@vibefield/puppeteer-adapter-pi';
import type {
  AgentRuntime,
  CreateAgentSessionResult,
  PrepareAgentSessionResult,
  SpawnAgentOptions,
  SpawnAgentResult,
} from '@vibefield/puppeteer-runtime';

/** Provider ids bundled by the optional turn-key composition package. */
export type BuiltinAgentKind =
  'claude' | 'codex' | 'acp' | 'grok' | 'kimi' | 'opencode' | 'hermes' | 'antigravity' | 'copilot' | 'pi';
export type BuiltinExecutableAgentKind = Exclude<BuiltinAgentKind, 'acp'>;

export interface ClaudeAgentOptions {
  permissionMode?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  settingSources?: readonly ClaudeSettingSource[] | undefined;
  fileChangeMatcher?: string | undefined;
  onDiagnostic?: ((diagnostic: ClaudeHookDiagnostic) => void) | undefined;
}

export type CodexAgentOptions = Pick<
  CreateCodexTuiSessionOptions,
  'model' | 'effort' | 'sandbox' | 'approvalPolicy' | 'onApproval'
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
export type HermesAgentOptions = Pick<
  CreateHermesTuiSessionOptions,
  'model' | 'provider' | 'effort' | 'yolo' | 'promptConfirmationTimeoutMs'
>;
export type AntigravityAgentOptions = Pick<
  CreateAntigravityTuiSessionOptions,
  | 'model'
  | 'effort'
  | 'mode'
  | 'skipPermissions'
  | 'sandbox'
  | 'agent'
  | 'project'
  | 'addDirs'
  | 'pollIntervalMs'
  | 'maxReplayBytes'
  | 'promptConfirmationTimeoutMs'
>;
export type CopilotAgentOptions = Pick<
  CreateCopilotTuiSessionOptions,
  | 'model'
  | 'effort'
  | 'mode'
  | 'allowAll'
  | 'agent'
  | 'context'
  | 'pollIntervalMs'
  | 'maxReplayBytes'
  | 'promptConfirmationTimeoutMs'
>;
export type PiAgentOptions = Pick<
  CreatePiTuiSessionOptions,
  'provider' | 'model' | 'thinking' | 'name' | 'pollIntervalMs' | 'maxReplayBytes'
>;

type BuiltinCreateBase = Omit<SpawnAgentOptions, 'agent' | 'agentOptions'>;

export type BuiltinCreateAgentSessionOptions =
  | (BuiltinCreateBase & { agent: 'claude'; agentOptions?: ClaudeAgentOptions })
  | (BuiltinCreateBase & { agent: 'codex'; agentOptions?: CodexAgentOptions })
  | (BuiltinCreateBase & { agent: 'acp'; agentOptions?: AcpAgentOptions })
  | (BuiltinCreateBase & { agent: 'grok'; agentOptions?: GrokAgentOptions })
  | (BuiltinCreateBase & { agent: 'kimi'; agentOptions?: KimiAgentOptions })
  | (BuiltinCreateBase & { agent: 'opencode'; agentOptions?: OpenCodeAgentOptions })
  | (BuiltinCreateBase & { agent: 'hermes'; agentOptions?: HermesAgentOptions })
  | (BuiltinCreateBase & { agent: 'antigravity'; agentOptions?: AntigravityAgentOptions })
  | (BuiltinCreateBase & { agent: 'copilot'; agentOptions?: CopilotAgentOptions })
  | (BuiltinCreateBase & { agent: 'pi'; agentOptions?: PiAgentOptions });

/** Runtime facade whose provider discriminator narrows its native launch options. */
export type BuiltinAgentRuntime = Omit<AgentRuntime, 'spawn' | 'createSession' | 'prepareSession'> & {
  spawn(options: BuiltinCreateAgentSessionOptions): Promise<SpawnAgentResult>;
  createSession(options: BuiltinCreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  prepareSession(options: BuiltinCreateAgentSessionOptions): Promise<PrepareAgentSessionResult>;
};
