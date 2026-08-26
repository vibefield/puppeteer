import { randomBytes, randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open as openFile, writeFile } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, powerMonitor, shell } from 'electron';
import {
  allSettledWithin,
  GhostteaElectronBackend,
  GhostteaConfigDocumentConflictError,
  installGhostteaClipboardHost,
  installGhostteaEditShortcuts,
  type GhostteaAutomationClient,
  type GhostteaElectronBackendOptions,
  type SessionExitedEvent,
} from '@vibecook/ghosttea-electron/main';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentHost } from '@vibecook/puppeteer-core';
import { createBuiltinAgentRuntime, type BuiltinExecutableAgentKind } from '@vibecook/puppeteer-builtin-providers';
import { createActionRecorder } from '@vibecook/puppeteer-record';
import type { GodviewTheme } from '../appearance-themes.js';
import {
  buildAgentEnvironment,
  connectMonitorIpcRelay,
  acknowledgeAgentFailureForIpc,
  formatMonitorCanaryTrace,
  MonitorIpcRelay,
  readAgentMonitorArtifactForIpc,
  resolveMonitorHostFeatureFlags,
  serializeLegacySessionState,
  type AgentRuntime,
  type AgentWorkspaceFinal,
  type AgentWorkspaceRequest,
  type MonitorShadowMismatchReport,
} from '@vibecook/puppeteer-runtime';
import type {
  AgentAccountUsageBatch,
  AgentSessionInfo,
  AgentSessionSnapshot,
  AgentStateBatch,
  AgentStateMessage,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PaneRehydrationRequest,
  PromptReceipt,
  ScenarioRecordingStatus,
  StartScenarioRecordingResult,
  SubmitPromptOptions,
  TerminalSessionHandoff,
} from '../protocol.js';
import { createAccountUsageMonitor } from './account-usage-monitor.js';
import {
  APPEARANCE_BLOCK_START,
  appearanceBlock,
  appearanceUpdateMismatches,
  patchAppearanceBlock,
  validateAppearanceUpdate,
  type ManagedAppearanceUpdate,
} from './appearance-config.js';
import {
  appearanceThemeFromRenderer,
  appearanceUpdateForMode,
  defaultAppearanceProfiles,
  parseAppearanceProfiles,
  replaceAppearanceProfile,
  serializeAppearanceProfiles,
  type AppearanceProfiles,
} from './appearance-profiles.js';
import {
  MAX_CONFIG_EDITOR_BYTES,
  assertConfigDocumentIncludesAuthorized,
  blockingConfigDiagnostics,
  serializeSupportedGhosttyConfig,
  trustedConfigEditorRendererUrl,
  validateConfigContents,
  validateConfigSaveRequest,
} from './config-editor.js';
import {
  missingManagedSessionIds,
  resolveRestoredSessionAlias,
  restoredSessionAliasOrigins,
  setRestoredSessionAlias,
} from './session-recovery.js';
import {
  prepareSpawnThroughLaunch,
  startSpawnThroughGateway,
  type SpawnThroughGateway,
  type SpawnThroughRequest,
  type SpawnThroughResponse,
} from './spawn-through.js';
import { orderNativeTabs } from './native-tab-order.js';
import { resolveProcessCwd } from './process-cwd.js';
import { GodviewTabRegistry } from './tab-registry.js';
import { godviewTruffleConfig } from './truffle-config.js';
import { LatestValueQueue } from './latest-value-queue.js';
import { allocateWorkspaceSlot } from './workspace-slots.js';
import { RESTORE_MANIFEST_VERSION, type RestoreManifest } from './restore-manifest.js';
import { readRestoreManifest, restorePaneFor, restorePromptDetail, summarizeRestore } from './restore-plan.js';
import {
  buildRestoreSnapshot,
  MAX_RESTORE_PANES_PER_WINDOW,
  paneRecoveryMetadata,
  preferredRestoreWindow,
  readPaneRecoveryMetadata,
  readRestoreWorkspaceDocument,
  restoreWorkspaceSessionIds,
  restoredAgentOptions,
  snapshotAgent,
  snapshotReferencedSessionIds,
  summarizeRestoreSnapshot,
  type RestoreDescriptor,
  type RestoreAgentLaunchProvenance,
  type RestoreSnapshot,
  type RestoreSnapshotAgent,
  type RestoreSnapshotAgentInput,
  type RestoreWorkspaceDocument,
} from '../restore-snapshot.js';
import { claudeRestoreLaunchProvenance } from './restore-launch.js';
import { discardDurableRestoreState, readDurableRestoreState, writeDurableRestoreState } from './restore-store.js';
import { createClaudeScenarioRecorder, type RecordedClaudeScenario } from './scenario-recorder.js';

declare const __dirname: string;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const AGENT_FLUSH_MS = 16;
const ADOPTED_PROCESS_EXIT_GRACE_MS = 5_000;
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 7_000;
const SMOKE = process.argv.includes('--smoke');
const APPEARANCE_SMOKE = process.argv.includes('--appearance-smoke');
const RESTORE_SMOKE_ARGUMENT = process.argv.find(
  (argument) => argument === '--restore-smoke' || argument.startsWith('--restore-smoke='),
);
const RESTORE_SMOKE = RESTORE_SMOKE_ARGUMENT !== undefined;
const RESTORE_SMOKE_PHASE = RESTORE_SMOKE_ARGUMENT?.split('=', 2)[1];
const AGENT_SMOKE = process.env.PUPPETEER_AGENT_SMOKE as BuiltinExecutableAgentKind | undefined;
const SPAWN_THROUGH_SMOKE = process.argv
  .find((argument) => argument.startsWith('--spawn-through-smoke='))
  ?.slice('--spawn-through-smoke='.length) as BuiltinExecutableAgentKind | undefined;
const CLAUDE_RAIL_FAILURE_SMOKE =
  SPAWN_THROUGH_SMOKE === 'claude' && process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_RAIL_FAILURE === '1';
const CLAUDE_RAIL_FAILURE_OCCURRENCE = (() => {
  const raw = process.env.PUPPETEER_SPAWN_SMOKE_RAIL_FAILURE_OCCURRENCE?.trim();
  if (!raw) return undefined;
  const occurrence = Number(raw);
  if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 100) {
    throw new Error('PUPPETEER_SPAWN_SMOKE_RAIL_FAILURE_OCCURRENCE must be an integer from 1 through 100');
  }
  return occurrence;
})();
const monitorHostFeatures = resolveMonitorHostFeatureFlags(process.argv);
const appRoot = resolve(__dirname, '..');
const repoRoot = resolve(appRoot, '../..');
const ghostteadBinaryName = process.platform === 'win32' ? 'ghosttead.exe' : 'ghosttead';
const nativeTabAddonPaths = [
  join(app.getAppPath(), 'dist', 'native', 'ghosttea_native_tabs.node'),
  join(process.resourcesPath, 'native', 'ghosttea_native_tabs.node'),
];
const originalPath = process.env.PATH ?? '';

function executableOnOriginalPath(command: string): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes('/')
      ? [resolve(command)]
      : originalPath
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the original PATH.
    }
  }
  return undefined;
}

const realAgentExecutables: Partial<Record<BuiltinExecutableAgentKind, string>> = Object.fromEntries(
  (['claude', 'codex', 'grok', 'kimi', 'opencode'] as const).flatMap((agent) => {
    const configured = process.env[`PUPPETEER_${agent.toUpperCase()}_BIN`] ?? agent;
    const executable = executableOnOriginalPath(configured);
    return executable ? [[agent, executable]] : [];
  }),
);

/**
 * The puppeteer imposter, found the same way the real agents are.
 *
 * Resolved off PATH rather than through a package dependency, so Godview and
 * the pane agree on which `ai` is in play — the one the package manager
 * installed (`pnpm ai:link`). A build with none simply cannot emulate, which is
 * reported as such rather than silently falling back to the real agent.
 */
const imposterExecutable = executableOnOriginalPath(process.env.PUPPETEER_IMPOSTER_BIN ?? 'ai');

app.setName('Godview');
nativeTheme.themeSource = 'light';
if (process.platform === 'darwin') app.setActivationPolicy('regular');
const terminalConfigPath = join(app.getPath('userData'), 'config.ghostty');
const terminalAppearanceProfilesPath = join(app.getPath('userData'), 'terminal-appearance-profiles.json');
const DEFAULT_TERMINAL_CONFIG = [
  '# Godview terminal overrides (Ghostty-compatible syntax).',
  '# Existing Ghostty config files are imported before this profile-owned overlay.',
  '# Light and dark color selections are stored separately by Godview.',
  '# Use the terminal deck Settings button for themes, opacity, shaders, and advanced settings.',
  '',
].join('\n');
const loadedAppearanceProfiles = loadAppearanceProfiles();
let appearanceProfiles = loadedAppearanceProfiles.profiles;
let appearanceProfilesPersisted = loadedAppearanceProfiles.persisted;
// Truffle state is a single-writer identity store. Native tabs share this
// process; a second Godview process must activate the existing owner instead
// of opening the same state directory concurrently.
const ownsTruffleState = app.requestSingleInstanceLock({ application: 'godview' });
if (!ownsTruffleState) {
  // A smoke run that loses the lock never reaches its assertions, so quitting
  // quietly would report success for work that never happened.
  if (SMOKE || APPEARANCE_SMOKE || SPAWN_THROUGH_SMOKE || RESTORE_SMOKE || AGENT_SMOKE) {
    console.error('another Godview instance owns the Truffle state; smoke did not run');
    app.exit(1);
  }
  app.quit();
}

const clipboardHost = installGhostteaClipboardHost(ipcMain, clipboard);

const tabs = new GodviewTabRegistry<BrowserWindow>();
let backend: GhostteaElectronBackend | undefined;
let activeAppearanceMode: GodviewTheme | undefined;
let appearanceOperationQueue = Promise.resolve();
const dirtyConfigEditorSenders = new Set<Electron.WebContents>();
const pendingDraftCloseConfirmations = new WeakMap<BrowserWindow, Promise<void>>();
let quitDraftConfirmation: Promise<void> | undefined;
let discardDraftsApprovedForQuit = false;
let quitting = false;
let quitReady = false;
let shutdownPromise: Promise<void> | undefined;
let systemShutdownRequested = false;
let recoveringBackend: Promise<void> | undefined;
let lastFocusedWindow: BrowserWindow | undefined;
let spawnThroughGateway: SpawnThroughGateway | undefined;
let spawnThroughDirectory: string | undefined;
let spawnThroughEnvironment: NodeJS.ProcessEnv | undefined;
let remoteSessionsEnabled = true;
const wiredAutomationClients = new WeakSet<GhostteaAutomationClient>();
const managedTerminalIds = new Set<string>();
const exitCleanups = new Set<Promise<unknown>>();
const adoptedProcessMonitors = new Map<string, NodeJS.Timeout>();
const adoptedPreparationSessions = new Map<string, string>();
const pendingTerminalHandoffs = new Map<string, { window: BrowserWindow; timer: NodeJS.Timeout }>();

interface AgentRecord {
  info: AgentSessionInfo;
  session: SessionSummary;
  /** Safe launch provenance needed to resume against the same provider identity. */
  launch?: RestoreAgentLaunchProvenance;
  /** The terminal can remain open after its adopted agent child exits. */
  agentProcessAlive: boolean;
  final?: AgentWorkspaceFinal;
}

/** Main-only provider options used by trusted restore wiring, never renderer IPC. */
type InternalCreateAgentSessionOptions = CreateAgentSessionOptions & { agentOptions?: unknown };

const agentRecords = new Map<string, AgentRecord>();
const dirtyAgentStates = new Set<string>();
let agentFlushTimer: NodeJS.Timeout | undefined;
const scenarioRecorder = createClaudeScenarioRecorder();
const scenarioRecordingFlushTimers = new Map<string, NodeJS.Timeout>();
// Checkpoint at activity bursts without rewriting a growing JSON document for
// every streaming MessageDisplay delta.
const SCENARIO_RECORDING_FLUSH_MS = 1_000;

const RESTORE_CHECKPOINT_DEBOUNCE_MS = 250;
const restoreStateDirectory = join(app.getPath('userData'), 'restore-state');
let restoreCheckpointTimer: NodeJS.Timeout | undefined;
let restoreGeneration = 0;
/** False until startup has either restored or deliberately replaced the saved topology. */
let restoreCheckpointReady = false;
/** Held for the whole run: panes rehydrate as their windows load, not all at startup. */
let restoreSnapshot: RestoreSnapshot | undefined;
/** V1 compatibility: read for one migration cycle and for the existing smoke. */
let restoreManifest: RestoreManifest | undefined;
/** Agents accepted for restore but not yet rebound to a new runtime session. */
const pendingRestoreAgents = new Map<string, RestoreSnapshotAgent>();
/** Old persisted id -> new live id while renderers replace restored panes. */
const restoredSessionAliases = new Map<string, string>();
/** One dead session can appear in several mirrored panes; recover it exactly once. */
const paneRehydrations = new Map<string, Promise<SessionSummary | null>>();

interface AgentStateDelivery {
  queue: LatestValueQueue<string, AgentStateMessage>;
  paused: boolean;
}

const agentStateDeliveries = new Map<number, AgentStateDelivery>();
const spawnThroughShadowMismatches = new Map<string, MonitorShadowMismatchReport>();

function safeSend(window: BrowserWindow, channel: string, value: unknown): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
  try {
    window.webContents.send(channel, value);
    return true;
  } catch {
    // A renderer can disappear between the lifecycle check and send. Periodic
    // producers must stop quietly until did-finish-load resumes delivery.
    return false;
  }
}

function broadcast(channel: string, value: unknown): void {
  for (const record of tabs.records()) {
    safeSend(record.window, channel, value);
  }
}

const monitorRelay = new MonitorIpcRelay({
  enabled: monitorHostFeatures.monitorV2,
  shadowComparison: monitorHostFeatures.shadowComparison,
  onState: (message) => {
    if (monitorHostFeatures.canaryTrace) process.stderr.write(formatMonitorCanaryTrace('state', message));
    broadcast('puppeteer:agent-monitor-state', message);
  },
  onNotification: (message) => {
    if (monitorHostFeatures.canaryTrace) process.stderr.write(formatMonitorCanaryTrace('notification', message));
    broadcast('puppeteer:agent-monitor-notification', message);
  },
  onRemoved: (message) => {
    if (monitorHostFeatures.canaryTrace) process.stderr.write(formatMonitorCanaryTrace('removed', message));
    broadcast('puppeteer:agent-monitor-removed', message);
    if (monitorHostFeatures.godviewMonitorV2 && message.terminalSessionId) {
      agentRecords.delete(message.terminalSessionId);
      discardAgentState(message.terminalSessionId);
      scheduleRestoreCheckpoint(true);
    }
  },
  onShadowMismatch: (report) => {
    if (SPAWN_THROUGH_SMOKE) spawnThroughShadowMismatches.set(report.runtimeRunId, report);
    if (monitorHostFeatures.canaryTrace) process.stderr.write(formatMonitorCanaryTrace('shadow-mismatch', report));
    process.stderr.write(`[main] monitor shadow mismatch ${JSON.stringify(report)}\n`);
  },
});

function scenarioNameFromPath(filePath: string): string {
  const stem = basename(filePath).replace(/\.json$/i, '');
  return (
    stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 128) || 'recorded-claude-session'
  );
}

