import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentSessionInfo } from './protocol.js';

export const RESTORE_SNAPSHOT_VERSION = 2 as const;
export const PANE_RECOVERY_METADATA_VERSION = 1 as const;
export const MAX_RESTORE_PANES_PER_WINDOW = 512;
const MAX_RESTORE_WINDOWS = 64;
const MAX_RESTORE_AGENTS = 512;
const MAX_WORKSPACE_NODES = MAX_RESTORE_PANES_PER_WINDOW * 2 - 1;
const MAX_WORKSPACE_DEPTH = MAX_RESTORE_PANES_PER_WINDOW;
const MAX_RESTORE_STRING = 8_192;

export interface RestoreAgentWorkspace {
  mode: string;
  root: string;
  sourcePath: string;
  branch?: string;
}

/**
 * Provider-specific launch provenance that is both necessary for a faithful
 * resume and safe to persist. This deliberately cannot contain argv,
 * environment maps, or credentials.
 */
export interface RestoreClaudeLaunchProvenance {
  kind: 'claude';
  /** Absolute Claude configuration root; selects the matching credential namespace. */
  configDir: string;
}

export type RestoreAgentLaunchProvenance = RestoreClaudeLaunchProvenance;

export type RestoreDescriptor =
  | { kind: 'terminal'; cwd?: string }
  | {
      kind: 'agent';
      agent: string;
      nativeSessionId: string;
      cwd?: string;
      workspace: RestoreAgentWorkspace;
      launch?: RestoreAgentLaunchProvenance;
    };

export interface PaneRecoveryMetadataV1 {
  type: 'godview-pane-recovery';
  version: typeof PANE_RECOVERY_METADATA_VERSION;
  exited: boolean;
  descriptor: RestoreDescriptor;
}

export interface RestoreWorkspacePane {
  kind: 'pane';
  id: string;
  sessionId: string;
  meta: PaneRecoveryMetadataV1;
}

export interface RestoreWorkspaceSplit {
  kind: 'split';
  id: string;
  axis: 'horizontal' | 'vertical';
  ratio: number;
  first: RestoreWorkspaceNode;
  second: RestoreWorkspaceNode;
}

export type RestoreWorkspaceNode = RestoreWorkspacePane | RestoreWorkspaceSplit;

export interface RestoreWorkspaceDocument {
  version: 1;
  root: RestoreWorkspaceNode;
  activePaneId: string;
  zoomedPaneId: string | null;
}

export interface RestoreSnapshotAgent extends Extract<RestoreDescriptor, { kind: 'agent' }> {
  runtimeSessionId: string;
}

export interface RestoreSnapshotWindow {
  slotId: string;
  groupId: string;
  activeCwd?: string;
  workspace: RestoreWorkspaceDocument;
}

export interface RestoreSnapshot {
  version: typeof RESTORE_SNAPSHOT_VERSION;
  updatedAtMs: number;
  windows: RestoreSnapshotWindow[];
  /** The window that owned focus at the checkpoint boundary. */
  activeWindowSlotId?: string;
  /** All live agents, including agents that are not mounted in a pane. */
  agents: RestoreSnapshotAgent[];
}

export interface RestoreSnapshotWindowInput {
  id: string;
  groupId: string;
  activeCwd: string | undefined;
  sessionIds: Iterable<string>;
  workspace: unknown;
}

export interface RestoreSnapshotAgentInput {
  info: Pick<AgentSessionInfo, 'agent' | 'sessionId' | 'runtimeSessionId' | 'workspace'>;
  session: Pick<SessionSummary, 'cwd' | 'exited'>;
  /** Sanitized provider launch provenance; never opaque agent options. */
  launch?: RestoreAgentLaunchProvenance;
  /** False once the managed agent child returned to its still-open shell pane. */
  agentProcessAlive?: boolean;
}

export interface BuildRestoreSnapshotInput {
  windows: readonly RestoreSnapshotWindowInput[];
  agents: ReadonlyMap<string, RestoreSnapshotAgentInput>;
  activeWindowId?: string;
  /** Old persisted pane session id -> newly recovered runtime session id. */
  sessionAliases?: ReadonlyMap<string, string>;
  updatedAtMs: number;
}

