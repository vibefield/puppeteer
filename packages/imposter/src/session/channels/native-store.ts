/**
 * Vendor-native durable session files.
 *
 * Grok exposes an append-only `updates.jsonl` rail beside replace-in-place
 * JSON state files. The mechanics are reusable; the directory layout and file
 * names remain persona data. The root is selected by session assembly; managed
 * adapter recipes give every Imposter composition a private shared root, while
 * an explicitly supplied persona-native root is honored for faithful resume.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  const directory = (): string => resolveNativeSessionDirectory(root, document, bindings);
  const updatesPath = (): string => {
    const base = directory();
    const components = document.updatesPath
      ? safePathComponents(document.updatesPath.map((component) => String(substitute(component, { bindings }))))
      : [safeFileName(document.updatesFile ?? '')];
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
      const envelope = flat
        ? {
            ...params,
            type: method,
            ...(method === 'metadata' || params.time !== undefined ? {} : { time: Date.now() }),
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
      // Kimi journals have one immutable metadata header. A resumed Imposter
      // session may replay the boot op, but it must not append a second header.
      if (flat && method === 'metadata' && existsSync(updatesPath()) && statSync(updatesPath()).size > 0) return;
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
            if (typeof record.type !== 'string') {
              throw new Error(`imposter native store record ${path}:${index + 1} has an invalid flat envelope`);
            }
            const { type, time, created_at: createdAt, ...params } = record;
            const timestamp = typeof time === 'number' ? time : typeof createdAt === 'number' ? createdAt : 0;
            return { timestamp, method: type, params };
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