function writeScenarioRecording(filePath: string, document: RecordedClaudeScenario): void {
  writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

function publishScenarioRecording(status: ScenarioRecordingStatus): void {
  broadcast('puppeteer:scenario-recording', status);
}

function clearScenarioRecordingFlush(runtimeSessionId: string): void {
  const timer = scenarioRecordingFlushTimers.get(runtimeSessionId);
  if (timer) clearTimeout(timer);
  scenarioRecordingFlushTimers.delete(runtimeSessionId);
}

function flushScenarioRecording(runtimeSessionId: string): ScenarioRecordingStatus | undefined {
  const status = scenarioRecorder.status(runtimeSessionId);
  const document = scenarioRecorder.document(runtimeSessionId);
  if (!status || !document) return undefined;
  writeScenarioRecording(status.filePath, document);
  publishScenarioRecording(status);
  return status;
}

function scheduleScenarioRecordingFlush(runtimeSessionId: string): void {
  if (scenarioRecordingFlushTimers.has(runtimeSessionId)) return;
  const timer = setTimeout(() => {
    scenarioRecordingFlushTimers.delete(runtimeSessionId);
    try {
      flushScenarioRecording(runtimeSessionId);
    } catch (error) {
      const status = scenarioRecorder.status(runtimeSessionId);
      const message = error instanceof Error ? error.message : String(error);
      if (status) publishScenarioRecording({ ...status, error: message });
      process.stderr.write(`[main] scenario recording flush failed: ${message}\n`);
    }
  }, SCENARIO_RECORDING_FLUSH_MS);
  timer.unref?.();
  scenarioRecordingFlushTimers.set(runtimeSessionId, timer);
}

function finishScenarioRecording(runtimeSessionId: string): ScenarioRecordingStatus | undefined {
  clearScenarioRecordingFlush(runtimeSessionId);
  const stoppedAt = new Date().toISOString();
  const status = scenarioRecorder.status(runtimeSessionId);
  const document = scenarioRecorder.document(runtimeSessionId, true, stoppedAt);
  if (!status || !document) return undefined;
  try {
    writeScenarioRecording(status.filePath, document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishScenarioRecording({ ...status, error: message });
    throw error;
  }
  const stopped = scenarioRecorder.stop(runtimeSessionId, stoppedAt)!;
  publishScenarioRecording(stopped);
  return stopped;
}

async function startScenarioRecording(
  runtimeSessionId: string,
  owner?: BrowserWindow,
): Promise<StartScenarioRecordingResult> {
  const record = agentRecords.get(runtimeSessionId);
  if (!record || record.info.agent !== 'claude') throw new Error('scenario recording requires a live Claude session');
  if (record.info.emulated) throw new Error('scenario recording is available only for real Claude sessions');
  const existing = scenarioRecorder.status(runtimeSessionId);
  if (existing) return { cancelled: false, status: existing };

  const directory = join(app.getPath('documents'), 'Puppeteer Scenarios');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const dialogOptions: Electron.SaveDialogOptions = {
    title: 'Record Claude hooks as an Imposter scenario',
    message: 'Recorded hooks may contain prompts, tool input and output, and local paths.',
    defaultPath: join(directory, `recorded-claude-${stamp}.json`),
    filters: [{ name: 'Imposter scenario', extensions: ['json'] }],
  };
  const selection = owner
    ? await dialog.showSaveDialog(owner, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);
  if (selection.canceled || !selection.filePath) return { cancelled: true };
  const filePath = selection.filePath.toLowerCase().endsWith('.json')
    ? selection.filePath
    : `${selection.filePath}.json`;
  const status = scenarioRecorder.start({
    runtimeSessionId,
    filePath,
    name: scenarioNameFromPath(filePath),
  });
  try {
    flushScenarioRecording(runtimeSessionId);
  } catch (error) {
    scenarioRecorder.stop(runtimeSessionId);
    throw error;
  }
  return { cancelled: false, status };
}

function stateDeliveryFor(window: BrowserWindow): AgentStateDelivery {
  const id = window.webContents.id;
  let delivery = agentStateDeliveries.get(id);
  if (!delivery) {
    delivery = { queue: new LatestValueQueue(), paused: false };
    agentStateDeliveries.set(id, delivery);
  }
  return delivery;
}

function flushAgentStateDelivery(window: BrowserWindow): void {
  const delivery = stateDeliveryFor(window);
  if (delivery.paused) return;
  const batch = delivery.queue.take();
  if (!batch) return;
  const message: AgentStateBatch = { sequence: batch.sequence, states: batch.values };
  if (!safeSend(window, 'puppeteer:agent-states', message)) {
    delivery.queue.retryInFlight();
    delivery.paused = true;
  }
}

function publishAgentState(message: AgentStateMessage): void {
  for (const record of tabs.records()) {
    if (record.window.isDestroyed() || record.window.webContents.isDestroyed()) continue;
    const delivery = stateDeliveryFor(record.window);
    delivery.queue.enqueue(message.runtimeSessionId, message);
    flushAgentStateDelivery(record.window);
  }
}

function pauseAgentStateDelivery(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const delivery = agentStateDeliveries.get(window.webContents.id);
  if (!delivery) return;
  delivery.queue.retryInFlight();
  delivery.paused = true;
}

function resumeAgentStateDelivery(window: BrowserWindow): void {
  const delivery = stateDeliveryFor(window);
  delivery.queue.retryInFlight();
  delivery.paused = false;
  flushAgentStateDelivery(window);
}

function discardAgentState(runtimeSessionId: string): void {
  dirtyAgentStates.delete(runtimeSessionId);
  for (const delivery of agentStateDeliveries.values()) delivery.queue.delete(runtimeSessionId);
}

function loadAppearanceProfiles(): { profiles: AppearanceProfiles; persisted: boolean } {
  if (!existsSync(terminalAppearanceProfilesPath)) {
    return { profiles: defaultAppearanceProfiles(), persisted: false };
  }
  try {
    return {
      profiles: parseAppearanceProfiles(readFileSync(terminalAppearanceProfilesPath, 'utf8')),
      persisted: true,
    };
  } catch (error) {
    console.warn('[main] ignoring invalid terminal appearance profiles', error);
    return { profiles: defaultAppearanceProfiles(), persisted: false };
  }
}

function persistAppearanceProfiles(profiles: AppearanceProfiles): void {
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
  const temporaryPath = `${terminalAppearanceProfilesPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serializeAppearanceProfiles(profiles), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, terminalAppearanceProfilesPath);
    chmodSync(terminalAppearanceProfilesPath, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  appearanceProfiles = profiles;
  appearanceProfilesPersisted = true;
}

function enqueueAppearanceOperation(operation: () => Promise<void>): Promise<void> {
  const next = appearanceOperationQueue.then(operation, operation);
  appearanceOperationQueue = next.catch(() => undefined);
  return next;
}

function externalBackendConfigured(): boolean {
  return Boolean(
    process.env.GHOSTTEA_EXTERNAL_CONTROL_SOCKET &&
    process.env.GHOSTTEA_EXTERNAL_FRAME_SOCKET &&
    process.env.GHOSTTEA_EXTERNAL_AUTH_TOKEN,
  );
}

async function showExternalConfigOwnershipMessage(
  sender: Electron.WebContents,
  action: 'open' | 'reload',
): Promise<void> {
  const owner = BrowserWindow.fromWebContents(sender);
  const options = {
    type: 'info' as const,
    title: 'Configuration managed externally',
    message: `Godview cannot ${action} this terminal configuration`,
    detail:
      'This window is connected to an externally managed Ghosttea daemon. Open or reload the configuration from the process that started that daemon.',
    buttons: ['OK'],
  };
  if (owner) await dialog.showMessageBox(owner, options);
  else await dialog.showMessageBox(options);
}

function trustedManagedConfigEditorSender(
  sender: Electron.WebContents,
  senderFrame: Electron.WebFrameMain | null,
): boolean {
  return Boolean(
    senderFrame &&
    senderFrame === sender.mainFrame &&
    BrowserWindow.fromWebContents(sender) &&
    trustedConfigEditorRendererUrl(senderFrame.url, undefined, join(__dirname, 'index.html')),
  );
}

async function requireManagedConfigEditor(event: Electron.IpcMainInvokeEvent): Promise<void> {
  const { sender, senderFrame } = event;
  if (!trustedManagedConfigEditorSender(sender, senderFrame)) {
    throw new Error('Configuration editor is unavailable for this sender');
  }
  if (externalBackendConfigured()) {
    await showExternalConfigOwnershipMessage(sender, 'reload');
    throw new Error('Configuration is managed by the external Ghosttea daemon');
  }
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || !tabs.get(owner)) throw new Error('Configuration editor is unavailable for this sender');
  await ensureBackend();
}

function assertProfileConfigDocument(path: string): void {
  if (resolve(path) !== resolve(terminalConfigPath)) {
    throw new Error('ghosttead returned a configuration path outside this Electron profile');
  }
}

async function validateManagedConfigCandidate(
  current: Awaited<ReturnType<GhostteaAutomationClient['getConfigDocument']>>,
  contents: string,
) {
  assertConfigDocumentIncludesAuthorized(current.contents, contents);
  const [baseline, validation] = await Promise.all([
    backend!.automation.validateConfigDocument(current.contents),
    backend!.automation.validateConfigDocument(contents),
  ]);
  return {
    ...validation,
    blockingErrors: blockingConfigDiagnostics(baseline.config.diagnostics, validation.config.diagnostics, current.path),
  };
}

async function readConfigImport(path: string): Promise<string> {
  const file = await openFile(path, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error('Imported configuration must be a regular file');
    if (metadata.size > MAX_CONFIG_EDITOR_BYTES) {
      throw new Error(`Imported configuration is ${metadata.size} bytes; maximum is ${MAX_CONFIG_EDITOR_BYTES} bytes`);
    }
    const bytes = await file.readFile();
    if (bytes.byteLength > MAX_CONFIG_EDITOR_BYTES) {
      throw new Error(
        `Imported configuration is ${bytes.byteLength} bytes; maximum is ${MAX_CONFIG_EDITOR_BYTES} bytes`,
      );
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error('Imported configuration is not valid UTF-8 text');
    }
  } finally {
    await file.close();
  }
}

async function openManagedTerminalConfig(): Promise<void> {
  await ensureBackend();
  let document = await backend!.automation.getConfigDocument();
  if (!document.exists) {
    try {
      document = (await backend!.automation.replaceConfigDocument(document.revision, DEFAULT_TERMINAL_CONFIG)).document;
    } catch (error) {
      if (!(error instanceof GhostteaConfigDocumentConflictError) || !error.document.exists) throw error;
      document = error.document;
    }
  }
  assertProfileConfigDocument(document.path);
  const message = await shell.openPath(document.path);
  if (message) throw new Error(message);
}

async function writeManagedAppearance(update: ManagedAppearanceUpdate): Promise<void> {
  await ensureBackend();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await backend!.automation.getConfigDocument();
    assertProfileConfigDocument(document.path);
    const base = document.exists ? document.contents : DEFAULT_TERMINAL_CONFIG;
    const candidate = patchAppearanceBlock(base, appearanceBlock(update));
    const validation = await validateManagedConfigCandidate(document, candidate);
    if (validation.blockingErrors.length > 0) {
      throw new Error(validation.blockingErrors.map((diagnostic) => diagnostic.message).join('\n'));
    }
    const mismatches = appearanceUpdateMismatches(validation.config.renderer, update);
    if (mismatches.length > 0) {
      throw new Error(
        `Appearance settings are overridden by an included configuration layer: ${mismatches.join(', ')}`,
      );
    }
    try {
      await backend!.automation.replaceConfigDocument(document.revision, candidate);
      return;
    } catch (error) {
      if (!(error instanceof GhostteaConfigDocumentConflictError) || attempt === 2) throw error;
    }
  }
}

async function activateManagedAppearanceMode(mode: GodviewTheme): Promise<void> {
  if (externalBackendConfigured() || activeAppearanceMode === mode) return;
  await ensureBackend();
  const [config, document] = await Promise.all([
    backend!.automation.getConfig(),
    backend!.automation.getConfigDocument(),
  ]);
  assertProfileConfigDocument(document.path);

  let nextProfiles = appearanceProfiles;
  const modeToCapture = activeAppearanceMode ?? mode;
  const shouldMigrateManagedTheme =
    !appearanceProfilesPersisted && document.exists && document.contents.includes(APPEARANCE_BLOCK_START);
  if (activeAppearanceMode || shouldMigrateManagedTheme) {
    const captured = appearanceThemeFromRenderer(config.renderer, modeToCapture, nextProfiles[modeToCapture]);
    if (captured && captured !== nextProfiles[modeToCapture]) {
      nextProfiles = replaceAppearanceProfile(nextProfiles, modeToCapture, captured);
    }
  }

  await writeManagedAppearance(appearanceUpdateForMode(config.renderer, nextProfiles[mode]));
  if (!appearanceProfilesPersisted || nextProfiles !== appearanceProfiles) persistAppearanceProfiles(nextProfiles);
  activeAppearanceMode = mode;
}

async function saveManagedAppearanceForMode(mode: GodviewTheme, update: ManagedAppearanceUpdate): Promise<void> {
  if (activeAppearanceMode !== mode) await activateManagedAppearanceMode(mode);
  let selectedTheme = update.theme;
  if (!selectedTheme) {
    const config = await backend!.automation.getConfig();
    selectedTheme =
      appearanceThemeFromRenderer(config.renderer, mode, appearanceProfiles[mode]) ?? appearanceProfiles[mode];
  }
  const nextProfiles = replaceAppearanceProfile(appearanceProfiles, mode, selectedTheme);
  await writeManagedAppearance({ ...update, theme: selectedTheme });
  persistAppearanceProfiles(nextProfiles);
  activeAppearanceMode = mode;
}

async function confirmDiscardConfigDraft(owner: BrowserWindow, quittingApp = false): Promise<boolean> {
  const count = [...dirtyConfigEditorSenders].filter((sender) => !sender.isDestroyed()).length;
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: 'Unsaved Ghostty configuration',
    message: quittingApp
      ? `Discard ${count === 1 ? 'the unsaved configuration draft' : `${count} unsaved configuration drafts`} and quit?`
      : 'Discard the unsaved configuration draft and close this window?',
    detail: 'The draft has not been written to disk. This action cannot be undone.',
    buttons: ['Keep Editing', quittingApp ? 'Discard and Quit' : 'Discard and Close'],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}

function guardDirtyConfigEditorClose(window: BrowserWindow, event: Electron.Event): void {
  if (!dirtyConfigEditorSenders.has(window.webContents)) return;
  event.preventDefault();
  if (pendingDraftCloseConfirmations.has(window)) return;
  const confirmation = confirmDiscardConfigDraft(window)
    .then((discard) => {
      if (!discard || window.isDestroyed()) return;
      dirtyConfigEditorSenders.delete(window.webContents);
      window.close();
    })
    .finally(() => pendingDraftCloseConfirmations.delete(window));
  pendingDraftCloseConfirmations.set(window, confirmation);
}

function backendOptions(): GhostteaElectronBackendOptions {
  const externalControl = process.env.GHOSTTEA_EXTERNAL_CONTROL_SOCKET;
  const externalFrames = process.env.GHOSTTEA_EXTERNAL_FRAME_SOCKET;
  const externalToken = process.env.GHOSTTEA_EXTERNAL_AUTH_TOKEN;
  if (externalControl && externalFrames && externalToken) {
    return {
      mode: 'external',
      connection: { controlSocket: externalControl, frameSocket: externalFrames, authToken: externalToken },
      bridge: { entryPoint: join(__dirname, 'bridge-entry.js') },
    };
  }

  // The daemon comes prebuilt from @vibecook/ghosttead, staged next to this
  // bundle by build.mjs — that package is ESM-only, so requiring it from here
  // fails under Electron's Node. The env overrides remain the way to run one
  // built from source, and a packaged app carries its own copy in resources.
  const configuredBinary =
    process.env.GHOSTTEAD_BIN ??
    process.env.TERMINALD_BIN ??
    (app.isPackaged
      ? join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ghosttead.exe' : 'ghosttead')
      : undefined);
  const truffle = godviewTruffleConfig({
    appRoot,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    platform: process.platform,
  });
  remoteSessionsEnabled = truffle.enabled;
  const environment: NodeJS.ProcessEnv = {
    ...spawnThroughEnvironment,
    ...truffle.environment,
    GHOSTTEA_CONFIG_PATH: terminalConfigPath,
  };
  return {
    mode: 'managed',
    daemon: {
      binary: { kind: 'executable', path: configuredBinary ?? join(__dirname, 'bin', ghostteadBinaryName) },
      environment,
    },
    bridge: { entryPoint: join(__dirname, 'bridge-entry.js') },
    automation: { clientBuild: 'godview' },
  };
}

const host: AgentHost = {
  async spawnTerminal(spec) {
    await ensureBackend();
    const session = await backend!.automation.createSession({
      executable: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      environment: { mode: 'clean', variables: buildAgentEnvironment({ allowed: spec.env }) },
      cols: spec.cols ?? DEFAULT_COLS,
      rows: spec.rows ?? DEFAULT_ROWS,
      persistence: 'terminate-with-app',
      programKind: 'application',
    });
    managedTerminalIds.add(session.id);
    return { runtimeSessionId: session.id };
  },
  async automateTerminal(runtimeSessionId, operation) {
    await ensureBackend();
    const client = backend!.automation;
    const result =
      operation.kind === 'paste'
        ? operation.submit
          ? await client.pasteAndSubmit(runtimeSessionId, operation.text)
          : await client.paste(runtimeSessionId, operation.text)
        : operation.kind === 'text'
          ? await client.sendText(runtimeSessionId, operation.text)
          : await client.interrupt(runtimeSessionId);
    return result.accepted ? { accepted: true } : { accepted: false, reason: result.reason ?? 'human-input-conflict' };
  },
};

const recorder = createActionRecorder({
  onError: (error) => process.stderr.write(`[main] own-action record failed: ${error.message}\n`),
});
const agentRuntime: AgentRuntime = createBuiltinAgentRuntime({
  host,
  defaultCwd: repoRoot,
  executables: realAgentExecutables,
  recorder,
  onClaudeObservationError: (error, { runtimeRunId }) =>
    process.stderr.write(
      `[claude-semantic] ${JSON.stringify({
        kind: 'error',
        runtimeRunId,
        name: error.name,
        code:
          typeof (error as Error & { code?: unknown }).code === 'string'
            ? (error as Error & { code: string }).code
            : 'unknown',
      })}\n`,
    ),
  ...(CLAUDE_RAIL_FAILURE_SMOKE
    ? {
        claudeHookRailFaultInjection: {
          afterHookEvent: process.env.PUPPETEER_SPAWN_SMOKE_RAIL_FAILURE_AFTER_HOOK?.trim() || 'Stop',
          ...(CLAUDE_RAIL_FAILURE_OCCURRENCE === undefined ? {} : { occurrence: CLAUDE_RAIL_FAILURE_OCCURRENCE }),
          reason: 'Godview native canary observation-rail fault',
        },
      }
    : {}),
  features: {
    claudeSubagentStatusObservation: monitorHostFeatures.monitorV2,
    workspaceProvenanceV2: monitorHostFeatures.monitorV2,
  },
  onError: (error) => process.stderr.write(`[main] agent runtime: ${error.message}\n`),
});
const monitorConnection = connectMonitorIpcRelay(agentRuntime, monitorRelay, (error) =>
  process.stderr.write(`[main] monitor IPC: ${error.message}\n`),
);
const accountUsageMonitor = createAccountUsageMonitor({
  fetchUsage: (agent) => agentRuntime.accountUsage(agent),
  publish: (batch: AgentAccountUsageBatch) => {
    if (!quitting) broadcast('puppeteer:account-usage', batch);
  },
  onError: (error) => process.stderr.write(`[main] account usage: ${error.message}\n`),
});
agentRuntime.onAccountUsage((agent, result) => {
  if (quitting) return;
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'grok') return;
  accountUsageMonitor.ingest(agent, result);
});
agentRuntime.onEvent((runtimeSessionId, envelope) => {
  if (scenarioRecorder.capture(runtimeSessionId, envelope)) scheduleScenarioRecordingFlush(runtimeSessionId);
  const runtimeInfo = agentRuntime.sessionInfo(runtimeSessionId);
  const record = agentRecords.get(runtimeSessionId);
  if (runtimeInfo && record && record.info.sessionId !== runtimeInfo.sessionId) {
    record.info = { ...record.info, sessionId: runtimeInfo.sessionId };
    scheduleRestoreCheckpoint(true);
    broadcast('puppeteer:agent-session', record.info);
  }
  const legacyState = agentRuntime.sessionState(runtimeSessionId);
  if (legacyState) monitorRelay.acceptLegacyState(runtimeSessionId, legacyState);
  dirtyAgentStates.add(runtimeSessionId);
  scheduleAgentStateFlush();
});

function stateSnapshot(runtimeSessionId: string): AgentStateMessage | undefined {
  const state = agentRuntime.sessionState(runtimeSessionId);
  const observationLevel = agentRuntime.observationLevel(runtimeSessionId);
  if (!state || !observationLevel) return undefined;
  monitorRelay.acceptLegacyState(runtimeSessionId, state);
  return { runtimeSessionId, state: serializeLegacySessionState(state), observationLevel };
}

function scheduleAgentStateFlush(): void {
  if (agentFlushTimer) return;
  agentFlushTimer = setTimeout(() => {
    agentFlushTimer = undefined;
    const sessionIds = [...dirtyAgentStates];
    dirtyAgentStates.clear();
    for (const sessionId of sessionIds) {
      const snapshot = stateSnapshot(sessionId);
      if (snapshot) publishAgentState(snapshot);
    }
  }, AGENT_FLUSH_MS);
}

function pushWorkspaceFinal(final: AgentWorkspaceFinal): void {
  try {
    finishScenarioRecording(final.runtimeSessionId);
  } catch (error) {
    process.stderr.write(`[main] scenario recording finalization failed: ${String(error)}\n`);
  }
  const record = agentRecords.get(final.runtimeSessionId);
  if (record) record.final = final;
  discardAgentState(final.runtimeSessionId);
  broadcast('puppeteer:workspace-final', final);
  // A v2 crash remains a small blocked monitor until acknowledgment. Clean
  // completion has already emitted monitor removal and can leave the board.
  const retainedFailure =
    monitorHostFeatures.godviewMonitorV2 && record && monitorRelay.hasRun(record.info.runtimeRunId);
  if (!retainedFailure) agentRecords.delete(final.runtimeSessionId);
}

function stopAdoptedProcessMonitor(runtimeSessionId: string): void {
  const timer = adoptedProcessMonitors.get(runtimeSessionId);
  if (timer) clearInterval(timer);
  adoptedProcessMonitors.delete(runtimeSessionId);
  for (const [preparationId, sessionId] of adoptedPreparationSessions) {
    if (sessionId === runtimeSessionId) adoptedPreparationSessions.delete(preparationId);
  }
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function finishAdoptedProcess(runtimeSessionId: string, reason = 'process-exited'): void {
  stopAdoptedProcessMonitor(runtimeSessionId);
  managedTerminalIds.delete(runtimeSessionId);
  const record = agentRecords.get(runtimeSessionId);
  if (record) {
    record.agentProcessAlive = false;
    scheduleRestoreCheckpoint(true);
  }
  const cleanup = agentRuntime
    .handleProcessExit(runtimeSessionId, { exitCode: null, signal: null, reason })
    .then((final) => {
      if (final) pushWorkspaceFinal(final);
    })
    .catch((error: unknown) => process.stderr.write(`[main] adopted agent exit cleanup failed: ${String(error)}\n`))
    .finally(() => exitCleanups.delete(cleanup));
  exitCleanups.add(cleanup);
}

function monitorAdoptedProcess(runtimeSessionId: string, processId: number, preparationId: string): void {
  stopAdoptedProcessMonitor(runtimeSessionId);
  adoptedPreparationSessions.set(preparationId, runtimeSessionId);
  const timer = setInterval(() => {
    if (processIsAlive(processId)) return;
    clearInterval(timer);
    // Ghosttea's session-exited event carries completed/crashed/requested
    // termination semantics. Give that authoritative event one bounded turn
    // before the PID poller falls back to an unknown process exit.
    const fallback = setTimeout(() => finishAdoptedProcess(runtimeSessionId), ADOPTED_PROCESS_EXIT_GRACE_MS);
    fallback.unref?.();
    adoptedProcessMonitors.set(runtimeSessionId, fallback);
  }, 500);
  timer.unref?.();
  adoptedProcessMonitors.set(runtimeSessionId, timer);
}

function restoreManifestPath(): string {
  return join(app.getPath('userData'), 'restore-manifest.json');
}

function loadLegacyRestoreManifest(): RestoreManifest | undefined {
  try {
    return readRestoreManifest(JSON.parse(readFileSync(restoreManifestPath(), 'utf8')));
  } catch {
    return undefined;
  }
}

function discardRestoreState(): void {
  restoreGeneration = 0;
  restoreSnapshot = undefined;
  restoreManifest = undefined;
  pendingRestoreAgents.clear();
  restoredSessionAliases.clear();
  paneRehydrations.clear();
  try {
    discardDurableRestoreState(restoreStateDirectory);
  } catch (error) {
    console.error('failed to discard durable restore state', error);
  }
  try {
    rmSync(restoreManifestPath(), { force: true });
  } catch (error) {
    console.error('failed to discard legacy restore state', error);
  }
}

/**
 * Persist one complete application checkpoint. The store keeps two verified
 * generations, publishes with atomic rename, and fsyncs both file and directory
 * so an interrupted write never destroys the last known-good checkpoint.
 */
function commitRestoreCheckpoint(): RestoreSnapshot | undefined {
  // An OS shutdown can arrive while the restore prompt or window creation is
  // still in flight. The already-durable generations are safer than a partial
  // topology assembled during that interval.
  if (!restoreCheckpointReady) return restoreSnapshot;
  try {
    const checkpointAgents = new Map<string, RestoreSnapshotAgentInput>(agentRecords);
    for (const pending of pendingRestoreAgents.values()) {
      checkpointAgents.set(pending.runtimeSessionId, {
        info: {
          agent: pending.agent as AgentSessionInfo['agent'],
          sessionId: pending.nativeSessionId,
          runtimeSessionId: pending.runtimeSessionId,
          workspace: pending.workspace as AgentSessionInfo['workspace'],
        },
        session: {
          cwd: pending.cwd ?? pending.workspace.sourcePath,
          exited: false,
        },
        agentProcessAlive: true,
      });
    }
    const snapshot = buildRestoreSnapshot({
      windows: tabs.records(),
      agents: checkpointAgents,
      activeWindowId: lastFocusedWindow ? tabs.get(lastFocusedWindow)?.id : undefined,
      sessionAliases: restoredSessionAliases,
      updatedAtMs: Date.now(),
    });
    if (snapshot.windows.length === 0 && snapshot.agents.length === 0) {
      // A legacy window restores its geometry from Chromium storage and may
      // not have acknowledged that document yet. Keep V1 as the fallback until
      // a complete, non-empty V2 generation has actually been published.
      if (restoreManifest) return restoreSnapshot;
      discardRestoreState();
      restoreGeneration = 0;
      return undefined;
    }
    const committed = writeDurableRestoreState(restoreStateDirectory, snapshot, restoreGeneration);
    restoreGeneration = committed.generation;
    restoreSnapshot = committed.snapshot;
    // Once V2 is durable the legacy file must not resurrect stale panes if both
    // V2 generations are later deliberately removed.
    rmSync(restoreManifestPath(), { force: true });
    restoreManifest = undefined;
    return committed.snapshot;
  } catch (error) {
    console.error('failed to checkpoint restore state', error);
    return undefined;
  }
}

function scheduleRestoreCheckpoint(immediate = false): void {
  if (quitting) return;
  if (immediate) {
    if (restoreCheckpointTimer) clearTimeout(restoreCheckpointTimer);
    restoreCheckpointTimer = undefined;
    commitRestoreCheckpoint();
    return;
  }
  if (restoreCheckpointTimer) return;
  restoreCheckpointTimer = setTimeout(() => {
    restoreCheckpointTimer = undefined;
    commitRestoreCheckpoint();
  }, RESTORE_CHECKPOINT_DEBOUNCE_MS);
  restoreCheckpointTimer.unref?.();
}

type RestoreCandidate = { kind: 'snapshot'; value: RestoreSnapshot } | { kind: 'legacy'; value: RestoreManifest };

function loadRestoreCandidate(): RestoreCandidate | undefined {
  const durable = readDurableRestoreState(restoreStateDirectory);
  if (durable) {
    restoreGeneration = durable.generation;
    restoreSnapshot = durable.snapshot;
    pendingRestoreAgents.clear();
    for (const agent of durable.snapshot.agents) pendingRestoreAgents.set(agent.runtimeSessionId, agent);
    return { kind: 'snapshot', value: durable.snapshot };
  }
  const legacy = loadLegacyRestoreManifest();
  return legacy ? { kind: 'legacy', value: legacy } : undefined;
}

/**
 * Restoring resumes agents, which costs real tokens and touches real
 * workspaces, so it is never the silent default — the user is told exactly
 * what would come back and asked first.
 */
async function confirmRestore(candidate: RestoreCandidate): Promise<boolean> {
  const detail = restorePromptDetail(
    candidate.kind === 'snapshot' ? summarizeRestoreSnapshot(candidate.value) : summarizeRestore(candidate.value),
  );
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Restore', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Restore previous session?',
    detail,
  });
  return response === 0;
}

/**
 * Ghosttea's saved layout holds the geometry; this manifest holds what each
 * pane was. Windows are reopened on their recorded slots so the two halves meet
 * — the layout document a window loads is the one its panes were persisted to.
 */
async function openRestoredLegacyWindows(manifest: RestoreManifest): Promise<void> {
  const leadByGroup = new Map<string, BrowserWindow>();
  for (const window of manifest.windows) {
    const lead = leadByGroup.get(window.groupId);
    const created = await createWindow({
      slotId: window.slotId,
      claimExistingSessions: false,
      ...(lead ? { tabOf: lead } : {}),
      ...(window.activeCwd ? { initialCwd: window.activeCwd } : {}),
    });
    if (!lead) leadByGroup.set(window.groupId, created);
  }
}

async function openRestoredSnapshotWindows(snapshot: RestoreSnapshot): Promise<void> {
  const leadByGroup = new Map<string, BrowserWindow>();
  const restoredBySlot = new Map<string, BrowserWindow>();
  for (const savedWindow of snapshot.windows) {
    const lead = leadByGroup.get(savedWindow.groupId);
    const created = await createWindow({
      slotId: savedWindow.slotId,
      restoreWorkspace: savedWindow.workspace,
      claimExistingSessions: false,
      activateOnReady: false,
      ...(lead ? { tabOf: lead } : {}),
      ...(savedWindow.activeCwd ? { initialCwd: savedWindow.activeCwd } : {}),
    });
    restoredBySlot.set(savedWindow.slotId, created);
    if (!lead) leadByGroup.set(savedWindow.groupId, created);
  }
  const preferred = preferredRestoreWindow(snapshot);
  const window = preferred ? restoredBySlot.get(preferred.slotId) : undefined;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.show();
    window.focus();
  }
}

async function openInitialWindows(): Promise<void> {
  const candidate = loadRestoreCandidate();
  if (!candidate) {
    // A stale Chromium slot is not an independent restore authority. Without
    // a verified durable candidate, start empty and clear that slot before the
    // renderer can ask to rehydrate anything recorded there.
    await createWindow({ freshWorkspace: true });
    restoreCheckpointReady = true;
    scheduleRestoreCheckpoint(true);
    return;
  }
  if (!(await confirmRestore(candidate))) {
    // Declining is an answer, not a deferral; re-asking every launch would
    // make the prompt noise rather than a choice.
    discardRestoreState();
    await createWindow({ freshWorkspace: true });
    restoreCheckpointReady = true;
    scheduleRestoreCheckpoint(true);
    return;
  }
  try {
    if (candidate.kind === 'snapshot') {
      restoreSnapshot = candidate.value;
      await openRestoredSnapshotWindows(candidate.value);
      await restoreDetachedAgents(candidate.value);
    } else {
      restoreManifest = candidate.value;
      await openRestoredLegacyWindows(candidate.value);
    }
  } catch (error) {
    console.error('failed to restore previous session', error);
  }
  // However restore went, the application must not end up running with no way
  // to reach it.
  if (tabs.records().length === 0) await createWindow({ freshWorkspace: true });
  restoreCheckpointReady = true;
  scheduleRestoreCheckpoint(true);
}

function rememberAgent(info: AgentSessionInfo, session: SessionSummary, launch?: RestoreAgentLaunchProvenance): void {
  agentRecords.set(info.runtimeSessionId, { info, session, ...(launch ? { launch } : {}), agentProcessAlive: true });
  scheduleRestoreCheckpoint(true);
  broadcast('puppeteer:agent-session', info);
  if (monitorHostFeatures.monitorV2) {
    if (monitorConnection.start(info.runtimeRunId)) {
      monitorRelay.bindTerminal(info.runtimeRunId, info.runtimeSessionId);
    }
  }
  const snapshot = stateSnapshot(info.runtimeSessionId);
  if (snapshot) publishAgentState(snapshot);
}

function onSessionExited(event: SessionExitedEvent, preserveAgentForRecovery = false): Promise<void> | undefined {
  if (!managedTerminalIds.delete(event.sessionId)) return undefined;
  const aliasedOrigins = restoredSessionAliasOrigins(restoredSessionAliases, event.sessionId);
  for (const originSessionId of aliasedOrigins) {
    // A promise resolved to the dead runtime id must never be handed to a
    // reloading mirror. During backend recovery the alias itself remains long
    // enough for a stale persisted id to find the pending descriptor below.
    paneRehydrations.delete(originSessionId);
    if (!preserveAgentForRecovery) restoredSessionAliases.delete(originSessionId);
  }
  paneRehydrations.delete(event.sessionId);
  stopAdoptedProcessMonitor(event.sessionId);
  const record = agentRecords.get(event.sessionId);
  if (record && preserveAgentForRecovery) {
    const descriptor = paneRecoveryMetadata(record.session, record.info, record.launch).descriptor;
    if (descriptor.kind === 'agent') {
      pendingRestoreAgents.set(event.sessionId, { runtimeSessionId: event.sessionId, ...descriptor });
    }
  }
  if (record) {
    record.agentProcessAlive = false;
    record.session = {
      ...record.session,
      exited: true,
      exitCode: event.exitCode,
      exitSignal: event.exitSignal,
      requestedTermination: event.requestedTermination,
      exitOutcome: event.exitOutcome,
    };
  }
  const shouldHandoffToShell = Boolean(
    record &&
    !preserveAgentForRecovery &&
    !quitting &&
    event.requestedTermination === null &&
    event.exitOutcome !== 'application-terminated' &&
    event.exitOutcome !== 'service-terminated' &&
    event.exitOutcome !== 'user-terminated',
  );
  scheduleRestoreCheckpoint(true);
  const cleanup = agentRuntime
    .handleProcessExit(event.sessionId, {
      exitCode: event.exitCode,
      signal: event.exitSignal,
      reason: event.exitOutcome,
      requestedTermination: event.requestedTermination,
    })
    .then((final) => {
      if (final) pushWorkspaceFinal(final);
    })
    .catch((error: unknown) => {
      process.stderr.write(`[main] agent exit cleanup failed: ${String(error)}\n`);
    })
    .then(async () => {
      if (shouldHandoffToShell && record) {
        await handoffExitedAgentTerminal(event.sessionId, aliasedOrigins, record);
      }
    })
    .finally(() => exitCleanups.delete(cleanup));
  exitCleanups.add(cleanup);
  return cleanup;
}

function wireAutomation(client: GhostteaAutomationClient): void {
  if (wiredAutomationClients.has(client)) return;
  wiredAutomationClients.add(client);
  client.on('session-exited', (event) => {
    void onSessionExited(event);
  });
}

async function ensureBackend(): Promise<void> {
  if (!backend) {
    backend = new GhostteaElectronBackend(backendOptions());
    backend.on('unexpected-exit', ({ source, code, signal }) => {
      if (quitting) return;
      console.error(`${source} exited unexpectedly (${code ?? signal ?? 'unknown'}); restarting`);
      void recoverBackend();
    });
  }
  if (!backend.running) await backend.start();
  const automation = backend.automation;
  wireAutomation(automation);
}

async function reconcileManagedSessions(preserveAgentsForRecovery = false): Promise<string[]> {
  if (!backend) return [];
  const liveSessionIds = (await backend.automation.listSessions()).map((session) => session.id);
  const cleanups: Promise<void>[] = [];
  const recoverableAgentIds: string[] = [];
  for (const sessionId of missingManagedSessionIds(managedTerminalIds, liveSessionIds)) {
    const cleanup = onSessionExited(
      {
        requestId: 0,
        type: 'session-exited',
        sessionId,
        exitCode: null,
        exitSignal: null,
        requestedTermination: null,
        exitOutcome: 'unknown',
      },
      preserveAgentsForRecovery,
    );
    if (cleanup) cleanups.push(cleanup);
    if (preserveAgentsForRecovery && pendingRestoreAgents.has(sessionId)) recoverableAgentIds.push(sessionId);
  }
  // Worktree destruction and claim release must complete before a replacement
  // session asks the workspace manager to resume the same branch.
  await Promise.all(cleanups);
  return recoverableAgentIds;
}

async function restoreAgentsAfterBackendRecovery(runtimeSessionIds: readonly string[]): Promise<void> {
  await Promise.all(
    runtimeSessionIds.map(async (runtimeSessionId) => {
      const pending = pendingRestoreAgents.get(runtimeSessionId);
      if (!pending) return;
      const { runtimeSessionId: _runtimeSessionId, ...descriptor } = pending;
      await startPaneRecovery(runtimeSessionId, descriptor, undefined, false);
    }),
  );
  // Hidden agents need no alias after they have resumed. Attached stale ids are
  // retained until their renderer acknowledges the replacement workspace.
  pruneRestoredSessionAliases();
}

function recoverBackend(): Promise<void> {
  recoveringBackend ??= (async () => {
    let lastError: unknown;
    const recoveryAgentIds = new Set<string>();
    for (let attempt = 0; attempt < 5 && !quitting; attempt += 1) {
      try {
        await ensureBackend();
        for (const sessionId of await reconcileManagedSessions(true)) recoveryAgentIds.add(sessionId);
        await restoreAgentsAfterBackendRecovery(
          [...recoveryAgentIds].filter((sessionId) => pendingRestoreAgents.has(sessionId)),
        );
        for (const record of tabs.records()) {
          if (!record.window.isDestroyed()) record.window.webContents.reload();
        }
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(5_000, 250 * 2 ** attempt)));
      }
    }
    if (lastError) console.error('terminal backend recovery failed', lastError);
  })().finally(() => {
    recoveringBackend = undefined;
  });
  return recoveringBackend;
}

const RESTORABLE_AGENTS: readonly string[] = ['claude', 'codex', 'grok', 'kimi', 'opencode', 'acp'];

function defaultShell(): string {
  return process.platform === 'win32' ? (process.env.COMSPEC ?? 'powershell.exe') : (process.env.SHELL ?? '/bin/zsh');
}

function handoffCwd(record: AgentRecord): string | undefined {
  const candidates = [record.session.cwd, record.info.workspace.root, record.info.workspace.sourcePath];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // A clean managed worktree may have been released during agent cleanup;
      // continue to the stable source directory in that case.
    }
  }
  return candidates.find((candidate): candidate is string => Boolean(candidate));
}

function reloadForTerminalHandoff(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.reload();
}

function dispatchTerminalHandoff(
  window: BrowserWindow,
  previousSessionId: string,
  monitorIdentity: string,
  session: SessionSummary,
): void {
  const handoffId = randomUUID();
  const message: TerminalSessionHandoff = { handoffId, previousSessionId, monitorIdentity, session };
  // A renderer can be between bootstrap and subscription while still accepting
  // IPC. Register before sending so even an immediate cross-process ack can
  // cancel this bounded, durable reload fallback.
  const timer = setTimeout(() => {
    const pending = pendingTerminalHandoffs.get(handoffId);
    if (!pending) return;
    pendingTerminalHandoffs.delete(handoffId);
    reloadForTerminalHandoff(pending.window);
  }, 800);
  timer.unref?.();
  pendingTerminalHandoffs.set(handoffId, { window, timer });
  if (!safeSend(window, 'terminal-session-handoff', message)) {
    clearTimeout(timer);
    pendingTerminalHandoffs.delete(handoffId);
    reloadForTerminalHandoff(window);
  }
}

async function handoffExitedAgentTerminal(
  runtimeSessionId: string,
  aliasedOrigins: readonly string[],
  record: AgentRecord,
): Promise<void> {
  if (quitting || recoveringBackend) return;
  const origins = [...new Set([runtimeSessionId, ...aliasedOrigins])];
  const attached = tabs
    .records()
    .some(
      (candidate) =>
        origins.some((origin) => candidate.sessionIds.has(origin)) ||
        Boolean(
          candidate.workspace &&
          restoreWorkspaceSessionIds(candidate.workspace).some((sessionId) => origins.includes(sessionId)),
        ),
    );
  if (!attached) return;
  const cwd = handoffCwd(record);

  try {
    await ensureBackend();
    const session = await backend!.automation.createSession({
      executable: defaultShell(),
      args: [],
      ...(cwd ? { cwd } : {}),
      environment: { mode: 'inherit' },
      cols: record.session.cols || DEFAULT_COLS,
      rows: record.session.rows || DEFAULT_ROWS,
      persistence: 'terminate-with-app',
      programKind: 'interactive-shell',
    });
    const previousByWindow = new Map<BrowserWindow, string>();
    for (const origin of origins) {
      pendingRestoreAgents.delete(origin);
      setRestoredSessionAlias(restoredSessionAliases, origin, session.id);
      paneRehydrations.set(origin, Promise.resolve(session));
      for (const owner of tabs.replaceSession(origin, session)) {
        if (!previousByWindow.has(owner.window)) previousByWindow.set(owner.window, origin);
      }
    }
    scheduleRestoreCheckpoint(true);
    for (const [window, previousSessionId] of previousByWindow) {
      dispatchTerminalHandoff(window, previousSessionId, runtimeSessionId, session);
    }
  } catch (error) {
    process.stderr.write(`[main] failed to hand exited agent pane to a shell: ${String(error)}\n`);
    // Downgrade the durable pane contract before reloading. Rehydration will
    // retry shell creation, never accidentally resume the ended conversation.
    const affected = new Set<BrowserWindow>();
    for (const origin of origins) {
      const terminal = { id: origin, cwd: cwd ?? null };
      for (const owner of tabs.replaceSession(origin, terminal)) affected.add(owner.window);
    }
    scheduleRestoreCheckpoint(true);
    for (const window of affected) reloadForTerminalHandoff(window);
  }
}

/**
 * Rebuild the workspace request for a restored agent.
 *
 * A clean worktree is destroyed when its session closes, so on the way back
 * only the branch is reliably reusable; the retained-dirty case still has its
 * directory, and `resumeRoot` binds to it. Passing a root that no longer exists
 * is a hard failure in packages/workspaces, so it is offered only when it does.
 */
function restoredWorkspaceRequest(descriptor: Extract<RestoreDescriptor, { kind: 'agent' }>): AgentWorkspaceRequest {
  const { mode, sourcePath, root, branch } = descriptor.workspace;
  const request: AgentWorkspaceRequest = { mode: mode as AgentWorkspaceRequest['mode'], path: sourcePath };
  if ((mode === 'worktree' || mode === 'copy') && branch) {
    request.resumeBranch = branch;
    if (existsSync(root)) request.resumeRoot = root;
  }
  return request;
}

function descriptorForRehydration(request: PaneRehydrationRequest): RestoreDescriptor | undefined {
  const metadata = readPaneRecoveryMetadata(request.meta);
  if (metadata) return metadata.descriptor;

  const savedAgent = restoreSnapshot && snapshotAgent(restoreSnapshot, request.sessionId);
  if (savedAgent) {
    const { runtimeSessionId: _runtimeSessionId, ...descriptor } = savedAgent;
    return descriptor;
  }

  const legacyPane = restoreManifest && restorePaneFor(restoreManifest, request.sessionId);
  if (!legacyPane) return undefined;
  const { sessionId: _sessionId, ...descriptor } = legacyPane;
  return descriptor;
}

async function recoverDescriptor(
  originSessionId: string,
  descriptor: RestoreDescriptor,
  owner: BrowserWindow | undefined,
  shellFallback: boolean,
): Promise<SessionSummary | null> {
  await ensureBackend();
  const client = backend?.automation;
  if (!client) return null;

  if (descriptor.kind === 'agent' && RESTORABLE_AGENTS.includes(descriptor.agent)) {
    try {
      const agentOptions = restoredAgentOptions(descriptor);
      const result = await createAgentSession(
        {
          agent: descriptor.agent,
          ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
          resume: descriptor.nativeSessionId,
          workspace: restoredWorkspaceRequest(descriptor),
          ...(agentOptions ? { agentOptions } : {}),
        } as InternalCreateAgentSessionOptions,
        owner,
        originSessionId,
      );
      if (!('error' in result)) return result.session;
      console.warn(`[main] could not resume ${descriptor.agent}: ${result.error.message}`);
      if (!shellFallback) return null;
    } catch (error) {
      console.error(`[main] failed to resume ${descriptor.agent}`, error);
      if (!shellFallback) return null;
    }
  } else if (descriptor.kind === 'agent') {
    if (!shellFallback) {
      console.warn(`[main] cannot restore unsupported agent ${descriptor.agent}`);
      return null;
    }
    console.warn(`[main] replacing unsupported agent ${descriptor.agent} with a shell`);
  }

  try {
    // The conversation may be gone, its workspace unusable, or its agent no
    // longer installed. Preserve an attached pane as a shell at the same cwd.
    const created = await client.createSession({
      executable: defaultShell(),
      args: [],
      ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
      environment: { mode: 'inherit' },
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      persistence: 'terminate-with-app',
      programKind: 'interactive-shell',
    });
    pendingRestoreAgents.delete(originSessionId);
    setRestoredSessionAlias(restoredSessionAliases, originSessionId, created.id);
    if (owner) tabs.get(owner)?.sessionIds.add(created.id);
    scheduleRestoreCheckpoint(true);
    return created;
  } catch (error) {
    console.error('failed to create fallback shell for persisted session', error);
    return null;
  }
}

/**
 * Answers Ghosttea's `onRehydratePane` for a pane whose saved session is gone.
 * Mirrored panes share the same old session id, so they share one recovery
 * promise and all bind to the same replacement PTY.
 */
function startPaneRecovery(
  originSessionId: string,
  descriptor: RestoreDescriptor,
  owner: BrowserWindow | undefined,
  shellFallback: boolean,
): Promise<SessionSummary | null> {
  const recoveryKeys = new Set([
    originSessionId,
    ...restoredSessionAliasOrigins(restoredSessionAliases, originSessionId),
  ]);
  for (const recoveryKey of recoveryKeys) {
    const existing = paneRehydrations.get(recoveryKey);
    if (!existing) continue;
    for (const key of recoveryKeys) paneRehydrations.set(key, existing);
    return existing;
  }
  const recovery = recoverDescriptor(originSessionId, descriptor, owner, shellFallback);
  for (const recoveryKey of recoveryKeys) paneRehydrations.set(recoveryKey, recovery);
  const clearFailedRecovery = (): void => {
    for (const recoveryKey of recoveryKeys) {
      if (paneRehydrations.get(recoveryKey) === recovery) paneRehydrations.delete(recoveryKey);
    }
  };
  void recovery.then((session) => {
    if (!session) clearFailedRecovery();
  }, clearFailedRecovery);
  return recovery;
}

function rehydratePane(request: PaneRehydrationRequest, owner?: BrowserWindow): Promise<SessionSummary | null> {
  const existing = paneRehydrations.get(request.sessionId);
  if (existing) return existing;
  const aliasedSessionId = resolveRestoredSessionAlias(restoredSessionAliases, request.sessionId);
  const aliasedAgent = agentRecords.get(aliasedSessionId);
  if (aliasedAgent && !aliasedAgent.session.exited) return Promise.resolve(aliasedAgent.session);
  const descriptor = descriptorForRehydration(request);
  if (!descriptor) {
    if (RESTORE_SMOKE) console.log(`[restore-smoke] no restore descriptor for ${request.sessionId}`);
    return Promise.resolve(null);
  }
  if (RESTORE_SMOKE) console.log(`[restore-smoke] rehydrating ${request.sessionId} as ${descriptor.kind}`);
  const recoveryOrigin = pendingRestoreAgents.has(aliasedSessionId) ? aliasedSessionId : request.sessionId;
  return startPaneRecovery(recoveryOrigin, descriptor, owner, true);
}

/** Resume agents that were alive without being mounted in any saved pane. */
async function restoreDetachedAgents(snapshot: RestoreSnapshot): Promise<void> {
  const attached = snapshotReferencedSessionIds(snapshot);
  for (const agent of snapshot.agents) {
    if (attached.has(agent.runtimeSessionId)) continue;
    const { runtimeSessionId, ...descriptor } = agent;
    await recoverDescriptor(runtimeSessionId, descriptor, undefined, false);
  }
}

async function createAgentSession(
  options: InternalCreateAgentSessionOptions,
  owner?: BrowserWindow,
  restoringSessionId?: string,
): Promise<CreateAgentSessionResult> {
  const result = await agentRuntime.createSession(options);
  if ('error' in result) return result;
  const session = await backend!.automation.getSession(result.runtimeSessionId);
  const info: AgentSessionInfo = { ...result, agent: result.agent as AgentSessionInfo['agent'], session };
  const rawAgentOptions =
    options.agentOptions !== null && typeof options.agentOptions === 'object'
      ? (options.agentOptions as Record<string, unknown>)
      : undefined;
  const configuredClaudeDirectory =
    options.agent === 'claude'
      ? typeof rawAgentOptions?.configDir === 'string'
        ? rawAgentOptions.configDir
        : process.env.CLAUDE_CONFIG_DIR
      : undefined;
  const launch = claudeRestoreLaunchProvenance(configuredClaudeDirectory, result.workspace.root);
  if (restoringSessionId) {
    pendingRestoreAgents.delete(restoringSessionId);
    setRestoredSessionAlias(restoredSessionAliases, restoringSessionId, result.runtimeSessionId);
  }
  rememberAgent(info, session, launch);
  if (owner) tabs.get(owner)?.sessionIds.add(result.runtimeSessionId);
  return info;
}

async function handleSpawnThroughRequest(request: SpawnThroughRequest): Promise<SpawnThroughResponse> {
  if (request.type === 'exec-failed') {
    const runtimeSessionId = adoptedPreparationSessions.get(request.preparationId);
    await agentRuntime.cancelPrepared(request.preparationId);
    if (runtimeSessionId) {
      try {
        finishScenarioRecording(runtimeSessionId);
      } catch (error) {
        process.stderr.write(`[main] scenario recording finalization failed: ${String(error)}\n`);
      }
      stopAdoptedProcessMonitor(runtimeSessionId);
      managedTerminalIds.delete(runtimeSessionId);
      agentRecords.delete(runtimeSessionId);
      discardAgentState(runtimeSessionId);
      broadcast('puppeteer:agent-removed', runtimeSessionId);
    }
    process.stderr.write(`[main] spawn-through exec failed: ${request.message}\n`);
    return { action: 'ack' };
  }
  await ensureBackend();
  return prepareSpawnThroughLaunch(request, {
    runtime: agentRuntime,
    imposterBin: () => imposterExecutable,
    imposterHome: (agent) => {
      if (!spawnThroughDirectory) return undefined;
      const directory = join(spawnThroughDirectory, 'imposter', agent);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return directory;
    },
    listSessions: () => backend!.automation.listSessions(),
    onAdopted: ({ info: adopted, session, processId, preparationId }) => {
      const info: AgentSessionInfo = {
        ...adopted,
        agent: adopted.agent as AgentSessionInfo['agent'],
        ...(request.imposter ? { emulated: true } : {}),
        session,
      };
      managedTerminalIds.add(session.id);
      const launch =
        request.agent === 'claude' ? claudeRestoreLaunchProvenance(request.claudeConfigDir, request.cwd) : undefined;
      rememberAgent(info, session, launch);
      monitorAdoptedProcess(session.id, processId, preparationId);
    },
  });
}

async function initializeSpawnThrough(): Promise<void> {
  if (spawnThroughGateway || process.platform === 'win32') return;
  // `ai` is shimmed on its own terms: an emulated pane needs no real agent
  // installed at all, so a machine with only the imposter still gets
  // spawn-through. The shim reads its own name to tell the two apart.
  const names = [...(Object.keys(realAgentExecutables) as string[]), ...(imposterExecutable ? ['ai'] : [])];
  if (names.length === 0) return;
  const token = randomBytes(32).toString('hex');
  spawnThroughGateway = await startSpawnThroughGateway(token, handleSpawnThroughRequest);
  spawnThroughDirectory = join(app.getPath('temp'), `godview-agent-shims-${process.pid}`);
  rmSync(spawnThroughDirectory, { recursive: true, force: true });
  mkdirSync(spawnThroughDirectory, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const destination = join(spawnThroughDirectory, name);
    copyFileSync(join(__dirname, 'agent-shim.cjs'), destination);
    chmodSync(destination, 0o700);
  }
  const zDotDirectory = join(spawnThroughDirectory, 'zdot');
  mkdirSync(zDotDirectory, { recursive: true, mode: 0o700 });
  for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
    writeFileSync(
      join(zDotDirectory, file),
      [
        '_puppeteer_zdotdir="${PUPPETEER_ORIGINAL_ZDOTDIR:-$HOME}"',
        `if [[ -r "$_puppeteer_zdotdir/${file}" ]]; then source "$_puppeteer_zdotdir/${file}"; fi`,
        'export PATH="$PUPPETEER_SHIM_DIR:$PATH"',
        'unset _puppeteer_zdotdir',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }
  spawnThroughEnvironment = {
    PUPPETEER_SPAWN_PORT: String(spawnThroughGateway.port),
    PUPPETEER_SPAWN_TOKEN: token,
    PUPPETEER_SHIM_DIR: spawnThroughDirectory,
    PUPPETEER_ORIGINAL_ZDOTDIR: process.env.ZDOTDIR ?? '',
    PATH: `${spawnThroughDirectory}${delimiter}${originalPath}`,
    ZDOTDIR: zDotDirectory,
  };
}

function registerIpc(): void {
  ipcMain.handle('puppeteer:account-usage', () => accountUsageMonitor.snapshot());
  ipcMain.handle('puppeteer:refresh-account-usage', () => accountUsageMonitor.refresh());
  ipcMain.handle('puppeteer:create-agent-session', (event, options: CreateAgentSessionOptions) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    return createAgentSession(options, owner && tabs.get(owner) ? owner : undefined);
  });
  ipcMain.handle('puppeteer:rehydrate-pane', (event, value: unknown): Promise<SessionSummary | null> => {
    if (!value || typeof value !== 'object') return Promise.resolve(null);
    const candidate = value as Partial<PaneRehydrationRequest>;
    if (typeof candidate.sessionId !== 'string' || !candidate.sessionId) return Promise.resolve(null);
    if (typeof candidate.paneId !== 'string' || !candidate.paneId) return Promise.resolve(null);
    const request: PaneRehydrationRequest = {
      sessionId: candidate.sessionId,
      paneId: candidate.paneId,
      meta: candidate.meta,
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    return rehydratePane(request, owner && tabs.get(owner) ? owner : undefined);
  });
  ipcMain.handle('terminal-take-restore-workspace', (event): RestoreWorkspaceDocument | undefined => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    return owner ? tabs.takeRestoreWorkspace(owner) : undefined;
  });
  ipcMain.handle('puppeteer:list-agent-sessions', (): AgentSessionSnapshot[] =>
    [...agentRecords.values()].map((record) => ({
      info: { ...record.info, session: record.session },
      state: stateSnapshot(record.info.runtimeSessionId),
      final: record.final,
    })),
  );
  ipcMain.handle('puppeteer:list-agent-monitors', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && tabs.get(window) ? monitorRelay.snapshot() : [];
  });
  ipcMain.handle('puppeteer:agent-monitor-configuration', () => ({
    godviewMonitorV2: monitorHostFeatures.godviewMonitorV2,
  }));
  ipcMain.handle('puppeteer:acknowledge-agent-failure', (event, input: unknown): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !tabs.get(window)) return Promise.resolve(false);
    return acknowledgeAgentFailureForIpc(agentRuntime, monitorRelay, input);
  });
  ipcMain.handle('puppeteer:read-agent-monitor-artifact', async (event, input: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !tabs.get(window)) return { status: 'denied' as const };
    return readAgentMonitorArtifactForIpc(agentRuntime, monitorRelay, input);
  });
  ipcMain.handle('puppeteer:submit-prompt', (_event, options: SubmitPromptOptions): Promise<PromptReceipt> =>
    agentRuntime.submitPrompt(options.runtimeSessionId, { text: options.text }),
  );
  ipcMain.handle('puppeteer:workspace-diff', (_event, runtimeSessionId: string) =>
    agentRuntime.workspaceDiff(runtimeSessionId),
  );
  ipcMain.handle('puppeteer:scenario-recordings', (): ScenarioRecordingStatus[] => scenarioRecorder.statuses());
  ipcMain.handle('puppeteer:start-scenario-recording', (event, runtimeSessionId: unknown) => {
    if (typeof runtimeSessionId !== 'string' || !runtimeSessionId) {
      throw new Error('runtimeSessionId is required');
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    return startScenarioRecording(runtimeSessionId, owner && tabs.get(owner) ? owner : undefined);
  });
  ipcMain.handle('puppeteer:stop-scenario-recording', (_event, runtimeSessionId: unknown) => {
    if (typeof runtimeSessionId !== 'string' || !runtimeSessionId) {
      throw new Error('runtimeSessionId is required');
    }
    const status = finishScenarioRecording(runtimeSessionId);
    if (!status) throw new Error('scenario recording is not active');
    return status;
  });
  ipcMain.on('puppeteer:agent-states-ack', (event, sequence: unknown) => {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !tabs.get(window)) return;
    const delivery = agentStateDeliveries.get(event.sender.id);
    if (delivery?.queue.acknowledge(sequence)) flushAgentStateDelivery(window);
  });
}

ipcMain.on('terminal-context-menu', (event, canCopy: boolean) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tabs.get(window)) return;
  const send = (action: string): void => window.webContents.send('terminal-menu-action', action);
  Menu.buildFromTemplate([
    { label: 'Copy', enabled: Boolean(canCopy), click: () => send('copy') },
    { label: 'Paste', click: () => send('paste') },
    { type: 'separator' },
    { label: 'Select All', click: () => send('select-all') },
    { label: 'Clear Screen', click: () => send('clear-screen') },
  ]).popup({ window });
});

ipcMain.on('terminal-toggle-fullscreen', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && tabs.get(window)) window.setFullScreen(!window.isFullScreen());
});

ipcMain.on('terminal-close-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && tabs.get(window)) window.close();
});

ipcMain.on('terminal-new-window', (event, cwd: unknown) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source)) return;
  void createWindow({
    initialCwd: typeof cwd === 'string' && cwd.trim() ? cwd : undefined,
    freshWorkspace: true,
  }).catch((error) => console.error('failed to create window', error));
});

ipcMain.on('terminal-quit', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (source && tabs.get(source)) app.quit();
});

ipcMain.on('terminal-close-all-windows', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source)) return;
  for (const record of tabs.records()) {
    if (!record.window.isDestroyed()) record.window.close();
  }
});

ipcMain.on('terminal-open-config', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source)) return;
  if (externalBackendConfigured()) {
    void showExternalConfigOwnershipMessage(event.sender, 'open');
    return;
  }
  void openManagedTerminalConfig().catch((error) => console.error('[main] failed to open terminal config', error));
});

ipcMain.on('terminal-reload-config', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source)) return;
  if (externalBackendConfigured()) {
    void showExternalConfigOwnershipMessage(event.sender, 'reload');
    return;
  }
  void ensureBackend()
    .then(() => backend!.automation.reloadConfig())
    .catch((error) => console.error('[main] failed to reload terminal config', error));
});

ipcMain.handle('terminal-save-appearance', async (event, payload: unknown) => {
  await requireManagedConfigEditor(event);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid mode-specific appearance request');
  const request = payload as Record<string, unknown>;
  if (request.mode !== 'light' && request.mode !== 'dark') throw new Error('Invalid terminal appearance mode');
  const update = validateAppearanceUpdate(request.update);
  await enqueueAppearanceOperation(() => saveManagedAppearanceForMode(request.mode as GodviewTheme, update));
});

ipcMain.handle('terminal-config-editor-load', async (event) => {
  await requireManagedConfigEditor(event);
  const [document, config] = await Promise.all([
    backend!.automation.getConfigDocument(),
    backend!.automation.getConfig(),
  ]);
  assertProfileConfigDocument(document.path);
  return { document, config };
});

ipcMain.handle('terminal-config-editor-validate', async (event, payload: unknown) => {
  await requireManagedConfigEditor(event);
  const contents = validateConfigContents(payload);
  const current = await backend!.automation.getConfigDocument();
  assertProfileConfigDocument(current.path);
  return validateManagedConfigCandidate(current, contents);
});

ipcMain.handle('terminal-config-editor-save', async (event, payload: unknown) => {
  await requireManagedConfigEditor(event);
  const request = validateConfigSaveRequest(payload);
  const current = await backend!.automation.getConfigDocument();
  assertProfileConfigDocument(current.path);
  const validation = await validateManagedConfigCandidate(current, request.contents);
  if (validation.blockingErrors.length > 0) {
    throw new Error(validation.blockingErrors.map((diagnostic) => diagnostic.message).join('\n'));
  }
  try {
    const update = await backend!.automation.replaceConfigDocument(request.expectedRevision, request.contents);
    assertProfileConfigDocument(update.document.path);
    return { status: 'saved', document: update.document, config: update.config } as const;
  } catch (error) {
    if (!(error instanceof GhostteaConfigDocumentConflictError)) throw error;
    assertProfileConfigDocument(error.document.path);
    return { status: 'conflict', document: error.document } as const;
  }
});

ipcMain.handle('terminal-config-editor-import-ghostty', async (event) => {
  await requireManagedConfigEditor(event);
  const inherited = await backend!.automation.validateConfigDocument('');
  const sources = inherited.config.sources.filter((source) => source.kind !== 'ghosttea-overlay');
  if (sources.length === 0) {
    return { status: 'unavailable', message: 'No Ghostty configuration files were detected.' } as const;
  }
  const contents = serializeSupportedGhosttyConfig(inherited.config);
  try {
    validateConfigContents(contents);
  } catch {
    return {
      status: 'unavailable',
      message: "The supported Ghostty settings exceed Ghosttea's 64 KiB profile-overlay limit.",
    } as const;
  }
  return {
    status: 'selected',
    name: sources.length === 1 ? basename(sources[0]!.path) : `${sources.length} detected Ghostty sources`,
    contents,
    notice:
      'Generated supported overrides from the effective Ghostty settings. Source files, private paths, unsupported keys, and relative includes were not copied.',
  } as const;
});

ipcMain.handle('terminal-config-editor-import-file', async (event) => {
  await requireManagedConfigEditor(event);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: 'Import Ghostty configuration',
    properties: ['openFile'],
    filters: [
      { name: 'Ghostty configuration', extensions: ['ghostty', 'conf', 'config'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  const path = selection.filePaths[0];
  if (selection.canceled || !path) return { status: 'cancelled' } as const;
  return {
    status: 'selected',
    name: basename(path),
    contents: await readConfigImport(path),
    notice:
      'Imported text is staged as a draft. Active config-file directives must stay in their current order or be cleared; edit include structure through the externally opened profile config.',
  } as const;
});

ipcMain.handle('terminal-config-editor-export-file', async (event, payload: unknown) => {
  await requireManagedConfigEditor(event);
  const contents = validateConfigContents(payload);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: 'Export Ghostty configuration',
    defaultPath: join(app.getPath('documents'), 'godview-terminal-config.ghostty'),
    filters: [{ name: 'Ghostty configuration', extensions: ['ghostty'] }],
  };
  const selection = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (selection.canceled || !selection.filePath) return { status: 'cancelled' } as const;
  await writeFile(selection.filePath, contents, { encoding: 'utf8', mode: 0o600 });
  return { status: 'saved', path: selection.filePath } as const;
});

ipcMain.on('terminal-config-editor-dirty', (event, payload: unknown) => {
  if (
    typeof payload !== 'boolean' ||
    externalBackendConfigured() ||
    !trustedManagedConfigEditorSender(event.sender, event.senderFrame)
  ) {
    return;
  }
  if (payload) dirtyConfigEditorSenders.add(event.sender);
  else dirtyConfigEditorSenders.delete(event.sender);
});

ipcMain.on('terminal-new-tab', (event, cwd: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tabs.get(window)) return;
  void createWindow({
    tabOf: window,
    initialCwd: typeof cwd === 'string' && cwd.trim() ? cwd : undefined,
    freshWorkspace: true,
  }).catch((error) => console.error('failed to create tab', error));
});

ipcMain.on('terminal-select-tab', (event, target: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tabs.get(window)) return;
  if (target === 'previous') {
    if (process.platform === 'darwin') window.selectPreviousTab();
    else focusRelativeTab(window, -1);
  } else if (target === 'next') {
    if (process.platform === 'darwin') window.selectNextTab();
    else focusRelativeTab(window, 1);
  } else if (target === 'last' || (typeof target === 'number' && Number.isSafeInteger(target))) {
    const current = tabs.get(window);
    if (!current) return;
    const orderedWindows = orderNativeTabs(
      tabs.group(current.groupId).map((record) => record.window),
      nativeTabAddonPaths,
    );
    if (orderedWindows.length === 0) return;
    const index =
      target === 'last' ? orderedWindows.length - 1 : Math.min(Math.max(target, 1), orderedWindows.length) - 1;
    focusTab(orderedWindows[index]);
  }
});

ipcMain.on('terminal-close-tab', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && tabs.get(window)) window.close();
});

function terminateDetachedPlainSessions(sessionIds: Iterable<string>): void {
  if (quitting) return;
  const client = backend?.automation;
  if (!client) return;
  for (const sessionId of sessionIds) {
    // Agents are application-level work: closing their last pane only detaches
    // the viewport. Plain terminals have no other owner and should end here.
    if (agentRecords.has(sessionId) || pendingRestoreAgents.has(sessionId) || restoredSessionAliases.has(sessionId)) {
      continue;
    }
    void client
      .terminate(sessionId, 'user')
      .catch((error) => console.warn(`[main] failed to terminate detached terminal ${sessionId}`, error));
  }
}

function pruneRestoredSessionAliases(): void {
  for (const originSessionId of restoredSessionAliases.keys()) {
    if (
      tabs
        .records()
        .some(
          (record) =>
            record.sessionIds.has(originSessionId) ||
            (record.workspace && restoreWorkspaceSessionIds(record.workspace).includes(originSessionId)),
        )
    ) {
      continue;
    }
    restoredSessionAliases.delete(originSessionId);
    paneRehydrations.delete(originSessionId);
  }
}

ipcMain.on('terminal-tab-sessions', (event, sessionIds: unknown, workspace: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    !window ||
    !Array.isArray(sessionIds) ||
    sessionIds.length > MAX_RESTORE_PANES_PER_WINDOW ||
    !sessionIds.every((id) => typeof id === 'string')
  ) {
    return;
  }
  const document = workspace === undefined ? undefined : readRestoreWorkspaceDocument(workspace);
  const changes = tabs.updateSessions(window, sessionIds, document);
  terminateDetachedPlainSessions(changes.detachedSessionIds);
  pruneRestoredSessionAliases();
  if (changes.sessionsChanged) scheduleRestoreCheckpoint(true);
  else if (changes.workspaceChanged) scheduleRestoreCheckpoint();
});

ipcMain.on('terminal-session-handoff-ack', (event, handoffId: unknown) => {
  if (typeof handoffId !== 'string') return;
  const pending = pendingTerminalHandoffs.get(handoffId);
  if (!pending || pending.window.webContents !== event.sender) return;
  clearTimeout(pending.timer);
  pendingTerminalHandoffs.delete(handoffId);
});

ipcMain.on('terminal-workspace-document', (event, workspace: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const record = window && tabs.get(window);
  const document = readRestoreWorkspaceDocument(workspace);
  if (!window || !record || !document) return;
  if (tabs.updateSessions(window, [...record.sessionIds], document).workspaceChanged) scheduleRestoreCheckpoint();
});

ipcMain.on('terminal-tab-active-cwd', (event, cwd: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  tabs.updateActiveCwd(window, typeof cwd === 'string' && cwd.trim() ? cwd : undefined);
  scheduleRestoreCheckpoint();
});

ipcMain.handle('godview:process-cwd', (event, pid: unknown): Promise<string | undefined> => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tabs.get(window) || typeof pid !== 'number') return Promise.resolve(undefined);
  return resolveProcessCwd(pid);
});

ipcMain.on('godview:set-theme', (event, value: unknown) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source) || (value !== 'light' && value !== 'dark')) return;
  nativeTheme.themeSource = value;
  const backgroundColor = process.platform === 'darwin' ? '#00000000' : value === 'dark' ? '#0a0a0a' : '#f7f7f7';
  for (const record of tabs.records()) {
    if (record.window.isDestroyed()) continue;
    record.window.setBackgroundColor(backgroundColor);
    record.window.webContents.send('godview:theme-changed', value);
  }
  if (!externalBackendConfigured()) {
    void enqueueAppearanceOperation(() => activateManagedAppearanceMode(value)).catch((error) =>
      console.error(`[main] failed to activate ${value} terminal appearance`, error),
    );
  }
});

function focusGodviewWindow(): void {
  const window =
    BrowserWindow.getFocusedWindow() ??
    (lastFocusedWindow && !lastFocusedWindow.isDestroyed() ? lastFocusedWindow : tabs.records()[0]?.window);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.show();
  window.focus();
}

function focusTab(window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
}

function focusRelativeTab(window: BrowserWindow, offset: -1 | 1): void {
  const current = tabs.get(window);
  if (!current) return;
  const group = tabs.group(current.groupId);
  const index = group.findIndex((record) => record.window === window);
  if (index < 0 || group.length < 2) return;
  focusTab(group[(index + offset + group.length) % group.length]?.window);
}

interface CreateWindowOptions {
  tabOf?: BrowserWindow;
  initialCwd?: string;
  claimExistingSessions?: boolean;
  /** Show this viewport without letting its load completion steal focus. */
  activateOnReady?: boolean;
  /** A user asking for a new window or tab wants an empty one, not whatever the reused slot still holds. */
  freshWorkspace?: boolean;
  /** Reopen a specific slot, so its saved layout document is the one this window loads. */
  slotId?: string;
  /** Complete V2 document seeded before Ghosttea reads localStorage. */
  restoreWorkspace?: RestoreWorkspaceDocument;
}

async function createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
  await ensureBackend();
  const parentRecord = options.tabOf ? tabs.get(options.tabOf) : undefined;
  const groupId = parentRecord?.groupId ?? `godview-${randomUUID()}`;
  const tabId = options.slotId ?? allocateWorkspaceSlot(tabs.records().map((record) => record.id));
  // Reopening a window restores the layout its slot still holds; asking for a
  // new one means asking for an empty one, so that slot's document is cleared.
  const resetWorkspace = options.freshWorkspace === true;
  const claimExistingSessions = options.claimExistingSessions ?? tabs.records().length === 0;
  const additionalArguments = [
    `--ghosttea-tab-id=${tabId}`,
    `--ghosttea-tab-reset=${resetWorkspace ? '1' : '0'}`,
    `--ghosttea-tab-claim-existing=${claimExistingSessions ? '1' : '0'}`,
    `--ghosttea-remote-sessions=${remoteSessionsEnabled ? '1' : '0'}`,
    `--ghosttea-managed-config-editor=${externalBackendConfigured() ? '0' : '1'}`,
    ...(options.initialCwd ? [`--ghosttea-tab-cwd=${encodeURIComponent(options.initialCwd)}`] : []),
  ];
  const window = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 680,
    minHeight: 360,
    show: false,
    title: 'Godview',
    // Transparency is immutable after construction. Keep every macOS viewport
    // alpha-capable so terminal opacity can change live from Settings. Native
    // under-window vibrancy supplies the desktop blur behind that alpha.
    backgroundColor:
      process.platform === 'darwin' ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#f7f7f7',
    transparent: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin'
      ? {
          tabbingIdentifier: groupId,
          trafficLightPosition: { x: 14, y: 13 },
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
        }
      : {}),
    acceptFirstMouse: true,
    fullscreenable: true,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
      additionalArguments,
    },
  });
  const windowWebContents = window.webContents;
  const webContentsId = windowWebContents.id;
  let rendererRecoveryTimer: NodeJS.Timeout | undefined;
  const record = tabs.add(window, tabId, groupId, options.restoreWorkspace);
  if (options.tabOf && process.platform === 'darwin' && !options.tabOf.isDestroyed()) {
    options.tabOf.addTabbedWindow(window);
  }
  const reveal = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (options.activateOnReady === false) {
      window.showInactive();
      return;
    }
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.show();
    window.focus();
  };
  window.once('ready-to-show', reveal);
  window.on('focus', () => {
    lastFocusedWindow = window;
    scheduleRestoreCheckpoint();
  });
  if (process.platform === 'win32') {
    // Windows does not emit app.before-quit for system logout/reboot. Its
    // session-end window events are the only reliable checkpoint opportunity.
    window.on('query-session-end', (event) => checkpointAndExitForSystemShutdown(event));
    window.on('session-end', (event) => checkpointAndExitForSystemShutdown(event));
  }
  window.on('new-window-for-tab', () => {
    void createWindow({ tabOf: window, initialCwd: record.activeCwd, freshWorkspace: true }).catch((error) =>
      console.error('failed to create native tab', error),
    );
  });
  window.once('closed', () => {
    // A window is only a viewport. Its PTYs may be agents, may be mirrored in
    // another viewport, and must keep running until process exit or app
    // shutdown. Removing the attachment record is intentionally observational.
    const closed = tabs.delete(window);
    if (closed) terminateDetachedPlainSessions(tabs.unreferencedSessionIds(closed.sessionIds));
    dirtyConfigEditorSenders.delete(windowWebContents);
    scheduleRestoreCheckpoint(true);
    agentStateDeliveries.delete(webContentsId);
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    if (lastFocusedWindow === window) lastFocusedWindow = undefined;
  });
  window.on('close', (event) => guardDirtyConfigEditorClose(window, event));
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[main] preload failed at ${preloadPath}: ${error.stack ?? error.message}`);
  });
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) dirtyConfigEditorSenders.delete(windowWebContents);
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      console.error(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    pauseAgentStateDelivery(window);
    console.error(`[renderer] process gone: ${details.reason} (${details.exitCode})`);
    if (quitting || window.isDestroyed() || details.reason === 'clean-exit' || rendererRecoveryTimer) return;
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = undefined;
      if (!quitting && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.reload();
    }, 250);
  });
  // Terminal selections live in the render worker rather than the DOM, so
  // Electron's native edit role cannot copy them. Route the shortcut through
  // the same renderer command path as the terminal context menu.
  installGhostteaEditShortcuts(
    window.webContents,
    (command) => window.webContents.send('terminal-menu-action', command),
    process.platform,
    (command) => command !== 'copy' || clipboardHost.canCopy(window.webContents),
  );
  window.webContents.on('did-finish-load', () => {
    resumeAgentStateDelivery(window);
    if (!window.isDestroyed() && backend?.running) backend.attachRenderer(window.webContents);
  });
  await window.loadFile(join(__dirname, 'index.html'));
  reveal();
  return window;
}

