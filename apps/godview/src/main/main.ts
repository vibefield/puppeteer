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
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
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
import { createBuiltinAgentRuntime } from '@vibecook/puppeteer-builtin-providers';
import { createActionRecorder } from '@vibecook/puppeteer-record';
import type { GodviewTheme } from '../appearance-themes.js';
import {
  buildAgentEnvironment,
  type AgentRuntime,
  type AgentWorkspaceFinal,
  type AgentWorkspaceRequest,
  type ResumeAgentOptions,
  type SpawnAgentResult,
} from '@vibecook/puppeteer-runtime';
import type {
  AccountUsageBatch,
  AgentInstallationsSnapshot,
  AgentProfile,
  AgentSessionInfo,
  AgentSessionSnapshot,
  CheckReleasesRequest,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  CreateProfileRequest,
  HistorySearchResponse,
  HistorySearchStatus,
  HistorySessionFacts,
  InstallationsRequest,
  NewTerminalTabRequest,
  PaneRehydrationRequest,
  ProfileDefaults,
  ProfileLoginResult,
  PromptReceipt,
  SetProfileDefaultRequest,
  StartProfileLoginRequest,
  SubmitPromptOptions,
  TerminalSessionHandoff,
  AgentInterruptResult,
  UpdateInstallationRequest,
} from '../protocol.js';
import { createAccountUsageMonitor, type AccountUsageProfileRef } from './account-usage-monitor.js';
import { createProfileDefaultsStore, profileDefaultIds, retainKnownProfileDefaults } from './agent-profile-defaults.js';
import {
  createHistorySearchService,
  defaultAnnounceDirectory,
  discoverAnnouncedDaemons,
  parseHistoryFactsRequest,
  parseHistorySearchRequest,
  resolveHistoryOrigin,
} from './history-search.js';
import { createHistorySettingsStore } from './history-settings.js';
import {
  acknowledgeAgentFailureForIpc,
  connectMonitorIpcRelay,
  MonitorIpcRelay,
  readAgentMonitorArtifactForIpc,
} from './monitor-ipc.js';
import {
  APPEARANCE_BLOCK_START,
  appearanceBlock,
  appearanceUpdateMismatches,
  patchAppearanceBlock,
  unappliedAppearanceKeys,
  validateAppearanceUpdate,
  type ManagedAppearanceUpdate,
} from './appearance-config.js';
import {
  appearanceThemeFromRenderer,
  appearanceUpdateForMode,
  defaultAppearanceProfiles,
  migrateRetiredAppearanceProfiles,
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
import { allocateWorkspaceSlot } from './workspace-slots.js';
import { RESTORE_MANIFEST_VERSION, type RestoreManifest } from './restore-manifest.js';
import { readRestoreManifest, restorePaneFor, restorePromptDetail, summarizeRestore } from './restore-plan.js';
import {
  buildRestoreSnapshot,
  MAX_RESTORE_PANES_PER_WINDOW,
  PANE_RECOVERY_METADATA_VERSION,
  paneRecoveryMetadata,
  preferredRestoreWindow,
  readPaneRecoveryMetadata,
  readRestoreWorkspaceDocument,
  restoreWorkspaceSessionIds,
  snapshotAgent,
  snapshotReferencedSessionIds,
  summarizeRestoreSnapshot,
  type RestoreDescriptor,
  type RestoreSnapshot,
  type RestoreSnapshotAgent,
  type RestoreSnapshotAgentInput,
  type RestoreWorkspaceDocument,
} from '../restore-snapshot.js';
import { discardDurableRestoreState, readDurableRestoreState, writeDurableRestoreState } from './restore-store.js';

declare const __dirname: string;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const ADOPTED_PROCESS_EXIT_GRACE_MS = 5_000;
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 7_000;
const SMOKE = process.argv.includes('--smoke');
const APPEARANCE_SMOKE = process.argv.includes('--appearance-smoke');
const RESTORE_SMOKE_ARGUMENT = process.argv.find(
  (argument) => argument === '--restore-smoke' || argument.startsWith('--restore-smoke='),
);
const RESTORE_SMOKE = RESTORE_SMOKE_ARGUMENT !== undefined;
const RESTORE_SMOKE_PHASE = RESTORE_SMOKE_ARGUMENT?.split('=', 2)[1];
const AGENT_SMOKE = process.env.PUPPETEER_AGENT_SMOKE?.trim() || undefined;
const SPAWN_THROUGH_SMOKE =
  process.argv
    .find((argument) => argument.startsWith('--spawn-through-smoke='))
    ?.slice('--spawn-through-smoke='.length)
    .trim() || undefined;
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
  /** The terminal can remain open after its adopted agent child exits. */
  agentProcessAlive: boolean;
  final?: AgentWorkspaceFinal;
}

