import { basename } from 'node:path';
import type { AgentProvider } from '@vibecook/puppeteer-runtime';
import { createAcpSession, type AcpConnector } from '@vibecook/puppeteer-adapter-acp';
import {
  createClaudeAccountUsageService,
  createClaudeSession,
  preflightClaudeLaunch,
  prepareClaudeTuiSession,
  type ClaudeHookRailFaultInjection,
} from '@vibecook/puppeteer-adapter-claude';
import {
  createCodexAccountUsageService,
  createCodexTuiSession,
  prepareCodexTuiSession,
} from '@vibecook/puppeteer-adapter-codex';
import { createGrokAccountUsageService, createGrokBackend, type GrokBackend } from '@vibecook/puppeteer-adapter-grok';
import { createKimiTuiSession, prepareKimiTuiSession } from '@vibecook/puppeteer-adapter-kimi';
import { createOpenCodeTuiSession, prepareOpenCodeTuiSession } from '@vibecook/puppeteer-adapter-opencode';
import { createHermesTuiSession, prepareHermesTuiSession } from '@vibecook/puppeteer-adapter-hermes';
import type {
  AcpAgentOptions,
  BuiltinExecutableAgentKind,
  ClaudeAgentOptions,
  CodexAgentOptions,
  GrokAgentOptions,
  KimiAgentOptions,
  OpenCodeAgentOptions,
  HermesAgentOptions,
} from './types.js';

export interface BuiltinProviderOptions {
  executables?: Partial<Record<BuiltinExecutableAgentKind, string>>;
  /** Default connector for generic ACP sessions; individual sessions may override it. */
  acpConnector?: AcpConnector;
  /** Native-canary-only hook rail fault; normal product sessions leave this unset. */
  claudeHookRailFaultInjection?: ClaudeHookRailFaultInjection;
}

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
    launch: ClaudeAgentOptions | undefined,
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
    launch: GrokAgentOptions | undefined,
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
      kind: 'claude',
      executionMode: 'native-tui',
      accountUsage: createClaudeAccountUsageService(),
      async createSession({ cwd, resume, title, host, agentOptions }) {
        const launch = agentOptions as ClaudeAgentOptions | undefined;
        const { executable, providerVersion } = await claudeLaunchFor(resume, title, launch);
        return createClaudeSession({
          cwd,
          resume,
          title,
          executable,
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
          hookRailFaultInjection: options.claudeHookRailFaultInjection,
          ports: {
            spawn: (prepared) => host.spawnTerminal(prepared),
            automate: host.automateTerminal,
          },
        });
      },
      async prepareSession({ cwd, resume, title, host, agentOptions }) {
        const launch = agentOptions as ClaudeAgentOptions | undefined;
        const { executable, providerVersion } = await claudeLaunchFor(resume, title, launch);
        const prepared = await prepareClaudeTuiSession({
          cwd,
          resume,
          title,
          executable,
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
          hookRailFaultInjection: options.claudeHookRailFaultInjection,
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
      kind: 'codex',
      executionMode: 'native-tui',
      accountUsage: createCodexAccountUsageService({ executable: resolved.codex }),
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as CodexAgentOptions | undefined;
        return createCodexTuiSession({
          cwd,
          resume,
          executable: launch?.executable ?? resolved.codex,
          host,
          model: launch?.model,
          sandbox: launch?.sandbox,
          approvalPolicy: launch?.approvalPolicy,
          onApproval: launch?.onApproval,
          resumeInvocation: launch?.resumeInvocation,
          appServerEnv: launch?.appServerEnv,
        });
      },
      async prepareSession({ cwd, resume, host, agentOptions }) {
        const launch = agentOptions as CodexAgentOptions | undefined;
        return prepareCodexTuiSession({
          cwd,
          resume,
          executable: launch?.executable ?? resolved.codex,
          host,
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
      kind: 'acp',
      executionMode: 'acp',
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
      kind: 'grok',
      executionMode: 'native-tui',
      accountUsage: createGrokAccountUsageService(),
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as GrokAgentOptions | undefined;
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
        const launch = agentOptions as GrokAgentOptions | undefined;
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
      kind: 'kimi',
      executionMode: 'native-tui',
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as KimiAgentOptions | undefined;
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
        const launch = agentOptions as KimiAgentOptions | undefined;
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
      kind: 'opencode',
      executionMode: 'native-tui',
      createSession: ({ cwd, resume, title, host, agentOptions }) => {
        const launch = agentOptions as OpenCodeAgentOptions | undefined;
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
        const launch = agentOptions as OpenCodeAgentOptions | undefined;
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
      kind: 'hermes',
      executionMode: 'native-tui',
      createSession: ({ cwd, resume, host, agentOptions }) => {
        const launch = agentOptions as HermesAgentOptions | undefined;
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
        const launch = agentOptions as HermesAgentOptions | undefined;
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