async function runSmoke(): Promise<void> {
  await ensureBackend();
  const session = await backend!.automation.createSession({
    executable: '/bin/echo',
    args: ['SMOKE OK'],
    environment: { mode: 'inherit' },
    cols: 80,
    rows: 24,
    persistence: 'terminate-with-app',
    programKind: 'application',
  });
  const exited = await backend!.automation.waitForExit(session.id, 20_000);
  if (exited.exitCode !== 0) throw new Error(`smoke session exited ${exited.exitCode ?? exited.exitSignal}`);
  console.log('SMOKE OK');
}

async function runAppearanceSmoke(): Promise<void> {
  if (!basename(app.getPath('userData')).startsWith('godview-appearance-smoke-')) {
    throw new Error('appearance smoke requires its isolated temporary user-data profile');
  }
  await activateManagedAppearanceMode('light');
  let document = await backend!.automation.getConfigDocument();
  if (!document.contents.includes('# Theme: Ghosttea Light')) {
    throw new Error('appearance smoke did not activate Ghosttea Light');
  }

  const current = await backend!.automation.getConfig();
  const smokeDarkTheme = {
    ...appearanceProfiles.dark,
    name: 'Appearance Smoke Dark',
    background: '#101820',
  };
  await saveManagedAppearanceForMode('dark', {
    ...appearanceUpdateForMode(current.renderer, smokeDarkTheme),
    backgroundOpacity: 0.57,
  });
  document = await backend!.automation.getConfigDocument();
  if (!document.contents.includes('# Theme: Appearance Smoke Dark')) {
    throw new Error('appearance smoke did not save the dark selection');
  }

  await activateManagedAppearanceMode('light');
  document = await backend!.automation.getConfigDocument();
  if (
    !document.contents.includes('# Theme: Ghosttea Light') ||
    !document.contents.includes('background-opacity = 0.57')
  ) {
    throw new Error('appearance smoke did not restore light colors with shared appearance settings');
  }

  await activateManagedAppearanceMode('dark');
  document = await backend!.automation.getConfigDocument();
  const persisted = parseAppearanceProfiles(readFileSync(terminalAppearanceProfilesPath, 'utf8'));
  if (
    !document.contents.includes('# Theme: Appearance Smoke Dark') ||
    persisted.light.name !== 'Ghosttea Light' ||
    persisted.dark.name !== 'Appearance Smoke Dark'
  ) {
    throw new Error('appearance smoke did not preserve independent light and dark selections');
  }
  console.log('APPEARANCE SMOKE OK');
}

