/**
 * Serialized, best-effort JSONL writer for Puppeteer-owned evidence.
 * V2 records are logically idempotent by stable recordId; v1 remains readable.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { OwnAction, OwnActionInput, OwnActionRecord, TaggedOwnActionRecord } from './actions.js';
import {
  OWN_ACTION_SCHEMA_VERSION,
  MAX_PERSISTED_PROMPT_BODY_BYTES,
  isOwnActionV2,
  normalizeOwnActionV2Input,
  type InjectionReceiptActionV2Input,
  type OwnActionV2,
  type OwnActionV2Input,
} from './actions-v2.js';

const DEFAULT_PATH = path.join(homedir(), '.puppeteer', 'own-actions.jsonl');

export type InjectionPersistencePolicy =
  { mode: 'metadata-only' } | { mode: 'keyed-digest'; key: Uint8Array } | { mode: 'body'; maxBytes: number };

export interface ActionRecorderStatus {
  readiness: 'ready' | 'degraded';
  failureCount: number;
  lastFailureAt?: string;
  lastError?: string;
}

export interface ActionRecorderOptions {
  /** Override the log path (tests). Default ~/.puppeteer/own-actions.jsonl. */
  path?: string;
  onError?: (error: Error) => void;
  onStatus?: (status: ActionRecorderStatus) => void;
  /** Injectable clock for deterministic tests; default () => new Date(). */
  now?: () => Date;
  /** Prompt bodies are excluded unless an explicit non-default policy is supplied. */
  injectionPersistence?: InjectionPersistencePolicy;
  /** Private per-install HMAC key; defaults beside the action log as installation.key. */
  installationKeyPath?: string;
}

export interface ActionRecordWriteResult {
  status: 'appended' | 'duplicate' | 'failed';
  recordId: string;
}

export interface ActionRecorder {
  readonly path: string;
  /** Legacy v1 append retained for compatibility callers. */
  record(action: OwnActionInput): Promise<void>;
  recordV2(action: OwnActionV2Input): Promise<ActionRecordWriteResult>;
  recordInjection(action: InjectionReceiptActionV2Input): Promise<ActionRecordWriteResult>;
  /** Domain-separated, per-install HMAC for privacy-safe durable joins. Raw key material never leaves the recorder. */
  keyedDigest(namespace: string, canonicalValue: string): Promise<string>;
  /** Mixed v1/v2 logical view; v2 duplicate IDs are collapsed to their first record. */
  read(): Promise<OwnActionRecord[]>;
  readTagged(): Promise<TaggedOwnActionRecord[]>;
  status(): ActionRecorderStatus;
  onStatus(listener: (status: ActionRecorderStatus) => void): () => void;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function cloneStatus(status: ActionRecorderStatus): ActionRecorderStatus {
  return { ...status };
}

function semanticRecord(record: OwnActionV2): string {
  const { observedAt: _observedAt, ...semantic } = record;
  return JSON.stringify(semantic);
}

function parseLegacyAction(value: unknown): OwnAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('legacy own-action line must be an object');
  }
  const action = value as Partial<OwnAction>;
  if (
    typeof action.ts !== 'string' ||
    typeof action.sessionId !== 'string' ||
    !['injection', 'workspace-final', 'session-exit', 'policy-conflict'].includes(action.type ?? '')
  ) {
    throw new TypeError('legacy own-action line failed validation');
  }
  return value as OwnAction;
}