const agentRecords = new Map<string, AgentRecord>();

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
  onState: (message) => broadcast('puppeteer:agent-monitor-state', message),
  onNotification: (message) => broadcast('puppeteer:agent-monitor-notification', message),
  onRemoved: (message) => {
    broadcast('puppeteer:agent-monitor-removed', message);
    if (message.terminalSessionId) {
      agentRecords.delete(message.terminalSessionId);
      scheduleRestoreCheckpoint(true);
    }
  },
});

function loadAppearanceProfiles(): { profiles: AppearanceProfiles; persisted: boolean } {
  if (!existsSync(terminalAppearanceProfilesPath)) {
    return { profiles: defaultAppearanceProfiles(), persisted: false };
  }
  try {
    const stored = parseAppearanceProfiles(readFileSync(terminalAppearanceProfilesPath, 'utf8'));
    const profiles = migrateRetiredAppearanceProfiles(stored);
    // Written back at once and reported as persisted: the first activation
    // would otherwise read the retired colours out of the previous managed
    // block and capture them over the decided theme.
    if (profiles !== stored) writeAppearanceProfilesFile(profiles);
    return { profiles, persisted: true };
  } catch (error) {
    console.warn('[main] ignoring invalid terminal appearance profiles', error);
    return { profiles: defaultAppearanceProfiles(), persisted: false };
  }
}