let restoreSmokeDiagnostic = '';

async function until<T>(what: string, attempt: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await attempt();
    if (value !== undefined) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const detail = restoreSmokeDiagnostic ? ` (${restoreSmokeDiagnostic})` : '';
  throw new Error(`restore smoke timed out waiting for ${what}${detail}`);
}

function requireRestoreSmokeProfile(): void {
  if (!basename(app.getPath('userData')).startsWith('godview-restore-smoke-')) {
    throw new Error('restore smoke requires its isolated temporary user-data profile');
  }
}

/** First process: checkpoint a real renderer workspace twice, then exit without the normal quit flush. */
async function runRestoreRestartSeedSmoke(): Promise<void> {
  requireRestoreSmokeProfile();
  const window = await createWindow({
    slotId: 'godview-restart-smoke',
    freshWorkspace: true,
    claimExistingSessions: false,
  });
  await until('the renderer workspace to reach main', async () => {
    const record = tabs.get(window);
    return record?.workspace && record.sessionIds.size === 1 ? record : undefined;
  });
  restoreCheckpointReady = true;
  const first = commitRestoreCheckpoint();
  const second = commitRestoreCheckpoint();
  const durable = readDurableRestoreState(restoreStateDirectory);
  if (!first || !second || !durable || durable.generation < 2 || durable.snapshot.windows.length !== 1) {
    throw new Error('restore smoke did not durably commit two complete generations');
  }
  console.log(`RESTORE RESTART SEED OK (generation ${durable.generation})`);

  // Deliberately bypass shutdown(), which is the behavior a killed process has.
  // Signal the test daemon only so the smoke itself does not leave an orphan.
  quitting = true;
  quitReady = true;
  if (restoreCheckpointTimer) clearTimeout(restoreCheckpointTimer);
  restoreCheckpointTimer = undefined;
  backend?.stop();
  backend = undefined;
  app.exit(73);
}

