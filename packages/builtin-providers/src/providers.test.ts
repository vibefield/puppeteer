import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapterBinding, AgentHost, AgentProfile } from '@vibecook/puppeteer-core';
import type { AcpConnector } from '@vibecook/puppeteer-adapter-acp';

const adapters = vi.hoisted(() => {
  // Minimal valid provider-scoped capabilities so composition passes runtime schema checks.
  const fakeDistribution = (id: string, label: string, command: string) => ({
    provider: {
      id,
      label,
      commands: [command],
      npmPackages: [],
      brewNames: [],
      detectors: [],
      nativeUpdateCheck: false,
    },
    inspect: vi.fn(async () => undefined),
    recipeFor: vi.fn(() => ({ kind: 'manual' as const, instructions: 'not applicable' })),
  });
  const fakeProfiles = (id: string, label: string) => ({
    provider: { id, label, support: { supported: true, identity: 'none' as const, sharedSurfaces: [] } },
    bindingEnvironment: vi.fn(() => ({})),
    loginInvocation: vi.fn(() => ({ command: id, args: ['login'], cwd: '/work' })),
    verify: vi.fn(async () => ({
      status: 'unsupported' as const,
      provider: id,
      message: 'no identity',
      retryable: false,
    })),
  });
  return {
    createAntigravityDistributionService: vi.fn(() => fakeDistribution('antigravity', 'Antigravity', 'agy')),
    createAntigravityProfileService: vi.fn(() => fakeProfiles('antigravity', 'Antigravity')),
    createAntigravityAccountUsageService: vi.fn(),
    fetchAntigravityAccountUsage: vi.fn(),
    createClaudeDistributionService: vi.fn(() => fakeDistribution('claude', 'Claude', 'claude')),
    createClaudeProfileService: vi.fn(() => fakeProfiles('claude', 'Claude')),
    createCodexDistributionService: vi.fn(() => fakeDistribution('codex', 'Codex', 'codex')),
    createCodexProfileService: vi.fn(() => fakeProfiles('codex', 'Codex')),
    createCopilotDistributionService: vi.fn(() => fakeDistribution('copilot', 'GitHub Copilot', 'copilot')),
    createCopilotProfileService: vi.fn(() => fakeProfiles('copilot', 'GitHub Copilot')),
    createGrokDistributionService: vi.fn(() => fakeDistribution('grok', 'Grok', 'grok')),
    createGrokProfileService: vi.fn(() => fakeProfiles('grok', 'Grok')),
    createKimiDistributionService: vi.fn(() => fakeDistribution('kimi', 'Kimi', 'kimi')),
    createKimiProfileService: vi.fn(() => fakeProfiles('kimi', 'Kimi')),
    createKimiAccountUsageService: vi.fn(),
    fetchKimiAccountUsage: vi.fn(),
    createOpenCodeDistributionService: vi.fn(() => fakeDistribution('opencode', 'OpenCode', 'opencode')),
    createOpenCodeProfileService: vi.fn(() => fakeProfiles('opencode', 'OpenCode')),
    createHermesDistributionService: vi.fn(() => fakeDistribution('hermes', 'Hermes', 'hermes')),
    createHermesProfileService: vi.fn(() => fakeProfiles('hermes', 'Hermes')),
    createPiDistributionService: vi.fn(() => fakeDistribution('pi', 'Pi', 'pi')),
    createPiProfileService: vi.fn(() => fakeProfiles('pi', 'Pi')),
    createAcpSession: vi.fn(),
    createAntigravityTuiSession: vi.fn(),
    prepareAntigravityTuiSession: vi.fn(),
    normalizeAntigravityNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    captureAntigravityContinuationState: vi.fn(),
    restoreAntigravityContinuationState: vi.fn(),
    createClaudeAccountUsageService: vi.fn(),
    createClaudeSession: vi.fn(),
    fetchClaudeAccountUsage: vi.fn(),
    onClaudeAccountUsage: vi.fn(() => () => undefined),
    preflightClaudeLaunch: vi.fn(),
    prepareClaudeTuiSession: vi.fn(),
    normalizeClaudeNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    captureClaudeContinuationState: vi.fn(),
    restoreClaudeContinuationState: vi.fn(),
    createCodexAccountUsageService: vi.fn(),
    createCodexTuiSession: vi.fn(),
    fetchCodexAccountUsage: vi.fn(),
    prepareCodexTuiSession: vi.fn(),
    prewarmCodex: vi.fn(),
    normalizeCodexNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    captureCodexContinuationState: vi.fn(),
    restoreCodexContinuationState: vi.fn(),
    createCopilotTuiSession: vi.fn(),
    prepareCopilotTuiSession: vi.fn(),
    normalizeCopilotNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    captureCopilotContinuationState: vi.fn(),
    restoreCopilotContinuationState: vi.fn(),
    createGrokAccountUsageService: vi.fn(),
    createGrokBackend: vi.fn(),
    fetchGrokAccountUsage: vi.fn(),
    normalizeGrokNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    captureGrokContinuationState: vi.fn(),
    restoreGrokContinuationState: vi.fn(),
    createKimiTuiSession: vi.fn(),
    prepareKimiTuiSession: vi.fn(),
    normalizeKimiNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    captureKimiContinuationState: vi.fn(),
    restoreKimiContinuationState: vi.fn(),
    createOpenCodeTuiSession: vi.fn(),
    prepareOpenCodeTuiSession: vi.fn(),
    normalizeOpenCodeNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    captureOpenCodeContinuationState: vi.fn(),
    restoreOpenCodeContinuationState: vi.fn(),
    createHermesTuiSession: vi.fn(),
    prepareHermesTuiSession: vi.fn(),
    normalizeHermesNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    captureHermesContinuationState: vi.fn(),
    restoreHermesContinuationState: vi.fn(),
    createPiTuiSession: vi.fn(),
    preparePiTuiSession: vi.fn(),
    normalizePiNativeInvocation: vi.fn(() => ({ status: 'accepted' })),
    capturePiContinuationState: vi.fn(),
    restorePiContinuationState: vi.fn(),
  };
});