export interface RestoreSnapshotSummary {
  windows: number;
  agents: number;
  terminals: number;
  entries: { agent: string; cwd?: string }[];
}

interface RawPane {
  id: string;
  sessionId: string;
  meta: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function usable(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_RESTORE_STRING ? normalized : undefined;
}

function parseWorkspace(value: unknown): RestoreAgentWorkspace | undefined {
  if (!isRecord(value)) return undefined;
  const mode = usable(value.mode);
  const root = usable(value.root);
  const sourcePath = usable(value.sourcePath);
  if (!mode || !root || !sourcePath) return undefined;
  const branch = usable(value.branch);
  return { mode, root, sourcePath, ...(branch ? { branch } : {}) };
}

function isAbsoluteFilesystemPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/u.test(value);
}

function parseRestoreLaunch(value: unknown, agent: string): RestoreAgentLaunchProvenance | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.kind !== 'claude' || agent !== 'claude') return null;
  const configDir = usable(value.configDir);
  if (!configDir || !isAbsoluteFilesystemPath(configDir)) return null;
  return { kind: 'claude', configDir };
}

/** Translate persisted safe provenance back to the provider's narrow launch options. */
export function restoredAgentOptions(
  descriptor: Extract<RestoreDescriptor, { kind: 'agent' }>,
): Record<string, string> | undefined {
  return descriptor.agent === 'claude' && descriptor.launch?.kind === 'claude'
    ? { configDir: descriptor.launch.configDir }
    : undefined;
}

export function readRestoreDescriptor(value: unknown): RestoreDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const cwd = usable(value.cwd);
  if (value.kind === 'terminal') return { kind: 'terminal', ...(cwd ? { cwd } : {}) };
  if (value.kind !== 'agent') return undefined;
  const agent = usable(value.agent);
  const nativeSessionId = usable(value.nativeSessionId);
  const workspace = parseWorkspace(value.workspace);
  if (!agent || !nativeSessionId || !workspace) return undefined;
  const launch = parseRestoreLaunch(value.launch, agent);
  if (launch === null) return undefined;
  return {
    kind: 'agent',
    agent,
    nativeSessionId,
    ...(cwd ? { cwd } : {}),
    workspace,
    ...(launch ? { launch } : {}),
  };
}

export function readPaneRecoveryMetadata(value: unknown): PaneRecoveryMetadataV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== 'godview-pane-recovery' || value.version !== PANE_RECOVERY_METADATA_VERSION) return undefined;
  if (typeof value.exited !== 'boolean') return undefined;
  const descriptor = readRestoreDescriptor(value.descriptor);
  if (!descriptor) return undefined;
  return {
    type: 'godview-pane-recovery',
    version: PANE_RECOVERY_METADATA_VERSION,
    exited: value.exited,
    descriptor,
  };
}

function descriptorForAgent(agent: RestoreSnapshotAgentInput): RestoreSnapshotAgent {
  const workspace = agent.info.workspace;
  const cwd = usable(workspace.sourcePath) ?? usable(workspace.root) ?? usable(agent.session.cwd);
  const branch = usable(workspace.branch);
  const launch = parseRestoreLaunch(agent.launch, agent.info.agent) ?? undefined;
  return {
    runtimeSessionId: agent.info.runtimeSessionId,
    kind: 'agent',
    agent: agent.info.agent,
    nativeSessionId: agent.info.sessionId,
    ...(cwd ? { cwd } : {}),
    workspace: {
      mode: workspace.mode,
      root: workspace.root,
      sourcePath: workspace.sourcePath,
      ...(branch ? { branch } : {}),
    },
    ...(launch ? { launch } : {}),
  };
}

export function paneRecoveryMetadata(
  session: Pick<SessionSummary, 'id' | 'cwd' | 'exited'>,
  agent?: Pick<AgentSessionInfo, 'agent' | 'sessionId' | 'runtimeSessionId' | 'workspace'>,
  launch?: RestoreAgentLaunchProvenance,
): PaneRecoveryMetadataV1 {
  let paneDescriptor: RestoreDescriptor;
  if (agent) {
    const { runtimeSessionId: _runtimeSessionId, ...descriptor } = descriptorForAgent({ info: agent, session, launch });
    paneDescriptor = descriptor;
  } else {
    const cwd = usable(session.cwd);
    paneDescriptor = { kind: 'terminal', ...(cwd ? { cwd } : {}) };
  }
  return {
    type: 'godview-pane-recovery',
    version: PANE_RECOVERY_METADATA_VERSION,
    exited: session.exited,
    descriptor: paneDescriptor,
  };
}