/** Second process: load the prior valid generation and prove its dead pane is rebound to a live PTY. */
async function runRestoreRestartVerifySmoke(): Promise<void> {
  requireRestoreSmokeProfile();
  const candidate = loadRestoreCandidate();
  if (candidate?.kind !== 'snapshot') throw new Error('restore smoke found no valid durable generation');
  const savedIds = snapshotReferencedSessionIds(candidate.value);
  restoreSnapshot = candidate.value;
  await openRestoredSnapshotWindows(candidate.value);
  await restoreDetachedAgents(candidate.value);
  restoreCheckpointReady = true;

  const restoredId = await until('the restarted pane to bind a replacement PTY', async () => {
    const ids = tabs.records().flatMap((record) => [...record.sessionIds]);
    return ids.find((id) => !savedIds.has(id));
  });
  const live = await backend!.automation.listSessions();
  if (!live.some((session) => session.id === restoredId && !session.exited)) {
    throw new Error(`post-restart pane ${restoredId} is not live`);
  }
  commitRestoreCheckpoint();
  console.log(`RESTORE RESTART/CORRUPTION SMOKE OK (${[...savedIds].join(',')} -> ${restoredId})`);
}

/**
 * Drives the restore path against a real window, because that is the only place
 * it exists: rehydration runs inside the renderer's workspace initialization,
 * so no amount of unit testing over the pure parts proves the wiring works.
 *
 * The pane is made dead the way a restart makes one dead: by pointing the saved
 * layout at a session id the daemon has never heard of. Terminating a real
 * session is not the same thing — ghosttead still reports it, so Ghosttea
 * resolves the pane and never asks for a replacement.
 */
