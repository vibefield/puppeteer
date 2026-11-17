/**
 * Native-TUI evidence capture for Antigravity 1.4.12 (staging step C5, run in step C6).
 *
 * Evidence, not proof: it never attests, never asserts the surface version, and runs only when
 * ANTIGRAVITY_TUI_CAPTURE=1, which no workflow sets. macOS only: every launch runs under `sandbox-exec` with a
 * loopback-only network profile against a loopback Gemini provider and a dummy key. It never signs in. Each
 * scenario copies its journals and a store inventory into ANTIGRAVITY_TUI_CAPTURE_DIR before its disposable
 * root is removed. The runbook is packages/surface/vendors/antigravity/census/README.md.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type { TerminalSpec } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { describe, expect, it } from 'vitest';
import { parseAntigravityVersion } from './detection.js';
import { createAntigravityTuiSession } from './driver.js';
import {
  ANTIGRAVITY_CAPTURE_COMMANDS,
  ANTIGRAVITY_CAPTURE_TOOL_PROMPT,
  ANTIGRAVITY_CAPTURE_TOOL_REPLY,
  antigravityCaptureReplyPrompt,
  antigravityCaptureReplyToken,
  startAntigravityCaptureProvider,
  type AntigravityCaptureProvider,
  type AntigravityCaptureToolVariant,
} from './test-support/capture-model.js';
import {
  ANTIGRAVITY_CAPTURE_PATH,
  ANTIGRAVITY_CAPTURE_SANDBOX_EXEC,
  ANTIGRAVITY_CAPTURE_SANDBOX_PROFILE,
  ANTIGRAVITY_CAPTURE_SHELL,
  ANTIGRAVITY_FIRST_RUN_PATTERNS,
  AntigravityCapturePtyHost,
  AntigravityCaptureStopPointReached,
  AntigravityVendorLoginError,
  firstRunMatches,
  type AntigravityCaptureStopPoint,
  looksLikeLoginScreen,
} from './test-support/capture-pty-host.js';
import {
  CaptureScrubber,
  copyConversationLogs,
  inventory,
  journalHolds,
  operatorHomes,
  type CopiedJournals,
} from './test-support/capture-store.js';
import { delay } from './test-support/live-harness.js';
import { isolatedAntigravityLiveEnvironment } from './test-support/live-model.js';

const ENABLED = process.env.ANTIGRAVITY_TUI_CAPTURE === '1';
const SCENARIOS = [
  'screens',
  'screens-terms',
  'screens-trust',
  'basic-chat',
  'resume',
  'tool-success',
  'tool-failure',
] as const;
type Scenario = (typeof SCENARIOS)[number];

/**
 * The stop-point scenarios walk the first-run screens as far as the named one, record it and send none of its keys,
 * so a person reads each screen before a later run answers it: `screens-terms` answers only the color scheme,
 * `screens-trust` the color scheme and the terms (collection unchecked).
 */
const STOP_POINTS: Partial<Record<Scenario, AntigravityCaptureStopPoint>> = {
  'screens-terms': 'terms',
  'screens-trust': 'trust',
};

/** Whether a scenario answers the terms screen, and so needs the disposable-terms approval. */
function answersTerms(scenario: Scenario): boolean {
  return scenario !== 'screens' && scenario !== 'screens-terms';
}
const SELECTED = (process.env.ANTIGRAVITY_TUI_CAPTURE_SCENARIOS ?? 'screens')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

/** The farm's settings plus telemetry off: `always-proceed` keeps a tool call from raising an approval prompt. */
const CAPTURE_SETTINGS = { modelProvider: 'gemini', enableTelemetry: false, toolPermission: 'always-proceed' };
const CAPTURE_FORMAT = 'puppeteer-antigravity-tui-capture/1';
const SCREENS_TIMEOUT_MS = 45_000;
const SCREENS_STABLE_MS = 5_000;
const TURN_TIMEOUT_MS = 90_000;
const SETTLE_MS = 2_000;

type CaptureSession = Awaited<ReturnType<typeof createAntigravityTuiSession>>;
type CaptureProjection = ReturnType<typeof projectAgentEvents>;

interface CaptureConfig {
  readonly output: string;
  readonly executable: string;
  readonly expectedSha256: string;
  readonly termsApproved: boolean;
}

