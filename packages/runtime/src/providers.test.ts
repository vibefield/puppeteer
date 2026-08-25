import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapterSession, AgentHost } from '@vibecook/chopsticks-core';
import type { AcpConnector } from '@vibecook/chopsticks-adapter-acp';
import type { CreateClaudeSessionOptions } from '@vibecook/chopsticks-adapter-claude';

const adapters = vi.hoisted(() => ({
  createAcpSession: vi.fn(),
  createClaudeSession: vi.fn(),
  fetchClaudeAccountUsage: vi.fn(),
  onClaudeAccountUsage: vi.fn(() => () => undefined),
  preflightClaudeLaunch: vi.fn(),
  prepareClaudeTuiSession: vi.fn(),
  createCodexTuiSession: vi.fn(),
  fetchCodexAccountUsage: vi.fn(),
  prepareCodexTuiSession: vi.fn(),
  createGrokBackend: vi.fn(),
  fetchGrokAccountUsage: vi.fn(),
  createKimiTuiSession: vi.fn(),
  prepareKimiTuiSession: vi.fn(),
  createOpenCodeTuiSession: vi.fn(),
  prepareOpenCodeTuiSession: vi.fn(),
  createHermesTuiSession: vi.fn(),
  prepareHermesTuiSession: vi.fn(),
}));

vi.mock('@vibecook/chopsticks-adapter-acp', () => ({
  createAcpSession: adapters.createAcpSession,
}));

vi.mock('@vibecook/chopsticks-adapter-claude', () => ({
  createClaudeSession: adapters.createClaudeSession,
  fetchClaudeAccountUsage: adapters.fetchClaudeAccountUsage,
  onClaudeAccountUsage: adapters.onClaudeAccountUsage,
  preflightClaudeLaunch: adapters.preflightClaudeLaunch,
  prepareClaudeTuiSession: adapters.prepareClaudeTuiSession,
}));

vi.mock('@vibecook/chopsticks-adapter-codex', () => ({
  createCodexTuiSession: adapters.createCodexTuiSession,
  fetchCodexAccountUsage: adapters.fetchCodexAccountUsage,
  prepareCodexTuiSession: adapters.prepareCodexTuiSession,
}));

vi.mock('@vibecook/chopsticks-adapter-grok', () => ({
  createGrokBackend: adapters.createGrokBackend,
  fetchGrokAccountUsage: adapters.fetchGrokAccountUsage,
}));

vi.mock('@vibecook/chopsticks-adapter-kimi', () => ({
  createKimiTuiSession: adapters.createKimiTuiSession,
  prepareKimiTuiSession: adapters.prepareKimiTuiSession,
}));

vi.mock('@vibecook/chopsticks-adapter-opencode', () => ({
  createOpenCodeTuiSession: adapters.createOpenCodeTuiSession,
  prepareOpenCodeTuiSession: adapters.prepareOpenCodeTuiSession,
}));

vi.mock('@vibecook/chopsticks-adapter-hermes', () => ({
  createHermesTuiSession: adapters.createHermesTuiSession,
  prepareHermesTuiSession: adapters.prepareHermesTuiSession,
}));

import { createBuiltinProviders } from './providers.js';
import type { BuiltinAgentRuntime, BuiltinCreateAgentSessionOptions } from './types.js';

const host: AgentHost = {
  async spawnTerminal() {
    return { runtimeSessionId: 'runtime-1' };
  },
  async automateTerminal() {
    return { accepted: true };
  },
};

function fakeSession(kind: string): AgentAdapterSession {
  return {
    sessionId: `${kind}-session`,
    runtimeSessionId: `${kind}-runtime`,
    observationLevel: () => 'structured',
    onEvent: () => () => undefined,
    async submitPrompt() {
      return { status: 'confirmed' };
    },
    async dispose() {},
  };
}

function fakePreparation(kind: string) {
  return {
    sessionId: `${kind}-session`,
    launch: {
      command: `/opt/${kind}`,
      args: ['--prepared'],
      cwd: '/work/repo',
      env: { SECRET: 'value' },
      settingsPath: '/private/internal',
      filesToCleanup: ['/private/internal'],
    },
    adopt: vi.fn(async (runtimeSessionId: string) => ({ ...fakeSession(kind), runtimeSessionId })),
    dispose: vi.fn(),
  };
}