async function runRestoreSmoke(): Promise<void> {
  await ensureBackend();
  const client = backend!.automation;
  const slotId = 'godview-restore-smoke';
  const storageKey = `godview:ghosttea-workspace:v2:${slotId}`;
  const savedSessionId = 'restore-smoke-session-that-never-existed';
  const window = await createWindow({ slotId, freshWorkspace: true, claimExistingSessions: false });

  const saved = await until('Ghosttea to persist a layout', async () => {
    const raw: unknown = await window.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(storageKey)})`,
    );
    if (typeof raw !== 'string') return undefined;
    const parsed = JSON.parse(raw) as { root?: { kind?: string; id?: string; sessionId?: string } };
    const root = parsed.root;
    if (root?.kind !== 'pane' || typeof root.id !== 'string' || typeof root.sessionId !== 'string') return undefined;
    return { document: parsed as Record<string, unknown>, paneId: root.id, sessionId: root.sessionId };
  });

  const originalSessionId = saved.sessionId;
  const originalPaneId = saved.paneId;
  const document = saved.document;
  // Two panes, one dead. A revived pane keeps the split; a dropped one collapses
  // it to the survivor. One pane could not tell those apart — an emptied layout
  // makes Ghosttea open a default shell, which looks just like a restored pane.
  document['root'] = {
    kind: 'split',
    id: 'restore-smoke-split',
    axis: 'horizontal',
    ratio: 0.5,
    first: { kind: 'pane', id: 'restore-smoke-dead-pane', sessionId: savedSessionId },
    second: { kind: 'pane', id: originalPaneId, sessionId: originalSessionId },
  };
  await window.webContents.executeJavaScript(
    `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(document))})`,
  );
  const savedRootKind = (): Promise<unknown> =>
    window.webContents.executeJavaScript(
      `JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}) ?? '{}')?.root?.kind`,
    );
  if ((await savedRootKind()) !== 'split') throw new Error('restore smoke could not seed a two-pane layout');

  restoreManifest = {
    version: RESTORE_MANIFEST_VERSION,
    updatedAtMs: Date.now(),
    windows: [
      { slotId, groupId: 'restore-smoke', panes: [{ sessionId: savedSessionId, kind: 'terminal', cwd: repoRoot }] },
    ],
  };

  window.webContents.reload();
  await new Promise<void>((settle) => {
    window.webContents.once('did-finish-load', () => settle());
  });
  // Guards the one-shot reset: a window that clears its layout on every load —
  // and this one reloads itself to recover a dead renderer — silently destroys
  // what it was meant to restore, and every assertion below would still pass by
  // way of Ghosttea opening a fresh default shell.
  if ((await savedRootKind()) !== 'split') {
    throw new Error('the saved layout was cleared on reload, so there was nothing left to restore');
  }

  // The window reporting exactly one pane, holding a session that is neither
  // the dead id nor the one from before the reload, is what proves the pane was
  // revived in place rather than dropped and its split collapsed.
  const restoredId = await until('the dead pane to be rehydrated', async () => {
    const reported = [...(tabs.get(window)?.sessionIds ?? [])];
    restoreSmokeDiagnostic = `window reported [${reported.join(', ')}]`;
    if (reported.length !== 2 || !reported.includes(originalSessionId)) return undefined;
    return reported.find((id) => id !== savedSessionId && id !== originalSessionId);
  });
  const live = await client.listSessions();
  if (!live.some((session) => session.id === restoredId && !session.exited)) {
    throw new Error(`restored pane ${restoredId} is not a live session`);
  }
  console.log(`RESTORE SMOKE OK (${savedSessionId} -> ${restoredId})`);
}

/**
 * Direct agent-session smoke (PUPPETEER_AGENT_SMOKE=<agent>): exercises the
 * runtime createSession path against the configured native executable. Use
 * `--spawn-through-smoke=<agent>` with `ai --<agent>` for Imposter integration;
 * that path owns the per-session persona environment as well as the binary.
 */
async function runAgentSmoke(agent: BuiltinExecutableAgentKind): Promise<void> {
  await ensureBackend();
  const result = await createAgentSession({ agent, cwd: repoRoot });
  if ('error' in result)
    throw new Error(`agent smoke createSession failed: ${result.error.code} ${result.error.message}`);
  // Watch for the spawned process dying so the failure says WHY, not just none.
  let exitInfo: string | undefined;
  void backend!.automation.waitForExit(result.runtimeSessionId, 35_000).then(
    (exit) => {
      exitInfo = `process exited code=${exit.exitCode ?? 'null'} signal=${exit.exitSignal ?? 'null'}`;
    },
    () => undefined,
  );
  const deadline = Date.now() + 30_000;
  let lifecycle: string | undefined;
  while (Date.now() < deadline) {
    lifecycle = agentRuntime.sessionState(result.runtimeSessionId)?.lifecycle;
    if (lifecycle === 'ready' || lifecycle === 'failed' || lifecycle === 'exited') break;
    if (exitInfo) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (lifecycle !== 'ready') {
    throw new Error(`${agent} did not become ready (lifecycle=${lifecycle ?? 'none'}; ${exitInfo ?? 'process alive'})`);
  }
  console.log(`AGENT SMOKE OK ${agent} ${result.sessionId}`);
  // Diagnostic hold (PUPPETEER_AGENT_SMOKE_HOLD_MS): keep the session alive
  // so external observers (e.g. the Imposter control plane) can see it.
  const holdMs = Number(process.env.PUPPETEER_AGENT_SMOKE_HOLD_MS ?? 0);
  if (holdMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, holdMs));
}

async function runSpawnThroughSmoke(agent: BuiltinExecutableAgentKind): Promise<void> {
  const launchCommand = process.env.PUPPETEER_SPAWN_SMOKE_COMMAND ?? agent;
  const commandWords = launchCommand.trim().split(/\s+/u);
  const usesInstalledImposter =
    Boolean(imposterExecutable) && commandWords[0] === 'ai' && commandWords[1] === `--${agent}`;
  if (!realAgentExecutables[agent] && !usesInstalledImposter) throw new Error(`${agent} is not installed`);
  const configuredCwd = process.env.PUPPETEER_SPAWN_SMOKE_CWD?.trim();
  const smokeCwd = configuredCwd || repoRoot;
  if (!isAbsolute(smokeCwd)) throw new Error('PUPPETEER_SPAWN_SMOKE_CWD must be absolute');
  try {
    accessSync(smokeCwd, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(`spawn-through smoke cwd is not an accessible directory: ${smokeCwd}`);
  }
  const expectedDelegateMarkers = (process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_DELEGATE_MARKERS ?? '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((marker) => {
      if (!isAbsolute(marker)) throw new Error('spawn-through delegate marker paths must be absolute');
      const markerPath = resolve(marker);
      const fromCwd = relative(resolve(smokeCwd), markerPath);
      if (fromCwd === '' || fromCwd === '..' || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd)) {
        throw new Error(`spawn-through delegate marker must be inside the smoke cwd: ${markerPath}`);
      }
      let initialSize = 0;
      try {
        initialSize = statSync(markerPath).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return { path: markerPath, initialSize };
    });
  await ensureBackend();
  const session = await backend!.automation.createSession({
    executable:
      process.platform === 'win32' ? (process.env.COMSPEC ?? 'powershell.exe') : (process.env.SHELL ?? '/bin/zsh'),
    args: [],
    cwd: smokeCwd,
    environment: { mode: 'inherit' },
    cols: 100,
    rows: 30,
    persistence: 'terminate-with-app',
    programKind: 'interactive-shell',
  });
  const submitted = await backend!.automation.pasteAndSubmit(session.id, launchCommand);
  if (!submitted.accepted) throw new Error(`spawn-through smoke input was rejected: ${submitted.reason}`);
  const pickerDelayMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_PICKER_ACCEPT_MS ?? 0);
  if (pickerDelayMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pickerDelayMs));
    const accepted = await backend!.automation.pasteAndSubmit(session.id, '');
    if (!accepted.accepted) throw new Error(`spawn-through smoke picker input was rejected: ${accepted.reason}`);
  }
  const deadline = Date.now() + 30_000;
  let lifecycle: string | undefined;
  // A fresh Kimi session is intentionally lazy: its durable native identity
  // and session:started record do not exist until the first prompt. Adoption
  // still has to complete before we proceed, and the scripted turn below must
  // then prove the durable bind and ready lifecycle.
  const allowsLazyInitialIdentity = agent === 'kimi' && Boolean(process.env.PUPPETEER_SPAWN_SMOKE_PROMPT);
  while (Date.now() < deadline) {
    lifecycle = stateSnapshot(session.id)?.state.lifecycle;
    if (
      agentRecords.has(session.id) &&
      lifecycle &&
      (allowsLazyInitialIdentity || !['preparing', 'starting'].includes(lifecycle))
    ) {
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const record = agentRecords.get(session.id);
  if (!record || record.info.agent !== agent || !record.info.preparationId) {
    throw new Error(`${agent} was not adopted into the shell terminal`);
  }
  if (!lifecycle || (!allowsLazyInitialIdentity && ['preparing', 'starting'].includes(lifecycle))) {
    throw new Error(`${agent} was adopted but structured control did not become ready`);
  }
  if (lifecycle === 'failed' || lifecycle === 'exited') {
    throw new Error(`${agent} entered terminal lifecycle ${lifecycle}`);
  }
  const observedToolRequests = new Map<string, string>();
  const observedToolOutcomes = new Map<string, 'completed' | 'failed'>();
  const observedPermissions = new Map<
    string,
    { tool?: string; toolCallId?: string; outcome?: 'allowed' | 'denied' | 'dismissed' | 'unknown' }
  >();
  const observedRebinds: Array<{ sequence: number; nativeSessionId?: string; startSource?: string }> = [];
  const observedProcessExitReasons: string[] = [];
  let clearEventSequence: number | undefined;
  let postClearTranscriptAssistant = false;
  const unsubscribeSmokeEvents = agentRuntime.onEvent((runtimeSessionId, envelope) => {
    if (runtimeSessionId !== session.id) return;
    const { event } = envelope;
    switch (event.type) {
      case 'tool:requested':
        observedToolRequests.set(event.toolCallId, event.tool);
        break;
      case 'tool:completed':
        observedToolOutcomes.set(event.toolCallId, 'completed');
        break;
      case 'tool:failed':
        observedToolOutcomes.set(event.toolCallId, 'failed');
        break;
      case 'interaction:permission-requested':
        observedPermissions.set(event.requestId, {
          ...(event.tool === undefined ? {} : { tool: event.tool }),
          ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        });
        break;
      case 'interaction:permission-resolved': {
        const prior = observedPermissions.get(event.requestId) ?? {};
        observedPermissions.set(event.requestId, { ...prior, outcome: event.outcome });
        break;
      }
      case 'session:started':
        if (event.rebind) {
          observedRebinds.push({
            sequence: envelope.sequence,
            ...(event.nativeSessionId === undefined ? {} : { nativeSessionId: event.nativeSessionId }),
            ...(event.startSource === undefined ? {} : { startSource: event.startSource }),
          });
        }
        break;
      case 'conversation:assistant-message':
        if (
          clearEventSequence !== undefined &&
          envelope.sequence > clearEventSequence &&
          envelope.source === 'native-transcript'
        ) {
          postClearTranscriptAssistant = true;
        }
        break;
      case 'process:exited':
        observedProcessExitReasons.push(event.reason);
        break;
    }
  });
  const expectedModel = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_MODEL?.trim().toLowerCase() || undefined;
  const expectedEffort = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_EFFORT?.trim().toLowerCase() || undefined;
  const expectedPermission =
    process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_PERMISSION_MODE?.trim().toLowerCase() || undefined;
  const expectedModelIntent =
    process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_MODEL_INTENT?.trim().toLowerCase() ||
    (expectedModel ? 'observed' : undefined);
  const expectedEffortIntent =
    process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_EFFORT_INTENT?.trim().toLowerCase() ||
    (expectedEffort ? 'configured' : undefined);
  const expectedPermissionIntent =
    process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_PERMISSION_MODE_INTENT?.trim().toLowerCase() ||
    (expectedPermission ? 'configured' : undefined);
  if (
    [expectedModelIntent, expectedEffortIntent, expectedPermissionIntent].some(
      (intent) => intent !== undefined && intent !== 'configured' && intent !== 'observed',
    )
  ) {
    throw new Error('initial model/effort/permission intent must be configured or observed');
  }
  const includesExpected = (values: Array<string | undefined>, expected: string | undefined): boolean =>
    expected === undefined || values.some((value) => value?.toLowerCase().includes(expected));
  const equalsExpected = (values: Array<string | undefined>, expected: string | undefined): boolean =>
    expected === undefined || values.some((value) => value?.toLowerCase() === expected);
  type MonitorConfigurationExpectation = {
    model?: string;
    modelIntent?: string;
    configuredModel?: string;
    effort?: string;
    effortIntent?: string;
    configuredEffort?: string;
    permission?: string;
    permissionIntent?: string;
    configuredPermission?: string;
  };
  const monitorMatchesConfiguration = (
    monitor: ReturnType<typeof agentRuntime.monitorState>,
    expected: MonitorConfigurationExpectation,
  ): boolean =>
    includesExpected([monitor?.model?.id, monitor?.model?.displayName], expected.model) &&
    equalsExpected([monitor?.model?.intent], expected.modelIntent) &&
    includesExpected(
      [monitor?.model?.configured?.id, monitor?.model?.configured?.displayName],
      expected.configuredModel,
    ) &&
    equalsExpected([monitor?.effort?.value], expected.effort) &&
    equalsExpected([monitor?.effort?.intent], expected.effortIntent) &&
    equalsExpected([monitor?.effort?.configured], expected.configuredEffort) &&
    equalsExpected(
      [monitor?.modes.providerPermission?.raw, monitor?.modes.providerPermission?.normalized],
      expected.permission,
    ) &&
    equalsExpected([monitor?.modes.providerPermission?.intent], expected.permissionIntent) &&
    equalsExpected(
      [monitor?.modes.providerPermission?.configured?.raw, monitor?.modes.providerPermission?.configured?.normalized],
      expected.configuredPermission,
    );
  const initialExpectation: MonitorConfigurationExpectation = {
    ...(expectedModel
      ? expectedModelIntent === 'configured'
        ? { configuredModel: expectedModel }
        : { model: expectedModel, modelIntent: expectedModelIntent }
      : {}),
    ...(expectedEffort
      ? expectedEffortIntent === 'configured'
        ? { configuredEffort: expectedEffort }
        : { effort: expectedEffort, effortIntent: expectedEffortIntent }
      : {}),
    ...(expectedPermission
      ? expectedPermissionIntent === 'configured'
        ? { configuredPermission: expectedPermission }
        : { permission: expectedPermission, permissionIntent: expectedPermissionIntent }
      : {}),
  };
  if (expectedModel || expectedEffort || expectedPermission) {
    const expectationDeadline = Date.now() + 20_000;
    let monitor = agentRuntime.monitorState(record.info.runtimeRunId);
    while (Date.now() < expectationDeadline) {
      monitor = agentRuntime.monitorState(record.info.runtimeRunId);
      if (monitorMatchesConfiguration(monitor, initialExpectation)) {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!monitorMatchesConfiguration(monitor, initialExpectation)) {
      throw new Error(
        `${agent} monitor did not confirm the requested model/effort/mode: ${JSON.stringify({
          expected: initialExpectation,
          observed: { model: monitor?.model, effort: monitor?.effort, modes: monitor?.modes },
        })}`,
      );
    }
    console.log(
      `SPAWN-THROUGH CONFIG OK ${JSON.stringify({ model: monitor?.model, effort: monitor?.effort, modes: monitor?.modes })}`,
    );
  }
  const configCommands = (process.env.PUPPETEER_SPAWN_SMOKE_CONFIG_COMMANDS ?? '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean);
  const configExpectationSpecs = (process.env.PUPPETEER_SPAWN_SMOKE_CONFIG_EXPECTATIONS ?? '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean);
  if (configCommands.length !== configExpectationSpecs.length) {
    throw new Error('config smoke commands and expectations must have the same length');
  }
  if (configCommands.length > 0) {
    const configSettleMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_CONFIG_SETTLE_MS ?? 8_000);
    if (!Number.isSafeInteger(configSettleMs) || configSettleMs < 0 || configSettleMs > 120_000) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_CONFIG_SETTLE_MS must be 0 through 120000');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, configSettleMs));
  }
  for (const [index, command] of configCommands.entries()) {
    if (!/^\/(?:model|effort)\b/.test(command)) {
      throw new Error(`unsupported config smoke command ${command}`);
    }
    const expected: MonitorConfigurationExpectation = {};
    for (const assignment of configExpectationSpecs[index]!.split(',')) {
      const separator = assignment.indexOf('=');
      const key = assignment.slice(0, separator).trim() as keyof typeof expected;
      const value = assignment
        .slice(separator + 1)
        .trim()
        .toLowerCase();
      if (
        separator <= 0 ||
        !['model', 'modelIntent', 'effort', 'effortIntent', 'permission', 'permissionIntent'].includes(key) ||
        !value
      ) {
        throw new Error(`invalid config smoke expectation ${assignment}`);
      }
      expected[key] = value;
    }
    const before = agentRuntime.monitorState(record.info.runtimeRunId);
    if (monitorMatchesConfiguration(before, expected)) {
      throw new Error(`config smoke step ${index + 1} already matched before ${command}`);
    }
    const submittedConfig = await backend!.automation.pasteAndSubmit(session.id, command);
    if (!submittedConfig.accepted) {
      throw new Error(`config smoke command was rejected: ${submittedConfig.reason}`);
    }
    const configDeadline = Date.now() + 20_000;
    let observed = agentRuntime.monitorState(record.info.runtimeRunId);
    while (Date.now() < configDeadline) {
      observed = agentRuntime.monitorState(record.info.runtimeRunId);
      if (monitorMatchesConfiguration(observed, expected)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!monitorMatchesConfiguration(observed, expected)) {
      throw new Error(
        `config smoke step ${index + 1} was not observed: ${JSON.stringify({ command, expected, observed })}`,
      );
    }
    console.log(
      `SPAWN-THROUGH CONFIG CHANGE OK ${JSON.stringify({ command, model: observed?.model, effort: observed?.effort, modes: observed?.modes })}`,
    );
  }
  if (process.env.PUPPETEER_SPAWN_SMOKE_REQUIRE_HISTORY === '1') {
    const conversation = agentRuntime.conversationSnapshot(session.id);
    const hasUser = conversation?.items.some((item) => item.kind === 'user');
    const hasAssistant = conversation?.items.some((item) => item.kind === 'assistant');
    if (!hasUser || !hasAssistant) {
      throw new Error(`${agent} resumed but did not project its existing conversation history`);
    }
  }
  const prompt = process.env.PUPPETEER_SPAWN_SMOKE_PROMPT;
  if (prompt) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 8_000));
    const shiftTabCount = Number(process.env.PUPPETEER_SPAWN_SMOKE_SHIFT_TAB_COUNT ?? 0);
    if (!Number.isSafeInteger(shiftTabCount) || shiftTabCount < 0 || shiftTabCount > 8) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_SHIFT_TAB_COUNT must be an integer from 0 through 8');
    }
    for (let count = 0; count < shiftTabCount; count += 1) {
      const cycled = await backend!.automation.sendText(session.id, '\x1b[Z');
      if (!cycled.accepted) throw new Error(`spawn-through smoke mode cycle was rejected: ${cycled.reason}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    const expectedPermissionAfterPrompt =
      process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_PERMISSION_MODE_AFTER_PROMPT?.trim().toLowerCase() || undefined;
    const expectedQuestion = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_QUESTION?.trim() || undefined;
    const expectedQuestionChoices = (process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_QUESTION_CHOICES ?? '')
      .split('|')
      .map((choice) => choice.trim())
      .filter(Boolean);
    const optionalQuestionBoolean = (name: string): boolean | undefined => {
      const raw = process.env[name]?.trim();
      if (!raw) return undefined;
      if (raw === '1') return true;
      if (raw === '0') return false;
      throw new Error(`${name} must be 0 or 1`);
    };
    const expectedQuestionAllowMultiple = optionalQuestionBoolean(
      'PUPPETEER_SPAWN_SMOKE_EXPECT_QUESTION_ALLOW_MULTIPLE',
    );
    const expectedQuestionAllowFreeForm = optionalQuestionBoolean(
      'PUPPETEER_SPAWN_SMOKE_EXPECT_QUESTION_ALLOW_FREE_FORM',
    );
    const questionInput = process.env.PUPPETEER_SPAWN_SMOKE_QUESTION_INPUT?.trim() || undefined;
    const questionSettleMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_QUESTION_SETTLE_MS ?? 1_000);
    if (!Number.isSafeInteger(questionSettleMs) || questionSettleMs < 0 || questionSettleMs > 10_000) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_QUESTION_SETTLE_MS must be 0 through 10000');
    }
    const questionNavigationHoldMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_QUESTION_NAVIGATION_HOLD_MS ?? 0);
    if (
      !Number.isSafeInteger(questionNavigationHoldMs) ||
      questionNavigationHoldMs < 0 ||
      questionNavigationHoldMs > 120_000
    ) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_QUESTION_NAVIGATION_HOLD_MS must be 0 through 120000');
    }
    const questionKey = process.env.PUPPETEER_SPAWN_SMOKE_QUESTION_KEY ?? 'enter';
    const questionKeys = ['enter', 'down-enter', 'space-enter', 'multi-first-two', 'other-text'];
    if (expectedQuestion && !questionKeys.includes(questionKey)) {
      throw new Error(`unsupported spawn-through smoke question key ${questionKey}`);
    }
    if (expectedQuestion && questionKey === 'other-text' && !questionInput) {
      throw new Error('other-text question smoke requires PUPPETEER_SPAWN_SMOKE_QUESTION_INPUT');
    }
    let questionKeyView: { viewId: string; attachmentEpoch: number; inputSequence: number } | undefined;
    const sendQuestionKey = async (key: 'Space' | 'ArrowDown' | 'Tab' | 'Enter'): Promise<void> => {
      if (!questionKeyView) {
        const viewId = `spawn-smoke-question-${session.id}`;
        const attached = await backend!.automation.request({ type: 'attach-session', sessionId: session.id, viewId });
        if (attached.type !== 'view-attached' || !attached.readWrite) {
          throw new Error(`spawn-through smoke could not attach question input view: ${JSON.stringify(attached)}`);
        }
        questionKeyView = { viewId, attachmentEpoch: attached.attachmentEpoch, inputSequence: 0 };
        questionKeyView.inputSequence += 1;
        const focused = await backend!.automation.request({
          type: 'focus',
          sessionId: session.id,
          viewId: questionKeyView.viewId,
          attachmentEpoch: questionKeyView.attachmentEpoch,
          inputSequence: questionKeyView.inputSequence,
          focused: true,
        });
        if (focused.type !== 'ok') {
          throw new Error(`spawn-through smoke could not focus question input view: ${JSON.stringify(focused)}`);
        }
      }
      const event =
        key === 'Space'
          ? { key: ' ', code: 'Space', unshiftedCodepoint: 32 }
          : key === 'ArrowDown'
            ? { key: 'ArrowDown', code: 'ArrowDown', unshiftedCodepoint: 0 }
            : key === 'Tab'
              ? { key: 'Tab', code: 'Tab', unshiftedCodepoint: 0 }
              : { key: 'Enter', code: 'Enter', unshiftedCodepoint: 0 };
      for (const type of ['down', 'up'] as const) {
        questionKeyView.inputSequence += 1;
        const result = await backend!.automation.request({
          type: 'send-key',
          sessionId: session.id,
          viewId: questionKeyView.viewId,
          attachmentEpoch: questionKeyView.attachmentEpoch,
          inputSequence: questionKeyView.inputSequence,
          event: {
            type,
            ...event,
            location: 0,
            repeat: false,
            shift: false,
            control: false,
            alt: false,
            meta: false,
            timestamp: Date.now(),
          },
        });
        if (result.type !== 'ok') {
          throw new Error(`spawn-through smoke question key was rejected: ${JSON.stringify(result)}`);
        }
      }
    };
    const detachQuestionKeyView = async (): Promise<void> => {
      if (!questionKeyView) return;
      const { viewId } = questionKeyView;
      questionKeyView = undefined;
      const result = await backend!.automation.request({ type: 'detach-session', sessionId: session.id, viewId });
      if (result.type !== 'ok') {
        throw new Error(`spawn-through smoke could not detach question input view: ${JSON.stringify(result)}`);
      }
    };
    let questionObserved = false;
    let questionBlockerId: string | undefined;
    const prompts = [
      prompt,
      process.env.PUPPETEER_SPAWN_SMOKE_PROMPT_2,
      process.env.PUPPETEER_SPAWN_SMOKE_PROMPT_3,
    ].filter((value): value is string => Boolean(value));
    const interPromptSettleMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_INTER_PROMPT_SETTLE_MS ?? 500);
    if (!Number.isFinite(interPromptSettleMs) || interPromptSettleMs < 0 || interPromptSettleMs > 120_000) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_INTER_PROMPT_SETTLE_MS must be 0 through 120000');
    }
    const expectedReplies = [
      process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_REPLY,
      process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_REPLY_2,
      process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_REPLY_3,
    ].map((value) => value?.trim() || undefined);
    const expectedToolName = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TOOL?.trim() || undefined;
    const expectedToolCount = Number(
      process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TOOL_COUNT ?? (expectedToolName ? '1' : '0'),
    );
    if (!Number.isSafeInteger(expectedToolCount) || expectedToolCount < 0 || expectedToolCount > 20) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_EXPECT_TOOL_COUNT must be an integer from 0 through 20');
    }
    const expectedToolOutcome = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TOOL_OUTCOME?.trim().toLowerCase() as
      'completed' | 'failed' | 'denied' | undefined;
    if (expectedToolOutcome && !['completed', 'failed', 'denied'].includes(expectedToolOutcome)) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_EXPECT_TOOL_OUTCOME must be completed, failed, or denied');
    }
    const allowHookDenial = process.env.PUPPETEER_SPAWN_SMOKE_ALLOW_HOOK_DENIAL === '1';
    if (allowHookDenial && expectedToolOutcome !== 'denied') {
      throw new Error('PUPPETEER_SPAWN_SMOKE_ALLOW_HOOK_DENIAL requires a denied tool outcome');
    }
    if (expectedToolOutcome === 'denied' && !allowHookDenial) {
      throw new Error('denied tool smoke requires PUPPETEER_SPAWN_SMOKE_ALLOW_HOOK_DENIAL=1');
    }
    if ((expectedToolCount > 0 || expectedToolOutcome) && !expectedToolName) {
      throw new Error('tool count/outcome expectations require PUPPETEER_SPAWN_SMOKE_EXPECT_TOOL');
    }
    const expectClear = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_CLEAR === '1';
    const requirePostClearTranscript = process.env.PUPPETEER_SPAWN_SMOKE_REQUIRE_POST_CLEAR_TRANSCRIPT === '1';
    const clearPromptIndex = prompts.findIndex((value) => value.trim() === '/clear');
    if (expectClear && (clearPromptIndex < 0 || clearPromptIndex === prompts.length - 1)) {
      throw new Error('clear smoke requires /clear followed by another scripted prompt');
    }
    if (requirePostClearTranscript && !expectClear) {
      throw new Error('post-clear transcript smoke requires PUPPETEER_SPAWN_SMOKE_EXPECT_CLEAR=1');
    }
    const expectedTask = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TASK?.trim() || undefined;
    const expectedTaskStatuses = (process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TASK_STATUSES ?? '')
      .split('|')
      .map((status) => status.trim())
      .filter(Boolean);
    const expectedPlanSteps = (process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_PLAN_STEPS ?? '')
      .split('|')
      .map((step) => step.trim())
      .filter(Boolean);
    const expectedSubagentType = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_SUBAGENT_TYPE?.trim() || undefined;
    const expectedSubagentModel = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_SUBAGENT_MODEL?.trim() || undefined;
    const requireSubagentTelemetry = process.env.PUPPETEER_SPAWN_SMOKE_REQUIRE_SUBAGENT_TELEMETRY === '1';
    const expectedTeamMember = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TEAM_MEMBER?.trim() || undefined;
    const expectedTeamMemberModel = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TEAM_MEMBER_MODEL?.trim() || undefined;
    const expectedTeamMemberEffort = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TEAM_MEMBER_EFFORT?.trim() || undefined;
    const requireTeamMemberTelemetry = process.env.PUPPETEER_SPAWN_SMOKE_REQUIRE_TEAM_MEMBER_TELEMETRY === '1';
    const requireTeamMemberContext = process.env.PUPPETEER_SPAWN_SMOKE_REQUIRE_TEAM_MEMBER_CONTEXT === '1';
    const expectTeamMemberIdle = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_TEAM_MEMBER_IDLE === '1';
    if (
      !expectedTeamMember &&
      (expectedTeamMemberModel ||
        expectedTeamMemberEffort ||
        requireTeamMemberTelemetry ||
        requireTeamMemberContext ||
        expectTeamMemberIdle)
    ) {
      throw new Error('team-member smoke expectations require PUPPETEER_SPAWN_SMOKE_EXPECT_TEAM_MEMBER');
    }
    const expectRailFailure = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_RAIL_FAILURE === '1';
    if (requirePostClearTranscript && !expectRailFailure) {
      throw new Error(
        'post-clear transcript smoke requires an observation-rail fault so canonical event filtering exposes the transcript copy',
      );
    }
    if (expectRailFailure && prompts.length < 2) {
      throw new Error('rail-failure smoke requires a second prompt proving the native TUI remains usable');
    }
    const expectCompaction = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_COMPACTION === '1';
    const expectedCompactionOutcome = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_COMPACTION_OUTCOME?.trim();
    const allowCompactionBoundaryFallback =
      process.env.PUPPETEER_SPAWN_SMOKE_ALLOW_COMPACTION_BOUNDARY_FALLBACK === '1';
    const compactionFallbackSettleMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_COMPACTION_FALLBACK_SETTLE_MS ?? 1_500);
    const stopAfterPlan = process.env.PUPPETEER_SPAWN_SMOKE_STOP_AFTER_PLAN === '1';
    const planSettleMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_PLAN_SETTLE_MS ?? 1_000);
    const observedTaskIds = new Set<string>();
    const observedTaskStatuses = new Set<string>();
    const observedSubagentIds = new Set<string>();
    const observedSubagentModels = new Set<string>();
    const observedSubagentObservedModels = new Set<string>();
    let observedSubagentActive = false;
    let observedSubagentStopped = false;
    let observedSubagentActivity = false;
    let observedSubagentUsage = false;
    let observedSubagentBurnRate = false;
    let observedSubagentContext = false;
    const observedTeamMemberIds = new Set<string>();
    const observedTeamMemberModels = new Set<string>();
    const observedTeamMemberObservedModels = new Set<string>();
    const observedTeamMemberEfforts = new Set<string>();
    const observedTeamMemberObservedEfforts = new Set<string>();
    let observedDurableTeamMembership = false;
    let observedTeamMemberActive = false;
    let observedTeamMemberIdle = false;
    let observedTeamMemberActivity = false;
    let observedTeamMemberUsage = false;
    let observedTeamMemberBurnRate = false;
    let observedTeamMemberContext = false;
    let observedCompactionActive = false;
    let observedCompactionEnded = false;
    let observedCompactionOutcome: string | undefined;
    let observedRailFailure = false;
    let observedRailFailureLevel: string | undefined;
    let observedRailFailureFamilies: string[] = [];
    let compactionStartedAt: number | undefined;
    const compactionCountBefore = agentRuntime.monitorState(record.info.runtimeRunId)?.compaction.count ?? 0;
    let observedPlan: NonNullable<ReturnType<typeof agentRuntime.monitorState>>['plan'] | undefined;
    let planObservedAt: number | undefined;
    let stoppedAfterPlan = false;
    for (const [index, smokePrompt] of prompts.entries()) {
      // The transcript/state boundary can precede Claude's final input-editor
      // redraw by one frame. Avoid appending the next scripted prompt to the
      // just-submitted editor contents.
      if (index > 0 && interPromptSettleMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, interPromptSettleMs));
      }
      const compactionCommand = expectCompaction && smokePrompt.trim().startsWith('/compact');
      const clearCommand = smokePrompt.trim() === '/clear';
      const currentBeforeClear = clearCommand ? agentRuntime.sessionInfo(session.id) : undefined;
      const nativeBeforeClear = currentBeforeClear
        ? {
            nativeSession: { ...currentBeforeClear.nativeSession },
            nativeSessionRevision: currentBeforeClear.nativeSessionRevision,
          }
        : undefined;
      const before = agentRuntime.conversationSnapshot(session.id);
      const assistantCount = before?.items.filter((item) => item.kind === 'assistant').length ?? 0;
      // `/clear` is a native input command. Send it as literal terminal typing
      // rather than bracketed paste so Claude's command dispatcher owns it.
      const promptResult = clearCommand
        ? await backend!.automation.sendText(session.id, `${smokePrompt}\r`)
        : await backend!.automation.pasteAndSubmit(session.id, smokePrompt);
      if (!promptResult.accepted) throw new Error(`spawn-through smoke prompt was rejected: ${promptResult.reason}`);
      const observationMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_WAIT_MS ?? 45_000);
      const turnDeadline = Date.now() + observationMs;
      if (clearCommand) {
        if (!nativeBeforeClear) throw new Error(`${agent} lost runtime identity before /clear`);
        let info = agentRuntime.sessionInfo(session.id);
        let rebind = observedRebinds.find(
          (candidate) =>
            candidate.nativeSessionId !== undefined && candidate.nativeSessionId !== nativeBeforeClear.nativeSession.id,
        );
        while (Date.now() < turnDeadline) {
          info = agentRuntime.sessionInfo(session.id);
          rebind = observedRebinds.find(
            (candidate) =>
              candidate.nativeSessionId !== undefined &&
              candidate.nativeSessionId !== nativeBeforeClear.nativeSession.id,
          );
          if (
            info &&
            info.nativeSession.id !== nativeBeforeClear.nativeSession.id &&
            info.nativeSessionRevision > nativeBeforeClear.nativeSessionRevision &&
            rebind?.startSource === 'clear' &&
            agentRuntime.sessionState(session.id)?.lifecycle === 'ready'
          ) {
            break;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
        if (
          !info ||
          info.nativeSession.id === nativeBeforeClear.nativeSession.id ||
          info.nativeSessionRevision <= nativeBeforeClear.nativeSessionRevision ||
          rebind?.startSource !== 'clear' ||
          agentRuntime.sessionState(session.id)?.lifecycle !== 'ready'
        ) {
          throw new Error(
            `${agent} did not rebind native identity after /clear: ${JSON.stringify({ before: nativeBeforeClear, after: info, rebind, state: agentRuntime.sessionState(session.id) })}`,
          );
        }
        clearEventSequence = rebind.sequence;
        console.log(
          `SPAWN-THROUGH CLEAR OK ${JSON.stringify({ before: nativeBeforeClear.nativeSession, beforeRevision: nativeBeforeClear.nativeSessionRevision, after: info.nativeSession, afterRevision: info.nativeSessionRevision })}`,
        );
        continue;
      }
      let conversation = agentRuntime.conversationSnapshot(session.id);
      while (Date.now() < turnDeadline) {
        const state = agentRuntime.sessionState(session.id);
        const monitor = agentRuntime.monitorState(record.info.runtimeRunId);
        conversation = agentRuntime.conversationSnapshot(session.id);
        if (expectCompaction && monitor) {
          if (monitor.compaction.active) {
            observedCompactionActive = true;
            compactionStartedAt ??= Date.now();
          }
          if (
            observedCompactionActive &&
            !monitor.compaction.active &&
            monitor.compaction.count > compactionCountBefore &&
            monitor.compaction.lastAt
          ) {
            observedCompactionEnded = true;
            observedCompactionOutcome = monitor.compaction.lastOutcome;
          }
        }
        if (expectRailFailure && monitor?.alive && state && !['failed', 'exited'].includes(state.lifecycle)) {
          const degradedFamilies = Object.entries(monitor.freshness.families)
            .filter(
              ([, freshness]) =>
                freshness?.support === 'degraded' &&
                freshness.availability !== 'available' &&
                freshness.reason?.includes('native canary observation-rail fault'),
            )
            .map(([family]) => family);
          if (degradedFamilies.length > 0) {
            observedRailFailure = true;
            observedRailFailureLevel = monitor.freshness.level;
            observedRailFailureFamilies = degradedFamilies;
          }
        }
        if (expectedTask) {
          for (const task of monitor?.tasks ?? []) {
            if ([task.id, task.description].some((value) => value?.includes(expectedTask))) {
              observedTaskIds.add(task.id);
            }
          }
          for (const task of monitor?.tasks ?? []) {
            if (observedTaskIds.has(task.id)) observedTaskStatuses.add(task.status);
          }
        }
        if (expectedSubagentType) {
          for (const subagent of monitor?.subagents ?? []) {
            if (subagent.type?.toLowerCase().includes(expectedSubagentType.toLowerCase())) {
              observedSubagentIds.add(subagent.id);
            }
          }
          for (const subagent of monitor?.subagents ?? []) {
            if (!observedSubagentIds.has(subagent.id)) continue;
            if (subagent.active) observedSubagentActive = true;
            else observedSubagentStopped = true;
            if (subagent.activity) observedSubagentActivity = true;
            if (subagent.cumulativeTokens !== undefined && subagent.cumulativeTokens > 0) {
              observedSubagentUsage = true;
            }
            if (subagent.burnRatePerMin !== undefined && subagent.burnRatePerMin > 0) {
              observedSubagentBurnRate = true;
            }
            if (subagent.contextPercent !== undefined) observedSubagentContext = true;
            if (subagent.modelId) {
              observedSubagentModels.add(subagent.modelId);
              if (subagent.modelIntent === 'observed') observedSubagentObservedModels.add(subagent.modelId);
            }
          }
        }
        if (expectedTeamMember) {
          const matchingMembers = (monitor?.team?.teammates ?? []).filter((member) =>
            [member.id, member.name].some((value) => value?.toLowerCase().includes(expectedTeamMember.toLowerCase())),
          );
          for (const member of matchingMembers) {
            observedTeamMemberIds.add(member.id);
            if (!monitor?.team?.provisional && !member.provisional) observedDurableTeamMembership = true;
            if (member.idle === false) observedTeamMemberActive = true;
            if (member.idle === true) observedTeamMemberIdle = true;
            if (member.activity) observedTeamMemberActivity = true;
            if (member.cumulativeTokens !== undefined && member.cumulativeTokens > 0) {
              observedTeamMemberUsage = true;
            }
            if (member.burnRatePerMin !== undefined && member.burnRatePerMin > 0) {
              observedTeamMemberBurnRate = true;
            }
            if (member.contextPercent !== undefined) observedTeamMemberContext = true;
            if (member.modelId) {
              observedTeamMemberModels.add(member.modelId);
              if (member.modelIntent === 'observed') observedTeamMemberObservedModels.add(member.modelId);
            }
            if (member.effort) {
              observedTeamMemberEfforts.add(member.effort);
              if (member.effortIntent === 'observed') observedTeamMemberObservedEfforts.add(member.effort);
            }
          }
        }
        if (!observedPlan && monitor?.plan) {
          const matched = expectedPlanSteps.every((expected) =>
            monitor.plan?.steps.some((step) => step.text.includes(expected)),
          );
          if (matched) {
            observedPlan = monitor.plan;
            planObservedAt = Date.now();
            console.log(`SPAWN-THROUGH PLAN OK ${JSON.stringify(monitor.plan)}`);
          }
        }
        if (stopAfterPlan && observedPlan && Date.now() - (planObservedAt ?? Date.now()) >= planSettleMs) {
          stoppedAfterPlan = true;
          break;
        }
        if (expectedQuestion && !questionObserved) {
          const questionBlocker = monitor?.blockers.find(
            (blocker) =>
              blocker.kind === 'question' &&
              blocker.questions.some((question) => question.prompt.includes(expectedQuestion)),
          );
          if (questionBlocker?.kind === 'question') {
            const matchedQuestion = questionBlocker.questions.find((question) =>
              question.prompt.includes(expectedQuestion),
            );
            if (!matchedQuestion) throw new Error(`${agent} question blocker lost its matching question`);
            const labels = matchedQuestion.options?.map((option) => option.label) ?? [];
            if (!expectedQuestionChoices.every((choice) => labels.includes(choice))) {
              throw new Error(
                `${agent} question choices did not match: ${JSON.stringify({ expectedQuestionChoices, labels })}`,
              );
            }
            if (
              expectedQuestionAllowMultiple !== undefined &&
              matchedQuestion.allowMultiple !== expectedQuestionAllowMultiple
            ) {
              throw new Error(
                `${agent} question multi-select did not match: ${JSON.stringify({ expectedQuestionAllowMultiple, question: matchedQuestion })}`,
              );
            }
            if (
              expectedQuestionAllowFreeForm !== undefined &&
              matchedQuestion.allowFreeForm !== expectedQuestionAllowFreeForm
            ) {
              throw new Error(
                `${agent} question free-form did not match: ${JSON.stringify({ expectedQuestionAllowFreeForm, question: matchedQuestion })}`,
              );
            }
            if (monitor?.status !== 'blocked' || monitor.blockers.some((blocker) => blocker.kind === 'permission')) {
              throw new Error(`${agent} structured question was not projected as a distinct question blocker`);
            }
            console.log(`SPAWN-THROUGH QUESTION OK ${JSON.stringify(questionBlocker.questions)}`);
            questionBlockerId = questionBlocker.id;
            // PreToolUse is observable just before Claude finishes activating
            // its Confirmation key context. Let that native UI boundary settle
            // before sending picker navigation.
            if (questionSettleMs > 0) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, questionSettleMs));
            }
            const navigation =
              questionKey === 'down-enter'
                ? (['ArrowDown'] as const)
                : questionKey === 'space-enter'
                  ? (['Space'] as const)
                  : questionKey === 'multi-first-two'
                    ? (['Space', 'ArrowDown', 'Space', 'Tab', 'Enter'] as const)
                    : questionKey === 'other-text'
                      ? Array.from({ length: labels.length }, () => 'ArrowDown' as const)
                      : ([] as const);
            for (const key of navigation) {
              await sendQuestionKey(key);
              await new Promise((resolveDelay) => setTimeout(resolveDelay, key === 'Enter' ? 500 : 150));
            }
            if (questionNavigationHoldMs > 0) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, questionNavigationHoldMs));
            }
            if (questionKey === 'other-text') {
              // Moving onto Claude's built-in "Type something" choice opens
              // its editor immediately. Submitting an extra Enter here would
              // accept an empty answer before the canary text is pasted.
              await detachQuestionKeyView();
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
              const customAnswer = await backend!.automation.pasteAndSubmit(session.id, questionInput!);
              if (!customAnswer.accepted) {
                throw new Error(`spawn-through smoke custom question input was rejected: ${customAnswer.reason}`);
              }
            } else {
              await sendQuestionKey('Enter');
              await detachQuestionKeyView();
            }
            questionObserved = true;
          }
        }
        const hasUser = conversation?.items.some((item) => item.kind === 'user' && item.text === smokePrompt);
        const inputBoundaryObserved = hasUser || (expectRailFailure && observedRailFailure && index > 0);
        const nextAssistantCount = conversation?.items.filter((item) => item.kind === 'assistant').length ?? 0;
        const expectedReply = expectedReplies[index];
        const replyObserved =
          !expectedReply ||
          (conversation?.items
            .flatMap((item) => (item.kind === 'assistant' ? [item.markdown.trim()] : []))
            .slice(assistantCount)
            .includes(expectedReply) ??
            false);
        const subagentModelObserved =
          !expectedSubagentModel ||
          [...observedSubagentObservedModels].some((model) =>
            model.toLowerCase().includes(expectedSubagentModel.toLowerCase()),
          );
        const subagentTelemetryObserved =
          !requireSubagentTelemetry ||
          (observedSubagentActivity &&
            observedSubagentUsage &&
            observedSubagentBurnRate &&
            observedSubagentContext &&
            subagentModelObserved);
        const subagentLifecycleObserved =
          !expectedSubagentType || (observedSubagentActive && observedSubagentStopped && subagentTelemetryObserved);
        const teamMemberModelObserved =
          !expectedTeamMemberModel ||
          [...observedTeamMemberObservedModels].some((model) =>
            model.toLowerCase().includes(expectedTeamMemberModel.toLowerCase()),
          );
        const teamMemberEffortObserved =
          !expectedTeamMemberEffort ||
          [...observedTeamMemberObservedEfforts].some((effort) =>
            effort.toLowerCase().includes(expectedTeamMemberEffort.toLowerCase()),
          );
        const teamMemberTelemetryObserved =
          !requireTeamMemberTelemetry ||
          (observedTeamMemberActivity &&
            observedTeamMemberUsage &&
            observedTeamMemberBurnRate &&
            teamMemberModelObserved &&
            teamMemberEffortObserved);
        const teamMemberLifecycleObserved =
          !expectedTeamMember ||
          (observedTeamMemberIds.size > 0 &&
            observedDurableTeamMembership &&
            (!expectTeamMemberIdle || observedTeamMemberIdle) &&
            (!requireTeamMemberContext || observedTeamMemberContext) &&
            teamMemberTelemetryObserved &&
            teamMemberModelObserved &&
            teamMemberEffortObserved);
        const promptConfigurationObserved = monitorMatchesConfiguration(monitor, {
          permission: expectedPermissionAfterPrompt,
          permissionIntent: expectedPermissionAfterPrompt ? 'observed' : undefined,
        });
        const questionStillPending =
          expectedQuestion !== undefined &&
          (monitor?.blockers.some(
            (blocker) =>
              blocker.kind === 'question' &&
              (blocker.id === questionBlockerId ||
                blocker.questions.some((question) => question.prompt.includes(expectedQuestion))),
          ) ??
            false);
        const questionResolutionObserved = !expectedQuestion || (questionObserved && !questionStillPending);
        if (compactionCommand && observedCompactionEnded && state?.lifecycle === 'ready') break;
        if (
          compactionCommand &&
          allowCompactionBoundaryFallback &&
          observedCompactionActive &&
          Date.now() - (compactionStartedAt ?? Date.now()) >= compactionFallbackSettleMs &&
          state?.lifecycle === 'ready'
        ) {
          break;
        }
        if (
          inputBoundaryObserved &&
          nextAssistantCount > assistantCount &&
          !conversation?.responding &&
          state?.lifecycle === 'ready' &&
          replyObserved &&
          promptConfigurationObserved &&
          questionResolutionObserved &&
          subagentLifecycleObserved &&
          teamMemberLifecycleObserved
        ) {
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      if (stoppedAfterPlan) break;
      if (compactionCommand) {
        if (!observedCompactionActive || (!observedCompactionEnded && !allowCompactionBoundaryFallback)) {
          throw new Error(
            `${agent} did not expose the expected compaction lifecycle: ${JSON.stringify({ observedCompactionActive, observedCompactionEnded, compaction: agentRuntime.monitorState(record.info.runtimeRunId)?.compaction })}`,
          );
        }
        console.log(
          `SPAWN-THROUGH COMPACTION STARTED ${JSON.stringify(agentRuntime.monitorState(record.info.runtimeRunId)?.compaction)}`,
        );
        continue;
      }
      const state = agentRuntime.sessionState(session.id);
      const hasUser = conversation?.items.some((item) => item.kind === 'user' && item.text === smokePrompt);
      const inputBoundaryObserved = hasUser || (expectRailFailure && observedRailFailure && index > 0);
      const nextAssistantCount = conversation?.items.filter((item) => item.kind === 'assistant').length ?? 0;
      const monitor = agentRuntime.monitorState(record.info.runtimeRunId);
      if (expectedQuestion && index === 0) {
        if (!questionObserved) throw new Error(`${agent} did not expose the expected structured question`);
        const unresolvedQuestion = monitor?.blockers.find(
          (blocker) =>
            blocker.kind === 'question' &&
            (blocker.id === questionBlockerId ||
              blocker.questions.some((question) => question.prompt.includes(expectedQuestion))),
        );
        if (unresolvedQuestion) {
          throw new Error(
            `${agent} did not resolve the expected structured question: ${JSON.stringify(unresolvedQuestion)}`,
          );
        }
      }
      const promptConfigurationObserved = monitorMatchesConfiguration(monitor, {
        permission: expectedPermissionAfterPrompt,
        permissionIntent: expectedPermissionAfterPrompt ? 'observed' : undefined,
      });
      if (
        !inputBoundaryObserved ||
        nextAssistantCount <= assistantCount ||
        conversation?.responding ||
        state?.lifecycle !== 'ready' ||
        !promptConfigurationObserved
      ) {
        throw new Error(
          `${agent} prompt ${index + 1} did not project as a completed conversation turn: ${JSON.stringify({ state, conversation, expectedPermissionAfterPrompt, modes: monitor?.modes })}`,
        );
      }
      const expectedReply = expectedReplies[index];
      if (expectedReply) {
        const replies =
          conversation?.items
            .flatMap((item) => (item.kind === 'assistant' ? [item.markdown.trim()] : []))
            .slice(assistantCount) ?? [];
        if (!replies.includes(expectedReply)) {
          throw new Error(
            `${agent} prompt ${index + 1} did not produce the expected reply: ${JSON.stringify({ expectedReply, replies })}`,
          );
        }
      }
    }
    if (expectedToolName) {
      const matchingTools = [...observedToolRequests.entries()].filter(
        ([, name]) => name.toLowerCase() === expectedToolName.toLowerCase(),
      );
      if (matchingTools.length !== expectedToolCount) {
        throw new Error(
          `${agent} did not expose the exact expected tool count: ${JSON.stringify({ expectedToolName, expectedToolCount, observed: matchingTools })}`,
        );
      }
      if (expectedToolOutcome === 'completed' || expectedToolOutcome === 'failed') {
        const mismatches = matchingTools.filter(
          ([toolCallId]) => observedToolOutcomes.get(toolCallId) !== expectedToolOutcome,
        );
        if (mismatches.length > 0) {
          throw new Error(
            `${agent} tool outcomes did not match: ${JSON.stringify({ expectedToolOutcome, mismatches, observed: [...observedToolOutcomes] })}`,
          );
        }
      } else if (expectedToolOutcome === 'denied') {
        const matchingIds = new Set(matchingTools.map(([toolCallId]) => toolCallId));
        const denied = [...observedPermissions.values()].some(
          (permission) =>
            permission.tool?.toLowerCase() === expectedToolName.toLowerCase() &&
            permission.toolCallId !== undefined &&
            matchingIds.has(permission.toolCallId) &&
            permission.outcome === 'denied',
        );
        if (!denied) {
          throw new Error(
            `${agent} did not expose the expected denied permission/tool correlation: ${JSON.stringify({ allowHookDenial, permissions: [...observedPermissions] })}`,
          );
        }
      }
      console.log(
        `SPAWN-THROUGH TOOL OK ${JSON.stringify({ tool: expectedToolName, count: matchingTools.length, outcome: expectedToolOutcome, ids: matchingTools.map(([id]) => id) })}`,
      );
    }
    if (requirePostClearTranscript && (clearEventSequence === undefined || !postClearTranscriptAssistant)) {
      throw new Error(
        `${agent} did not prove post-/clear semantic observer reattachment: ${JSON.stringify({ clearEventSequence, postClearTranscriptAssistant, rebinds: observedRebinds })}`,
      );
    }
    if (requirePostClearTranscript) {
      console.log(
        `SPAWN-THROUGH TRANSCRIPT REATTACH OK ${JSON.stringify({ clearEventSequence, postClearTranscriptAssistant })}`,
      );
    }
    if (expectedPlanSteps.length > 0 && !observedPlan) {
      throw new Error(`${agent} did not expose the expected plan steps: ${JSON.stringify(expectedPlanSteps)}`);
    }
    if (
      expectCompaction &&
      (!observedCompactionEnded ||
        (expectedCompactionOutcome !== undefined && observedCompactionOutcome !== expectedCompactionOutcome))
    ) {
      throw new Error(
        `${agent} did not expose the expected /compact outcome: ${JSON.stringify({ expectedCompactionOutcome, observedCompactionActive, observedCompactionEnded, observedCompactionOutcome, compaction: agentRuntime.monitorState(record.info.runtimeRunId)?.compaction })}`,
      );
    }
    if (expectCompaction) {
      console.log(
        `SPAWN-THROUGH COMPACTION OK ${JSON.stringify(agentRuntime.monitorState(record.info.runtimeRunId)?.compaction)}`,
      );
    }
    if (expectRailFailure) {
      const monitor = agentRuntime.monitorState(record.info.runtimeRunId);
      const state = agentRuntime.sessionState(session.id);
      if (
        !observedRailFailure ||
        !monitor?.alive ||
        !state ||
        ['failed', 'exited'].includes(state.lifecycle) ||
        monitor.freshness.level === 'native-hooks'
      ) {
        throw new Error(
          `${agent} did not preserve liveness while degrading the observation rail: ${JSON.stringify({ observedRailFailure, observedRailFailureLevel, observedRailFailureFamilies, state, monitor })}`,
        );
      }
      console.log(
        `SPAWN-THROUGH RAIL FAILURE OK ${JSON.stringify({ alive: monitor.alive, lifecycle: state.lifecycle, level: monitor.freshness.level, families: observedRailFailureFamilies })}`,
      );
    }
    if (expectedTask) {
      const missingStatuses = expectedTaskStatuses.filter((status) => !observedTaskStatuses.has(status));
      if (missingStatuses.length > 0 || observedTaskStatuses.size === 0) {
        throw new Error(
          `${agent} did not expose the expected task lifecycle: ${JSON.stringify({ expectedTask, expectedTaskStatuses, observedTaskStatuses: [...observedTaskStatuses], missingStatuses })}`,
        );
      }
      console.log(
        `SPAWN-THROUGH TASK OK ${JSON.stringify({ expectedTask, taskIds: [...observedTaskIds], statuses: [...observedTaskStatuses] })}`,
      );
    }
    if (expectedSubagentType) {
      const modelObserved =
        !expectedSubagentModel ||
        [...observedSubagentObservedModels].some((model) =>
          model.toLowerCase().includes(expectedSubagentModel.toLowerCase()),
        );
      const lifecycleObserved = observedSubagentActive && observedSubagentStopped;
      const telemetryObserved =
        !requireSubagentTelemetry ||
        (observedSubagentActivity &&
          observedSubagentUsage &&
          observedSubagentBurnRate &&
          observedSubagentContext &&
          modelObserved);
      if (observedSubagentIds.size === 0 || !lifecycleObserved || !modelObserved || !telemetryObserved) {
        throw new Error(
          `${agent} did not expose the expected subagent lifecycle and telemetry: ${JSON.stringify({ expectedSubagentType, expectedSubagentModel, requireSubagentTelemetry, ids: [...observedSubagentIds], models: [...observedSubagentModels], observedModels: [...observedSubagentObservedModels], observedSubagentActive, observedSubagentStopped, observedSubagentActivity, observedSubagentUsage, observedSubagentBurnRate, observedSubagentContext })}`,
        );
      }
      console.log(
        `SPAWN-THROUGH SUBAGENT OK ${JSON.stringify({ type: expectedSubagentType, ids: [...observedSubagentIds], models: [...observedSubagentModels], telemetry: requireSubagentTelemetry })}`,
      );
    }
    if (expectedTeamMember) {
      const modelObserved =
        !expectedTeamMemberModel ||
        [...observedTeamMemberObservedModels].some((model) =>
          model.toLowerCase().includes(expectedTeamMemberModel.toLowerCase()),
        );
      const effortObserved =
        !expectedTeamMemberEffort ||
        [...observedTeamMemberObservedEfforts].some((effort) =>
          effort.toLowerCase().includes(expectedTeamMemberEffort.toLowerCase()),
        );
      const telemetryObserved =
        !requireTeamMemberTelemetry ||
        (observedTeamMemberActivity &&
          observedTeamMemberUsage &&
          observedTeamMemberBurnRate &&
          modelObserved &&
          effortObserved);
      if (
        observedTeamMemberIds.size === 0 ||
        !observedDurableTeamMembership ||
        (expectTeamMemberIdle && !observedTeamMemberIdle) ||
        (requireTeamMemberContext && !observedTeamMemberContext) ||
        !modelObserved ||
        !effortObserved ||
        !telemetryObserved
      ) {
        throw new Error(
          `${agent} did not expose the expected team member and telemetry: ${JSON.stringify({ expectedTeamMember, expectedTeamMemberModel, expectedTeamMemberEffort, requireTeamMemberTelemetry, requireTeamMemberContext, expectTeamMemberIdle, ids: [...observedTeamMemberIds], models: [...observedTeamMemberModels], observedModels: [...observedTeamMemberObservedModels], efforts: [...observedTeamMemberEfforts], observedEfforts: [...observedTeamMemberObservedEfforts], observedDurableTeamMembership, observedTeamMemberActive, observedTeamMemberIdle, observedTeamMemberActivity, observedTeamMemberUsage, observedTeamMemberBurnRate, observedTeamMemberContext })}`,
        );
      }
      console.log(
        `SPAWN-THROUGH TEAM MEMBER OK ${JSON.stringify({ member: expectedTeamMember, ids: [...observedTeamMemberIds], models: [...observedTeamMemberModels], efforts: [...observedTeamMemberEfforts], active: observedTeamMemberActive, idle: observedTeamMemberIdle, telemetry: requireTeamMemberTelemetry })}`,
      );
    }
    console.log(`SPAWN-THROUGH CONVERSATION ${JSON.stringify(agentRuntime.conversationSnapshot(session.id))}`);
  }
  if (expectedDelegateMarkers.length > 0) {
    const markerDeadline = Date.now() + 20_000;
    let missing = expectedDelegateMarkers;
    while (Date.now() < markerDeadline) {
      missing = expectedDelegateMarkers.filter(({ path, initialSize }) => {
        try {
          return statSync(path).size <= initialSize;
        } catch {
          return true;
        }
      });
      if (missing.length === 0) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (missing.length > 0) {
      throw new Error(
        `${agent} did not invoke expected status delegates: ${missing.map(({ path }) => path).join(', ')}`,
      );
    }
    console.log(`SPAWN-THROUGH STATUS DELEGATES OK ${JSON.stringify(expectedDelegateMarkers.map(({ path }) => path))}`);
  }
  const exitMode = process.env.PUPPETEER_SPAWN_SMOKE_EXIT_MODE?.trim().toLowerCase() || 'host';
  if (!['host', 'clean', 'crash'].includes(exitMode)) {
    throw new Error('PUPPETEER_SPAWN_SMOKE_EXIT_MODE must be host, clean, or crash');
  }
  const expectedExitReason = exitMode === 'host' ? 'runtime-terminated' : exitMode === 'clean' ? 'completed' : 'crash';
  if (exitMode === 'clean') {
    const exitSettleMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_EXIT_SETTLE_MS ?? 8_000);
    if (!Number.isSafeInteger(exitSettleMs) || exitSettleMs < 0 || exitSettleMs > 120_000) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_EXIT_SETTLE_MS must be 0 through 120000');
    }
    if (exitSettleMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, exitSettleMs));
    const submittedExit = await backend!.automation.pasteAndSubmit(session.id, '/exit');
    if (!submittedExit.accepted) throw new Error(`spawn-through native exit was rejected: ${submittedExit.reason}`);
    const processId = record.info.processId;
    if (!processId) throw new Error(`${agent} native-exit canary has no adopted process identity`);
    const exitDeadline = Date.now() + 20_000;
    while (
      Date.now() < exitDeadline &&
      (processIsAlive(processId) || agentRuntime.sessionState(session.id)?.lifecycle !== 'exited')
    ) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (processIsAlive(processId) || agentRuntime.sessionState(session.id)?.lifecycle !== 'exited') {
      throw new Error(
        `${agent} did not emit SessionEnd and exit its adopted process after /exit: ${JSON.stringify({ processId, state: agentRuntime.sessionState(session.id) })}`,
      );
    }
    finishAdoptedProcess(session.id, 'completed');
    if (exitCleanups.size > 0) await Promise.all([...exitCleanups]);
    const shellExit = await backend!.automation.terminateAndWait(session.id, 'application', 5_000);
    await onSessionExited(shellExit);
  } else if (exitMode === 'crash') {
    const processId = record.info.processId;
    if (!processId) throw new Error(`${agent} crash canary has no adopted process identity`);
    process.kill(processId, 'SIGKILL');
    const crashDeadline = Date.now() + 10_000;
    while (Date.now() < crashDeadline && processIsAlive(processId)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (processIsAlive(processId)) throw new Error(`${agent} crash canary process ${processId} survived SIGKILL`);
    finishAdoptedProcess(session.id, 'crash');
    if (exitCleanups.size > 0) await Promise.all([...exitCleanups]);
    const retained = agentRuntime.monitorState(record.info.runtimeRunId);
    if (
      retained?.alive !== false ||
      retained.status !== 'blocked' ||
      !retained.blockers.some(
        (blocker) => blocker.kind === 'failure' && blocker.id === 'run:runtime' && blocker.failure?.code === 'crash',
      )
    ) {
      throw new Error(`${agent} crash did not retain the expected failure blocker: ${JSON.stringify(retained)}`);
    }
    console.log(`SPAWN-THROUGH CRASH RETENTION OK ${JSON.stringify(retained.blockers)}`);
    if (!(await agentRuntime.acknowledgeFailureBlocker(record.info.runtimeRunId, 'run:runtime'))) {
      throw new Error(`${agent} retained crash blocker could not be acknowledged`);
    }
    const shellExit = await backend!.automation.terminateAndWait(session.id, 'application', 5_000);
    await onSessionExited(shellExit);
  } else {
    const exited = await backend!.automation.terminateAndWait(session.id, 'application', 5_000);
    await onSessionExited(exited);
  }
  if (exitCleanups.size > 0) await Promise.all([...exitCleanups]);
  if (!observedProcessExitReasons.includes(expectedExitReason)) {
    throw new Error(
      `${agent} did not expose expected process exit reason ${expectedExitReason}: ${JSON.stringify(observedProcessExitReasons)}`,
    );
  }
  if (monitorRelay.hasRun(record.info.runtimeRunId)) {
    throw new Error(`${agent} monitor was not removed at the final canary boundary`);
  }
  const shadowMismatch = spawnThroughShadowMismatches.get(record.info.runtimeRunId);
  if (shadowMismatch) {
    throw new Error(`${agent} produced a settled monitor shadow mismatch: ${JSON.stringify(shadowMismatch)}`);
  }
  unsubscribeSmokeEvents();
  console.log(`SPAWN-THROUGH SMOKE OK ${agent} ${record.info.sessionId} exit=${exitMode}`);
}

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    quitting = true;
    // Snapshot synchronously before cleanup marks sessions exited. The store's
    // fsync/rename/fsync commit does not depend on the daemon answering in time.
    if (restoreCheckpointTimer) clearTimeout(restoreCheckpointTimer);
    restoreCheckpointTimer = undefined;
    commitRestoreCheckpoint();
    accountUsageMonitor.stop();
    if (agentFlushTimer) clearTimeout(agentFlushTimer);
    for (const runtimeSessionId of adoptedProcessMonitors.keys()) stopAdoptedProcessMonitor(runtimeSessionId);
    const client = backend?.automation;
    if (client) {
      let terminalIds: string[];
      if (externalBackendConfigured()) {
        terminalIds = [
          ...new Set([...managedTerminalIds, ...tabs.records().flatMap((record) => [...record.sessionIds])]),
        ];
      } else {
        // A managed daemon is private to this Godview process. Drain every PTY,
        // including plain shells, before asking the daemon to stop; otherwise
        // its ten-second service drain races an older supervisor's three-second
        // escalation window.
        terminalIds = (await client.listSessions().catch(() => []))
          .filter((session) => !session.exited)
          .map((s) => s.id);
      }
      const settled = await allSettledWithin(
        terminalIds.map((id) => client.terminateAndWait(id, 'application', 6_000)),
        SHUTDOWN_CLEANUP_TIMEOUT_MS,
      );
      if (!settled) console.warn('[main] terminal cleanup timed out during shutdown');
    }
    if (!(await allSettledWithin(exitCleanups, SHUTDOWN_CLEANUP_TIMEOUT_MS))) {
      console.warn('[main] agent exit cleanup timed out during shutdown');
    }
    const finals = await agentRuntime.dispose();
    for (const final of finals) pushWorkspaceFinal(final);
    await monitorConnection.close();
    for (const status of scenarioRecorder.statuses()) {
      try {
        finishScenarioRecording(status.runtimeSessionId);
      } catch (error) {
        process.stderr.write(`[main] scenario recording shutdown flush failed: ${String(error)}\n`);
      }
    }
    backend?.stop();
    backend = undefined;
    await spawnThroughGateway?.close().catch(() => undefined);
    spawnThroughGateway = undefined;
    if (spawnThroughDirectory) rmSync(spawnThroughDirectory, { recursive: true, force: true });
    spawnThroughDirectory = undefined;
    spawnThroughEnvironment = undefined;
  })();
  return shutdownPromise;
}

