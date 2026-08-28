import type {
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { WorkspaceEvent, WorkspaceFileChange } from '@vibecook/puppeteer-core';

interface AcpWorkspaceOperation {
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
}

const MAX_OPERATIONS = 1_024;

function boundedSet<K, V>(target: Map<K, V>, key: K, value: V): void {
  target.delete(key);
  target.set(key, value);
  while (target.size > MAX_OPERATIONS) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    target.delete(oldest);
  }
}

function operationKind(kind: ToolKind | null | undefined): WorkspaceFileChange['kind'] {
  if (kind === 'edit') return 'modify';
  if (kind === 'delete') return 'delete';
  if (kind === 'move') return 'move';
  return 'unknown';
}

function diffChanges(operation: AcpWorkspaceOperation): WorkspaceFileChange[] {
  const changes: WorkspaceFileChange[] = [];
  for (const item of operation.content ?? []) {
    if (
      item.type !== 'diff' ||
      typeof item.path !== 'string' ||
      item.path.length === 0 ||
      typeof item.newText !== 'string'
    )
      continue;
    const hasBefore = Object.hasOwn(item, 'oldText');
    const kind =
      operation.kind === 'delete' ? 'delete' : item.oldText === null ? 'create' : operationKind(operation.kind);
    changes.push({
      path: item.path,
      kind,
      details: [
        {
          representation: 'content',
          basis: 'native-file-operation',
          ...(hasBefore ? { before: item.oldText ?? null } : {}),
          after: item.newText,
        },
      ],
    });
  }
  return changes;
}

function locationChanges(operation: AcpWorkspaceOperation): WorkspaceFileChange[] {
  if (!['edit', 'delete', 'move'].includes(operation.kind ?? '')) return [];
  return (operation.locations ?? [])
    .filter((location) => typeof location.path === 'string' && location.path.length > 0)
    .map((location) => ({ path: location.path, kind: operationKind(operation.kind) }));
}

/** ACP diff/location updates -> provider-neutral workspace lifecycle. */
export class AcpWorkspaceNormalizer {
  private readonly operations = new Map<string, AcpWorkspaceOperation>();
  private readonly fingerprints = new Map<string, string>();

  normalize(update: SessionUpdate): WorkspaceEvent[] {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return [];
    const toolCallId = update.toolCallId;
    const previous = this.operations.get(toolCallId) ?? {};
    const next: AcpWorkspaceOperation = {
      ...previous,
      ...(Object.hasOwn(update, 'kind') ? { kind: update.kind } : {}),
      ...(Object.hasOwn(update, 'status') ? { status: update.status } : {}),
      ...(Object.hasOwn(update, 'content') ? { content: update.content } : {}),
      ...(Object.hasOwn(update, 'locations') ? { locations: update.locations } : {}),
    };
    boundedSet(this.operations, toolCallId, next);

    const fromDiff = diffChanges(next);
    const changes = fromDiff.length > 0 ? fromDiff : locationChanges(next);
    if (changes.length === 0) return [];
    const status = next.status;
    const phase =
      status === 'completed'
        ? 'applied'
        : status === 'failed'
          ? 'failed'
          : status === 'in_progress'
            ? 'in-progress'
            : status === 'pending' || update.sessionUpdate === 'tool_call'
              ? 'proposed'
              : 'in-progress';
    const event: WorkspaceEvent = {
      type: 'workspace:file-operation',
      toolCallId,
      phase,
      changes,
    };
    const fingerprint = JSON.stringify(event);
    if (this.fingerprints.get(toolCallId) === fingerprint) return [];
    boundedSet(this.fingerprints, toolCallId, fingerprint);
    return [event];
  }
}