function workspaceLeaves(node: RestoreWorkspaceNode): RestoreWorkspacePane[] {
  return node.kind === 'pane' ? [node] : [...workspaceLeaves(node.first), ...workspaceLeaves(node.second)];
}

export function restoreWorkspaceSessionIds(workspace: RestoreWorkspaceDocument): string[] {
  return [...new Set(workspaceLeaves(workspace.root).map((pane) => pane.sessionId))];
}

/**
 * Atomically hand every pane mounted to a dead application PTY to one live
 * shell. Pane ids and split geometry stay unchanged; only the terminal
 * resource and its recovery contract change.
 */
export function replaceRestoreWorkspaceSession(
  workspace: RestoreWorkspaceDocument,
  originSessionId: string,
  replacement: Pick<SessionSummary, 'id' | 'cwd'>,
): RestoreWorkspaceDocument {
  const cwd = usable(replacement.cwd);
  const replaceNode = (node: RestoreWorkspaceNode): RestoreWorkspaceNode => {
    if (node.kind === 'split') {
      return {
        ...node,
        first: replaceNode(node.first),
        second: replaceNode(node.second),
      };
    }
    if (node.sessionId !== originSessionId) return node;
    return {
      ...node,
      sessionId: replacement.id,
      meta: {
        type: 'godview-pane-recovery',
        version: PANE_RECOVERY_METADATA_VERSION,
        exited: false,
        descriptor: { kind: 'terminal', ...(cwd ? { cwd } : {}) },
      },
    };
  };
  return { ...workspace, root: replaceNode(workspace.root) };
}

function containsPane(node: RestoreWorkspaceNode, paneId: string): boolean {
  return node.kind === 'pane'
    ? node.id === paneId
    : containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

function transformWorkspace(
  value: unknown,
  transformPane: (pane: RawPane) => PaneRecoveryMetadataV1 | null,
): RestoreWorkspaceDocument | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.root)) return undefined;
  const nodeIds = new Set<string>();
  const paneIds = new Set<string>();

  const parseNode = (raw: unknown, depth = 0): RestoreWorkspaceNode | null => {
    if (depth > MAX_WORKSPACE_DEPTH || nodeIds.size >= MAX_WORKSPACE_NODES) return null;
    if (!isRecord(raw)) return null;
    const id = usable(raw.id);
    if (!id || nodeIds.has(id)) return null;
    nodeIds.add(id);
    if (raw.kind === 'pane') {
      const sessionId = usable(raw.sessionId) ?? (isRecord(raw.session) ? usable(raw.session.id) : undefined);
      if (!sessionId || paneIds.has(id)) return null;
      paneIds.add(id);
      const meta = transformPane({ id, sessionId, meta: raw.meta });
      return meta ? { kind: 'pane', id, sessionId, meta } : null;
    }
    if (raw.kind !== 'split' || (raw.axis !== 'horizontal' && raw.axis !== 'vertical')) return null;
    const first = parseNode(raw.first, depth + 1);
    const second = parseNode(raw.second, depth + 1);
    if (!first) return second;
    if (!second) return first;
    const ratio = typeof raw.ratio === 'number' && Number.isFinite(raw.ratio) ? raw.ratio : 0.5;
    return {
      kind: 'split',
      id,
      axis: raw.axis,
      ratio: Math.max(0.1, Math.min(0.9, ratio)),
      first,
      second,
    };
  };

  const root = parseNode(value.root);
  if (!root) return undefined;
  const firstPane = workspaceLeaves(root)[0];
  if (!firstPane) return undefined;
  const requestedActivePaneId = usable(value.activePaneId);
  const activePaneId =
    requestedActivePaneId && containsPane(root, requestedActivePaneId) ? requestedActivePaneId : firstPane.id;
  const requestedZoomedPaneId = usable(value.zoomedPaneId);
  const zoomedPaneId =
    requestedZoomedPaneId && containsPane(root, requestedZoomedPaneId) ? requestedZoomedPaneId : null;
  return { version: 1, root, activePaneId, zoomedPaneId };
}

