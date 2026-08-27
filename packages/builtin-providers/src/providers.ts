import { basename } from 'node:path';
import type { AgentProviderDescriptor } from '@vibecook/puppeteer-core';
import type { AgentProvider } from '@vibecook/puppeteer-runtime';
import { createAcpSession, type AcpConnector } from '@vibecook/puppeteer-adapter-acp';
import {
  createClaudeAccountUsageService,
  captureClaudeContinuationState,
  createClaudeSession,
  normalizeClaudeNativeInvocation,
  preflightClaudeLaunch,
  prepareClaudeTuiSession,
  restoreClaudeContinuationState,
  type ClaudeNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-claude';
import {
  createCodexAccountUsageService,
  captureCodexContinuationState,
  createCodexTuiSession,
  normalizeCodexNativeInvocation,
  prepareCodexTuiSession,
  restoreCodexContinuationState,
  type CodexNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-codex';
import {
  captureGrokContinuationState,
  createGrokAccountUsageService,
  createGrokBackend,
  normalizeGrokNativeInvocation,
  restoreGrokContinuationState,
  type GrokBackend,
  type GrokNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-grok';
import {
  captureKimiContinuationState,
  createKimiTuiSession,
  normalizeKimiNativeInvocation,
  prepareKimiTuiSession,
  restoreKimiContinuationState,
  type CreateKimiTuiSessionOptions,
  type KimiNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-kimi';
import {
  captureOpenCodeContinuationState,
  createOpenCodeTuiSession,
  normalizeOpenCodeNativeInvocation,
  prepareOpenCodeTuiSession,
  restoreOpenCodeContinuationState,
  type CreateOpenCodeTuiSessionOptions,
  type OpenCodeNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-opencode';
import {
  captureHermesContinuationState,
  createHermesTuiSession,
  normalizeHermesNativeInvocation,
  prepareHermesTuiSession,
  restoreHermesContinuationState,
  type CreateHermesTuiSessionOptions,
  type HermesNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-hermes';
import type {
  AcpAgentOptions,
  BuiltinAgentKind,
  BuiltinExecutableAgentKind,
  ClaudeAgentOptions,
  CodexAgentOptions,
  GrokAgentOptions,
  KimiAgentOptions,
  OpenCodeAgentOptions,
  HermesAgentOptions,
} from './types.js';

type ClaudeProviderOptions = ClaudeAgentOptions & ClaudeNativeInvocationOptions;
type CodexProviderOptions = CodexAgentOptions & CodexNativeInvocationOptions;
type GrokProviderOptions = GrokAgentOptions & GrokNativeInvocationOptions;
type KimiProviderOptions = KimiAgentOptions &
  KimiNativeInvocationOptions &
  Pick<CreateKimiTuiSessionOptions, 'pollIntervalMs' | 'maxReplayBytes'>;
type OpenCodeProviderOptions = OpenCodeAgentOptions &
  OpenCodeNativeInvocationOptions &
  Pick<CreateOpenCodeTuiSessionOptions, 'backendStartupTimeoutMs' | 'backendShutdownTimeoutMs' | 'reconnectDelayMs'>;
type HermesProviderOptions = HermesAgentOptions &
  HermesNativeInvocationOptions &
  Pick<CreateHermesTuiSessionOptions, 'executable' | 'python' | 'env' | 'gatewayUrl'>;

export interface BuiltinProviderOptions {
  executables?: Partial<Record<BuiltinExecutableAgentKind, string>>;
  /** Generic executable used only when an opaque continuation records an Imposter implementation. */
  imposterExecutable?: string;
  /** Default connector for generic ACP sessions; individual sessions may override it. */
  acpConnector?: AcpConnector;
}

const BUILTIN_PROVIDER_DESCRIPTORS = {
  claude: { id: 'claude', label: 'Claude' },
  codex: { id: 'codex', label: 'Codex' },
  acp: { id: 'acp', label: 'ACP' },
  grok: { id: 'grok', label: 'Grok' },
  kimi: { id: 'kimi', label: 'Kimi' },
  opencode: { id: 'opencode', label: 'OpenCode' },
  hermes: { id: 'hermes', label: 'Hermes' },
} as const satisfies Record<BuiltinAgentKind, AgentProviderDescriptor>;

/**
 * Construct the built-in providers. All CLI-specific recipes and shared service
 * lifetimes terminate here; callers only see AgentProvider/AgentRuntime.
 */
export function createBuiltinProviders(options: BuiltinProviderOptions = {}): AgentProvider[] {
  const { executables = {}, acpConnector } = options;
  const resolved = {
    claude: executables.claude ?? process.env.PUPPETEER_CLAUDE_BIN,
    codex: executables.codex ?? process.env.PUPPETEER_CODEX_BIN,
    grok: executables.grok ?? process.env.PUPPETEER_GROK_BIN,
    kimi: executables.kimi ?? process.env.PUPPETEER_KIMI_BIN,
    opencode: executables.opencode ?? process.env.PUPPETEER_OPENCODE_BIN,
    hermes: executables.hermes ?? process.env.PUPPETEER_HERMES_BIN,
  };
  const claudeLaunchFor = async (
    resume: string | undefined,
    title: string | undefined,
    launch: ClaudeProviderOptions | undefined,
  ): Promise<{ executable: string; providerVersion?: string }> => {
    const executable = launch?.executable ?? resolved.claude ?? 'claude';
    // The unified Imposter selects its vendor outside Claude's argv surface,
    // so probing an unselected `ai` entry point would fail before the owning
    // launcher can add that selection. Other custom paths still get probed.
    if (/^ai(?:\.(?:mjs|cjs|js|ts|exe))?$/i.test(basename(executable))) return { executable };
    const detection = await preflightClaudeLaunch({
      executable,
      freshSession: resume === undefined && launch?.resumeInvocation === undefined,
      resume: resume !== undefined,
      title: title !== undefined,
      model: launch?.model !== undefined,
      effort: launch?.effort !== undefined,
      settingSources: launch?.settingSources !== undefined,
    });
    return {
      executable: detection.executable,
      ...(detection.version ? { providerVersion: detection.version } : {}),
    };
  };
  const grokBackends = new Map<string, GrokBackend>();
  const grokBackendFor = (
    launch: GrokProviderOptions | undefined,
    host: Parameters<typeof createGrokBackend>[0]['host'],
  ) => {
    const executable = launch?.executable ?? resolved.grok;
    const appServerEnv = launch?.appServerEnv;
    const key = JSON.stringify([
      executable ?? null,
      Object.entries(appServerEnv ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    let backend = grokBackends.get(key);
    if (!backend) {
      backend = createGrokBackend({
        executable,
        host,
        ...(appServerEnv ? { appServerEnv } : {}),
      });
      grokBackends.set(key, backend);
    }
    return backend;
  };

  return [
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.claude,
      executionMode: 'native-tui',
      accountUsage: createClaudeAccountUsageService(),
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.claude,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'claude', executable: resolved.claude ?? 'claude' }],
            environmentVariables: ['CLAUDE_CONFIG_DIR'],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation: normalizeClaudeNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) =>
            captureClaudeContinuationState(agentOptions as ClaudeProviderOptions | undefined, cwd),
          restore: (state) => restoreClaudeContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      async createSession({ cwd, resume, title, host, agentOptions }) {
        const launch = agentOptions as ClaudeProviderOptions | undefined;
        const { executable, providerVersion } = await claudeLaunchFor(resume, title, launch);
        return createClaudeSession({
          cwd,
          resume,
          title,
          executable,
          env: launch?.env,
          providerVersion,
          permissionMode: launch?.permissionMode,
          model: launch?.model,
          effort: launch?.effort,
          settingSources: launch?.settingSources,
          configDir: launch?.configDir,
          fileChangeMatcher: launch?.fileChangeMatcher,
          resumeInvocation: launch?.resumeInvocation,
          onDiagnostic: launch?.onDiagnostic,
          observeSubagentStatus: true,
          ports: {
            spawn: (prepared) => host.spawnTerminal(prepared),
            automate: host.automateTerminal,
          },
        });
      },
      async prepareSession({ cwd, resume, title, host, agentOptions }) {
        const launch = agentOptions as ClaudeProviderOptions | undefined;
        const { executable, providerVersion } = await claudeLaunchFor(resume, title, launch);
        const prepared = await prepareClaudeTuiSession({
          cwd,
          resume,
          title,
          executable,
          env: launch?.env,
          providerVersion,
          permissionMode: launch?.permissionMode,
          model: launch?.model,
          effort: launch?.effort,
          settingSources: launch?.settingSources,
          configDir: launch?.configDir,
          fileChangeMatcher: launch?.fileChangeMatcher,
          resumeInvocation: launch?.resumeInvocation,
          onDiagnostic: launch?.onDiagnostic,
          observeSubagentStatus: true,
          automate: host.automateTerminal,
        });
        const { command, args, cwd: launchCwd, env } = prepared.launch;
        return {
          sessionId: prepared.sessionId,
          launch: { command, args, cwd: launchCwd, env },
          adopt: (runtimeSessionId) => prepared.adopt(runtimeSessionId),
          dispose: () => prepared.dispose(),
        };
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.codex,
      executionMode: 'native-tui',
      accountUsage: createCodexAccountUsageService({ executable: resolved.codex }),
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.codex,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'codex', executable: resolved.codex ?? 'codex' }],
            environmentVariables: ['CODEX_HOME'],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation: normalizeCodexNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) =>
            captureCodexContinuationState(agentOptions as CodexProviderOptions | undefined, cwd),
          restore: (state) => restoreCodexContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as CodexProviderOptions | undefined;
        return createCodexTuiSession({
          cwd,
          resume,
          executable: launch?.executable ?? resolved.codex,
          host,
          env: launch?.env,
          model: launch?.model,
          sandbox: launch?.sandbox,
          approvalPolicy: launch?.approvalPolicy,
          onApproval: launch?.onApproval,
          resumeInvocation: launch?.resumeInvocation,
          appServerEnv: launch?.appServerEnv,
        });
      },
      async prepareSession({ cwd, resume, host, agentOptions }) {
        const launch = agentOptions as CodexProviderOptions | undefined;
        return prepareCodexTuiSession({
          cwd,
          resume,
          executable: launch?.executable ?? resolved.codex,
          host,
          env: launch?.env,
          model: launch?.model,
          sandbox: launch?.sandbox,
          approvalPolicy: launch?.approvalPolicy,
          onApproval: launch?.onApproval,
          resumeInvocation: launch?.resumeInvocation,
          appServerEnv: launch?.appServerEnv,
        });
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.acp,
      executionMode: 'acp',
      launch: { provider: { ...BUILTIN_PROVIDER_DESCRIPTORS.acp, resume: true } },
      createSession: ({ cwd, resume, agentOptions }) => {
        const launch = agentOptions as AcpAgentOptions | undefined;
        const connector = launch?.connector ?? acpConnector;
        if (!connector) {
          throw new Error('ACP sessions require agentOptions.connector or BuiltinProviderOptions.acpConnector');
        }
        return createAcpSession({
          cwd,
          resume,
          connector,
          clientCapabilities: launch?.clientCapabilities,
          onApproval: launch?.onApproval,
          onElicitation: launch?.onElicitation,
        });
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.grok,
      executionMode: 'native-tui',
      accountUsage: createGrokAccountUsageService(),
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.grok,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'grok', executable: resolved.grok ?? 'grok' }],
            environmentVariables: ['GROK_HOME'],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation: normalizeGrokNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) =>
            captureGrokContinuationState(agentOptions as GrokProviderOptions | undefined, cwd),
          restore: (state) => restoreGrokContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as GrokProviderOptions | undefined;
        return grokBackendFor(launch, host).createSession({
          cwd,
          resume,
          model: launch?.model,
          permissionMode: launch?.permissionMode,
          sandbox: launch?.sandbox,
          resumeLatest: launch?.resumeLatest,
          clientCapabilities: launch?.clientCapabilities,
          onApproval: launch?.onApproval,
          onElicitation: launch?.onElicitation,
        });
      },
      prepareSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as GrokProviderOptions | undefined;
        return grokBackendFor(launch, host).prepareSession({
          cwd,
          resume,
          model: launch?.model,
          permissionMode: launch?.permissionMode,
          sandbox: launch?.sandbox,
          resumeLatest: launch?.resumeLatest,
          clientCapabilities: launch?.clientCapabilities,
          onApproval: launch?.onApproval,
          onElicitation: launch?.onElicitation,
        });
      },
      dispose() {
        for (const backend of grokBackends.values()) backend.dispose();
        grokBackends.clear();
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.kimi,
      executionMode: 'native-tui',
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.kimi,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'kimi', executable: resolved.kimi ?? 'kimi' }],
            environmentVariables: ['KIMI_CODE_HOME'],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation: normalizeKimiNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) => {
            const launch = agentOptions as KimiProviderOptions | undefined;
            return captureKimiContinuationState(launch, cwd);
          },
          restore: (state) => restoreKimiContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as KimiProviderOptions | undefined;
        return createKimiTuiSession({
          cwd,
          resume,
          host,
          executable: launch?.executable ?? resolved.kimi,
          env: launch?.env,
          kimiHome: launch?.kimiHome,
          model: launch?.model,
          permissionMode: launch?.permissionMode,
          plan: launch?.plan,
          agent: launch?.agent,
          agentFile: launch?.agentFile,
          pollIntervalMs: launch?.pollIntervalMs,
          maxReplayBytes: launch?.maxReplayBytes,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
        });
      },
      prepareSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as KimiProviderOptions | undefined;
        return prepareKimiTuiSession({
          cwd,
          resume,
          host,
          executable: launch?.executable ?? resolved.kimi,
          env: launch?.env,
          kimiHome: launch?.kimiHome,
          model: launch?.model,
          permissionMode: launch?.permissionMode,
          plan: launch?.plan,
          agent: launch?.agent,
          agentFile: launch?.agentFile,
          pollIntervalMs: launch?.pollIntervalMs,
          maxReplayBytes: launch?.maxReplayBytes,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
        });
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.opencode,
      executionMode: 'native-tui',
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.opencode,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'opencode', executable: resolved.opencode ?? 'opencode' }],
            environmentVariables: [],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation: normalizeOpenCodeNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) =>
            captureOpenCodeContinuationState(agentOptions as OpenCodeProviderOptions | undefined, cwd),
          restore: (state) =>
            restoreOpenCodeContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      createSession: ({ cwd, resume, title, host, agentOptions }) => {
        const launch = agentOptions as OpenCodeProviderOptions | undefined;
        return createOpenCodeTuiSession({
          cwd,
          resume,
          title,
          host,
          executable: launch?.executable ?? resolved.opencode,
          env: launch?.env,
          agent: launch?.agent,
          model: launch?.model,
          permission: launch?.permission,
          contextWindowCapacityTokens: launch?.contextWindowCapacityTokens,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
          backendStartupTimeoutMs: launch?.backendStartupTimeoutMs,
          backendShutdownTimeoutMs: launch?.backendShutdownTimeoutMs,
          reconnectDelayMs: launch?.reconnectDelayMs,
        });
      },
      prepareSession: ({ cwd, resume, title, host, agentOptions }) => {
        const launch = agentOptions as OpenCodeProviderOptions | undefined;
        return prepareOpenCodeTuiSession({
          cwd,
          resume,
          title,
          host,
          executable: launch?.executable ?? resolved.opencode,
          env: launch?.env,
          agent: launch?.agent,
          model: launch?.model,
          permission: launch?.permission,
          contextWindowCapacityTokens: launch?.contextWindowCapacityTokens,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
          backendStartupTimeoutMs: launch?.backendStartupTimeoutMs,
          backendShutdownTimeoutMs: launch?.backendShutdownTimeoutMs,
          reconnectDelayMs: launch?.reconnectDelayMs,
        });
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.hermes,
      executionMode: 'native-tui',
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.hermes,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'hermes', executable: resolved.hermes ?? 'hermes' }],
            environmentVariables: ['HERMES_HOME'],
          },
        },
        normalizeInvocation: normalizeHermesNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) => {
            const launch = agentOptions as HermesProviderOptions | undefined;
            return captureHermesContinuationState(launch?.hermesHome, launch?.env, cwd);
          },
          restore: restoreHermesContinuationState,
        },
      },
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as HermesProviderOptions | undefined;
        return createHermesTuiSession({
          cwd,
          resume,
          host,
          executable: launch?.executable ?? resolved.hermes,
          python: launch?.python,
          hermesHome: launch?.hermesHome,
          env: launch?.env,
          yolo: launch?.yolo,
          gatewayUrl: launch?.gatewayUrl,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
        });
      },
      prepareSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as HermesProviderOptions | undefined;
        return prepareHermesTuiSession({
          cwd,
          resume,
          host,
          executable: launch?.executable ?? resolved.hermes,
          python: launch?.python,
          hermesHome: launch?.hermesHome,
          env: launch?.env,
          yolo: launch?.yolo,
          gatewayUrl: launch?.gatewayUrl,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
        });
      },
    },
  ];
}
