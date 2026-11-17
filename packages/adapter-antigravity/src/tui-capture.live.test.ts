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
import { isAbsolute, join } from 'node:path';
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
  ANTIGRAVITY_CAPTURE_SANDBOX_EXEC,
  ANTIGRAVITY_CAPTURE_SANDBOX_PROFILE,
  ANTIGRAVITY_FIRST_RUN_PATTERNS,
  AntigravityCapturePtyHost,
  AntigravityVendorLoginError,
  firstRunMatches,
  looksLikeLoginScreen,
} from './test-support/capture-pty-host.js';
import { CaptureScrubber, copyConversationLogs, inventory, journalHolds } from './test-support/capture-store.js';
import { delay } from './test-support/live-harness.js';
import { isolatedAntigravityLiveEnvironment } from './test-support/live-model.js';

const ENABLED = process.env.ANTIGRAVITY_TUI_CAPTURE === '1';
const SCENARIOS = ['screens', 'basic-chat', 'resume', 'tool-success', 'tool-failure'] as const;
type Scenario = (typeof SCENARIOS)[number];
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
  const expectedSha256 = process.env.ANTIGRAVITY_TUI_CAPTURE_SHA256 ?? '';
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('ANTIGRAVITY_TUI_CAPTURE_SHA256 must be the pinned executable SHA-256 (64 lowercase hex)');
  }
  if (scenario !== 'screens' && process.env.ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED !== '1') {
    throw new Error(
      `${scenario} answers the first-run terms: set ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED to the literal '1' ` +
        "(AGY_CLI_DISABLE_AUTO_UPDATE is the one that takes 'true')",
    );
  }
  if (!existsSync(ANTIGRAVITY_CAPTURE_SANDBOX_EXEC)) throw new Error('the capture needs macOS sandbox-exec');
  const output = join(outputRoot, scenario);
  if (existsSync(output)) throw new Error(`refusing to overwrite the existing ${scenario} capture`);
  return { output, executable, expectedSha256, termsApproved: scenario !== 'screens' };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function captureEnvironment(root: string, home: string, baseUrl: string): Record<string, string> {
  const env = isolatedAntigravityLiveEnvironment(root, home, baseUrl);
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
  mkdirSync(cwd, { recursive: true });
  const variant = toolVariant(scenario);
  const provider = await startAntigravityCaptureProvider({ tool: variant });
  const env = captureEnvironment(root, home, provider.baseUrl);
  const host = new AntigravityCapturePtyHost({ termsApproved: config.termsApproved });
  const notes: Record<string, unknown> = {};
  const prompts: string[] = [];
  const adapterEvents: Array<ReturnType<typeof adapterEventSummary>> = [];
  const live: Array<{ phase: string; session: CaptureSession; projection: CaptureProjection }> = [];
  const cleanupErrors: string[] = [];
  const sha256Before = sha256File(config.executable);
  let version: ReturnType<typeof probeVersion> | undefined;
  let screens: Awaited<ReturnType<typeof captureScreens>>['result'] | undefined;
  let failure: unknown;

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
    await waitForJournal(dataRoot, token, host, session.runtimeSessionId, provider);
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
    expect(sha256Before, 'the executable is not the pinned artifact').toBe(config.expectedSha256);
    version = probeVersion(config.executable, env, join(root, 'probe-home'));
    if (scenario === 'screens') {
      const captured = await captureScreens(host, { command: config.executable, args: [], cwd, env });
      screens = captured.result;
      await host.disposeTerminal(captured.runtimeSessionId);
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
      notes.providerRequestsBeforeResume = provider.records.length;
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
      expect(provider.functionCallsIssued(), 'the provider issued no run_command call').toBe(1);
      expect(provider.functionResponsesSeen(), 'the binary never reported the command result').toBeGreaterThan(0);
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
  try {
    await host.dispose();
  } catch (error) {
    cleanupErrors.push(errorText(error));
  }
  await provider.close();
  const sha256After = sha256File(config.executable);

  // Everything leaves the disposable root before it is removed.
  mkdirSync(config.output, { recursive: true });
  const screensDocument = screens ? { stages: host.stages, screensOnly: screens } : { stages: host.stages };
  scrubber.writeJson(join(config.output, 'screens.json'), screensDocument);
  scrubber.writeJson(join(config.output, 'provider-requests.json'), {
    runCommandDeclaration: provider.runCommandDeclaration() ?? null,
    requests: provider.records,
  });
  scrubber.writeJson(join(config.output, 'adapter-events.json'), adapterEvents);
  const journals = copyConversationLogs(dataRoot, config.output, scrubber);
  scrubber.writeJson(join(config.output, 'store-inventory.json'), {
    home: inventory(root, home, scrubber),
    workspace: inventory(root, cwd, scrubber),
  });
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch (error) {
    cleanupErrors.push(`disposable root not removed: ${errorText(error)}`);
  }
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
      unchanged: sha256Before === sha256After,
    },
    version: version ?? null,
    network: { confinement: 'sandbox-exec', profile: ANTIGRAVITY_CAPTURE_SANDBOX_PROFILE },
    provider: {
      kind: 'loopback-gemini',
      apiKey: 'dummy',
      requests: provider.records.length,
      toolVariant: variant ?? null,
      command: variant ? ANTIGRAVITY_CAPTURE_COMMANDS[variant] : null,
      functionCallsIssued: provider.functionCallsIssued(),
      functionResponsesSeen: provider.functionResponsesSeen(),
    },
    environment: {
      AGY_CLI_DISABLE_AUTO_UPDATE: env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
      AGY_CLI_HIDE_ACCOUNT_INFO: env.AGY_CLI_HIDE_ACCOUNT_INFO ?? null,
      ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED: config.termsApproved ? '1' : 'not used (no keys sent)',
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

  if (failure !== undefined) throw failure;
  expect(cleanupErrors).toEqual([]);
  expect(sha256After, 'the executable changed during the capture').toBe(config.expectedSha256);
}

describe.runIf(ENABLED && process.platform !== 'darwin')('Antigravity native-TUI capture (macOS only)', () => {
  it('refuses to run off macOS', () => {
    throw new Error('the Antigravity native-TUI capture runs only on macOS (sandbox-exec loopback confinement)');
  });
});

describe.runIf(ENABLED && process.platform === 'darwin')('Antigravity native-TUI capture (evidence only)', () => {
  it('names only known scenarios', () => {
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