/**
 * OS logout/reboot grants a much shorter window than an ordinary app quit.
 * Commit synchronously, ask Electron to delay shutdown just long enough for
 * that commit, signal the backend, and skip the multi-second cleanup path.
 */
function checkpointAndExitForSystemShutdown(event?: { preventDefault?: () => void }): void {
  event?.preventDefault?.();
  if (systemShutdownRequested) return;
  systemShutdownRequested = true;
  quitting = true;
  if (restoreCheckpointTimer) clearTimeout(restoreCheckpointTimer);
  restoreCheckpointTimer = undefined;
  commitRestoreCheckpoint();
  accountUsageMonitor.stop();
  if (agentFlushTimer) clearTimeout(agentFlushTimer);
  backend?.stop();
  quitReady = true;
  app.quit();
}

registerIpc();
app
  .whenReady()
  .then(async () => {
    if (process.platform !== 'win32') {
      // Electron's generated type omits the event argument even though the
      // documented runtime event is preventable on macOS and Linux.
      powerMonitor.on('shutdown', (...args: unknown[]) => {
        checkpointAndExitForSystemShutdown(args[0] as { preventDefault?: () => void } | undefined);
      });
    }
    await initializeSpawnThrough();
    if (SMOKE || APPEARANCE_SMOKE || SPAWN_THROUGH_SMOKE || RESTORE_SMOKE || AGENT_SMOKE) {
      if (SPAWN_THROUGH_SMOKE) await runSpawnThroughSmoke(SPAWN_THROUGH_SMOKE);
      else if (RESTORE_SMOKE_PHASE === 'seed') {
        await runRestoreRestartSeedSmoke();
        return;
      } else if (RESTORE_SMOKE_PHASE === 'verify') await runRestoreRestartVerifySmoke();
      else if (RESTORE_SMOKE) await runRestoreSmoke();
      else if (AGENT_SMOKE) await runAgentSmoke(AGENT_SMOKE);
      else if (APPEARANCE_SMOKE) await runAppearanceSmoke();
      else await runSmoke();
      await shutdown();
      app.exit(0);
      return;
    }
    accountUsageMonitor.start();
    await openInitialWindows();
    // Emulator/dev flow: PUPPETEER_AUTOCREATE_AGENTS=claude[,codex,…] creates
    // agent sessions at startup. The shim spawn-through path is POSIX-only, so
    // on Windows this is the way to get an agent session in the swarm.
    for (const agent of (process.env.PUPPETEER_AUTOCREATE_AGENTS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      void createAgentSession({ agent: agent as BuiltinExecutableAgentKind, cwd: repoRoot }).catch((error) =>
        console.error(`[main] autocreate ${agent} failed`, error),
      );
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on('activate', () => {
  if (tabs.records().length === 0) {
    void createWindow({ claimExistingSessions: true }).catch((error) =>
      console.error('failed to recreate window', error),
    );
  } else {
    focusGodviewWindow();
  }
});

app.on('second-instance', () => focusGodviewWindow());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  // Normal cleanup sets this only after it has finished; the OS-shutdown path
  // sets it after its synchronous durable checkpoint. Neither final quit may
  // be intercepted by a draft prompt after terminal teardown has begun.
  if (quitReady) return;
  if (!discardDraftsApprovedForQuit) {
    const dirtyWindows = BrowserWindow.getAllWindows().filter((window) =>
      dirtyConfigEditorSenders.has(window.webContents),
    );
    if (dirtyWindows.length > 0) {
      event.preventDefault();
      if (!quitDraftConfirmation) {
        const owner = (
          lastFocusedWindow && dirtyWindows.includes(lastFocusedWindow) ? lastFocusedWindow : dirtyWindows[0]
        )!;
        quitDraftConfirmation = confirmDiscardConfigDraft(owner, true)
          .then((discard) => {
            if (!discard) return;
            dirtyConfigEditorSenders.clear();
            discardDraftsApprovedForQuit = true;
            app.quit();
          })
          .finally(() => {
            quitDraftConfirmation = undefined;
          });
      }
      return;
    }
  }
  event.preventDefault();
  void shutdown().finally(() => {
    quitReady = true;
    app.quit();
  });
});