vi.mock('@vibecook/puppeteer-adapter-acp', () => ({
  createAcpSession: adapters.createAcpSession,
}));

vi.mock('@vibecook/puppeteer-adapter-antigravity', () => ({
  createAntigravityDistributionService: adapters.createAntigravityDistributionService,
  createAntigravityProfileService: adapters.createAntigravityProfileService,
  createAntigravityAccountUsageService: adapters.createAntigravityAccountUsageService,
  createAntigravityTuiSession: adapters.createAntigravityTuiSession,
  prepareAntigravityTuiSession: adapters.prepareAntigravityTuiSession,
  normalizeAntigravityNativeInvocation: adapters.normalizeAntigravityNativeInvocation,
  captureAntigravityContinuationState: adapters.captureAntigravityContinuationState,
  restoreAntigravityContinuationState: adapters.restoreAntigravityContinuationState,
}));

vi.mock('@vibecook/puppeteer-adapter-claude', () => ({
  createClaudeDistributionService: adapters.createClaudeDistributionService,
  createClaudeProfileService: adapters.createClaudeProfileService,
  createClaudeAccountUsageService: adapters.createClaudeAccountUsageService,
  createClaudeSession: adapters.createClaudeSession,
  fetchClaudeAccountUsage: adapters.fetchClaudeAccountUsage,
  onClaudeAccountUsage: adapters.onClaudeAccountUsage,
  preflightClaudeLaunch: adapters.preflightClaudeLaunch,
  prepareClaudeTuiSession: adapters.prepareClaudeTuiSession,
  normalizeClaudeNativeInvocation: adapters.normalizeClaudeNativeInvocation,
  captureClaudeContinuationState: adapters.captureClaudeContinuationState,
  restoreClaudeContinuationState: adapters.restoreClaudeContinuationState,
}));

vi.mock('@vibecook/puppeteer-adapter-codex', () => ({
  createCodexDistributionService: adapters.createCodexDistributionService,
  createCodexProfileService: adapters.createCodexProfileService,
  createCodexAccountUsageService: adapters.createCodexAccountUsageService,
  createCodexTuiSession: adapters.createCodexTuiSession,
  fetchCodexAccountUsage: adapters.fetchCodexAccountUsage,
  prepareCodexTuiSession: adapters.prepareCodexTuiSession,
  prewarmCodex: adapters.prewarmCodex,
  normalizeCodexNativeInvocation: adapters.normalizeCodexNativeInvocation,
  captureCodexContinuationState: adapters.captureCodexContinuationState,
  restoreCodexContinuationState: adapters.restoreCodexContinuationState,
}));