function writeAppearanceProfilesFile(profiles: AppearanceProfiles): void {
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
  const temporaryPath = `${terminalAppearanceProfilesPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serializeAppearanceProfiles(profiles), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, terminalAppearanceProfilesPath);
    chmodSync(terminalAppearanceProfilesPath, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function persistAppearanceProfiles(profiles: AppearanceProfiles): void {
  writeAppearanceProfilesFile(profiles);
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
    const mismatches = appearanceUpdateMismatches(
      validation.config.renderer,
      update,
      unappliedAppearanceKeys(validation.config.diagnostics),
    );
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
  recorder,
  imposterExecutable,
  onError: (error) => process.stderr.write(`[main] agent runtime: ${error.message}\n`),
});
const monitorConnection = connectMonitorIpcRelay(agentRuntime, monitorRelay, (error) =>
  process.stderr.write(`[main] monitor IPC: ${error.message}\n`),
);
/** Which account a new terminal binds to when the user names none. */
const profileDefaultsStore = createProfileDefaultsStore(join(app.getPath('userData'), 'agent-profile-defaults.json'));
/** Login terminals awaiting their exit, so the account is verified from native evidence afterwards. */
const pendingProfileLogins = new Map<string, { profileId: string; timer: NodeJS.Timeout }>();
/** Where the transcript history daemon lives; hand-edited, never written by Godview. */
const historySettingsStore = createHistorySettingsStore(join(app.getPath('userData'), 'history-search.json'));
const historyAnnounceDirectory = defaultAnnounceDirectory(process.platform, process.env);
const HISTORY_ORIGIN_TTL_MS = 10_000;
let historyOriginCache: { at: number; value: ReturnType<typeof resolveHistoryOrigin> } | undefined;
/** Resolved per call so a daemon that restarts on another port is followed; the announce directory is read at most every few seconds. */
function currentHistoryOrigin(): ReturnType<typeof resolveHistoryOrigin> | undefined {
  const settings = historySettingsStore.read();
  if (!settings.enabled) return undefined;
  const now = Date.now();
  if (historyOriginCache && now - historyOriginCache.at < HISTORY_ORIGIN_TTL_MS) return historyOriginCache.value;
  const value = resolveHistoryOrigin({
    ...(settings.origin ? { configured: settings.origin } : {}),
    ...(process.env.GODVIEW_HISTORY_DAEMON ? { environment: process.env.GODVIEW_HISTORY_DAEMON } : {}),
    announced: discoverAnnouncedDaemons(historyAnnounceDirectory),
  });
  historyOriginCache = { at: now, value };
  return value;
}
// Loopback only, and only ever the daemon the user's own settings or the
// daemon's own announcement point at; the service refuses any other origin.
const historySearch = createHistorySearchService({
  fetch: (input, init) => globalThis.fetch(input, init),
  origin: currentHistoryOrigin,
});
const PROFILE_LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Registered accounts per provider, as the usage monitor needs them. */
async function usageProfileRefs(): Promise<AccountUsageProfileRef[]> {
  const profiles = await agentRuntime.profiles();
  return profiles.map((profile) => ({ id: profile.id, provider: profile.provider, label: profile.label }));
}

const accountUsageMonitor = createAccountUsageMonitor({
  providers: agentRuntime.accountUsageProviders(),
  fetchUsage: (providerId, profileId) => agentRuntime.accountUsage(providerId, profileId),
  listProfiles: usageProfileRefs,
  publish: (batch: AccountUsageBatch) => {
    if (!quitting) broadcast('puppeteer:account-usage', batch);
  },
  onError: (error) => process.stderr.write(`[main] account usage: ${error.message}\n`),
});
agentRuntime.onAccountUsage((provider, result) => {
  if (quitting) return;
  accountUsageMonitor.ingest(provider.id, result);
});
agentRuntime.onProfilesChanged((profiles) => {
  if (quitting) return;
  broadcast('puppeteer:profiles', profiles);
  void accountUsageMonitor
    .refreshProfiles()
    .catch((error: unknown) => process.stderr.write(`[main] account usage profiles: ${String(error)}\n`));
});
function pushWorkspaceFinal(final: AgentWorkspaceFinal): void {
  const record = agentRecords.get(final.runtimeSessionId);
  if (record) record.final = final;
  broadcast('puppeteer:workspace-final', final);
  // A crash remains a small blocked monitor until acknowledgment. Clean
  // completion has already emitted monitor removal and can leave the board.
  const retainedFailure = record && monitorRelay.hasRun(record.info.runtimeRunId);
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
          continuation: { ...pending.continuation },
          runtimeSessionId: pending.runtimeSessionId,
          workspace: pending.workspace as AgentSessionInfo['workspace'],
          // An agent waiting to rebind keeps its account across checkpoints.
          ...(pending.profileId ? { profileId: pending.profileId } : {}),
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

function rememberAgent(info: AgentSessionInfo, session: SessionSummary): void {
  agentRecords.set(info.runtimeSessionId, { info, session, agentProcessAlive: true });
  const agent = agentRuntime.agent(info.runtimeSessionId);
  agent?.on('*', () => {
    const runtimeInfo = agent.info;
    const record = agentRecords.get(info.runtimeSessionId);
    if (record && record.info.nativeSession.id !== runtimeInfo.nativeSession.id) {
      record.info = {
        ...record.info,
        nativeSession: { ...runtimeInfo.nativeSession },
        nativeSessionRevision: runtimeInfo.nativeSessionRevision,
        continuation: { ...runtimeInfo.continuation },
        sessionId: runtimeInfo.nativeSession.id,
      };
      scheduleRestoreCheckpoint(true);
      broadcast('puppeteer:agent-session', record.info);
    }
  });
  scheduleRestoreCheckpoint(true);
  broadcast('puppeteer:agent-session', info);
  if (monitorConnection.start(info.runtimeRunId)) {
    monitorRelay.bindTerminal(info.runtimeRunId, info.runtimeSessionId);
  }
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
    const descriptor = paneRecoveryMetadata(record.session, record.info).descriptor;
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
  // An account is verified when its login terminal ends, independently of the
  // agent-session bookkeeping above: a login pane owns no run.
  client.on('session-exited', (event) => finishProfileLogin(event.sessionId));
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
  if (legacyPane.kind === 'terminal') {
    return { kind: 'terminal', ...(legacyPane.cwd ? { cwd: legacyPane.cwd } : {}) };
  }
  return {
    kind: 'agent',
    continuation: {
      providerId: legacyPane.agent,
      nativeSessionId: legacyPane.nativeSessionId,
      implementation: 'native',
    },
    ...(legacyPane.cwd ? { cwd: legacyPane.cwd } : {}),
    workspace: legacyPane.workspace,
  };
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

  if (
    descriptor.kind === 'agent' &&
    agentRuntime
      .launchProviders()
      .some((provider) => provider.id === descriptor.continuation.providerId && provider.resume)
  ) {
    try {
      const result = await resumeAgentSession(
        {
          continuation: descriptor.continuation,
          ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
          workspace: restoredWorkspaceRequest(descriptor),
          // The account the run was launched under, so a restart resumes into
          // the same root and the session keeps its attribution.
          ...(descriptor.profileId ? { profile: descriptor.profileId } : {}),
        },
        owner,
        originSessionId,
      );
      if (!('error' in result)) return result.session;
      console.warn(`[main] could not resume ${descriptor.continuation.providerId}: ${result.error.message}`);
      if (!shellFallback) return null;
    } catch (error) {
      console.error(`[main] failed to resume ${descriptor.continuation.providerId}`, error);
      if (!shellFallback) return null;
    }
  } else if (descriptor.kind === 'agent') {
    if (!shellFallback) {
      console.warn(`[main] cannot restore unsupported agent ${descriptor.continuation.providerId}`);
      return null;
    }
    console.warn(`[main] replacing unsupported agent ${descriptor.continuation.providerId} with a shell`);
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
  options: CreateAgentSessionOptions,
  owner?: BrowserWindow,
  restoringSessionId?: string,
): Promise<CreateAgentSessionResult> {
  return registerSpawnedAgent(await agentRuntime.spawn(options), owner, restoringSessionId);
}

async function resumeAgentSession(
  options: ResumeAgentOptions,
  owner?: BrowserWindow,
  restoringSessionId?: string,
): Promise<CreateAgentSessionResult> {
  return registerSpawnedAgent(await agentRuntime.resume(options), owner, restoringSessionId);
}

async function registerSpawnedAgent(
  spawned: SpawnAgentResult,
  owner?: BrowserWindow,
  restoringSessionId?: string,
): Promise<CreateAgentSessionResult> {
  if ('error' in spawned) return spawned;
  const result = spawned.info;
  const session = await backend!.automation.getSession(result.runtimeSessionId);
  const info: AgentSessionInfo = {
    ...result,
    provider: { ...result.provider },
    session,
  };
  if (restoringSessionId) {
    pendingRestoreAgents.delete(restoringSessionId);
    setRestoredSessionAlias(restoredSessionAliases, restoringSessionId, result.runtimeSessionId);
  }
  rememberAgent(info, session);
  if (owner) tabs.get(owner)?.sessionIds.add(result.runtimeSessionId);
  return info;
}

async function handleSpawnThroughRequest(request: SpawnThroughRequest): Promise<SpawnThroughResponse> {
  if (request.type === 'exec-failed') {
    const runtimeSessionId = adoptedPreparationSessions.get(request.preparationId);
    await agentRuntime.cancelPrepared(request.preparationId);
    if (runtimeSessionId) {
      stopAdoptedProcessMonitor(runtimeSessionId);
      managedTerminalIds.delete(runtimeSessionId);
      agentRecords.delete(runtimeSessionId);
      broadcast('puppeteer:agent-removed', runtimeSessionId);
    }
    process.stderr.write(`[main] spawn-through exec failed: ${request.message}\n`);
    return { action: 'ack' };
  }
  await ensureBackend();
  return prepareSpawnThroughLaunch(request, {
    runtime: agentRuntime,
    imposterBin: () => imposterExecutable,
    imposterStateRoot: (providerId) => {
      const directory = join(app.getPath('userData'), 'imposter', providerId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      return directory;
    },
    listSessions: () => backend!.automation.listSessions(),
    onAdopted: ({ info: adopted, session, processId, preparationId }) => {
      const info: AgentSessionInfo = {
        ...adopted,
        provider: { ...adopted.provider },
        session,
      };
      managedTerminalIds.add(session.id);
      rememberAgent(info, session);
      monitorAdoptedProcess(session.id, processId, preparationId);
    },
  });
}

async function initializeSpawnThrough(): Promise<void> {
  if (spawnThroughGateway || process.platform === 'win32') return;
  const availableNames = new Set<string>();
  const launchProviders = agentRuntime.launchProviders().flatMap((provider) => {
    const capability = provider.nativeInvocation;
    if (!capability) return [];
    let hasAvailableCommand = false;
    const commands = capability.commands.map((command) => {
      const executable = executableOnOriginalPath(command.executable);
      if (executable) {
        hasAvailableCommand = true;
        availableNames.add(command.name);
      }
      return { ...command, executable: executable ?? command.executable };
    });
    const canImpersonate = Boolean(imposterExecutable && capability.imposter);
    if (!hasAvailableCommand && !canImpersonate) return [];
    return [{ ...provider, nativeInvocation: { ...capability, commands } }];
  });
  const canUseImposter = launchProviders.some((provider) => provider.nativeInvocation?.imposter !== undefined);
  const names = [...availableNames, ...(canUseImposter ? ['ai'] : [])];
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
    PUPPETEER_LAUNCH_PROVIDERS: JSON.stringify(launchProviders),
    ...(imposterExecutable ? { PUPPETEER_IMPOSTER_EXECUTABLE: imposterExecutable } : {}),
    PATH: `${spawnThroughDirectory}${delimiter}${originalPath}`,
    ZDOTDIR: zDotDirectory,
  };
}

function usableCwd(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A tab holding exactly the session main just created, mounted the way a restored pane is. */
function singlePaneWorkspaceDocument(session: SessionSummary): RestoreWorkspaceDocument {
  const paneId = `godview-pane-${randomUUID()}`;
  const cwd = usableCwd(session.cwd);
  return {
    version: 1,
    root: {
      kind: 'pane',
      id: paneId,
      sessionId: session.id,
      meta: {
        type: 'godview-pane-recovery',
        version: PANE_RECOVERY_METADATA_VERSION,
        exited: false,
        descriptor: { kind: 'terminal', ...(cwd ? { cwd } : {}) },
      },
    },
    activePaneId: paneId,
    zoomedPaneId: null,
  };
}

async function attachSessionAsTab(session: SessionSummary, owner?: BrowserWindow): Promise<BrowserWindow> {
  const cwd = usableCwd(session.cwd);
  const window = await createWindow({
    ...(owner ? { tabOf: owner } : {}),
    restoreWorkspace: singlePaneWorkspaceDocument(session),
    claimExistingSessions: false,
    ...(cwd ? { initialCwd: cwd } : {}),
  });
  tabs.get(window)?.sessionIds.add(session.id);
  scheduleRestoreCheckpoint(true);
  return window;
}

/**
 * Variables that bind a pane to the named accounts, or to the persisted
 * defaults when the caller names none. The runtime owns what each name is;
 * this host only merges the record it hands back.
 */
async function profileBindingEnvironment(profileIds?: readonly string[]): Promise<Record<string, string>> {
  let ids = (profileIds ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (ids.length === 0) {
    const stored = profileDefaultsStore.read();
    if (Object.keys(stored).length === 0) return {};
    const registered = await agentRuntime.profiles();
    const retained = retainKnownProfileDefaults(
      stored,
      registered.map((profile) => profile.id),
    );
    // A default pointing at an unregistered account is stale preference, not a
    // failure: drop it so the pane opens unbound and the file self-heals.
    if (Object.keys(retained).length !== Object.keys(stored).length) profileDefaultsStore.write(retained);
    ids = profileDefaultIds(retained);
  }
  if (ids.length === 0) return {};
  try {
    return await agentRuntime.profileBindingEnvironment(ids);
  } catch (error) {
    process.stderr.write(`[main] profile binding unavailable: ${String(error)}\n`);
    return {};
  }
}

/**
 * A new tab whose pane carries the selected accounts.
 *
 * The daemon environment already holds the spawn-through interception, so the
 * binding is an override on top of it rather than a replacement; with no
 * binding the tab is created exactly as it was before profiles existed.
 */
async function openTerminalTab(request: NewTerminalTabRequest, owner?: BrowserWindow): Promise<boolean> {
  const cwd = usableCwd(request.cwd);
  const overrides = await profileBindingEnvironment(request.profileIds);
  if (Object.keys(overrides).length === 0) {
    await createWindow({
      ...(owner ? { tabOf: owner } : {}),
      ...(cwd ? { initialCwd: cwd } : {}),
      freshWorkspace: true,
    });
    return true;
  }
  await ensureBackend();
  const session = await backend!.automation.createSession({
    executable: defaultShell(),
    args: [],
    ...(cwd ? { cwd } : {}),
    environment: { mode: 'inherit', overrides },
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    persistence: 'terminate-with-app',
    programKind: 'interactive-shell',
  });
  await attachSessionAsTab(session, owner);
  return true;
}

async function broadcastProfiles(): Promise<void> {
  if (quitting) return;
  try {
    broadcast('puppeteer:profiles', await agentRuntime.profiles());
  } catch (error) {
    process.stderr.write(`[main] profiles unavailable: ${String(error)}\n`);
  }
}

/**
 * The login pane's exit is the whole signal: its output is never captured and
 * never parsed, and the account's state is re-read from native evidence.
 */
function finishProfileLogin(runtimeSessionId: string): void {
  const pending = pendingProfileLogins.get(runtimeSessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingProfileLogins.delete(runtimeSessionId);
  if (quitting) return;
  void agentRuntime.verifyProfile(pending.profileId).then(
    () => void broadcastProfiles(),
    (error: unknown) => {
      process.stderr.write(`[main] account verification failed: ${String(error)}\n`);
      void broadcastProfiles();
    },
  );
}

function watchProfileLogin(runtimeSessionId: string, profileId: string): void {
  const existing = pendingProfileLogins.get(runtimeSessionId);
  if (existing) clearTimeout(existing.timer);
  // A login left open indefinitely still gets one verification, so an account
  // that was signed in but never closed does not stay unverified forever.
  const timer = setTimeout(() => finishProfileLogin(runtimeSessionId), PROFILE_LOGIN_TIMEOUT_MS);
  timer.unref?.();
  pendingProfileLogins.set(runtimeSessionId, { profileId, timer });
}

async function startProfileLogin(
  request: StartProfileLoginRequest,
  owner?: BrowserWindow,
): Promise<ProfileLoginResult> {
  await ensureBackend();
  const cwd = usableCwd(request.cwd);
  const result = await agentRuntime.startProfileLogin({ profileId: request.profileId, ...(cwd ? { cwd } : {}) });
  if (!('runtimeSessionId' in result)) return result;
  try {
    const session = await backend!.automation.getSession(result.runtimeSessionId);
    await attachSessionAsTab(session, owner);
  } catch (error) {
    // The terminal is live even when no viewport could be opened for it; the
    // watch below still verifies the account when it ends.
    process.stderr.write(`[main] could not attach the login terminal: ${String(error)}\n`);
  }
  watchProfileLogin(result.runtimeSessionId, result.profile.id);
  void broadcastProfiles();
  return result;
}

async function inspectInstallations(request?: InstallationsRequest): Promise<AgentInstallationsSnapshot> {
  const installations = await agentRuntime.inspectInstallations(request?.refresh ? { refresh: true } : undefined);
  return {
    providers: [...agentRuntime.distributionProviders()],
    installations,
    inspectedAt: new Date().toISOString(),
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
      final: record.final,
    })),
  );
  ipcMain.handle('puppeteer:list-agent-monitors', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && tabs.get(window) ? monitorRelay.snapshot() : [];
  });
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
  ipcMain.handle(
    'puppeteer:submit-prompt',
    (_event, options: SubmitPromptOptions): Promise<PromptReceipt> =>
      agentRuntime.agent(options.runtimeSessionId)?.submitPrompt({ text: options.text }) ??
      Promise.resolve({ status: 'rejected', reason: 'agent session not found' }),
  );
  // The pane's stop verb. There is no runtime interrupt service; stopping a
  // turn is what the agent's own TUI does on ^C, so the host sends exactly
  // that through Ghosttea's automation, which yields to a human mid-keystroke.
  ipcMain.handle(
    'puppeteer:interrupt-agent',
    async (event, runtimeSessionId: unknown): Promise<AgentInterruptResult> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || !tabs.get(window) || typeof runtimeSessionId !== 'string') {
        return { accepted: false, reason: 'agent-not-running' };
      }
      const record = agentRecords.get(runtimeSessionId);
      if (!record || !record.agentProcessAlive) return { accepted: false, reason: 'agent-not-running' };
      await ensureBackend();
      const result = await backend!.automation.interrupt(runtimeSessionId);
      return result.accepted
        ? { accepted: true }
        : { accepted: false, reason: result.reason ?? 'human-input-conflict' };
    },
  );
  // The pane's resume verb: the exited run's own continuation, the same way a
  // restore resumes it, mounted by the renderer into the pane that asked.
  ipcMain.handle(
    'puppeteer:resume-agent-session',
    async (event, runtimeSessionId: unknown): Promise<CreateAgentSessionResult> => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const failure = (message: string): CreateAgentSessionResult => ({
        runtimeRunId: '',
        runtimeEpoch: 0,
        externalRefs: [],
        error: { code: 'AGENT_NOT_FOUND', message },
      });
      if (!owner || !tabs.get(owner) || typeof runtimeSessionId !== 'string') return failure('unknown pane');
      const record = agentRecords.get(runtimeSessionId);
      if (!record || record.agentProcessAlive) return failure('no exited agent to resume');
      const descriptor = paneRecoveryMetadata(record.session, record.info).descriptor;
      if (descriptor.kind !== 'agent') return failure('no exited agent to resume');
      const resumable = agentRuntime
        .launchProviders()
        .some((provider) => provider.id === descriptor.continuation.providerId && provider.resume);
      if (!resumable) return failure(`${descriptor.continuation.providerId} cannot resume a session`);
      return resumeAgentSession(
        {
          continuation: descriptor.continuation,
          ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
          workspace: restoredWorkspaceRequest(descriptor),
          ...(descriptor.profileId ? { profile: descriptor.profileId } : {}),
        },
        owner,
      );
    },
  );
  ipcMain.handle('puppeteer:workspace-diff', (_event, runtimeSessionId: string) =>
    agentRuntime.workspaceDiff(runtimeSessionId),
  );
  ipcMain.handle(
    'puppeteer:installations',
    (_event, request: InstallationsRequest | undefined): Promise<AgentInstallationsSnapshot> =>
      inspectInstallations(request),
  );
  // The only outbound path in this application, and only because a person
  // pressed the button that reaches it.
  ipcMain.handle('puppeteer:check-releases', (_event, request: CheckReleasesRequest) =>
    agentRuntime.checkReleases({ providerId: request.providerId, network: true }),
  );
  ipcMain.handle('puppeteer:update-installation', (_event, request: UpdateInstallationRequest) =>
    agentRuntime.updateInstallation({ providerId: request.providerId }),
  );
  ipcMain.handle('puppeteer:profile-providers', () => [...agentRuntime.profileProviders()]);
  ipcMain.handle('puppeteer:profiles', (): Promise<AgentProfile[]> => agentRuntime.profiles());
  ipcMain.handle('puppeteer:create-profile', async (_event, request: CreateProfileRequest) => {
    const created = await agentRuntime.createProfile({ providerId: request.providerId, label: request.label });
    if ('id' in created) void broadcastProfiles();
    return created;
  });
  ipcMain.handle(
    'puppeteer:start-profile-login',
    (event, request: StartProfileLoginRequest): Promise<ProfileLoginResult> => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      return startProfileLogin(request, owner && tabs.get(owner) ? owner : undefined);
    },
  );
  ipcMain.handle('puppeteer:verify-profile', async (_event, profileId: string) => {
    const identity = await agentRuntime.verifyProfile(profileId);
    void broadcastProfiles();
    return identity;
  });
  ipcMain.handle('puppeteer:remove-profile', async (_event, profileId: string): Promise<boolean> => {
    const removed = await agentRuntime.removeProfile(profileId);
    if (removed) {
      const registered = await agentRuntime.profiles();
      profileDefaultsStore.write(
        retainKnownProfileDefaults(
          profileDefaultsStore.read(),
          registered.map((profile) => profile.id),
        ),
      );
      void broadcastProfiles();
    }
    return removed;
  });
  ipcMain.handle('puppeteer:profile-defaults', (): ProfileDefaults => profileDefaultsStore.read());
  ipcMain.handle('puppeteer:set-profile-default', (_event, request: SetProfileDefaultRequest): ProfileDefaults =>
    profileDefaultsStore.set(request.providerId, request.profileId),
  );
  ipcMain.handle('puppeteer:new-terminal-tab', (event, request: NewTerminalTabRequest | undefined) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    return openTerminalTab(request ?? {}, owner && tabs.get(owner) ? owner : undefined);
  });
  ipcMain.handle('puppeteer:history-status', (event): Promise<HistorySearchStatus> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !tabs.get(window)) {
      return Promise.resolve({ reachable: false, detail: 'not a Godview window', checkedAt: new Date().toISOString() });
    }
    return historySearch.status();
  });
  ipcMain.handle('puppeteer:history-facts', (event, input: unknown): Promise<HistorySessionFacts[]> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const ids = parseHistoryFactsRequest(input);
    if (!window || !tabs.get(window) || !ids) return Promise.resolve([]);
    return historySearch.facts(ids);
  });
  ipcMain.handle('puppeteer:history-search', (event, input: unknown): Promise<HistorySearchResponse> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const request = parseHistorySearchRequest(input);
    if (!window || !tabs.get(window) || !request) {
      return Promise.resolve({
        status: {
          reachable: false,
          detail: 'the search request was not understood',
          checkedAt: new Date().toISOString(),
        },
        answered: false,
        hits: [],
        clipped: false,
      });
    }
    return historySearch.search(request);
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
  void openTerminalTab({ ...(usableCwd(cwd) ? { cwd: usableCwd(cwd)! } : {}) }, window).catch((error) =>
    console.error('failed to create tab', error),
  );
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
async function runAgentSmoke(providerId: string): Promise<void> {
  await ensureBackend();
  const provider = agentRuntime.providers().find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`unknown agent provider: ${providerId}`);
  const result = await createAgentSession({ agent: provider.id, cwd: repoRoot });
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
    lifecycle = agentRuntime.agent(result.runtimeSessionId)?.lifecycle;
    if (lifecycle === 'ready' || lifecycle === 'failed' || lifecycle === 'exited') break;
    if (exitInfo) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (lifecycle !== 'ready') {
    throw new Error(
      `${provider.label} did not become ready (lifecycle=${lifecycle ?? 'none'}; ${exitInfo ?? 'process alive'})`,
    );
  }
  console.log(`AGENT SMOKE OK ${provider.id} ${result.sessionId}`);
  // Diagnostic hold (PUPPETEER_AGENT_SMOKE_HOLD_MS): keep the session alive
  // so external observers (e.g. the Imposter control plane) can see it.
  const holdMs = Number(process.env.PUPPETEER_AGENT_SMOKE_HOLD_MS ?? 0);
  if (holdMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, holdMs));
}

async function runSpawnThroughSmoke(providerId: string): Promise<void> {
  const provider = agentRuntime.providers().find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error('unknown agent provider: ' + providerId);
  const launch = agentRuntime.launchProviders().find((candidate) => candidate.id === provider.id)?.nativeInvocation;
  if (!launch) throw new Error(provider.label + ' does not advertise native terminal invocation');

  const launchCommand = process.env.PUPPETEER_SPAWN_SMOKE_COMMAND?.trim() || launch.commands[0]?.name;
  if (!launchCommand) throw new Error(provider.label + ' has no advertised launch command');
  const commandWords = launchCommand.split(/\s+/u);
  const usesImposter =
    Boolean(imposterExecutable && launch.imposter) &&
    commandWords[0] === 'ai' &&
    commandWords[1] === '--' + provider.id;
  const usesNative = launch.commands.some(
    (command) => command.name === commandWords[0] && executableOnOriginalPath(command.executable) !== undefined,
  );
  if (!usesNative && !usesImposter) throw new Error(provider.label + ' is not installed');

  const configuredCwd = process.env.PUPPETEER_SPAWN_SMOKE_CWD?.trim();
  const smokeCwd = configuredCwd || repoRoot;
  if (!isAbsolute(smokeCwd)) throw new Error('PUPPETEER_SPAWN_SMOKE_CWD must be absolute');
  try {
    accessSync(smokeCwd, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error('spawn-through smoke cwd is not an accessible directory: ' + smokeCwd);
  }

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
  if (!submitted.accepted) throw new Error('spawn-through smoke input was rejected: ' + submitted.reason);

  const record = await until(
    provider.label + ' to be adopted into its shell terminal',
    async () => {
      const candidate = agentRecords.get(session.id);
      return candidate?.info.provider.id === provider.id && candidate.info.preparationId ? candidate : undefined;
    },
    30_000,
  );
  const smokeAgent = agentRuntime.agent(session.id);
  if (!smokeAgent) throw new Error(provider.label + ' runtime Agent is unavailable after adoption');

  const prompt = process.env.PUPPETEER_SPAWN_SMOKE_PROMPT?.trim();
  if (prompt) {
    const receipt = await smokeAgent.submitPrompt({ text: prompt });
    if (receipt.status === 'rejected') {
      throw new Error('spawn-through smoke prompt was rejected: ' + receipt.reason);
    }
    const expectedReply = process.env.PUPPETEER_SPAWN_SMOKE_EXPECT_REPLY?.trim();
    const waitMs = Number(process.env.PUPPETEER_SPAWN_SMOKE_WAIT_MS ?? 45_000);
    if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > 120_000) {
      throw new Error('PUPPETEER_SPAWN_SMOKE_WAIT_MS must be greater than 0 and at most 120000');
    }
    await until(
      provider.label + ' to publish a normalized conversation turn',
      async () => {
        const conversation = smokeAgent.conversation;
        const hasPrompt = conversation.items.some((item) => item.kind === 'user' && item.text === prompt);
        const replies = conversation.items.flatMap((item) => (item.kind === 'assistant' ? [item.markdown.trim()] : []));
        const hasReply = expectedReply ? replies.includes(expectedReply) : replies.length > 0;
        return hasPrompt && hasReply && !conversation.responding && smokeAgent.lifecycle === 'ready' ? true : undefined;
      },
      waitMs,
    );
  } else {
    await until(
      provider.label + ' structured control to become ready',
      async () => (smokeAgent.lifecycle === 'ready' ? true : undefined),
      30_000,
    );
  }

  const exited = await backend!.automation.terminateAndWait(session.id, 'application', 5_000);
  await onSessionExited(exited);
  if (exitCleanups.size > 0) await Promise.all([...exitCleanups]);
  if (agentRuntime.agent(session.id)) throw new Error(provider.label + ' remained registered after host termination');
  console.log('SPAWN-THROUGH SMOKE OK ' + provider.id + ' ' + record.info.sessionId);
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
    // The registry decides how many readings a provider has; without this the
    // first poll would be one unkeyed row per provider until an account changed.
    void accountUsageMonitor
      .refreshProfiles()
      .catch((error: unknown) => process.stderr.write(`[main] account usage profiles: ${String(error)}\n`));
    await openInitialWindows();
    // Development flow: create only provider ids advertised by Runtime. The
    // shim spawn-through path is POSIX-only, so this also supports Windows.
    const availableProviders = new Map(agentRuntime.providers().map((provider) => [provider.id, provider]));
    for (const providerId of (process.env.PUPPETEER_AUTOCREATE_AGENTS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const provider = availableProviders.get(providerId);
      if (!provider) {
        console.error(`[main] autocreate ignored unknown provider ${providerId}`);
        continue;
      }
      void createAgentSession({ agent: provider.id, cwd: repoRoot })
        .then((result) => {
          if ('error' in result) console.error(`[main] autocreate ${provider.label} failed: ${result.error.message}`);
        })
        .catch((error) => console.error(`[main] autocreate ${provider.label} failed`, error));
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