describe('createBuiltinProviders launch options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapters.createAcpSession.mockResolvedValue(fakeSession('acp'));
    adapters.createClaudeSession.mockResolvedValue(fakeSession('claude'));
    adapters.fetchClaudeAccountUsage.mockResolvedValue({
      status: 'unauthenticated',
      provider: 'claude',
      message: 'missing',
      retryable: false,
    });
    adapters.preflightClaudeLaunch.mockImplementation(async ({ executable }: { executable?: string }) => ({
      executable: executable ?? 'claude',
      version: '2.1.226',
      flags: {
        sessionId: true,
        settings: true,
        settingSources: true,
        name: true,
        permissionMode: true,
        resume: true,
        model: true,
        effort: true,
      },
      warnings: [],
    }));
    adapters.prepareClaudeTuiSession.mockResolvedValue(fakePreparation('claude'));
    adapters.createCodexTuiSession.mockResolvedValue(fakeSession('codex'));
    adapters.fetchCodexAccountUsage.mockResolvedValue({
      status: 'unavailable',
      provider: 'codex',
      message: 'missing',
      retryable: true,
    });
    adapters.prepareCodexTuiSession.mockResolvedValue(fakePreparation('codex'));
    adapters.createGrokBackend.mockReturnValue({
      createSession: vi.fn(),
      prepareSession: vi.fn(async () => fakePreparation('grok')),
      dispose: vi.fn(),
    });
    adapters.fetchGrokAccountUsage.mockResolvedValue({
      status: 'unsupported',
      provider: 'grok',
      message: 'missing',
      retryable: false,
    });
    adapters.createKimiTuiSession.mockResolvedValue(fakeSession('kimi'));
    adapters.prepareKimiTuiSession.mockResolvedValue(fakePreparation('kimi'));
    adapters.createOpenCodeTuiSession.mockResolvedValue(fakeSession('opencode'));
    adapters.prepareOpenCodeTuiSession.mockResolvedValue(fakePreparation('opencode'));
    adapters.createHermesTuiSession.mockResolvedValue(fakeSession('hermes'));
    adapters.prepareHermesTuiSession.mockResolvedValue(fakePreparation('hermes'));
  });

  it('forwards Claude model and permission mode to the native driver', async () => {
    const claude = createBuiltinProviders({ executables: { claude: '/opt/claude' } }).find(
      (provider) => provider.kind === 'claude',
    )!;

    const onDiagnostic = vi.fn();
    await claude.createSession({
      cwd: '/work/repo',
      title: 'review',
      host,
      agentOptions: {
        model: 'claude-fable-5',
        effort: 'high',
        settingSources: ['project', 'local'],
        permissionMode: 'plan',
        fileChangeMatcher: '.env|.envrc',
        onDiagnostic,
      },
    });

    expect(adapters.preflightClaudeLaunch).toHaveBeenCalledWith({
      executable: '/opt/claude',
      freshSession: true,
      resume: false,
      title: true,
      model: true,
      effort: true,
      settingSources: true,
    });
    expect(adapters.createClaudeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        title: 'review',
        executable: '/opt/claude',
        providerVersion: '2.1.226',
        model: 'claude-fable-5',
        effort: 'high',
        settingSources: ['project', 'local'],
        permissionMode: 'plan',
        fileChangeMatcher: '.env|.envrc',
        onDiagnostic,
        observeSubagentStatus: false,
      }),
    );
  });

  it('forwards Claude observation options through create and prepare paths', async () => {
    const hookRailFaultInjection = { afterHookEvent: 'Stop', reason: 'runtime canary fault' };
    const onClaudeScopedObservationBatch = vi.fn();
    const onClaudeScopedObservationDiagnostic = vi.fn();
    const onClaudeScopedObservationError = vi.fn();
    const claude = createBuiltinProviders({
      claudeSubagentStatusObservation: true,
      onClaudeScopedObservationBatch,
      onClaudeScopedObservationDiagnostic,
      onClaudeScopedObservationError,
      claudeHookRailFaultInjection: hookRailFaultInjection,
    }).find((provider) => provider.kind === 'claude')!;

    await claude.createSession({ runtimeRunId: 'runtime-create', cwd: '/work/repo', host });
    await claude.prepareSession!({ runtimeRunId: 'runtime-prepare', cwd: '/work/repo', host });

    expect(adapters.createClaudeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        observeSubagentStatus: true,
        onScopedObservationBatch: expect.any(Function),
        onScopedObservationDiagnostic: expect.any(Function),
        onScopedObservationError: expect.any(Function),
        hookRailFaultInjection,
      }),
    );
    expect(adapters.prepareClaudeTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        observeSubagentStatus: true,
        onScopedObservationBatch: expect.any(Function),
        onScopedObservationDiagnostic: expect.any(Function),
        onScopedObservationError: expect.any(Function),
        hookRailFaultInjection,
      }),
    );

    const createdOptions = adapters.createClaudeSession.mock.calls[0]![0] as CreateClaudeSessionOptions;
    const preparedOptions = adapters.prepareClaudeTuiSession.mock.calls[0]![0] as CreateClaudeSessionOptions;
    const batch = {} as Parameters<NonNullable<CreateClaudeSessionOptions['onScopedObservationBatch']>>[0];
    const diagnostic = {} as Parameters<NonNullable<CreateClaudeSessionOptions['onScopedObservationDiagnostic']>>[0];
    const error = new Error('observer');
    for (const forwarded of [createdOptions, preparedOptions]) {
      forwarded.onScopedObservationBatch?.(batch);
      forwarded.onScopedObservationDiagnostic?.(diagnostic);
      forwarded.onScopedObservationError?.(error);
    }
    expect(onClaudeScopedObservationBatch).toHaveBeenNthCalledWith(1, batch, {
      runtimeRunId: 'runtime-create',
    });
    expect(onClaudeScopedObservationBatch).toHaveBeenNthCalledWith(2, batch, {
      runtimeRunId: 'runtime-prepare',
    });
    expect(onClaudeScopedObservationDiagnostic).toHaveBeenNthCalledWith(1, diagnostic, {
      runtimeRunId: 'runtime-create',
    });
    expect(onClaudeScopedObservationError).toHaveBeenNthCalledWith(1, error, {
      runtimeRunId: 'runtime-create',
    });
  });

  it('does not spawn Claude when capability preflight fails', async () => {
    const claude = createBuiltinProviders({ executables: { claude: '/old/claude' } }).find(
      (provider) => provider.kind === 'claude',
    )!;
    const error = Object.assign(new Error('missing --settings'), {
      name: 'ClaudeCapabilityError',
      code: 'CLAUDE_CAPABILITY_MISSING',
      missingFlags: ['settings'],
    });
    adapters.preflightClaudeLaunch.mockRejectedValueOnce(error);

    await expect(claude.createSession({ cwd: '/work/repo', host })).rejects.toBe(error);
    expect(adapters.createClaudeSession).not.toHaveBeenCalled();
  });

  it('leaves alternate per-session Claude executables to their owning launcher contract', async () => {
    const claude = createBuiltinProviders().find((provider) => provider.kind === 'claude')!;

    await claude.createSession({
      cwd: '/work/repo',
      host,
      agentOptions: { executable: '/opt/ai' },
    });

    expect(adapters.preflightClaudeLaunch).not.toHaveBeenCalled();
    expect(adapters.createClaudeSession).toHaveBeenCalledWith(expect.objectContaining({ executable: '/opt/ai' }));
  });

  it('still preflights custom-named Claude wrappers', async () => {
    const claude = createBuiltinProviders({ executables: { claude: '/opt/company-claude' } }).find(
      (provider) => provider.kind === 'claude',
    )!;

    await claude.createSession({ cwd: '/work/repo', host });

    expect(adapters.preflightClaudeLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ executable: '/opt/company-claude' }),
    );
  });

  it('exposes provider-level account usage independently of sessions', async () => {
    const providers = createBuiltinProviders({ executables: { codex: '/opt/codex' } });
    const claude = providers.find((provider) => provider.kind === 'claude')!;
    const codex = providers.find((provider) => provider.kind === 'codex')!;
    const acp = providers.find((provider) => provider.kind === 'acp')!;
    const grok = providers.find((provider) => provider.kind === 'grok')!;

    await claude.fetchAccountUsage!();
    await codex.fetchAccountUsage!();
    await grok.fetchAccountUsage!();

    expect(adapters.fetchClaudeAccountUsage).toHaveBeenCalledWith();
    expect(adapters.fetchCodexAccountUsage).toHaveBeenCalledWith({ executable: '/opt/codex' });
    expect(adapters.fetchGrokAccountUsage).toHaveBeenCalledWith();
    expect(acp.fetchAccountUsage).toBeUndefined();
    expect(claude.onAccountUsage).toEqual(expect.any(Function));
    expect(codex.onAccountUsage).toBeUndefined();
    expect(acp.onAccountUsage).toBeUndefined();
  });

  it('forwards Codex safety posture to the native-TUI thread bootstrap', async () => {
    const codex = createBuiltinProviders({ executables: { codex: '/opt/codex' } }).find(
      (provider) => provider.kind === 'codex',
    )!;

    const onApproval = vi.fn(() => 'approved' as const);
    await codex.createSession({
      cwd: '/work/repo',
      host,
      agentOptions: { model: 'gpt-5.6-sol', sandbox: 'read-only', approvalPolicy: 'never', onApproval },
    });

    expect(adapters.createCodexTuiSession).toHaveBeenCalledWith({
      cwd: '/work/repo',
      resume: undefined,
      executable: '/opt/codex',
      host,
      model: 'gpt-5.6-sol',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      onApproval,
    });
  });

  it('forwards generic ACP capabilities, approvals, and elicitations through a configured connector', async () => {
    const connector = vi.fn() as unknown as AcpConnector;
    const onApproval = vi.fn(() => 'approved' as const);
    const onElicitation = vi.fn(() => ({ action: 'decline' as const }));
    const clientCapabilities = { terminal: true };
    const acp = createBuiltinProviders({ acpConnector: connector }).find((provider) => provider.kind === 'acp')!;

    await acp.createSession({
      cwd: '/work/repo',
      resume: 'session-1',
      host,
      agentOptions: { clientCapabilities, onApproval, onElicitation },
    });

    expect(adapters.createAcpSession).toHaveBeenCalledWith({
      cwd: '/work/repo',
      resume: 'session-1',
      connector,
      clientCapabilities,
      onApproval,
      onElicitation,
    });
  });

  it('forwards Grok model, safety posture, capabilities, approvals, and elicitations', async () => {
    const onApproval = vi.fn(() => 'denied' as const);
    const onElicitation = vi.fn(() => ({ action: 'decline' as const }));
    const clientCapabilities = { terminal: true };
    const providers = createBuiltinProviders({ executables: { grok: '/opt/grok' } });
    const grok = providers.find((provider) => provider.kind === 'grok')!;

    await grok.createSession({
      cwd: '/work/repo',
      host,
      agentOptions: {
        model: 'grok-code-fast',
        permissionMode: 'plan',
        sandbox: 'workspace-write',
        clientCapabilities,
        onApproval,
        onElicitation,
      },
    });

    expect(adapters.createGrokBackend).toHaveBeenCalledWith({ executable: '/opt/grok', host });
    const backend = adapters.createGrokBackend.mock.results[0]!.value;
    expect(backend.createSession).toHaveBeenCalledWith({
      cwd: '/work/repo',
      resume: undefined,
      model: 'grok-code-fast',
      permissionMode: 'plan',
      sandbox: 'workspace-write',
      clientCapabilities,
      onApproval,
      onElicitation,
    });
  });

  it('isolates and reuses Grok backends by per-session executable and environment', async () => {
    const providers = createBuiltinProviders({ executables: { grok: '/opt/grok' } });
    const grok = providers.find((provider) => provider.kind === 'grok')!;
    const appServerEnv = { AI_PERSONA: 'grok', GROK_HOME: '/tmp/grok-home' };

    await grok.createSession({
      cwd: '/work/repo',
      host,
      agentOptions: { executable: '/opt/ai', appServerEnv },
    });
    await grok.prepareSession!({
      cwd: '/work/repo',
      host,
      agentOptions: {
        executable: '/opt/ai',
        appServerEnv: { GROK_HOME: '/tmp/grok-home', AI_PERSONA: 'grok' },
      },
    });

    expect(adapters.createGrokBackend).toHaveBeenCalledTimes(1);
    expect(adapters.createGrokBackend).toHaveBeenCalledWith({ executable: '/opt/ai', appServerEnv, host });
  });

  it('forwards Kimi native launch, durable-store, and permission options', async () => {
    const kimi = createBuiltinProviders({ executables: { kimi: '/opt/kimi' } }).find(
      (provider) => provider.kind === 'kimi',
    )!;
    const env = { KIMI_CODE_HOME: '/tmp/kimi-home', AI_PERSONA: 'kimi' };

    await kimi.createSession({
      cwd: '/work/repo',
      resume: 'session-1',
      title: 'review',
      host,
      agentOptions: {
        env,
        kimiHome: '/tmp/kimi-home',
        model: 'kimi-for-coding',
        permissionMode: 'auto',
        plan: true,
        pollIntervalMs: 25,
      },
    });

    expect(adapters.createKimiTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        resume: 'session-1',
        host,
        executable: '/opt/kimi',
        env,
        kimiHome: '/tmp/kimi-home',
        model: 'kimi-for-coding',
        permissionMode: 'auto',
        plan: true,
        pollIntervalMs: 25,
      }),
    );
    expect(kimi.fetchAccountUsage).toBeUndefined();
  });

  it('forwards OpenCode private-backend, model, and permission options', async () => {
    const opencode = createBuiltinProviders({ executables: { opencode: '/opt/opencode' } }).find(
      (provider) => provider.kind === 'opencode',
    )!;
    const env = { OPENCODE_CONFIG_DIR: '/tmp/opencode-config' };
    const model = { providerID: 'imposter', modelID: 'opencode-imposter', variant: 'fast' };
    const permission = [{ permission: '*', pattern: '*', action: 'allow' }];

    await opencode.createSession({
      cwd: '/work/repo',
      resume: 'ses_existing',
      title: 'review',
      host,
      agentOptions: {
        env,
        agent: 'reviewer',
        model,
        permission,
        contextWindowCapacityTokens: 128_000,
        promptConfirmationTimeoutMs: 250,
        backendStartupTimeoutMs: 1_000,
        backendShutdownTimeoutMs: 500,
        reconnectDelayMs: 25,
      },
    });

    expect(adapters.createOpenCodeTuiSession).toHaveBeenCalledWith({
      cwd: '/work/repo',
      resume: 'ses_existing',
      title: 'review',
      host,
      executable: '/opt/opencode',
      env,
      agent: 'reviewer',
      model,
      permission,
      contextWindowCapacityTokens: 128_000,
      promptConfirmationTimeoutMs: 250,
      backendStartupTimeoutMs: 1_000,
      backendShutdownTimeoutMs: 500,
      reconnectDelayMs: 25,
    });
    expect(opencode.fetchAccountUsage).toBeUndefined();
  });

  it('forwards Hermes isolated-home, gateway, and attach options', async () => {
    const hermes = createBuiltinProviders({ executables: { hermes: '/opt/hermes' } }).find(
      (provider) => provider.kind === 'hermes',
    )!;
    const env = { HERMES_HOME: '/tmp/hermes-home', AI_PERSONA: 'hermes' };

    await hermes.createSession({
      cwd: '/work/repo',
      resume: '20260812_132919_ae981b',
      host,
      agentOptions: {
        env,
        hermesHome: '/tmp/hermes-home',
        python: '/opt/python',
        gatewayUrl: 'ws://127.0.0.1:9/api/ws',
        promptConfirmationTimeoutMs: 250,
      },
    });

    expect(adapters.createHermesTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        resume: '20260812_132919_ae981b',
        host,
        executable: '/opt/hermes',
        env,
        hermesHome: '/tmp/hermes-home',
        python: '/opt/python',
        gatewayUrl: 'ws://127.0.0.1:9/api/ws',
        promptConfirmationTimeoutMs: 250,
      }),
    );
    expect(hermes.fetchAccountUsage).toBeUndefined();
  });

  it('exposes prepare/adopt for native providers while generic ACP stays explicitly unsupported', async () => {
    const providers = createBuiltinProviders({
      executables: {
        claude: '/opt/claude',
        codex: '/opt/codex',
        grok: '/opt/grok',
        kimi: '/opt/kimi',
        opencode: '/opt/opencode',
        hermes: '/opt/hermes',
      },
    });
    const claude = providers.find((provider) => provider.kind === 'claude')!;
    const codex = providers.find((provider) => provider.kind === 'codex')!;
    const acp = providers.find((provider) => provider.kind === 'acp')!;
    const grok = providers.find((provider) => provider.kind === 'grok')!;
    const kimi = providers.find((provider) => provider.kind === 'kimi')!;
    const opencode = providers.find((provider) => provider.kind === 'opencode')!;
    const hermes = providers.find((provider) => provider.kind === 'hermes')!;

    const claudePrepared = await claude.prepareSession!({
      cwd: '/work/repo',
      title: 'review',
      host,
      agentOptions: {
        model: 'sonnet',
        permissionMode: 'plan',
        configDir: '/work/claude-config',
        fileChangeMatcher: '.env',
      },
    });
    expect(adapters.prepareClaudeTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        title: 'review',
        executable: '/opt/claude',
        providerVersion: '2.1.226',
        model: 'sonnet',
        permissionMode: 'plan',
        configDir: '/work/claude-config',
        fileChangeMatcher: '.env',
        observeSubagentStatus: false,
      }),
    );
    expect(claudePrepared.launch).toEqual({
      command: '/opt/claude',
      args: ['--prepared'],
      cwd: '/work/repo',
      env: { SECRET: 'value' },
    });

    await codex.prepareSession!({ cwd: '/work/repo', host, agentOptions: { sandbox: 'read-only' } });
    expect(adapters.prepareCodexTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/work/repo', executable: '/opt/codex', sandbox: 'read-only', host }),
    );

    const onApproval = vi.fn(() => 'approved' as const);
    await grok.prepareSession!({
      cwd: '/work/repo',
      host,
      agentOptions: { permissionMode: 'plan', onApproval },
    });
    const backend = adapters.createGrokBackend.mock.results[0]!.value;
    expect(backend.prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/work/repo', permissionMode: 'plan', onApproval }),
    );
    await kimi.prepareSession!({
      cwd: '/work/repo',
      host,
      agentOptions: { permissionMode: 'yolo', agent: 'reviewer' },
    });
    expect(adapters.prepareKimiTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        executable: '/opt/kimi',
        permissionMode: 'yolo',
        agent: 'reviewer',
        host,
      }),
    );
    await opencode.prepareSession!({
      cwd: '/work/repo',
      title: 'review',
      host,
      agentOptions: { agent: 'reviewer', reconnectDelayMs: 25 },
    });
    expect(adapters.prepareOpenCodeTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        title: 'review',
        executable: '/opt/opencode',
        agent: 'reviewer',
        reconnectDelayMs: 25,
        host,
      }),
    );
    await hermes.prepareSession!({
      cwd: '/work/repo',
      host,
      agentOptions: { hermesHome: '/tmp/hermes-home', yolo: true },
    });
    expect(adapters.prepareHermesTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        executable: '/opt/hermes',
        hermesHome: '/tmp/hermes-home',
        yolo: true,
        host,
      }),
    );
    expect(acp.prepareSession).toBeUndefined();
  });
});

const typedClaudeRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'claude',
  agentOptions: { model: 'sonnet', permissionMode: 'plan' },
};
void typedClaudeRequest;

const mismatchedRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'claude',
  // @ts-expect-error a Codex sandbox is not a Claude launch option
  agentOptions: { sandbox: 'read-only' },
};
void mismatchedRequest;

const typedConnector = vi.fn() as unknown as AcpConnector;
const typedAcpRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'acp',
  agentOptions: { connector: typedConnector, clientCapabilities: { terminal: true }, onApproval: () => 'approved' },
};
void typedAcpRequest;

const typedGrokRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'grok',
  agentOptions: { model: 'grok-code-fast', permissionMode: 'plan', sandbox: 'workspace-write' },
};
void typedGrokRequest;

const typedKimiRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'kimi',
  agentOptions: { model: 'kimi-for-coding', permissionMode: 'auto', plan: true },
};
void typedKimiRequest;

const typedOpenCodeRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'opencode',
  agentOptions: {
    agent: 'reviewer',
    model: { providerID: 'openai', modelID: 'gpt-5' },
    permission: [{ permission: '*', pattern: '*', action: 'ask' }],
  },
};
void typedOpenCodeRequest;

const typedHermesRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'hermes',
  agentOptions: { hermesHome: '/tmp/hermes-home', yolo: false },
};
void typedHermesRequest;

type BuiltinPrepareRequest = Parameters<BuiltinAgentRuntime['prepareSession']>[0];
const typedCodexPreparation: BuiltinPrepareRequest = {
  agent: 'codex',
  agentOptions: { model: 'gpt-5.6-sol', sandbox: 'read-only', onApproval: () => 'denied' },
};
void typedCodexPreparation;

const mismatchedPreparation: BuiltinPrepareRequest = {
  agent: 'grok',
  // @ts-expect-error a Codex approvalPolicy is not a Grok launch option
  agentOptions: { approvalPolicy: 'never' },
};
void mismatchedPreparation;