vi.mock('@vibecook/puppeteer-adapter-copilot', () => ({
  createCopilotDistributionService: adapters.createCopilotDistributionService,
  createCopilotProfileService: adapters.createCopilotProfileService,
  createCopilotTuiSession: adapters.createCopilotTuiSession,
  prepareCopilotTuiSession: adapters.prepareCopilotTuiSession,
  normalizeCopilotNativeInvocation: adapters.normalizeCopilotNativeInvocation,
  captureCopilotContinuationState: adapters.captureCopilotContinuationState,
  restoreCopilotContinuationState: adapters.restoreCopilotContinuationState,
}));

vi.mock('@vibecook/puppeteer-adapter-grok', () => ({
  createGrokDistributionService: adapters.createGrokDistributionService,
  createGrokProfileService: adapters.createGrokProfileService,
  createGrokAccountUsageService: adapters.createGrokAccountUsageService,
  createGrokBackend: adapters.createGrokBackend,
  fetchGrokAccountUsage: adapters.fetchGrokAccountUsage,
  normalizeGrokNativeInvocation: adapters.normalizeGrokNativeInvocation,
  captureGrokContinuationState: adapters.captureGrokContinuationState,
  restoreGrokContinuationState: adapters.restoreGrokContinuationState,
}));

vi.mock('@vibecook/puppeteer-adapter-kimi', () => ({
  createKimiDistributionService: adapters.createKimiDistributionService,
  createKimiProfileService: adapters.createKimiProfileService,
  createKimiAccountUsageService: adapters.createKimiAccountUsageService,
  createKimiTuiSession: adapters.createKimiTuiSession,
  prepareKimiTuiSession: adapters.prepareKimiTuiSession,
  normalizeKimiNativeInvocation: adapters.normalizeKimiNativeInvocation,
  captureKimiContinuationState: adapters.captureKimiContinuationState,
  restoreKimiContinuationState: adapters.restoreKimiContinuationState,
}));

vi.mock('@vibecook/puppeteer-adapter-opencode', () => ({
  createOpenCodeDistributionService: adapters.createOpenCodeDistributionService,
  createOpenCodeProfileService: adapters.createOpenCodeProfileService,
  createOpenCodeTuiSession: adapters.createOpenCodeTuiSession,
  prepareOpenCodeTuiSession: adapters.prepareOpenCodeTuiSession,
  normalizeOpenCodeNativeInvocation: adapters.normalizeOpenCodeNativeInvocation,
  captureOpenCodeContinuationState: adapters.captureOpenCodeContinuationState,
  restoreOpenCodeContinuationState: adapters.restoreOpenCodeContinuationState,
}));

vi.mock('@vibecook/puppeteer-adapter-hermes', () => ({
  createHermesDistributionService: adapters.createHermesDistributionService,
  createHermesProfileService: adapters.createHermesProfileService,
  createHermesTuiSession: adapters.createHermesTuiSession,
  prepareHermesTuiSession: adapters.prepareHermesTuiSession,
  normalizeHermesNativeInvocation: adapters.normalizeHermesNativeInvocation,
  captureHermesContinuationState: adapters.captureHermesContinuationState,
  restoreHermesContinuationState: adapters.restoreHermesContinuationState,
}));