function captureConfig(scenario: Scenario): CaptureConfig {
  const outputRoot = process.env.ANTIGRAVITY_TUI_CAPTURE_DIR ?? '';
  if (!isAbsolute(outputRoot)) throw new Error('ANTIGRAVITY_TUI_CAPTURE_DIR must name an absolute output directory');
  const executable = process.env.PUPPETEER_ANTIGRAVITY_BIN ?? '';
  if (!isAbsolute(executable) || !existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error('PUPPETEER_ANTIGRAVITY_BIN must name the exact executable by absolute path (no PATH lookup)');
  }
  const underHome = (path: string): boolean =>
    operatorHomes().some((home) => path === home || path.startsWith(`${home}${sep}`));
  if (underHome(executable) || underHome(realpathSync(executable))) {
    throw new Error("PUPPETEER_ANTIGRAVITY_BIN must live outside the runner's home; a binary under it names the home");
  }
  const expectedSha256 = process.env.ANTIGRAVITY_TUI_CAPTURE_SHA256 ?? '';
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('ANTIGRAVITY_TUI_CAPTURE_SHA256 must be the pinned executable SHA-256 (64 lowercase hex)');
  }
  if (answersTerms(scenario) && process.env.ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED !== '1') {
    throw new Error(
      `${scenario} answers the first-run terms: set ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED to the literal '1' ` +
        "(AGY_CLI_DISABLE_AUTO_UPDATE is the one that takes 'true')",
    );
  }
  if (!existsSync(ANTIGRAVITY_CAPTURE_SANDBOX_EXEC)) throw new Error('the capture needs macOS sandbox-exec');
  const output = join(outputRoot, scenario);
  if (existsSync(output)) throw new Error(`refusing to overwrite the existing ${scenario} capture`);
  return { output, executable, expectedSha256, termsApproved: answersTerms(scenario) };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The attested lane's isolated environment with `PATH` and `SHELL` fixed, so no runner home path is passed on. */
function captureEnvironment(root: string, home: string, baseUrl: string): Record<string, string> {
  const env: Record<string, string> = {
    ...isolatedAntigravityLiveEnvironment(root, home, baseUrl),
    PATH: ANTIGRAVITY_CAPTURE_PATH,
    SHELL: ANTIGRAVITY_CAPTURE_SHELL,
  };
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(CAPTURE_SETTINGS));
  if (env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true') throw new Error("AGY_CLI_DISABLE_AUTO_UPDATE must be 'true'");
  return env;
}