export function readRestoreWorkspaceDocument(value: unknown): RestoreWorkspaceDocument | undefined {
  return transformWorkspace(value, ({ meta }) => {
    const recovery = readPaneRecoveryMetadata(meta);
    if (recovery?.exited) return null;
    return (
      recovery ?? {
        type: 'godview-pane-recovery',
        version: PANE_RECOVERY_METADATA_VERSION,
        exited: false,
        descriptor: { kind: 'terminal' },
      }
    );
  });
}

function fallbackWorkspace(
  sessionIds: Iterable<string>,
  activeCwd: string | undefined,
  agents: ReadonlyMap<string, RestoreSnapshotAgent>,
): RestoreWorkspaceDocument | undefined {
  const ids = [...sessionIds];
  if (ids.length > MAX_RESTORE_PANES_PER_WINDOW) throw new Error('workspace session count exceeds the restore limit');
  const panes = ids.map((sessionId, index): RestoreWorkspacePane => {
    const agent = agents.get(sessionId);
    const descriptor: RestoreDescriptor = agent
      ? (({ runtimeSessionId: _runtimeSessionId, ...rest }) => rest)(agent)
      : { kind: 'terminal', ...(activeCwd ? { cwd: activeCwd } : {}) };
    return {
      kind: 'pane',
      id: `recovered-pane-${index}-${sessionId}`,
      sessionId,
      meta: {
        type: 'godview-pane-recovery',
        version: PANE_RECOVERY_METADATA_VERSION,
        exited: false,
        descriptor,
      },
    };
  });
  if (!panes.length) return undefined;
  let root: RestoreWorkspaceNode = panes[0]!;
  for (const [index, pane] of panes.slice(1).entries()) {
    root = {
      kind: 'split',
      id: `recovered-split-${index}`,
      axis: 'horizontal',
      ratio: 0.5,
      first: root,
      second: pane,
    };
  }
  return { version: 1, root, activePaneId: panes[0]!.id, zoomedPaneId: null };
}

export function buildRestoreSnapshot(input: BuildRestoreSnapshotInput): RestoreSnapshot {
  if (input.windows.length > MAX_RESTORE_WINDOWS || input.agents.size > MAX_RESTORE_AGENTS) {
    throw new Error('live topology exceeds the restore snapshot limits');
  }
  const agents = [...input.agents.values()]
    .filter((agent) => !agent.session.exited && agent.agentProcessAlive !== false)
    .map(descriptorForAgent);
  const agentsByRuntimeSession = new Map(agents.map((agent) => [agent.runtimeSessionId, agent]));
  const windows: RestoreSnapshotWindow[] = [];

  for (const window of input.windows) {
    const activeCwd = usable(window.activeCwd);
    const workspace =
      transformWorkspace(window.workspace, ({ sessionId, meta }) => {
        const liveAgent = agentsByRuntimeSession.get(input.sessionAliases?.get(sessionId) ?? sessionId);
        if (liveAgent) {
          const { runtimeSessionId: _runtimeSessionId, ...descriptor } = liveAgent;
          return {
            type: 'godview-pane-recovery',
            version: PANE_RECOVERY_METADATA_VERSION,
            exited: false,
            descriptor,
          };
        }
        const previous = readPaneRecoveryMetadata(meta);
        if (previous?.exited) return null;
        const descriptor: RestoreDescriptor =
          previous?.descriptor.kind === 'terminal'
            ? previous.descriptor
            : { kind: 'terminal', ...(previous?.descriptor.cwd ? { cwd: previous.descriptor.cwd } : {}) };
        return {
          type: 'godview-pane-recovery',
          version: PANE_RECOVERY_METADATA_VERSION,
          exited: false,
          descriptor,
        };
      }) ?? fallbackWorkspace(window.sessionIds, activeCwd, agentsByRuntimeSession);
    if (!workspace) continue;
    windows.push({
      slotId: window.id,
      groupId: window.groupId,
      ...(activeCwd ? { activeCwd } : {}),
      workspace,
    });
  }

  const activeWindowSlotId = usable(input.activeWindowId);
  return {
    version: RESTORE_SNAPSHOT_VERSION,
    updatedAtMs: input.updatedAtMs,
    windows,
    ...(activeWindowSlotId && windows.some((window) => window.slotId === activeWindowSlotId)
      ? { activeWindowSlotId }
      : {}),
    agents,
  };
}

