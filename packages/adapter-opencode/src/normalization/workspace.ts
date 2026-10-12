import type { WorkspaceEvent, WorkspaceFileChange } from '@vibefield/puppeteer-core';
import type { OpenCodeSseRecord } from '../transport/event-stream.js';
import { boundedOpenCodeMapSet, isOpenCodeRecord, openCodeNumber, openCodeText } from './wire.js';

const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch']);

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  const candidate = openCodeNumber(value);
  return candidate !== undefined && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function nativeKind(value: unknown): WorkspaceFileChange['kind'] {
  switch (openCodeText(value)) {
    case 'add':
    case 'added':
    case 'create':
    case 'created':
      return 'create';
    case 'delete':
    case 'deleted':
    case 'unlink':
      return 'delete';
    case 'move':
    case 'moved':
    case 'rename':
    case 'renamed':
      return 'move';
    case 'change':
    case 'edit':
    case 'modified':
    case 'update':
      return 'modify';
    default:
      return 'unknown';
  }
}

function patchChange(value: unknown, fallbackKind: WorkspaceFileChange['kind']): WorkspaceFileChange | undefined {
  const body = isOpenCodeRecord(value) ? value : undefined;
  const path = openCodeText(body?.filePath) ?? openCodeText(body?.file) ?? openCodeText(body?.path);
  if (!body || !path) return undefined;
  const patch = stringValue(body.patch) ?? stringValue(body.diff);
  const kind = nativeKind(body.type ?? body.status);
  const additions = count(body.additions);
  const deletions = count(body.deletions);
  const newPath = openCodeText(body.newPath) ?? openCodeText(body.movePath);
  const normalizedKind = kind === 'unknown' ? fallbackKind : kind;
  return {
    path,
    kind: newPath ? 'move' : normalizedKind,
    ...(newPath ? { newPath } : {}),
    ...(patch !== undefined
      ? {
          details: [
            {
              representation: 'diff-preview' as const,
              basis: 'tool-result' as const,
              text: patch,
              completeness: 'complete' as const,
            },
          ],
        }
      : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

function mergeInputDetail(change: WorkspaceFileChange, inputs: readonly WorkspaceFileChange[]): WorkspaceFileChange {
  const input = inputs.find((candidate) => candidate.path === change.path);
  if (!input?.details?.length) return change;
  return {
    ...change,
    details: [...input.details, ...(change.details ?? [])],
  };
}

function metadataChanges(
  tool: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): WorkspaceFileChange[] {
  if (!metadata) return [];
  const fromInput = inputChanges(tool, input);
  if (Array.isArray(metadata.files)) {
    return metadata.files
      .map((file) => patchChange(file, 'unknown'))
      .filter((change): change is WorkspaceFileChange => change !== undefined)
      .map((change) => mergeInputDetail(change, fromInput));
  }
  const fileDiff = patchChange(metadata.filediff, tool === 'edit' ? 'modify' : 'unknown');
  if (fileDiff) return [mergeInputDetail(fileDiff, fromInput)];

  const path = openCodeText(metadata.filepath) ?? openCodeText(input?.filePath);
  if (!path) return [];
  const exists = typeof metadata.exists === 'boolean' ? metadata.exists : undefined;
  const inputChange = fromInput.find((change) => change.path === path);
  return [
    {
      path,
      kind: exists === false ? 'create' : exists === true ? 'modify' : 'unknown',
      ...(inputChange?.details ? { details: inputChange.details } : {}),
    },
  ];
}

function inputChanges(tool: string, input: Record<string, unknown> | undefined): WorkspaceFileChange[] {
  if (!input) return [];
  const path = openCodeText(input.filePath) ?? openCodeText(input.path);
  if (!path) return [];
  if (tool === 'write') {
    const content = stringValue(input.content);
    return [
      {
        path,
        kind: 'unknown',
        ...(content !== undefined
          ? {
              details: [
                {
                  representation: 'write' as const,
                  basis: 'tool-input' as const,
                  content,
                  mode: 'overwrite' as const,
                },
              ],
            }
          : {}),
      },
    ];
  }
  if (tool !== 'edit') return [];
  const oldText = stringValue(input.oldString);
  const newText = stringValue(input.newString);
  return [
    {
      path,
      kind: 'modify',
      ...(oldText !== undefined && newText !== undefined
        ? {
            details: [
              {
                representation: 'replacement' as const,
                basis: 'tool-input' as const,
                oldText,
                newText,
                ...(typeof input.replaceAll === 'boolean' ? { replaceAll: input.replaceAll } : {}),
              },
            ],
          }
        : {}),
    },
  ];
}

/** OpenCode tool parts and file watcher records -> Core workspace events. */
export class OpenCodeWorkspaceNormalizer {
  private readonly operationFingerprints = new Map<string, string>();

  constructor(private readonly maximum: number) {}

  normalizeToolPart(part: Record<string, unknown>): WorkspaceEvent | undefined {
    const toolCallId = openCodeText(part.callID);
    const tool = openCodeText(part.tool)?.toLowerCase();
    const state = isOpenCodeRecord(part.state) ? part.state : undefined;
    const status = openCodeText(state?.status);
    if (!toolCallId || !tool || !MUTATING_TOOLS.has(tool) || !state || !status) return undefined;

    const phase =
      status === 'pending'
        ? 'proposed'
        : status === 'running'
          ? 'in-progress'
          : status === 'completed'
            ? 'applied'
            : status === 'error'
              ? 'failed'
              : undefined;
    if (!phase) return undefined;

    const input = isOpenCodeRecord(state.input) ? state.input : undefined;
    const metadata = isOpenCodeRecord(state.metadata) ? state.metadata : undefined;
    const fromMetadata = metadataChanges(tool, input, metadata);
    const changes = fromMetadata.length > 0 ? fromMetadata : inputChanges(tool, input);
    if (changes.length === 0) return undefined;
    const event: WorkspaceEvent = {
      type: 'workspace:file-operation',
      toolCallId,
      phase,
      changes,
    };
    const fingerprint = JSON.stringify(event);
    if (this.operationFingerprints.get(toolCallId) === fingerprint) return undefined;
    boundedOpenCodeMapSet(this.operationFingerprints, toolCallId, fingerprint, this.maximum);
    return event;
  }

  normalizeFileWatcher(record: OpenCodeSseRecord): WorkspaceEvent | undefined {
    if (record.type !== 'file.watcher.updated') return undefined;
    const path = openCodeText(record.properties.file);
    if (!path) return undefined;
    return {
      type: 'workspace:file-changed',
      changes: [{ path, kind: nativeKind(record.properties.event) }],
    };
  }
}
