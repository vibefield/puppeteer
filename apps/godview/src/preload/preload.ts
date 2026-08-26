import { contextBridge, ipcRenderer } from 'electron';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { createGhostteaClipboardBridge, forwardGhostteaRendererPorts } from '@vibecook/ghosttea-electron/preload';
import type {
  AcknowledgeAgentFailureRequest,
  AccountUsageBatch,
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorStateMessage,
  AgentSessionSnapshot,
  AgentSessionInfo,
  PuppeteerBridge,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PromptReceipt,
  ReadAgentMonitorArtifactRequest,
  PaneRehydrationRequest,
  ScenarioRecordingStatus,
  StartScenarioRecordingResult,
  SubmitPromptOptions,
  TerminalSessionHandoff,
  WorkspaceDiff,
  WorkspaceFinalEvent,
} from '../protocol.js';

forwardGhostteaRendererPorts(ipcRenderer);
const clipboardBridge = createGhostteaClipboardBridge(ipcRenderer);

function onIpcMessage<T>(channel: string, callback: (message: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, message: T): void => callback(message);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const tabId = argument('ghosttea-tab-id') ?? 'default';
const resetWorkspace = argument('ghosttea-tab-reset') === '1';
const claimExistingSessions = argument('ghosttea-tab-claim-existing') !== '0';
const remoteSessionsEnabled = argument('ghosttea-remote-sessions') !== '0';
const managedConfigEditor = argument('ghosttea-managed-config-editor') === '1';
const encodedInitialCwd = argument('ghosttea-tab-cwd');
let initialCwd: string | undefined;
try {
  initialCwd = encodedInitialCwd ? decodeURIComponent(encodedInitialCwd) : undefined;
} catch {
  initialCwd = undefined;
}

const puppeteer: PuppeteerBridge = {
  accountUsage: (): Promise<AccountUsageBatch> => ipcRenderer.invoke('puppeteer:account-usage'),
  refreshAccountUsage: (): Promise<AccountUsageBatch> => ipcRenderer.invoke('puppeteer:refresh-account-usage'),
  onAccountUsage: (callback: (batch: AccountUsageBatch) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, batch: AccountUsageBatch): void => callback(batch);
    ipcRenderer.on('puppeteer:account-usage', listener);
    return () => ipcRenderer.removeListener('puppeteer:account-usage', listener);
  },
  createAgentSession: (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> =>
    ipcRenderer.invoke('puppeteer:create-agent-session', options),
  listAgentSessions: (): Promise<AgentSessionSnapshot[]> => ipcRenderer.invoke('puppeteer:list-agent-sessions'),
  rehydratePane: (request: PaneRehydrationRequest): Promise<SessionSummary | null> =>
    ipcRenderer.invoke('puppeteer:rehydrate-pane', request),
  onAgentSession: (callback: (info: AgentSessionInfo) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: AgentSessionInfo): void => callback(info);
    ipcRenderer.on('puppeteer:agent-session', listener);
    return () => ipcRenderer.removeListener('puppeteer:agent-session', listener);
  },
  onAgentRemoved: (callback: (runtimeSessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, runtimeSessionId: string): void => callback(runtimeSessionId);
    ipcRenderer.on('puppeteer:agent-removed', listener);
    return () => ipcRenderer.removeListener('puppeteer:agent-removed', listener);
  },
  submitPrompt: (options: SubmitPromptOptions): Promise<PromptReceipt> =>
    ipcRenderer.invoke('puppeteer:submit-prompt', options),
  listAgentMonitors: (): Promise<AgentMonitorStateMessage[]> => ipcRenderer.invoke('puppeteer:list-agent-monitors'),
  onAgentMonitorState: (callback: (message: AgentMonitorStateMessage) => void): (() => void) =>
    onIpcMessage('puppeteer:agent-monitor-state', callback),
  onAgentMonitorNotification: (callback: (message: AgentMonitorNotificationMessage) => void): (() => void) =>
    onIpcMessage('puppeteer:agent-monitor-notification', callback),
  onAgentMonitorRemoved: (callback: (message: AgentMonitorRemovedMessage) => void): (() => void) =>
    onIpcMessage('puppeteer:agent-monitor-removed', callback),
  acknowledgeAgentFailure: (request: AcknowledgeAgentFailureRequest): Promise<boolean> =>
    ipcRenderer.invoke('puppeteer:acknowledge-agent-failure', request),
  readAgentMonitorArtifact: (request: ReadAgentMonitorArtifactRequest) =>
    ipcRenderer.invoke('puppeteer:read-agent-monitor-artifact', request),
  workspaceDiff: (runtimeSessionId: string): Promise<WorkspaceDiff | null> =>
    ipcRenderer.invoke('puppeteer:workspace-diff', runtimeSessionId),
  onWorkspaceFinal: (callback: (event: WorkspaceFinalEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, final: WorkspaceFinalEvent): void => callback(final);
    ipcRenderer.on('puppeteer:workspace-final', listener);
    return () => ipcRenderer.removeListener('puppeteer:workspace-final', listener);
  },
  scenarioRecordings: (): Promise<ScenarioRecordingStatus[]> => ipcRenderer.invoke('puppeteer:scenario-recordings'),
  startScenarioRecording: (runtimeSessionId: string): Promise<StartScenarioRecordingResult> =>
    ipcRenderer.invoke('puppeteer:start-scenario-recording', runtimeSessionId),
  stopScenarioRecording: (runtimeSessionId: string): Promise<ScenarioRecordingStatus> =>
    ipcRenderer.invoke('puppeteer:stop-scenario-recording', runtimeSessionId),
  onScenarioRecording: (callback: (status: ScenarioRecordingStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ScenarioRecordingStatus): void => callback(status);
    ipcRenderer.on('puppeteer:scenario-recording', listener);
    return () => ipcRenderer.removeListener('puppeteer:scenario-recording', listener);
  },
};