function readSnapshotAgent(value: unknown): RestoreSnapshotAgent | undefined {
  if (!isRecord(value)) return undefined;
  const runtimeSessionId = usable(value.runtimeSessionId);
  const descriptor = readRestoreDescriptor(value);
  if (!runtimeSessionId || descriptor?.kind !== 'agent') return undefined;
  return { runtimeSessionId, ...descriptor };
}

export function readRestoreSnapshot(value: unknown): RestoreSnapshot | undefined {
  if (!isRecord(value) || value.version !== RESTORE_SNAPSHOT_VERSION) return undefined;
  if (!Array.isArray(value.windows) || !Array.isArray(value.agents)) return undefined;
  if (value.windows.length > MAX_RESTORE_WINDOWS || value.agents.length > MAX_RESTORE_AGENTS) return undefined;
  const agents: RestoreSnapshotAgent[] = [];
  const agentIds = new Set<string>();
  for (const raw of value.agents) {
    const agent = readSnapshotAgent(raw);
    if (!agent || agentIds.has(agent.runtimeSessionId)) continue;
    agentIds.add(agent.runtimeSessionId);
    agents.push(agent);
  }
  const windows: RestoreSnapshotWindow[] = [];
  const slotIds = new Set<string>();
  for (const raw of value.windows) {
    if (!isRecord(raw)) continue;
    const slotId = usable(raw.slotId);
    const groupId = usable(raw.groupId);
    const workspace = readRestoreWorkspaceDocument(raw.workspace);
    if (!slotId || !groupId || !workspace || slotIds.has(slotId)) continue;
    slotIds.add(slotId);
    const activeCwd = usable(raw.activeCwd);
    windows.push({ slotId, groupId, ...(activeCwd ? { activeCwd } : {}), workspace });
  }
  if (!windows.length && !agents.length) return undefined;
  const updatedAtMs =
    typeof value.updatedAtMs === 'number' && Number.isFinite(value.updatedAtMs) ? value.updatedAtMs : 0;
  const activeWindowSlotId = usable(value.activeWindowSlotId);
  return {
    version: RESTORE_SNAPSHOT_VERSION,
    updatedAtMs,
    windows,
    ...(activeWindowSlotId && slotIds.has(activeWindowSlotId) ? { activeWindowSlotId } : {}),
    agents,
  };
}

export function summarizeRestoreSnapshot(snapshot: RestoreSnapshot): RestoreSnapshotSummary {
  let terminals = 0;
  for (const window of snapshot.windows) {
    for (const pane of workspaceLeaves(window.workspace.root)) {
      if (pane.meta.descriptor.kind === 'terminal') terminals += 1;
    }
  }
  return {
    windows: snapshot.windows.length,
    agents: snapshot.agents.length,
    terminals,
    entries: snapshot.agents.map((agent) => ({ agent: agent.agent, ...(agent.cwd ? { cwd: agent.cwd } : {}) })),
  };
}

export function snapshotAgent(snapshot: RestoreSnapshot, runtimeSessionId: string): RestoreSnapshotAgent | undefined {
  return snapshot.agents.find((agent) => agent.runtimeSessionId === runtimeSessionId);
}

export function snapshotReferencedSessionIds(snapshot: RestoreSnapshot): Set<string> {
  return new Set(snapshot.windows.flatMap((window) => restoreWorkspaceSessionIds(window.workspace)));
}

/**
 * Pick the viewport that should be foreground after all restored windows have
 * loaded. Older V2 snapshots predate focus persistence, so prefer a window
 * containing a resumed agent instead of leaving the last plain shell in front.
 */
export function preferredRestoreWindow(snapshot: RestoreSnapshot): RestoreSnapshotWindow | undefined {
  const recorded = snapshot.activeWindowSlotId
    ? snapshot.windows.find((window) => window.slotId === snapshot.activeWindowSlotId)
    : undefined;
  if (recorded) return recorded;
  return (
    snapshot.windows.find((window) =>
      workspaceLeaves(window.workspace.root).some((pane) => pane.meta.descriptor.kind === 'agent'),
    ) ?? snapshot.windows.at(-1)
  );
}
