import { randomUUID } from 'node:crypto';
import type { ExternalRef, NativeSessionRef, RuntimeRunId } from '@vibecook/puppeteer-core';

export const MAX_CREATION_REQUEST_ID_BYTES = 256;
export const MAX_EXTERNAL_REFS = 32;
export const MAX_EXTERNAL_REF_NAMESPACE_BYTES = 64;
export const MAX_EXTERNAL_REF_KIND_BYTES = 64;
export const MAX_EXTERNAL_REF_ID_BYTES = 256;

export type RuntimeCreationOperation = 'create' | 'prepare';

export interface RuntimeRunIdentity {
  readonly runtimeRunId: RuntimeRunId;
  readonly runtimeEpoch: number;
  readonly providerId: string;
  readonly externalRefs: readonly ExternalRef[];
  readonly creationRequestId?: string;
}

export interface RevisionedNativeSessionClaim {
  readonly revision: number;
  readonly value: NativeSessionRef;
}

export type RuntimeIdentityErrorCode =
  'INVALID_CREATION_REQUEST_ID' | 'INVALID_EXTERNAL_REFS' | 'CREATION_REQUEST_NOT_FINGERPRINTABLE';

export class RuntimeIdentityError extends Error {
  constructor(
    readonly code: RuntimeIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeIdentityError';
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertBoundedString(value: unknown, label: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > maxBytes) {
    throw new RuntimeIdentityError(
      label === 'creationRequestId' ? 'INVALID_CREATION_REQUEST_ID' : 'INVALID_EXTERNAL_REFS',
      `${label} must be a non-empty string of at most ${maxBytes} UTF-8 bytes`,
    );
  }
}

export function validateCreationRequestId(creationRequestId: string): string {
  assertBoundedString(creationRequestId, 'creationRequestId', MAX_CREATION_REQUEST_ID_BYTES);
  return creationRequestId;
}

export function validateExternalRefs(externalRefs: readonly ExternalRef[] | undefined): ExternalRef[] {
  if (externalRefs === undefined) return [];
  if (!Array.isArray(externalRefs) || externalRefs.length > MAX_EXTERNAL_REFS) {
    throw new RuntimeIdentityError(
      'INVALID_EXTERNAL_REFS',
      `externalRefs must contain at most ${MAX_EXTERNAL_REFS} entries`,
    );
  }

  return externalRefs.map((ref, index) => {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
      throw new RuntimeIdentityError('INVALID_EXTERNAL_REFS', `externalRefs[${index}] must be an object`);
    }
    assertBoundedString(ref.namespace, `externalRefs[${index}].namespace`, MAX_EXTERNAL_REF_NAMESPACE_BYTES);
    assertBoundedString(ref.kind, `externalRefs[${index}].kind`, MAX_EXTERNAL_REF_KIND_BYTES);
    assertBoundedString(ref.id, `externalRefs[${index}].id`, MAX_EXTERNAL_REF_ID_BYTES);
    if (!['project', 'contributor', 'workflow', 'caller', 'other'].includes(ref.kind)) {
      throw new RuntimeIdentityError('INVALID_EXTERNAL_REFS', `externalRefs[${index}].kind is not supported`);
    }
    return { namespace: ref.namespace, kind: ref.kind, id: ref.id };
  });
}

export function allocateRuntimeRunIdentity(input: {
  providerId: string;
  creationRequestId?: string;
  externalRefs?: readonly ExternalRef[];
  runtimeRunId?: RuntimeRunId;
  runtimeEpoch?: number;
}): RuntimeRunIdentity {
  const creationRequestId =
    input.creationRequestId === undefined ? undefined : validateCreationRequestId(input.creationRequestId);
  const runtimeEpoch = input.runtimeEpoch ?? 1;
  if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 1) {
    throw new RangeError('runtimeEpoch must be a positive safe integer');
  }
  return {
    runtimeRunId: input.runtimeRunId ?? randomUUID(),
    runtimeEpoch,
    providerId: input.providerId,
    externalRefs: validateExternalRefs(input.externalRefs),
    ...(creationRequestId === undefined ? {} : { creationRequestId }),
  };
}

function fingerprintFailure(path: string, detail: string): never {
  throw new RuntimeIdentityError(
    'CREATION_REQUEST_NOT_FINGERPRINTABLE',
    `idempotent creation requires JSON-plain options; ${path} ${detail}`,
  );
}

function canonicalJson(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) fingerprintFailure(path, 'must be a finite number');
      return JSON.stringify(value);
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      return fingerprintFailure(path, `cannot contain ${typeof value}`);
    case 'object':
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) fingerprintFailure(path, 'cannot contain a cycle');
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => canonicalJson(entry, `${path}[${index}]`, ancestors)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      fingerprintFailure(path, 'must contain only plain objects');
    if (Object.getOwnPropertySymbols(value).length > 0) fingerprintFailure(path, 'cannot contain symbol keys');

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const entries = keys.map((key) => {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) fingerprintFailure(`${path}.${key}`, 'must be enumerable');
      if (!('value' in descriptor)) fingerprintFailure(`${path}.${key}`, 'cannot be an accessor');
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, `${path}.${key}`, ancestors)}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Canonicalizes creation identity without hashing it. The returned material is
 * ephemeral and must only be passed to a creation registry, which applies its
 * per-install keyed digest before persistence.
 */
export function canonicalizeCreationFingerprint(value: unknown): string {
  return canonicalJson(value, '$', new Set());
}

export function createNativeSessionClaim(
  namespace: string,
  id: string,
  basis: NativeSessionRef['basis'] = 'observed',
): RevisionedNativeSessionClaim {
  return { revision: 1, value: { namespace, id, basis, quality: 'exact' } };
}

export function reviseNativeSessionClaim(
  current: RevisionedNativeSessionClaim,
  next: NativeSessionRef,
): RevisionedNativeSessionClaim {
  if (
    current.value.namespace === next.namespace &&
    current.value.id === next.id &&
    current.value.basis === next.basis &&
    current.value.quality === next.quality
  ) {
    return current;
  }
  return { revision: current.revision + 1, value: { ...next } };
}