contextBridge.exposeInMainWorld('puppeteer', puppeteer);
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  tabId,
  resetWorkspace,
  claimExistingSessions,
  remoteSessionsEnabled,
  initialCwd,
  defaultShell:
    process.platform === 'win32' ? (process.env.COMSPEC ?? 'powershell.exe') : (process.env.SHELL ?? '/bin/zsh'),
  writeClipboard: clipboardBridge.writeText,
  readClipboard: clipboardBridge.readText,
  setTerminalCanCopy: clipboardBridge.setCanCopy,
  showContextMenu: (canCopy: boolean) => ipcRenderer.send('terminal-context-menu', canCopy),
  toggleFullscreen: () => ipcRenderer.send('terminal-toggle-fullscreen'),
  closeWindow: () => ipcRenderer.send('terminal-close-window'),
  newWindow: (cwd?: string) => ipcRenderer.send('terminal-new-window', cwd),
  quit: () => ipcRenderer.send('terminal-quit'),
  closeAllWindows: () => ipcRenderer.send('terminal-close-all-windows'),
  openConfig: () => ipcRenderer.send('terminal-open-config'),
  reloadConfig: () => ipcRenderer.send('terminal-reload-config'),
  ...(managedConfigEditor
    ? {
        saveAppearance: (mode: 'light' | 'dark', update: unknown) =>
          ipcRenderer.invoke('terminal-save-appearance', { mode, update }) as Promise<void>,
        configEditor: {
          load: () => ipcRenderer.invoke('terminal-config-editor-load') as Promise<unknown>,
          validate: (contents: string) =>
            ipcRenderer.invoke('terminal-config-editor-validate', contents) as Promise<unknown>,
          save: (expectedRevision: string, contents: string) =>
            ipcRenderer.invoke('terminal-config-editor-save', { expectedRevision, contents }) as Promise<unknown>,
          importGhostty: () => ipcRenderer.invoke('terminal-config-editor-import-ghostty') as Promise<unknown>,
          importFile: () => ipcRenderer.invoke('terminal-config-editor-import-file') as Promise<unknown>,
          exportFile: (contents: string) =>
            ipcRenderer.invoke('terminal-config-editor-export-file', contents) as Promise<unknown>,
          openExternal: () => ipcRenderer.send('terminal-open-config'),
          setDirty: (dirty: boolean) => ipcRenderer.send('terminal-config-editor-dirty', dirty),
        },
      }
    : {}),
  newTab: (cwd?: string) => ipcRenderer.send('terminal-new-tab', cwd),
  selectTab: (target: 'previous' | 'next' | 'last' | number) => ipcRenderer.send('terminal-select-tab', target),
  closeTab: () => ipcRenderer.send('terminal-close-tab'),
  takeRestoreWorkspace: (): Promise<unknown> => ipcRenderer.invoke('terminal-take-restore-workspace'),
  updateTabSessions: (sessionIds: readonly string[], workspace?: unknown) =>
    ipcRenderer.send('terminal-tab-sessions', sessionIds, workspace),
  updateWorkspace: (workspace: unknown) => ipcRenderer.send('terminal-workspace-document', workspace),
  onTerminalSessionHandoff: (listener: (handoff: TerminalSessionHandoff) => void) =>
    onIpcMessage('terminal-session-handoff', listener),
  acknowledgeTerminalSessionHandoff: (handoffId: string) => ipcRenderer.send('terminal-session-handoff-ack', handoffId),
  updateActiveCwd: (cwd?: string) => ipcRenderer.send('terminal-tab-active-cwd', cwd),
  resolveProcessCwd: (pid: number): Promise<string | undefined> => ipcRenderer.invoke('godview:process-cwd', pid),
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.send('godview:set-theme', theme),
  onThemeChanged: (listener: (theme: 'light' | 'dark') => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark'): void => listener(theme);
    ipcRenderer.on('godview:theme-changed', handler);
    return () => ipcRenderer.removeListener('godview:theme-changed', handler);
  },
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => listener(action);
    ipcRenderer.on('terminal-menu-action', handler);
    return () => ipcRenderer.removeListener('terminal-menu-action', handler);
  },
});