vi.mock('@vibecook/puppeteer-adapter-pi', () => ({
  createPiDistributionService: adapters.createPiDistributionService,
  createPiProfileService: adapters.createPiProfileService,
  createPiTuiSession: adapters.createPiTuiSession,
  preparePiTuiSession: adapters.preparePiTuiSession,
  normalizePiNativeInvocation: adapters.normalizePiNativeInvocation,
  capturePiContinuationState: adapters.capturePiContinuationState,
  restorePiContinuationState: adapters.restorePiContinuationState,
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

function fakeSession(kind: string): AgentAdapterBinding {
  return {
    sessionId: `${kind}-session`,
    runtimeSessionId: `${kind}-runtime`,
    observationLevel: () => 'structured',
    events: { onCandidate: () => () => undefined },
    services: {
      prompt: {
        async submit() {
          return { status: 'confirmed' };
        },
      },
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
    adapters.createClaudeAccountUsageService.mockReturnValue({
      provider: {
        id: 'claude',
        label: 'Claude',
        refresh: { pollIntervalMs: 30 * 60_000, pushUpdatePollIntervalMs: 30 * 60_000 },
      },
      fetch: adapters.fetchClaudeAccountUsage,
      subscribe: adapters.onClaudeAccountUsage,
    });
    adapters.createCodexAccountUsageService.mockImplementation((options: { executable?: string } = {}) => ({
      provider: { id: 'codex', label: 'Codex', refresh: { pollIntervalMs: 60_000 } },
      fetch: () => adapters.fetchCodexAccountUsage(options),
    }));
    adapters.createGrokAccountUsageService.mockImplementation((options: { executable?: string } = {}) => ({
      provider: { id: 'grok', label: 'Grok', refresh: { pollIntervalMs: 15 * 60_000 } },
      fetch: () => adapters.fetchGrokAccountUsage(options),
    }));
    adapters.createAntigravityAccountUsageService.mockImplementation((options: { executable?: string } = {}) => ({
      provider: { id: 'antigravity', label: 'Antigravity', refresh: { pollIntervalMs: 5 * 60_000 } },
      fetch: () => adapters.fetchAntigravityAccountUsage(options),
    }));
    adapters.createKimiAccountUsageService.mockReturnValue({
      provider: { id: 'kimi', label: 'Kimi', refresh: { pollIntervalMs: 5 * 60_000 } },
      fetch: adapters.fetchKimiAccountUsage,
    });
    adapters.createAcpSession.mockResolvedValue(fakeSession('acp'));
    adapters.createAntigravityTuiSession.mockResolvedValue(fakeSession('antigravity'));
    adapters.prepareAntigravityTuiSession.mockResolvedValue(fakePreparation('antigravity'));
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
    adapters.createCopilotTuiSession.mockResolvedValue(fakeSession('copilot'));
    adapters.prepareCopilotTuiSession.mockResolvedValue(fakePreparation('copilot'));
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
    adapters.fetchAntigravityAccountUsage.mockResolvedValue({
      status: 'unauthenticated',
      provider: 'antigravity',
      message: 'missing',
      retryable: false,
    });
    adapters.fetchKimiAccountUsage.mockResolvedValue({
      status: 'unauthenticated',
      provider: 'kimi',
      message: 'missing',
      retryable: false,
    });
    adapters.createKimiTuiSession.mockResolvedValue(fakeSession('kimi'));
    adapters.prepareKimiTuiSession.mockResolvedValue(fakePreparation('kimi'));
    adapters.createOpenCodeTuiSession.mockResolvedValue(fakeSession('opencode'));
    adapters.prepareOpenCodeTuiSession.mockResolvedValue(fakePreparation('opencode'));
    adapters.createHermesTuiSession.mockResolvedValue(fakeSession('hermes'));
    adapters.prepareHermesTuiSession.mockResolvedValue(fakePreparation('hermes'));
    adapters.createPiTuiSession.mockResolvedValue(fakeSession('pi'));
    adapters.preparePiTuiSession.mockResolvedValue(fakePreparation('pi'));
  });

  it('exposes distribution and profile capabilities on every executable provider', () => {
    for (const provider of createBuiltinProviders()) {
      if (provider.descriptor.id === 'acp') {
        expect(provider.distribution).toBeUndefined();
        expect(provider.profiles).toBeUndefined();
        continue;
      }
      expect(provider.distribution?.provider.id).toBe(provider.descriptor.id);
      expect(provider.distribution?.provider.label).toBe(provider.descriptor.label);
      expect(provider.profiles?.provider.id).toBe(provider.descriptor.id);
    }
  });

  it('prewarms Codex with the configured executable and selected account, without launching a session', async () => {
    const codex = createBuiltinProviders({ executables: { codex: '/opt/codex' } }).find(
      (provider) => provider.descriptor.id === 'codex',
    )!;
    const signal = new AbortController().signal;
    const profile: AgentProfile = {
      id: 'work',
      provider: 'codex',
      label: 'Work',
      kind: 'managed',
      dataRoot: '/roots/codex/work',
      createdAt: '2026-09-11T00:00:00.000Z',
    };
    vi.mocked(codex.profiles!.bindingEnvironment).mockReturnValue({ CODEX_HOME: profile.dataRoot });
    await codex.prewarm!({ profile, signal });
    expect(adapters.prewarmCodex).toHaveBeenCalledWith({
      executable: '/opt/codex',
      env: { CODEX_HOME: profile.dataRoot },
      signal,
    });
    await codex.prewarm!({ signal });
    expect(adapters.prewarmCodex).toHaveBeenLastCalledWith({ executable: '/opt/codex', signal });
    expect(adapters.createCodexTuiSession).not.toHaveBeenCalled();
    expect(adapters.prepareCodexTuiSession).not.toHaveBeenCalled();
  });

  it('binds a selected profile through the adapter normalizer, never through a consumer-side recipe', async () => {
    const providers = createBuiltinProviders({ executables: { claude: '/opt/claude', codex: '/opt/codex' } });
    const claude = providers.find((provider) => provider.descriptor.id === 'claude')!;
    const codex = providers.find((provider) => provider.descriptor.id === 'codex')!;
    const profile: AgentProfile = {
      id: 'p1',
      provider: 'claude',
      label: 'Work',
      kind: 'managed',
      dataRoot: '/roots/claude/p1',
      createdAt: '2026-09-06T00:00:00.000Z',
    };
    vi.mocked(claude.profiles!.bindingEnvironment).mockReturnValue({ CLAUDE_CONFIG_DIR: '/roots/claude/p1' });
    adapters.normalizeClaudeNativeInvocation.mockReturnValue({
      status: 'accepted',
      options: { configDir: '/roots/claude/p1' },
    } as ReturnType<typeof adapters.normalizeClaudeNativeInvocation>);

    await claude.createSession({ cwd: '/work/repo', host, profile, agentOptions: { model: 'claude-fable-5' } });

    expect(adapters.normalizeClaudeNativeInvocation).toHaveBeenCalledWith({
      providerId: 'claude',
      cwd: '/work/repo',
      argv: [],
      environment: { CLAUDE_CONFIG_DIR: '/roots/claude/p1' },
      implementation: { kind: 'native' },
    });
    expect(adapters.createClaudeSession).toHaveBeenCalledWith(
      expect.objectContaining({ configDir: '/roots/claude/p1', model: 'claude-fable-5' }),
    );

    const codexProfile: AgentProfile = { ...profile, id: 'p2', provider: 'codex', dataRoot: '/roots/codex/p2' };
    vi.mocked(codex.profiles!.bindingEnvironment).mockReturnValue({ CODEX_HOME: '/roots/codex/p2' });
    adapters.normalizeCodexNativeInvocation.mockReturnValue({
      status: 'accepted',
      options: { env: { CODEX_HOME: '/roots/codex/p2' }, appServerEnv: { CODEX_HOME: '/roots/codex/p2' } },
    } as ReturnType<typeof adapters.normalizeCodexNativeInvocation>);

    await codex.createSession({
      cwd: '/work/repo',
      host,
      profile: codexProfile,
      agentOptions: { model: 'gpt-5.6-sol' },
    });

    expect(adapters.createCodexTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { CODEX_HOME: '/roots/codex/p2' },
        appServerEnv: { CODEX_HOME: '/roots/codex/p2' },
        model: 'gpt-5.6-sol',
      }),
    );
  });

  it('leaves launches without a profile untouched by profile binding', async () => {
    const claude = createBuiltinProviders({ executables: { claude: '/opt/claude' } }).find(
      (provider) => provider.descriptor.id === 'claude',
    )!;
    await claude.createSession({ cwd: '/work/repo', host, agentOptions: { model: 'claude-fable-5' } });
    expect(adapters.normalizeClaudeNativeInvocation).not.toHaveBeenCalled();
  });

  it('forwards Claude model and permission mode to the native driver', async () => {
    const claude = createBuiltinProviders({ executables: { claude: '/opt/claude' } }).find(
      (provider) => provider.descriptor.id === 'claude',
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
        observeSubagentStatus: true,
      }),
    );
  });

  it('does not spawn Claude when capability preflight fails', async () => {
    const claude = createBuiltinProviders({ executables: { claude: '/old/claude' } }).find(
      (provider) => provider.descriptor.id === 'claude',
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
    const claude = createBuiltinProviders().find((provider) => provider.descriptor.id === 'claude')!;

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
      (provider) => provider.descriptor.id === 'claude',
    )!;

    await claude.createSession({ cwd: '/work/repo', host });

    expect(adapters.preflightClaudeLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ executable: '/opt/company-claude' }),
    );
  });

  it('exposes provider-level account usage independently of sessions', async () => {
    const providers = createBuiltinProviders({
      executables: { codex: '/opt/codex', antigravity: '/opt/agy', grok: '/opt/grok' },
    });
    const claude = providers.find((provider) => provider.descriptor.id === 'claude')!;
    const codex = providers.find((provider) => provider.descriptor.id === 'codex')!;
    const acp = providers.find((provider) => provider.descriptor.id === 'acp')!;
    const grok = providers.find((provider) => provider.descriptor.id === 'grok')!;
    const antigravity = providers.find((provider) => provider.descriptor.id === 'antigravity')!;
    const kimi = providers.find((provider) => provider.descriptor.id === 'kimi')!;

    await claude.accountUsage!.fetch();
    await codex.accountUsage!.fetch();
    await grok.accountUsage!.fetch();
    await antigravity.accountUsage!.fetch();
    await kimi.accountUsage!.fetch();

    expect(adapters.fetchClaudeAccountUsage).toHaveBeenCalledWith();
    expect(adapters.fetchCodexAccountUsage).toHaveBeenCalledWith({ executable: '/opt/codex' });
    expect(adapters.fetchGrokAccountUsage).toHaveBeenCalledWith({ executable: '/opt/grok' });
    expect(adapters.fetchAntigravityAccountUsage).toHaveBeenCalledWith({ executable: '/opt/agy' });
    expect(adapters.fetchKimiAccountUsage).toHaveBeenCalledWith();
    expect(acp.accountUsage).toBeUndefined();
    expect(claude.accountUsage?.subscribe).toEqual(expect.any(Function));
    expect(codex.accountUsage?.subscribe).toBeUndefined();
    expect(antigravity.accountUsage?.subscribe).toBeUndefined();
    expect(kimi.accountUsage?.subscribe).toBeUndefined();
  });

  it('advertises only durable Imposter routes and resolves opaque continuation topology in adapters', () => {
    const providers = createBuiltinProviders({ imposterExecutable: '/opt/ai' });
    const imposterProviders = providers
      .filter((provider) => provider.launch?.provider.nativeInvocation?.imposter)
      .map((provider) => [provider.descriptor.id, provider.launch!.provider.nativeInvocation!.imposter] as const);

    expect(imposterProviders).toEqual([
      ['claude', { state: 'isolated-root' }],
      ['codex', { state: 'isolated-root' }],
      ['grok', { state: 'isolated-root' }],
      ['kimi', { state: 'isolated-root' }],
      ['opencode', { state: 'isolated-root' }],
      ['antigravity', { state: 'isolated-root' }],
      ['copilot', { state: 'isolated-root' }],
      ['pi', { state: 'isolated-root' }],
    ]);
    const opencode = providers.find((provider) => provider.descriptor.id === 'opencode')!;
    opencode.launch!.continuation!.restore('opaque-state', { cwd: '/repo' });
    expect(adapters.restoreOpenCodeContinuationState).toHaveBeenCalledWith('opaque-state', {
      imposterExecutable: '/opt/ai',
    });
  });

  it('forwards Codex safety posture to the native-TUI thread bootstrap', async () => {
    const codex = createBuiltinProviders({ executables: { codex: '/opt/codex' } }).find(
      (provider) => provider.descriptor.id === 'codex',
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
    const acp = createBuiltinProviders({ acpConnector: connector }).find(
      (provider) => provider.descriptor.id === 'acp',
    )!;

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
    const grok = providers.find((provider) => provider.descriptor.id === 'grok')!;

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
    const grok = providers.find((provider) => provider.descriptor.id === 'grok')!;
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
      (provider) => provider.descriptor.id === 'kimi',
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
    expect(kimi.accountUsage?.provider.id).toBe('kimi');
  });

  it('forwards OpenCode private-backend, model, and permission options', async () => {
    const opencode = createBuiltinProviders({ executables: { opencode: '/opt/opencode' } }).find(
      (provider) => provider.descriptor.id === 'opencode',
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
    expect(opencode.accountUsage).toBeUndefined();
  });

  it('forwards Hermes isolated-home, gateway, and attach options', async () => {
    const hermes = createBuiltinProviders({ executables: { hermes: '/opt/hermes' } }).find(
      (provider) => provider.descriptor.id === 'hermes',
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
    expect(hermes.accountUsage).toBeUndefined();
  });

  it('forwards Antigravity, Copilot, and Pi native launch options without consumer-side recipes', async () => {
    const providers = createBuiltinProviders({
      executables: {
        antigravity: '/opt/agy',
        copilot: '/opt/copilot',
        pi: '/opt/pi',
      },
    });
    const antigravity = providers.find((provider) => provider.descriptor.id === 'antigravity')!;
    const copilot = providers.find((provider) => provider.descriptor.id === 'copilot')!;
    const pi = providers.find((provider) => provider.descriptor.id === 'pi')!;

    await antigravity.createSession({
      cwd: '/work/repo',
      resume: 'conversation-1',
      host,
      agentOptions: {
        dataRoot: '/tmp/antigravity-data',
        model: 'gemini-pro',
        effort: 'high',
        mode: 'plan',
        skipPermissions: true,
      },
    });
    expect(adapters.createAntigravityTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        resume: 'conversation-1',
        host,
        executable: '/opt/agy',
        dataRoot: '/tmp/antigravity-data',
        model: 'gemini-pro',
        effort: 'high',
        mode: 'plan',
        skipPermissions: true,
      }),
    );

    await copilot.createSession({
      cwd: '/work/repo',
      resume: 'session-1',
      title: 'review',
      host,
      agentOptions: {
        copilotHome: '/tmp/copilot-home',
        name: 'native-review',
        model: 'gpt-5',
        effort: 'high',
        mode: 'autopilot',
        allowAll: true,
      },
    });
    expect(adapters.createCopilotTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        resume: 'session-1',
        title: 'native-review',
        host,
        executable: '/opt/copilot',
        copilotHome: '/tmp/copilot-home',
        model: 'gpt-5',
        effort: 'high',
        mode: 'autopilot',
        allowAll: true,
      }),
    );

    await pi.createSession({
      cwd: '/work/repo',
      resume: 'session-2',
      title: 'review',
      host,
      agentOptions: {
        sessionDir: '/tmp/pi-sessions',
        provider: 'openai',
        model: 'gpt-5',
        thinking: 'high',
      },
    });
    expect(adapters.createPiTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work/repo',
        resume: 'session-2',
        host,
        executable: '/opt/pi',
        sessionDir: '/tmp/pi-sessions',
        provider: 'openai',
        model: 'gpt-5',
        thinking: 'high',
        name: 'review',
      }),
    );

    await antigravity.prepareSession!({ cwd: '/work/repo', host });
    await copilot.prepareSession!({
      cwd: '/work/repo',
      title: 'consumer-title',
      host,
      agentOptions: { name: 'native-title' },
    });
    await pi.prepareSession!({ cwd: '/work/repo', host });
    expect(adapters.prepareAntigravityTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/work/repo', executable: '/opt/agy', host }),
    );
    expect(adapters.prepareCopilotTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/work/repo', executable: '/opt/copilot', title: 'native-title', host }),
    );
    expect(adapters.preparePiTuiSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/work/repo', executable: '/opt/pi', host }),
    );
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
    const claude = providers.find((provider) => provider.descriptor.id === 'claude')!;
    const codex = providers.find((provider) => provider.descriptor.id === 'codex')!;
    const acp = providers.find((provider) => provider.descriptor.id === 'acp')!;
    const grok = providers.find((provider) => provider.descriptor.id === 'grok')!;
    const kimi = providers.find((provider) => provider.descriptor.id === 'kimi')!;
    const opencode = providers.find((provider) => provider.descriptor.id === 'opencode')!;
    const hermes = providers.find((provider) => provider.descriptor.id === 'hermes')!;

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
        observeSubagentStatus: true,
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
  agentOptions: { yolo: false },
};
void typedHermesRequest;

const typedAntigravityRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'antigravity',
  agentOptions: { model: 'gemini-pro', effort: 'high', mode: 'plan' },
};
void typedAntigravityRequest;

const typedCopilotRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'copilot',
  agentOptions: { model: 'gpt-5', effort: 'high', mode: 'autopilot' },
};
void typedCopilotRequest;

const typedPiRequest: BuiltinCreateAgentSessionOptions = {
  agent: 'pi',
  agentOptions: { provider: 'openai', model: 'gpt-5', thinking: 'high' },
};
void typedPiRequest;

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
