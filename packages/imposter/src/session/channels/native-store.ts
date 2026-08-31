/**
 * Vendor-native durable session files.
 *
 * Grok exposes an append-only `updates.jsonl` rail beside replace-in-place
 * JSON state files. The mechanics are reusable; the directory layout and file
 * names remain persona data. The root is selected by session assembly; managed
 * adapter recipes give every Imposter composition a private shared root, while
 * an explicitly supplied persona-native root is honored for faithful resume.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { NativeStoreDocument } from '../../persona/types.ts';
import { substitute } from '../template.ts';

export interface NativeSessionStore {
  readonly directory: string;
  readonly updatesPath: string;
  readonly indexPath?: string;
  append(method: string, params: Record<string, unknown>): void;
  appendIndex(payload: Record<string, unknown>): void;
  write(name: string, payload: Record<string, unknown>): void;
  exists(): boolean;
  readUpdates(): Array<{ timestamp: number; method: string; params: Record<string, unknown> }>;
  read(name: string): Record<string, unknown> | undefined;
}

export interface NativeSessionStoreOptions {
  validateRecord?(method: string, record: Record<string, unknown>): string[];
}

function safeComponent(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`imposter native store refused unsafe path component ${JSON.stringify(value)}`);
  }
  return value;
}

function safeFileName(value: string): string {
  if (!value || value === '.' || value === '..' || basename(value) !== value || value.includes(sep)) {
    throw new Error(`imposter native store refused unsafe filename ${JSON.stringify(value)}`);
  }
  return value;
}

function safePathComponents(values: readonly string[]): string[] {
  return values.map((value) => safeComponent(value));
}

export function resolveNativeSessionDirectory(
  root: string,
  document: NativeStoreDocument,
  bindings: Record<string, unknown>,
): string {
  const components = document.sessionPath.map((component) => safeComponent(substitute(component, { bindings })));
  const directory = resolve(root, ...components);
  const safeRoot = resolve(root);
  if (directory !== safeRoot && !directory.startsWith(`${safeRoot}${sep}`)) {
    throw new Error('imposter native store path escaped its isolated root');
  }
  return directory;
}

export function createNativeSessionStore(
  root: string,
  document: NativeStoreDocument,
  bindings: Record<string, unknown>,
  options: NativeSessionStoreOptions = {},
): NativeSessionStore {
  interface JournalState {
    methods: Set<string>;
    nextSequence: number;
    previousRecordId?: string;
  }
  const journalStates = new Map<string, JournalState>();
  const directory = (): string => resolveNativeSessionDirectory(root, document, bindings);
  const updatesPath = (): string => {
    const base = directory();
    const components = document.updatesPath
      ? safePathComponents(document.updatesPath.map((component) => String(substitute(component, { bindings }))))
      : [safeFileName(String(substitute(document.updatesFile ?? '', { bindings })))];
    const path = resolve(base, ...components);
    if (!path.startsWith(`${resolve(base)}${sep}`)) {
      throw new Error('imposter native store updates path escaped its session');
    }
    return path;
  };
  const indexPath = (): string | undefined => {
    if (!document.indexPath) return undefined;
    const base = resolve(root);
    const components = safePathComponents(
      document.indexPath.map((component) => String(substitute(component, { bindings }))),
    );
    const path = resolve(base, ...components);
    if (!path.startsWith(`${base}${sep}`)) {
      throw new Error('imposter native store index path escaped its isolated root');
    }
    return path;
  };
  const ready = (): string => {
    const path = directory();
    mkdirSync(path, { recursive: true });
    return path;
  };
  const journalState = (): JournalState => {
    const path = updatesPath();
    const existing = journalStates.get(path);
    if (existing) return existing;
    const state: JournalState = {
      methods: new Set(),
      nextSequence: document.recordSequence?.start ?? 0,
    };
    if (existsSync(path)) {
      const typeField = document.recordTypeField ?? 'type';
      for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/u).entries()) {
        if (line.trim().length === 0) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `imposter native store cannot continue ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (record === null || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error(`imposter native store cannot continue ${path}:${index + 1}: record must be an object`);
        }
        const carrier = record as Record<string, unknown>;
        if (typeof carrier[typeField] === 'string') state.methods.add(carrier[typeField]);
        const sequenceField = document.recordSequence?.field;
        const ordinal = sequenceField === undefined ? undefined : carrier[sequenceField];
        if (typeof ordinal === 'number' && Number.isInteger(ordinal)) {
          state.nextSequence = Math.max(state.nextSequence, ordinal + 1);
        }
        const idField = document.recordIdentity?.idField;
        const id = idField === undefined ? undefined : carrier[idField];
        if (typeof id === 'string') state.previousRecordId = id;
      }
    }
    journalStates.set(path, state);
    return state;
  };

  return {
    get directory() {
      return directory();
    },
    get updatesPath() {
      return updatesPath();
    },
    get indexPath() {
      return indexPath();
    },
    append(method, params) {
      const flat = document.recordFormat === 'flat-record';
      const state = journalState();
      if (flat && document.singletonEvents?.includes(method) && state.methods.has(method)) return;
      const automatic: Record<string, unknown> = {};
      if (flat && document.recordTimestamp && !document.recordTimestamp.omitFor?.includes(method)) {
        automatic[document.recordTimestamp.field] =
          document.recordTimestamp.format === 'iso' ? new Date().toISOString() : Date.now();
      }
      if (flat && document.recordSequence) {
        automatic[document.recordSequence.field] = state.nextSequence;
      }
      if (flat && document.recordIdentity) {
        automatic[document.recordIdentity.idField] = crypto.randomUUID();
        if (document.recordIdentity.parentField && !document.recordIdentity.omitParentFor?.includes(method)) {
          automatic[document.recordIdentity.parentField] = state.previousRecordId ?? null;
        }
      }
      const typeField = document.recordTypeField ?? 'type';
      const payload = document.recordPayloadField ? { [document.recordPayloadField]: params } : params;
      const envelope: Record<string, unknown> = flat
        ? {
            ...automatic,
            ...payload,
            [typeField]: method,
            ...(!document.recordTimestamp && method !== 'metadata' && params.time === undefined
              ? { time: Date.now() }
              : {}),
          }
        : {
            // Grok's persisted envelope uses Unix epoch milliseconds. Keep this
            // distinct from `_meta.agentTimestampMs`: both are independently
            // present in real captures and consumers use the outer value while
            // replaying records that do not carry metadata.
            timestamp: Date.now(),
            method,
            params,
          };
      const violations = options.validateRecord?.(method, envelope) ?? [];
      if (violations.length > 0) {
        throw new Error(`imposter refused an off-model native record for ${method}: ${violations.join('; ')}`);
      }
      state.methods.add(method);
      if (flat && document.recordSequence) {
        const ordinal = envelope[document.recordSequence.field];
        state.nextSequence =
          typeof ordinal === 'number' && Number.isInteger(ordinal)
            ? Math.max(state.nextSequence, ordinal + 1)
            : state.nextSequence + 1;
      }
      if (flat && document.recordIdentity) {
        const id = envelope[document.recordIdentity.idField];
        if (typeof id === 'string') state.previousRecordId = id;
      }
      ready();
      mkdirSync(dirname(updatesPath()), { recursive: true });
      appendFileSync(updatesPath(), `${JSON.stringify(envelope)}\n`, 'utf8');
    },
    appendIndex(payload) {
      const path = indexPath();
      if (!path) throw new Error('imposter native store has no index path configured');
      const line = JSON.stringify(payload);
      // Re-entering an existing session must not add the same immutable index
      // fact again. A changed record is still appended, preserving the
      // last-writer-wins behavior of an append-only native index.
      if (
        existsSync(path) &&
        readFileSync(path, 'utf8')
          .split(/\r?\n/)
          .some((existing) => existing === line)
      ) {
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`, 'utf8');
    },
    write(name, payload) {
      const path = ready();
      writeFileSync(join(path, safeFileName(name)), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    },
    exists() {
      return existsSync(directory());
    },
    readUpdates() {
      const path = updatesPath();
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch (error) {
            throw new Error(
              `imposter native store cannot parse ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`imposter native store record ${path}:${index + 1} must be an object`);
          }
          const record = value as Record<string, unknown>;
          if (document.recordFormat === 'flat-record') {
            const typeField = document.recordTypeField ?? 'type';
            if (typeof record[typeField] !== 'string') {
              throw new Error(`imposter native store record ${path}:${index + 1} has an invalid flat envelope`);
            }
            const method = record[typeField] as string;
            const timestampField = document.recordTimestamp?.field;
            const rawTimestamp = timestampField ? record[timestampField] : (record.time ?? record.created_at);
            const timestamp =
              typeof rawTimestamp === 'number'
                ? rawTimestamp
                : typeof rawTimestamp === 'string'
                  ? Date.parse(rawTimestamp) || 0
                  : 0;
            const nestedPayload =
              document.recordPayloadField === undefined ? undefined : record[document.recordPayloadField];
            if (
              document.recordPayloadField !== undefined &&
              (nestedPayload === null || typeof nestedPayload !== 'object' || Array.isArray(nestedPayload))
            ) {
              throw new Error(`imposter native store record ${path}:${index + 1} has an invalid payload field`);
            }
            const params =
              document.recordPayloadField === undefined
                ? Object.fromEntries(Object.entries(record).filter(([name]) => name !== typeField))
                : (nestedPayload as Record<string, unknown>);
            return { timestamp, method, params };
          }
          if (
            typeof record.timestamp !== 'number' ||
            typeof record.method !== 'string' ||
            record.params === null ||
            typeof record.params !== 'object' ||
            Array.isArray(record.params)
          ) {
            throw new Error(`imposter native store record ${path}:${index + 1} has an invalid envelope`);
          }
          return {
            timestamp: record.timestamp,
            method: record.method,
            params: record.params as Record<string, unknown>,
          };
        });
    },
    read(name) {
      const path = join(directory(), safeFileName(name));
      if (!existsSync(path)) return undefined;
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`imposter native store state ${path} must be an object`);
      }
      return value as Record<string, unknown>;
    },
  };
}