/** `--version` in its own disposable home, under the same sandbox. Recorded, never compared with a pin. */
function probeVersion(executable: string, env: Record<string, string>, home: string) {
  mkdirSync(home, { recursive: true });
  const args = ['-p', ANTIGRAVITY_CAPTURE_SANDBOX_PROFILE, executable, '--version'];
  const result = spawnSync(ANTIGRAVITY_CAPTURE_SANDBOX_EXEC, args, {
    env: { ...env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return { status: result.status, output, parsed: parseAntigravityVersion(output) ?? null };
}

async function waitForJournal(
  dataRoot: string,
  token: string,
  host: AntigravityCapturePtyHost,
  runtimeSessionId: string,
  provider: AntigravityCaptureProvider,
): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (journalHolds(dataRoot, token)) return;
    if (host.loginScreenSettled(runtimeSessionId)) {
      host.record(runtimeSessionId, `journal:${token}:login`);
      throw new AntigravityVendorLoginError(`the ${token} turn`);
    }
    if (host.exited(runtimeSessionId)) break;
    await delay(100);
  }
  host.record(runtimeSessionId, `journal:${token}:timeout`);
  const declared = provider.records.some((record) => record.runCommandDeclared);
  throw new Error(
    `no journal record holds ${token} (provider requests ${provider.records.length}, ` +
      `run_command declared ${declared}, calls issued ${provider.functionCallsIssued()})`,
  );
}

/** Screens only: launch, send nothing, and keep every distinct screen until it settles. */
async function captureScreens(host: AntigravityCapturePtyHost, launch: TerminalSpec) {
  const { runtimeSessionId } = await host.launch(launch);
  const snapshots: Array<{ atMs: number; screen: string; matches: string[] }> = [];
  const started = Date.now();
  let last = '';
  let changedAt = started;
  while (Date.now() - started < SCREENS_TIMEOUT_MS && !host.exited(runtimeSessionId) && snapshots.length < 200) {
    const screen = host.screen(runtimeSessionId);
    if (screen !== last) {
      snapshots.push({ atMs: Date.now() - started, screen, matches: firstRunMatches(screen) });
      last = screen;
      changedAt = Date.now();
    } else if (screen.trim() && Date.now() - changedAt >= SCREENS_STABLE_MS) {
      break;
    }
    await delay(250);
  }
  host.record(runtimeSessionId, 'screens:final');
  return {
    runtimeSessionId,
    result: {
      keysSent: 0,
      exitedBeforeCapture: host.exited(runtimeSessionId),
      loginScreen: snapshots.some(({ screen }) => looksLikeLoginScreen(screen)),
      patterns: ANTIGRAVITY_FIRST_RUN_PATTERNS.map(({ id, pattern }) => ({
        id,
        pattern: pattern.source,
        matchedFinal: pattern.test(last),
        matchedAny: snapshots.some(({ screen }) => pattern.test(screen)),
      })),
      snapshots,
    },
  };
}

function toolVariant(scenario: Scenario): AntigravityCaptureToolVariant | undefined {
  if (scenario === 'tool-success') return 'success';
  if (scenario === 'tool-failure') return 'failure';
  return undefined;
}

function adapterEventSummary(phase: string, projection: CaptureProjection) {
  const envelopes = projection.envelopes;
  return {
    phase,
    types: envelopes.map(({ event }) => event.type),
    tool: envelopes.filter(({ event }) => event.type.startsWith('tool:')).map(({ event }) => event),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCapture(scenario: Scenario): Promise<void> {
  const config = captureConfig(scenario);
  const startedAt = new Date().toISOString();
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-antigravity-capture-')));
  const scrubber = new CaptureScrubber(root);
  const cwd = join(root, 'workspace');
  const home = join(root, 'home');
  const dataRoot = join(home, '.gemini', 'antigravity-cli');
  const variant = toolVariant(scenario);
  const stopPoint = STOP_POINTS[scenario];
  const host = new AntigravityCapturePtyHost({ termsApproved: config.termsApproved, stopBefore: stopPoint });
  const notes: Record<string, unknown> = {};
  const prompts: string[] = [];
  const adapterEvents: Array<ReturnType<typeof adapterEventSummary>> = [];
  const live: Array<{ phase: string; session: CaptureSession; projection: CaptureProjection }> = [];
  const cleanupErrors: string[] = [];
  let provider: AntigravityCaptureProvider | undefined;
  let env: Record<string, string> = {};
  let sha256Before: string | null = null;
  let sha256After: string | null = null;
  let version: ReturnType<typeof probeVersion> | undefined;
  let screens: Awaited<ReturnType<typeof captureScreens>>['result'] | undefined;
  let failure: unknown;

  const running = (): AntigravityCaptureProvider => {
    if (!provider) throw new Error('the capture provider is not running');
    return provider;
  };
  const start = async (phase: string, resume?: string): Promise<CaptureSession> => {
    const session = await createAntigravityTuiSession({
      cwd,
      host,
      executable: config.executable,
      env,
      antigravityHome: home,
      resume,
      pollIntervalMs: 25,
      promptConfirmationTimeoutMs: 30_000,
    });
    live.push({ phase, session, projection: projectAgentEvents(session) });
    return session;
  };
  const turn = async (session: CaptureSession, prompt: string, token: string): Promise<void> => {
    prompts.push(prompt);
    const receipt = await session.services.prompt.submit({ text: prompt });
    notes[`receipt:${token}`] = receipt.status;
    await waitForJournal(dataRoot, token, host, session.runtimeSessionId, running());
    await delay(SETTLE_MS);
    host.record(session.runtimeSessionId, `after:${token}`);
  };
  /** Stop one launch: its adapter events are summarized, then its PTY group and its observer are stopped. */
  const stop = async (entry: (typeof live)[number], suffix = ''): Promise<void> => {
    live.splice(live.indexOf(entry), 1);
    host.record(entry.session.runtimeSessionId, `${entry.phase}${suffix}:before-dispose`);
    adapterEvents.push(adapterEventSummary(`${entry.phase}${suffix}`, entry.projection));
    entry.projection.dispose();
    await host.disposeTerminal(entry.session.runtimeSessionId);
    await entry.session.dispose();
  };
  const stopSession = async (session: CaptureSession): Promise<void> => {
    const entry = live.find((candidate) => candidate.session === session);
    if (entry) await stop(entry);
  };

  try {
    // Setup is inside the try: a throw here still reaches the copy, the provider's close and the root's removal.
    mkdirSync(cwd, { recursive: true });
    const started = await startAntigravityCaptureProvider({ tool: variant });
    provider = started;
    env = captureEnvironment(root, home, started.baseUrl);
    sha256Before = sha256File(config.executable);
    expect(sha256Before, 'the executable is not the pinned artifact').toBe(config.expectedSha256);
    version = probeVersion(config.executable, env, join(root, 'probe-home'));
    if (scenario === 'screens') {
      const captured = await captureScreens(host, { command: config.executable, args: [], cwd, env });
      screens = captured.result;
      await host.disposeTerminal(captured.runtimeSessionId);
    } else if (stopPoint) {
      // The walk throws at its stop point; reaching the composer instead means the screen never came.
      try {
        const { runtimeSessionId } = await host.spawnTerminal({ command: config.executable, args: [], cwd, env });
        await host.disposeTerminal(runtimeSessionId);
        throw new Error(`the first-run walk reached the composer without meeting the ${stopPoint} screen`);
      } catch (error) {
        if (!(error instanceof AntigravityCaptureStopPointReached) || error.stage !== stopPoint) throw error;
        notes.stoppedBefore = error.stage;
      }
    } else if (scenario === 'basic-chat') {
      const session = await start('first');
      notes.sessionIdBeforeTurn = session.sessionId;
      await turn(session, antigravityCaptureReplyPrompt('CHAT'), antigravityCaptureReplyToken('CHAT'));
      notes.sessionId = session.sessionId;
      await stopSession(session);
    } else if (scenario === 'resume') {
      const first = await start('first');
      await turn(first, antigravityCaptureReplyPrompt('CHAT'), antigravityCaptureReplyToken('CHAT'));
      const sessionId = first.sessionId;
      notes.sessionId = sessionId;
      await stopSession(first);
      notes.providerRequestsBeforeResume = started.records.length;
      const resumed = await start('resumed', sessionId);
      notes.resumedSameSession = resumed.sessionId === sessionId;
      await turn(resumed, antigravityCaptureReplyPrompt('RESUME'), antigravityCaptureReplyToken('RESUME'));
      await stopSession(resumed);
      expect(notes.resumedSameSession, 'the resumed launch bound a different conversation').toBe(true);
    } else {
      const session = await start('first');
      await turn(session, ANTIGRAVITY_CAPTURE_TOOL_PROMPT, ANTIGRAVITY_CAPTURE_TOOL_REPLY);
      notes.sessionId = session.sessionId;
      await stopSession(session);
      expect(started.functionCallsIssued(), 'the provider issued no run_command call').toBe(1);
      expect(started.functionResponsesSeen(), 'the binary never reported the command result').toBeGreaterThan(0);
    }
  } catch (error) {
    failure = error;
  }

  // Cleanup never skips the copy: a failed run's journals and screens are its diagnosis.
  for (const entry of [...live]) {
    try {
      await stop(entry, ':cleanup');
    } catch (error) {
      cleanupErrors.push(errorText(error));
    }
  }
  /** One cleanup or copy step: a throw is recorded and never skips the steps after it, the manifest or the removal. */
  const keep = async (label: string, step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      cleanupErrors.push(`${label}: ${errorText(error)}`);
    }
  };
  await keep('host', () => host.dispose());
  if (provider) await keep('provider', () => running().close());
  try {
    sha256After = sha256File(config.executable);
  } catch (error) {
    cleanupErrors.push(`executable digest after: ${errorText(error)}`);
  }

  // Everything leaves the disposable root before it is removed.
  let journals: CopiedJournals = { conversations: [], copied: [], withheldBinary: [], unreadable: [] };
  await keep('output directory', () => {
    mkdirSync(config.output, { recursive: true });
  });
  await keep('screens', () => {
    const screensDocument = screens ? { stages: host.stages, screensOnly: screens } : { stages: host.stages };
    scrubber.writeJson(join(config.output, 'screens.json'), screensDocument);
  });
  await keep('provider requests', () => {
    scrubber.writeJson(join(config.output, 'provider-requests.json'), {
      runCommandDeclaration: provider?.runCommandDeclaration() ?? null,
      requests: provider?.records ?? [],
    });
  });
  await keep('adapter events', () => {
    scrubber.writeJson(join(config.output, 'adapter-events.json'), adapterEvents);
  });
  await keep('journals', () => {
    journals = copyConversationLogs(dataRoot, config.output, scrubber);
  });
  await keep('store inventory', () => {
    scrubber.writeJson(join(config.output, 'store-inventory.json'), {
      home: inventory(root, home, scrubber),
      workspace: inventory(root, cwd, scrubber),
    });
  });
  await keep('disposable root not removed', () => {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  scrubber.writeJson(join(config.output, 'capture.json'), {
    format: CAPTURE_FORMAT,
    vendor: 'antigravity',
    scenario,
    outcome: failure === undefined ? 'passed' : 'failed',
    error: failure === undefined ? null : errorText(failure),
    cleanupErrors,
    startedAt,
    finishedAt: new Date().toISOString(),
    host: { platform: `${process.platform}-${arch()}`, osRelease: release() },
    executable: {
      expectedSha256: config.expectedSha256,
      sha256Before,
      sha256After,
      unchanged: sha256Before !== null && sha256Before === sha256After,
    },
    version: version ?? null,
    network: { confinement: 'sandbox-exec', profile: ANTIGRAVITY_CAPTURE_SANDBOX_PROFILE },
    provider: {
      kind: 'loopback-gemini',
      apiKey: 'dummy',
      requests: provider?.records.length ?? 0,
      wrappedRequests: provider?.records.filter((record) => record.wrapped).length ?? 0,
      toolVariant: variant ?? null,
      command: variant ? ANTIGRAVITY_CAPTURE_COMMANDS[variant] : null,
      functionCallsIssued: provider?.functionCallsIssued() ?? 0,
      functionResponsesSeen: provider?.functionResponsesSeen() ?? 0,
    },
    environment: {
      PATH: env.PATH ?? null,
      SHELL: env.SHELL ?? null,
      AGY_CLI_DISABLE_AUTO_UPDATE: env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
      AGY_CLI_HIDE_ACCOUNT_INFO: env.AGY_CLI_HIDE_ACCOUNT_INFO ?? null,
      ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED: config.termsApproved ? '1' : 'not used (the terms are not answered)',
    },
    settings: CAPTURE_SETTINGS,
    firstRun: {
      keysSent: scenario !== 'screens',
      collectionCheckboxUnchecked: host.stages.some(({ stage }) => stage === 'collection-unchecked'),
    },
    prompts,
    notes,
    journals,
    privacy: { operatorHomeHits: scrubber.operatorHomeHits, operatorNameHits: scrubber.operatorNameHits },
  });

  // What reaches the runner's console is scrubbed too (not counted: the counts above are what was written).
  if (failure !== undefined) throw new Error(scrubber.redact(errorText(failure)));
  expect(cleanupErrors.map((error) => scrubber.redact(error))).toEqual([]);
  expect(sha256After, 'the executable changed during the capture').toBe(config.expectedSha256);
}

describe.runIf(ENABLED && process.platform !== 'darwin')('Antigravity native-TUI capture (macOS only)', () => {
  it('refuses to run off macOS', () => {
    throw new Error('the Antigravity native-TUI capture runs only on macOS (sandbox-exec loopback confinement)');
  });
});

describe.runIf(ENABLED && process.platform === 'darwin')('Antigravity native-TUI capture (evidence only)', () => {
  it('names at least one scenario, and only known ones', () => {
    expect(SELECTED.length, 'ANTIGRAVITY_TUI_CAPTURE_SCENARIOS names no scenario').toBeGreaterThan(0);
    expect(SELECTED.filter((name) => !(SCENARIOS as readonly string[]).includes(name))).toEqual([]);
  });
  for (const scenario of SCENARIOS) {
    it.runIf(SELECTED.includes(scenario))(
      `captures ${scenario}`,
      () => runCapture(scenario),
      scenario === 'screens' ? 120_000 : 300_000,
    );
  }
});
