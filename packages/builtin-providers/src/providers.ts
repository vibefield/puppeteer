import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type {
  AgentNativeInvocation,
  AgentNativeInvocationResolution,
  AgentProfile,
  AgentProviderDescriptor,
  ProfileService,
} from '@vibecook/puppeteer-core';
import type { AgentProvider } from '@vibecook/puppeteer-runtime';
import { createAcpSession, type AcpConnector } from '@vibecook/puppeteer-adapter-acp';
import {
  captureAntigravityContinuationState,
  createAntigravityAccountUsageService,
  createAntigravityDistributionService,
  createAntigravityExtensionService,
  createAntigravityProfileService,
  createAntigravityTuiSession,
  normalizeAntigravityNativeInvocation,
  prepareAntigravityTuiSession,
  restoreAntigravityContinuationState,
  type AntigravityNativeInvocationOptions,
  type CreateAntigravityTuiSessionOptions,
} from '@vibecook/puppeteer-adapter-antigravity';
import {
  createClaudeAccountUsageService,
  createClaudeDistributionService,
  createClaudeExtensionService,
  createClaudeProfileService,
  captureClaudeContinuationState,
  attachClaudeTuiSession,
  createClaudeSession,
  normalizeClaudeNativeInvocation,
  preflightClaudeLaunch,
  prepareClaudeTuiSession,
  restoreClaudeContinuationState,
  type ClaudeNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-claude';
import {
  createCodexAccountUsageService,
  createCodexDistributionService,
  createCodexExtensionService,
  createCodexProfileService,
  captureCodexContinuationState,
  createCodexTuiSession,
  normalizeCodexNativeInvocation,
  prepareCodexTuiSession,
  prewarmCodex,
  restoreCodexContinuationState,
  type CodexNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-codex';
import {
  captureCopilotContinuationState,
  createCopilotDistributionService,
  createCopilotProfileService,
  createCopilotTuiSession,
  normalizeCopilotNativeInvocation,
  prepareCopilotTuiSession,
  restoreCopilotContinuationState,
  type CopilotNativeInvocationOptions,
  type CreateCopilotTuiSessionOptions,
} from '@vibecook/puppeteer-adapter-copilot';
import {
  captureGrokContinuationState,
  createGrokDistributionService,
  createGrokExtensionService,
  createGrokProfileService,
  createGrokAccountUsageService,
  createGrokBackend,
  normalizeGrokNativeInvocation,
  restoreGrokContinuationState,
  type GrokBackend,
  type GrokNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-grok';
import {
  captureKimiContinuationState,
  createKimiAccountUsageService,
  createKimiDistributionService,
  createKimiExtensionService,
  createKimiProfileService,
  createKimiTuiSession,
  normalizeKimiNativeInvocation,
  prepareKimiTuiSession,
  restoreKimiContinuationState,
  type CreateKimiTuiSessionOptions,
  type KimiNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-kimi';
import {
  captureOpenCodeContinuationState,
  createOpenCodeDistributionService,
  createOpenCodeExtensionService,
  createOpenCodeProfileService,
  createOpenCodeTuiSession,
  normalizeOpenCodeNativeInvocation,
  prepareOpenCodeTuiSession,
  restoreOpenCodeContinuationState,
  type CreateOpenCodeTuiSessionOptions,
  type OpenCodeNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-opencode';
import {
  captureHermesContinuationState,
  createHermesDistributionService,
  createHermesExtensionService,
  createHermesProfileService,
  createHermesTuiSession,
  normalizeHermesNativeInvocation,
  prepareHermesTuiSession,
  restoreHermesContinuationState,
  type CreateHermesTuiSessionOptions,
  type HermesNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-hermes';
import {
  capturePiContinuationState,
  createPiDistributionService,
  createPiExtensionService,
  createPiProfileService,
  createPiTuiSession,
  normalizePiNativeInvocation,
  preparePiTuiSession,
  restorePiContinuationState,
  type CreatePiTuiSessionOptions,
  type PiNativeInvocationOptions,
} from '@vibecook/puppeteer-adapter-pi';
import type {
  AcpAgentOptions,
  AntigravityAgentOptions,
  BuiltinAgentKind,
  BuiltinExecutableAgentKind,
  ClaudeAgentOptions,
  CodexAgentOptions,
  CopilotAgentOptions,
  GrokAgentOptions,
  KimiAgentOptions,
  OpenCodeAgentOptions,
  PiAgentOptions,
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
type AntigravityProviderOptions = AntigravityAgentOptions &
  AntigravityNativeInvocationOptions &
  Pick<CreateAntigravityTuiSessionOptions, 'pollIntervalMs' | 'maxReplayBytes' | 'promptConfirmationTimeoutMs'>;
type CopilotProviderOptions = CopilotAgentOptions &
  CopilotNativeInvocationOptions &
  Pick<CreateCopilotTuiSessionOptions, 'pollIntervalMs' | 'maxReplayBytes' | 'promptConfirmationTimeoutMs'>;
type PiProviderOptions = PiAgentOptions &
  PiNativeInvocationOptions &
  Pick<CreatePiTuiSessionOptions, 'pollIntervalMs' | 'maxReplayBytes'>;

export interface BuiltinProviderOptions {
  executables?: Partial<Record<BuiltinExecutableAgentKind, string>> | undefined;
  /** Generic executable used only when an opaque continuation records an Imposter implementation. */
  imposterExecutable?: string | undefined;
  /** Default connector for generic ACP sessions; individual sessions may override it. */
  acpConnector?: AcpConnector | undefined;
  /**
   * The home directory native-default roots hang off, for the services that
   * read them (profiles and extensions); the process home when absent. A host's
   * tests pass a temporary one, so no inventory of the native set reads the
   * real home.
   */
  home?: string | undefined;
}

const BUILTIN_PROVIDER_DESCRIPTORS = {
  claude: { id: 'claude', label: 'Claude' },
  codex: { id: 'codex', label: 'Codex' },
  acp: { id: 'acp', label: 'ACP' },
  grok: { id: 'grok', label: 'Grok' },
  kimi: { id: 'kimi', label: 'Kimi' },
  opencode: { id: 'opencode', label: 'OpenCode' },
  hermes: { id: 'hermes', label: 'Hermes' },
  antigravity: { id: 'antigravity', label: 'Antigravity' },
  copilot: { id: 'copilot', label: 'GitHub Copilot' },
  pi: { id: 'pi', label: 'Pi' },
} as const satisfies Record<BuiltinAgentKind, AgentProviderDescriptor>;

/**
 * A selected profile binds exactly like a shell-forwarded launch: the adapter's
 * own native-invocation normalizer turns the binding variables into native
 * options, so this composition root never learns which variable a provider
 * uses or how it maps to a launch option.
 */
function withProfileBinding<
  Options extends { env?: Record<string, string> | undefined; appServerEnv?: Record<string, string> | undefined },
  Bound extends Partial<Options>,
>(
  providerId: string,
  cwd: string,
  profile: AgentProfile | undefined,
  profiles: ProfileService,
  normalize: (invocation: AgentNativeInvocation) => AgentNativeInvocationResolution<Bound>,
  launch: Options | undefined,
): Options | undefined {
  if (!profile) return launch;
  const environment = profiles.bindingEnvironment(profile);
  if (Object.keys(environment).length === 0) return launch;
  const resolution = normalize({ providerId, cwd, argv: [], environment, implementation: { kind: 'native' } });
  if (resolution.status === 'passthrough') {
    // An empty argv is the bare session. A normalizer that calls it anything else is wrong about its own CLI.
    throw new Error(
      `profile ${profile.id} cannot bind ${providerId}: the adapter's normalizer calls an empty argv a ${resolution.kind} passthrough (${resolution.reason}), which is an adapter bug`,
    );
  }
  if (resolution.status !== 'accepted') {
    throw new Error(`profile ${profile.id} cannot bind ${providerId}: ${resolution.reason}`);
  }
  const bound: Partial<Options> = resolution.options ?? {};
  return {
    ...launch,
    ...bound,
    ...(launch?.env || bound.env ? { env: { ...launch?.env, ...bound.env } } : {}),
    ...(launch?.appServerEnv || bound.appServerEnv
      ? { appServerEnv: { ...launch?.appServerEnv, ...bound.appServerEnv } }
      : {}),
  } as Options;
}

/**
 * A host's launch values (RFC 006 C2: the keys of MCP servers the agent's
 * settings name as variables) beneath a launch's own variables, in each
 * environment the provider starts a process with for the run: the terminal's,
 * or the helper's that runs the agent's MCP servers (Codex's app-server,
 * Grok's leader). The profile binding and the adapter's own variables win.
 * Only a created session takes them: a prepared recipe goes back to its
 * caller, and an attach starts nothing.
 */
function withLaunchEnvironment<
  Options extends { env?: Record<string, string> | undefined; appServerEnv?: Record<string, string> | undefined },
>(
  launch: Options | undefined,
  environment: Readonly<Record<string, string>> | undefined,
  into: ReadonlyArray<'env' | 'appServerEnv'>,
): Options | undefined {
  if (environment === undefined || Object.keys(environment).length === 0) return launch;
  const next: Options = { ...launch } as Options;
  for (const key of into) next[key] = { ...environment, ...launch?.[key] } as Options[typeof key];
  return next;
}

/**
 * Construct the built-in providers. All CLI-specific recipes and shared service
 * lifetimes terminate here; callers only see AgentProvider/AgentRuntime.
 */
export function createBuiltinProviders(options: BuiltinProviderOptions = {}): AgentProvider[] {
  const { executables = {}, acpConnector } = options;
  const homeOption = options.home === undefined ? {} : { home: options.home };
  const resolved = {
    claude: executables.claude ?? process.env.PUPPETEER_CLAUDE_BIN,
    codex: executables.codex ?? process.env.PUPPETEER_CODEX_BIN,
    grok: executables.grok ?? process.env.PUPPETEER_GROK_BIN,
    kimi: executables.kimi ?? process.env.PUPPETEER_KIMI_BIN,
    opencode: executables.opencode ?? process.env.PUPPETEER_OPENCODE_BIN,
    hermes: executables.hermes ?? process.env.PUPPETEER_HERMES_BIN,
    antigravity: executables.antigravity ?? process.env.PUPPETEER_ANTIGRAVITY_BIN,
    copilot: executables.copilot ?? process.env.PUPPETEER_COPILOT_BIN,
    pi: executables.pi ?? process.env.PUPPETEER_PI_BIN,
  };
  const chosen = (executable: string | undefined): { executable?: string } =>
    executable === undefined ? {} : { executable };
  // Provider-scoped capabilities live for the composition's lifetime, like account usage.
  // Profile services get the same executable the launch uses: a login, an identity
  // read or a sign-out must reach the install the host chose, not whatever PATH holds.
  const services = {
    claude: {
      distribution: createClaudeDistributionService({ executable: resolved.claude }),
      profiles: createClaudeProfileService({ ...chosen(resolved.claude), ...homeOption }),
      extensions: createClaudeExtensionService({ ...chosen(resolved.claude), ...homeOption }),
    },
    codex: {
      distribution: createCodexDistributionService({ executable: resolved.codex }),
      profiles: createCodexProfileService({ ...chosen(resolved.codex), ...homeOption }),
      extensions: createCodexExtensionService({ ...chosen(resolved.codex), ...homeOption }),
    },
    grok: {
      distribution: createGrokDistributionService({ executable: resolved.grok }),
      profiles: createGrokProfileService({ ...chosen(resolved.grok), ...homeOption }),
      extensions: createGrokExtensionService({ ...chosen(resolved.grok), ...homeOption }),
    },
    kimi: {
      distribution: createKimiDistributionService({ executable: resolved.kimi }),
      profiles: createKimiProfileService({ ...chosen(resolved.kimi), ...homeOption }),
      extensions: createKimiExtensionService(homeOption),
    },
    opencode: {
      distribution: createOpenCodeDistributionService({ executable: resolved.opencode }),
      profiles: createOpenCodeProfileService({ ...chosen(resolved.opencode), ...homeOption }),
      extensions: createOpenCodeExtensionService({ ...chosen(resolved.opencode), ...homeOption }),
    },
    hermes: {
      distribution: createHermesDistributionService({ executable: resolved.hermes }),
      profiles: createHermesProfileService({ ...chosen(resolved.hermes), ...homeOption }),
      extensions: createHermesExtensionService({ ...chosen(resolved.hermes), ...homeOption }),
    },
    antigravity: {
      distribution: createAntigravityDistributionService({ executable: resolved.antigravity }),
      profiles: createAntigravityProfileService({ ...chosen(resolved.antigravity), ...homeOption }),
      extensions: createAntigravityExtensionService({ ...chosen(resolved.antigravity), ...homeOption }),
    },
    copilot: {
      distribution: createCopilotDistributionService({ executable: resolved.copilot }),
      profiles: createCopilotProfileService({ ...chosen(resolved.copilot), ...homeOption }),
    },
    pi: {
      distribution: createPiDistributionService({ executable: resolved.pi }),
      profiles: createPiProfileService({ ...chosen(resolved.pi), ...homeOption }),
      extensions: createPiExtensionService(homeOption),
    },
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
    // a digest: the environment may carry a host's launch values, which no key repeats
    const key = createHash('sha256')
      .update(
        JSON.stringify([executable ?? null, Object.entries(appServerEnv ?? {}).sort(([a], [b]) => a.localeCompare(b))]),
      )
      .digest('hex');
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
      distribution: services.claude.distribution,
      profiles: services.claude.profiles,
      extensions: services.claude.extensions,
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
      async createSession({ cwd, resume, title, host, agentOptions, profile, ingress, environment }) {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'claude',
            cwd,
            profile,
            services.claude.profiles,
            normalizeClaudeNativeInvocation,
            agentOptions as ClaudeProviderOptions | undefined,
          ),
          environment,
          ['env'],
        );
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
          ingress,
          ports: {
            spawn: (prepared) => host.spawnTerminal(prepared),
            automate: host.automateTerminal,
          },
        });
      },
      // Stable ingress, the restart half: a Claude that outlived its host keeps
      // posting to the bridge it was launched against; rebinding that ingress
      // and tailing the transcript by id is the whole re-attach. The profile
      // binding resolves the config root the same way a launch does.
      async attachSession({ sessionId, runtimeSessionId, cwd, host, agentOptions, profile, ingress }) {
        if (!ingress) {
          throw new Error('Claude attach needs the ingress the process was launched against');
        }
        const launch = withProfileBinding(
          'claude',
          cwd,
          profile,
          services.claude.profiles,
          normalizeClaudeNativeInvocation,
          agentOptions as ClaudeProviderOptions | undefined,
        );
        return attachClaudeTuiSession({
          sessionId,
          runtimeSessionId,
          cwd,
          ingress,
          env: launch?.env,
          permissionMode: launch?.permissionMode,
          model: launch?.model,
          effort: launch?.effort,
          configDir: launch?.configDir,
          onDiagnostic: launch?.onDiagnostic,
          observeSubagentStatus: true,
          automate: host.automateTerminal,
        });
      },
      async prepareSession({ cwd, resume, title, host, agentOptions, profile, ingress }) {
        const launch = withProfileBinding(
          'claude',
          cwd,
          profile,
          services.claude.profiles,
          normalizeClaudeNativeInvocation,
          agentOptions as ClaudeProviderOptions | undefined,
        );
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
          ingress,
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
      distribution: services.codex.distribution,
      profiles: services.codex.profiles,
      extensions: services.codex.extensions,
      accountUsage: createCodexAccountUsageService({ executable: resolved.codex }),
      prewarm: ({ profile, signal }) =>
        prewarmCodex({
          executable: resolved.codex,
          ...(profile ? { env: services.codex.profiles.bindingEnvironment(profile) } : {}),
          signal,
        }),
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.codex,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'codex', executable: resolved.codex ?? 'codex' }],
            environmentVariables: ['CODEX_HOME'],
            imposter: { state: 'isolated-root' },
            classifies: true,
          },
        },
        normalizeInvocation: normalizeCodexNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) =>
            captureCodexContinuationState(agentOptions as CodexProviderOptions | undefined, cwd),
          restore: (state) => restoreCodexContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      createSession: ({ cwd, resume, host, agentOptions, profile, environment }) => {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'codex',
            cwd,
            profile,
            services.codex.profiles,
            normalizeCodexNativeInvocation,
            agentOptions as CodexProviderOptions | undefined,
          ),
          environment,
          ['appServerEnv'],
        );
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
          appServerArguments: launch?.appServerArguments,
          tuiArguments: launch?.tuiArguments,
          prompt: launch?.prompt,
        });
      },
      async prepareSession({ cwd, resume, host, agentOptions, profile }) {
        const own = agentOptions as CodexProviderOptions | undefined;
        const launch = withProfileBinding(
          'codex',
          cwd,
          profile,
          services.codex.profiles,
          normalizeCodexNativeInvocation,
          own,
        );
        return prepareCodexTuiSession({
          cwd,
          resume,
          executable: launch?.executable ?? resolved.codex,
          host,
          env: launch?.env,
          model: launch?.model,
          sandbox: launch?.sandbox,
          approvalPolicy: launch?.approvalPolicy,
          // The launch's own word only: a profile binding normalizes an empty argv as
          // well, and must not start a host's own spawn from the configuration.
          permissionDefaults: own?.permissionDefaults,
          onApproval: launch?.onApproval,
          resumeInvocation: launch?.resumeInvocation,
          appServerEnv: launch?.appServerEnv,
          appServerArguments: launch?.appServerArguments,
          tuiArguments: launch?.tuiArguments,
          prompt: launch?.prompt,
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
      distribution: services.grok.distribution,
      profiles: services.grok.profiles,
      extensions: services.grok.extensions,
      accountUsage: createGrokAccountUsageService({ executable: resolved.grok }),
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
      createSession: ({ cwd, resume, host, agentOptions, profile, environment }) => {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'grok',
            cwd,
            profile,
            services.grok.profiles,
            normalizeGrokNativeInvocation,
            agentOptions as GrokProviderOptions | undefined,
          ),
          environment,
          ['appServerEnv'],
        );
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
      prepareSession: ({ cwd, resume, host, agentOptions, profile }) => {
        const launch = withProfileBinding(
          'grok',
          cwd,
          profile,
          services.grok.profiles,
          normalizeGrokNativeInvocation,
          agentOptions as GrokProviderOptions | undefined,
        );
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
      distribution: services.kimi.distribution,
      profiles: services.kimi.profiles,
      extensions: services.kimi.extensions,
      accountUsage: createKimiAccountUsageService(),
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
      createSession: ({ cwd, resume, host, agentOptions, profile, environment }) => {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'kimi',
            cwd,
            profile,
            services.kimi.profiles,
            normalizeKimiNativeInvocation,
            agentOptions as KimiProviderOptions | undefined,
          ),
          environment,
          ['env'],
        );
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
      prepareSession: ({ cwd, resume, host, agentOptions, profile }) => {
        const launch = withProfileBinding(
          'kimi',
          cwd,
          profile,
          services.kimi.profiles,
          normalizeKimiNativeInvocation,
          agentOptions as KimiProviderOptions | undefined,
        );
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
      distribution: services.opencode.distribution,
      profiles: services.opencode.profiles,
      extensions: services.opencode.extensions,
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.opencode,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'opencode', executable: resolved.opencode ?? 'opencode' }],
            environmentVariables: ['XDG_DATA_HOME'],
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
      createSession: ({ cwd, resume, title, host, agentOptions, profile, environment }) => {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'opencode',
            cwd,
            profile,
            services.opencode.profiles,
            normalizeOpenCodeNativeInvocation,
            agentOptions as OpenCodeProviderOptions | undefined,
          ),
          environment,
          ['env'],
        );
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
      prepareSession: ({ cwd, resume, title, host, agentOptions, profile }) => {
        const launch = withProfileBinding(
          'opencode',
          cwd,
          profile,
          services.opencode.profiles,
          normalizeOpenCodeNativeInvocation,
          agentOptions as OpenCodeProviderOptions | undefined,
        );
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
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.antigravity,
      executionMode: 'native-tui',
      distribution: services.antigravity.distribution,
      profiles: services.antigravity.profiles,
      extensions: services.antigravity.extensions,
      accountUsage: createAntigravityAccountUsageService({ executable: resolved.antigravity }),
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.antigravity,
          resume: true,
          nativeInvocation: {
            commands: [
              { name: 'agy', executable: resolved.antigravity ?? 'agy' },
              { name: 'antigravity', executable: resolved.antigravity ?? 'agy' },
            ],
            environmentVariables: ['PUPPETEER_ANTIGRAVITY_HOME', 'PUPPETEER_ANTIGRAVITY_DATA_ROOT'],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation: normalizeAntigravityNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) =>
            captureAntigravityContinuationState(agentOptions as AntigravityProviderOptions | undefined, cwd),
          restore: (state) =>
            restoreAntigravityContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      createSession: ({ cwd, resume, host, agentOptions, profile, environment }) => {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'antigravity',
            cwd,
            profile,
            services.antigravity.profiles,
            normalizeAntigravityNativeInvocation,
            agentOptions as AntigravityProviderOptions | undefined,
          ),
          environment,
          ['env'],
        );
        return createAntigravityTuiSession({
          cwd,
          resume,
          host,
          executable: launch?.executable ?? resolved.antigravity,
          env: launch?.env,
          antigravityHome: launch?.antigravityHome,
          dataRoot: launch?.dataRoot,
          model: launch?.model,
          effort: launch?.effort,
          mode: launch?.mode,
          skipPermissions: launch?.skipPermissions,
          sandbox: launch?.sandbox,
          agent: launch?.agent,
          project: launch?.project,
          addDirs: launch?.addDirs,
          pollIntervalMs: launch?.pollIntervalMs,
          maxReplayBytes: launch?.maxReplayBytes,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
        });
      },
      prepareSession: ({ cwd, resume, host, agentOptions, profile }) => {
        const launch = withProfileBinding(
          'antigravity',
          cwd,
          profile,
          services.antigravity.profiles,
          normalizeAntigravityNativeInvocation,
          agentOptions as AntigravityProviderOptions | undefined,
        );
        return prepareAntigravityTuiSession({
          cwd,
          resume,
          host,
          executable: launch?.executable ?? resolved.antigravity,
          env: launch?.env,
          antigravityHome: launch?.antigravityHome,
          dataRoot: launch?.dataRoot,
          model: launch?.model,
          effort: launch?.effort,
          mode: launch?.mode,
          skipPermissions: launch?.skipPermissions,
          sandbox: launch?.sandbox,
          agent: launch?.agent,
          project: launch?.project,
          addDirs: launch?.addDirs,
          pollIntervalMs: launch?.pollIntervalMs,
          maxReplayBytes: launch?.maxReplayBytes,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
        });
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.copilot,
      executionMode: 'native-tui',
      distribution: services.copilot.distribution,
      profiles: services.copilot.profiles,
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.copilot,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'copilot', executable: resolved.copilot ?? 'copilot' }],
            environmentVariables: ['COPILOT_HOME'],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation: normalizeCopilotNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) =>
            captureCopilotContinuationState(agentOptions as CopilotProviderOptions | undefined, cwd),
          restore: (state) =>
            restoreCopilotContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      createSession: ({ cwd, resume, title, host, agentOptions, profile, environment }) => {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'copilot',
            cwd,
            profile,
            services.copilot.profiles,
            normalizeCopilotNativeInvocation,
            agentOptions as CopilotProviderOptions | undefined,
          ),
          environment,
          ['env'],
        );
        return createCopilotTuiSession({
          cwd,
          resume,
          title: launch?.name ?? title,
          host,
          executable: launch?.executable ?? resolved.copilot,
          env: launch?.env,
          copilotHome: launch?.copilotHome,
          model: launch?.model,
          effort: launch?.effort,
          mode: launch?.mode,
          allowAll: launch?.allowAll,
          agent: launch?.agent,
          context: launch?.context,
          pollIntervalMs: launch?.pollIntervalMs,
          maxReplayBytes: launch?.maxReplayBytes,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
        });
      },
      prepareSession: ({ cwd, resume, title, host, agentOptions, profile }) => {
        const launch = withProfileBinding(
          'copilot',
          cwd,
          profile,
          services.copilot.profiles,
          normalizeCopilotNativeInvocation,
          agentOptions as CopilotProviderOptions | undefined,
        );
        return prepareCopilotTuiSession({
          cwd,
          resume,
          title: launch?.name ?? title,
          host,
          executable: launch?.executable ?? resolved.copilot,
          env: launch?.env,
          copilotHome: launch?.copilotHome,
          model: launch?.model,
          effort: launch?.effort,
          mode: launch?.mode,
          allowAll: launch?.allowAll,
          agent: launch?.agent,
          context: launch?.context,
          pollIntervalMs: launch?.pollIntervalMs,
          maxReplayBytes: launch?.maxReplayBytes,
          promptConfirmationTimeoutMs: launch?.promptConfirmationTimeoutMs,
        });
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.pi,
      executionMode: 'native-tui',
      distribution: services.pi.distribution,
      profiles: services.pi.profiles,
      extensions: services.pi.extensions,
      launch: {
        provider: {
          ...BUILTIN_PROVIDER_DESCRIPTORS.pi,
          resume: true,
          nativeInvocation: {
            commands: [{ name: 'pi', executable: resolved.pi ?? 'pi' }],
            environmentVariables: ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'],
            imposter: { state: 'isolated-root' },
          },
        },
        normalizeInvocation: normalizePiNativeInvocation,
        continuation: {
          capture: ({ agentOptions, cwd }) =>
            capturePiContinuationState(agentOptions as PiProviderOptions | undefined, cwd),
          restore: (state) => restorePiContinuationState(state, { imposterExecutable: options.imposterExecutable }),
        },
      },
      createSession: ({ cwd, resume, title, host, agentOptions, profile, environment }) => {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'pi',
            cwd,
            profile,
            services.pi.profiles,
            normalizePiNativeInvocation,
            agentOptions as PiProviderOptions | undefined,
          ),
          environment,
          ['env'],
        );
        return createPiTuiSession({
          cwd,
          resume,
          host,
          executable: launch?.executable ?? resolved.pi,
          env: launch?.env,
          piAgentDir: launch?.piAgentDir,
          sessionDir: launch?.sessionDir,
          provider: launch?.provider,
          model: launch?.model,
          thinking: launch?.thinking,
          name: launch?.name ?? title,
          pollIntervalMs: launch?.pollIntervalMs,
          maxReplayBytes: launch?.maxReplayBytes,
        });
      },
      prepareSession: ({ cwd, resume, title, host, agentOptions, profile }) => {
        const launch = withProfileBinding(
          'pi',
          cwd,
          profile,
          services.pi.profiles,
          normalizePiNativeInvocation,
          agentOptions as PiProviderOptions | undefined,
        );
        return preparePiTuiSession({
          cwd,
          resume,
          host,
          executable: launch?.executable ?? resolved.pi,
          env: launch?.env,
          piAgentDir: launch?.piAgentDir,
          sessionDir: launch?.sessionDir,
          provider: launch?.provider,
          model: launch?.model,
          thinking: launch?.thinking,
          name: launch?.name ?? title,
          pollIntervalMs: launch?.pollIntervalMs,
          maxReplayBytes: launch?.maxReplayBytes,
        });
      },
    },
    {
      descriptor: BUILTIN_PROVIDER_DESCRIPTORS.hermes,
      executionMode: 'native-tui',
      distribution: services.hermes.distribution,
      profiles: services.hermes.profiles,
      extensions: services.hermes.extensions,
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
      createSession: ({ cwd, resume, host, agentOptions, profile, environment }) => {
        const launch = withLaunchEnvironment(
          withProfileBinding(
            'hermes',
            cwd,
            profile,
            services.hermes.profiles,
            normalizeHermesNativeInvocation,
            agentOptions as HermesProviderOptions | undefined,
          ),
          environment,
          ['env'],
        );
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
      prepareSession: ({ cwd, resume, host, agentOptions, profile }) => {
        const launch = withProfileBinding(
          'hermes',
          cwd,
          profile,
          services.hermes.profiles,
          normalizeHermesNativeInvocation,
          agentOptions as HermesProviderOptions | undefined,
        );
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