export function createActionRecorder(options: ActionRecorderOptions = {}): ActionRecorder {
  const filePath = options.path ?? DEFAULT_PATH;
  const installationKeyPath = options.installationKeyPath ?? path.join(path.dirname(filePath), 'installation.key');
  if (path.resolve(installationKeyPath) === path.resolve(filePath)) {
    throw new RangeError('installationKeyPath must differ from the action log path');
  }
  const now = options.now ?? (() => new Date());
  const configuredInjectionPolicy = options.injectionPersistence ?? { mode: 'metadata-only' as const };
  const injectionPolicy: InjectionPersistencePolicy =
    configuredInjectionPolicy.mode === 'keyed-digest'
      ? { mode: 'keyed-digest', key: new Uint8Array(configuredInjectionPolicy.key) }
      : { ...configuredInjectionPolicy };
  if (injectionPolicy.mode === 'keyed-digest' && injectionPolicy.key.byteLength < 32) {
    throw new RangeError('keyed-digest injection persistence requires at least 32 bytes of per-install key material');
  }
  if (
    injectionPolicy.mode === 'body' &&
    (!Number.isSafeInteger(injectionPolicy.maxBytes) ||
      injectionPolicy.maxBytes < 0 ||
      injectionPolicy.maxBytes > MAX_PERSISTED_PROMPT_BODY_BYTES)
  ) {
    throw new RangeError(
      `body injection persistence maxBytes must be between 0 and ${MAX_PERSISTED_PROMPT_BODY_BYTES}`,
    );
  }

  let dirReady = false;
  let installationKeyPromise: Promise<Buffer> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let knownV2Records: Promise<Map<string, string>> | undefined;
  let recorderStatus: ActionRecorderStatus = { readiness: 'ready', failureCount: 0 };
  const statusListeners = new Set<(status: ActionRecorderStatus) => void>();

  function publishStatus(): void {
    const snapshot = cloneStatus(recorderStatus);
    try {
      options.onStatus?.(snapshot);
    } catch {
      // Diagnostics must not break recording.
    }
    for (const listener of statusListeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener faults stay outside the evidence path.
      }
    }
  }

  function reportFailure(error: unknown): Error {
    const normalized = error instanceof Error ? error : new Error(String(error));
    recorderStatus = {
      readiness: 'degraded',
      failureCount: recorderStatus.failureCount + 1,
      lastFailureAt: now().toISOString(),
      lastError: normalized.message,
    };
    try {
      options.onError?.(normalized);
    } catch {
      // Error callbacks cannot wedge the append queue.
    }
    publishStatus();
    return normalized;
  }

  async function syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function installationKey(): Promise<Buffer> {
    if (installationKeyPromise) return installationKeyPromise;
    installationKeyPromise = (async () => {
      const directory = path.dirname(installationKeyPath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = path.join(
        directory,
        `.${path.basename(installationKeyPath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      const proposed = `${randomBytes(32).toString('base64')}\n`;
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(proposed, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryPath, installationKeyPath);
        await syncDirectory(directory);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      const metadata = await stat(installationKeyPath);
      if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
        throw new Error(`installation key must not be accessible by group or other users: ${installationKeyPath}`);
      }
      const encoded = (await readFile(installationKeyPath, 'utf8')).trim();
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) {
        throw new Error(`installation key is invalid: ${installationKeyPath}`);
      }
      return key;
    })().catch((error) => {
      installationKeyPromise = undefined;
      throw reportFailure(error);
    });
    return installationKeyPromise;
  }

  async function append(action: OwnActionRecord): Promise<void> {
    if (!dirReady) {
      await mkdir(path.dirname(filePath), { recursive: true });
      dirReady = true;
    }
    await appendFile(filePath, `${JSON.stringify(action)}\n`, 'utf8');
  }

  async function readContents(): Promise<string> {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return '';
      throw error;
    }
  }

  function parseV2(value: unknown): OwnActionV2 {
    if (!isOwnActionV2(value)) throw new TypeError('v2 own-action line failed envelope validation');
    return normalizeOwnActionV2Input(value as OwnActionV2Input, value.observedAt, {
      allowInjectionContent: true,
    });
  }

  function parseLine(line: string): OwnActionRecord {
    const value = JSON.parse(line) as unknown;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { schemaVersion?: unknown }).schemaVersion === OWN_ACTION_SCHEMA_VERSION
    ) {
      return parseV2(value);
    }
    return parseLegacyAction(value);
  }

  async function loadKnownV2Records(): Promise<Map<string, string>> {
    if (knownV2Records) return knownV2Records;
    knownV2Records = (async () => {
      const known = new Map<string, string>();
      const contents = await readContents();
      for (const line of contents.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          const record = parseLine(line);
          if (isOwnActionV2(record)) {
            const semantic = semanticRecord(record);
            const existing = known.get(record.recordId);
            if (existing === undefined) known.set(record.recordId, semantic);
            else if (existing !== semantic) {
              reportFailure(new Error(`conflicting physical own-action records: ${record.recordId}`));
            }
          }
        } catch (error) {
          reportFailure(error);
        }
      }
      return known;
    })().catch((error) => {
      knownV2Records = undefined;
      throw error;
    });
    return knownV2Records;
  }

  function enqueue<T>(operation: () => Promise<T>, failure: () => T): Promise<T> {
    const pending = chain.then(operation);
    const settled = pending.catch((error) => {
      reportFailure(error);
      return failure();
    });
    chain = settled.then(() => undefined);
    return settled;
  }

  function appendV2(input: OwnActionV2Input, allowInjectionContent = false): Promise<ActionRecordWriteResult> {
    return enqueue<ActionRecordWriteResult>(
      async () => {
        const record = normalizeOwnActionV2Input(input, now().toISOString(), { allowInjectionContent });
        const known = await loadKnownV2Records();
        const semantic = semanticRecord(record);
        const existing = known.get(record.recordId);
        if (existing !== undefined) {
          if (existing !== semantic) throw new Error(`own-action recordId conflict: ${record.recordId}`);
          return { status: 'duplicate', recordId: record.recordId } as const;
        }
        await append(record);
        known.set(record.recordId, semantic);
        return { status: 'appended', recordId: record.recordId } as const;
      },
      () => ({ status: 'failed', recordId: input.recordId }),
    );
  }

  async function logicalRead(): Promise<OwnActionRecord[]> {
    await chain;
    let contents: string;
    try {
      contents = await readContents();
    } catch (error) {
      reportFailure(error);
      return [];
    }
    const records: OwnActionRecord[] = [];
    const v2 = new Map<string, string>();
    for (const line of contents.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const record = parseLine(line);
        if (!isOwnActionV2(record)) {
          records.push(record);
          continue;
        }
        const semantic = semanticRecord(record);
        const existing = v2.get(record.recordId);
        if (existing === undefined) {
          v2.set(record.recordId, semantic);
          records.push(record);
        } else if (existing !== semantic) {
          reportFailure(new Error(`conflicting physical own-action records: ${record.recordId}`));
        }
      } catch (error) {
        reportFailure(error);
      }
    }
    return records;
  }

  return {
    path: filePath,

    async keyedDigest(namespace, canonicalValue) {
      if (namespace.length === 0 || Buffer.byteLength(namespace, 'utf8') > 128 || /[\0\r\n]/.test(namespace)) {
        throw new TypeError('digest namespace must be a bounded single-line value');
      }
      if (Buffer.byteLength(canonicalValue, 'utf8') > 16 * 1024 * 1024) {
        throw new RangeError('canonical digest value exceeds 16 MiB');
      }
      const key = await installationKey();
      return createHmac('sha256', key)
        .update('puppeteer-own-action-v2\0')
        .update(namespace)
        .update('\0')
        .update(canonicalValue)
        .digest('hex');
    },

    record(input: OwnActionInput): Promise<void> {
      const action = { ts: now().toISOString(), ...input } as OwnAction;
      return enqueue(
        async () => append(action),
        () => undefined,
      );
    },

    recordV2(input: OwnActionV2Input): Promise<ActionRecordWriteResult> {
      return appendV2(input);
    },

    recordInjection(input: InjectionReceiptActionV2Input): Promise<ActionRecordWriteResult> {
      const { prompt, ...base } = input;
      const promptByteLength = Buffer.byteLength(prompt, 'utf8');
      let persistence: Pick<
        OwnActionV2 & { type: 'injection.receipt' },
        'promptPersistence' | 'promptDigest' | 'promptBody'
      >;
      switch (injectionPolicy.mode) {
        case 'metadata-only':
          persistence = { promptPersistence: 'metadata-only' };
          break;
        case 'keyed-digest':
          persistence = {
            promptPersistence: 'keyed-digest',
            promptDigest: {
              algorithm: 'hmac-sha256',
              value: createHmac('sha256', injectionPolicy.key).update(prompt).digest('hex'),
            },
          };
          break;
        case 'body':
          persistence =
            promptByteLength <= injectionPolicy.maxBytes
              ? { promptPersistence: 'body', promptBody: prompt }
              : { promptPersistence: 'body-too-large' };
          break;
      }
      return appendV2(
        {
          ...base,
          type: 'injection.receipt',
          promptByteLength,
          ...persistence,
          ...(persistence.promptPersistence === 'body-too-large' ? { completeness: 'partial' } : {}),
        },
        true,
      );
    },

    read: logicalRead,

    async readTagged(): Promise<TaggedOwnActionRecord[]> {
      return (await logicalRead()).map((record) =>
        isOwnActionV2(record) ? { version: 'v2', record } : { version: 'v1', record },
      );
    },

    status: () => cloneStatus(recorderStatus),

    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}
