import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RuntimeRunId } from '@vibecook/chopsticks-core';
import { validateCreationRequestId, type RuntimeCreationOperation } from './identity.js';

const CLAIM_SCHEMA_VERSION = 1 as const;
const MAX_CLAIM_BYTES = 16 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const MAX_LOCK_BYTES = 4 * 1024;

export type CreationRequestTerminalOutcome =
  { kind: 'failed'; code: string } | { kind: 'closed'; reason: string } | { kind: 'cancelled' };

/** Non-secret evidence bridge to the immutable allocation claim on disk. */
export interface CreationRequestClaimRef {
  readonly claimId: string;
  readonly requestFingerprint: string;
}

export interface CreationRequestClaim {
  readonly ref: CreationRequestClaimRef;
  readonly runtimeRunId: RuntimeRunId;
  readonly runtimeEpoch: number;
  readonly operation: RuntimeCreationOperation;
  readonly state: 'allocated' | 'terminal';
  readonly terminalOutcome?: CreationRequestTerminalOutcome;
}

export interface ClaimCreationRequestInput {
  /** Raw only at the registry boundary; implementations must persist a keyed digest instead. */
  creationRequestId: string;
  /** Canonical but potentially sensitive; implementations must persist a keyed digest instead. */
  canonicalFingerprint: string;
  proposedRuntimeRunId: RuntimeRunId;
  operation: RuntimeCreationOperation;
}

export type ClaimCreationRequestResult =
  { status: 'created' | 'existing'; claim: CreationRequestClaim } | { status: 'conflict'; claim: CreationRequestClaim };

export interface CreationRequestRegistry {
  claim(input: ClaimCreationRequestInput): Promise<ClaimCreationRequestResult>;
  markTerminal(input: {
    creationRequestId: string;
    runtimeRunId: RuntimeRunId;
    runtimeEpoch: number;
    outcome: CreationRequestTerminalOutcome;
  }): Promise<{ applied: boolean; claim: CreationRequestClaim }>;
  incrementRuntimeEpoch(input: {
    creationRequestId: string;
    runtimeRunId: RuntimeRunId;
    expectedRuntimeEpoch: number;
  }): Promise<{ advanced: boolean; claim: CreationRequestClaim }>;
}

export class CreationRequestRegistryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CreationRequestRegistryError';
  }
}

interface StoredClaim {
  schemaVersion: typeof CLAIM_SCHEMA_VERSION;
  requestDigest: string;
  requestFingerprint: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  operation: RuntimeCreationOperation;
  state: 'allocated' | 'terminal';
  terminalOutcome?: CreationRequestTerminalOutcome;
}

function validateTerminalOutcome(value: unknown): CreationRequestTerminalOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CreationRequestRegistryError('creation request terminal outcome has an invalid shape');
  }
  const outcome = value as Partial<CreationRequestTerminalOutcome>;
  if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
  if (
    outcome.kind === 'failed' &&
    typeof outcome.code === 'string' &&
    outcome.code.length > 0 &&
    Buffer.byteLength(outcome.code, 'utf8') <= 128
  ) {
    return { kind: 'failed', code: outcome.code };
  }
  if (
    outcome.kind === 'closed' &&
    typeof outcome.reason === 'string' &&
    outcome.reason.length > 0 &&
    Buffer.byteLength(outcome.reason, 'utf8') <= 256
  ) {
    return { kind: 'closed', reason: outcome.reason };
  }
  throw new CreationRequestRegistryError('creation request terminal outcome failed validation');
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function publicClaim(claim: StoredClaim): CreationRequestClaim {
  return {
    ref: {
      claimId: claim.requestDigest,
      requestFingerprint: claim.requestFingerprint,
    },
    runtimeRunId: claim.runtimeRunId,
    runtimeEpoch: claim.runtimeEpoch,
    operation: claim.operation,
    state: claim.state,
    ...(claim.terminalOutcome ? { terminalOutcome: claim.terminalOutcome } : {}),
  };
}

function parseStoredClaim(contents: string, expectedRequestDigest: string): StoredClaim {
  if (Buffer.byteLength(contents, 'utf8') > MAX_CLAIM_BYTES) {
    throw new CreationRequestRegistryError('creation request claim exceeds the maximum supported size');
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    throw new CreationRequestRegistryError('creation request claim is not valid JSON', { cause });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CreationRequestRegistryError('creation request claim has an invalid shape');
  }
  const claim = value as Partial<StoredClaim>;
  if (
    claim.schemaVersion !== CLAIM_SCHEMA_VERSION ||
    claim.requestDigest !== expectedRequestDigest ||
    typeof claim.requestFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(claim.requestFingerprint) ||
    typeof claim.runtimeRunId !== 'string' ||
    claim.runtimeRunId.length === 0 ||
    Buffer.byteLength(claim.runtimeRunId, 'utf8') > 256 ||
    !Number.isSafeInteger(claim.runtimeEpoch) ||
    claim.runtimeEpoch! < 1 ||
    (claim.operation !== 'create' && claim.operation !== 'prepare') ||
    (claim.state !== 'allocated' && claim.state !== 'terminal')
  ) {
    throw new CreationRequestRegistryError('creation request claim failed validation');
  }
  if (claim.state === 'terminal' && claim.terminalOutcome === undefined) {
    throw new CreationRequestRegistryError('terminal creation request claim is missing its outcome');
  }
  if (claim.state === 'allocated' && claim.terminalOutcome !== undefined) {
    throw new CreationRequestRegistryError('allocated creation request claim cannot have a terminal outcome');
  }
  return {
    ...(claim as StoredClaim),
    ...(claim.terminalOutcome === undefined ? {} : { terminalOutcome: validateTerminalOutcome(claim.terminalOutcome) }),
  };
}

async function assertOwnerOnly(path: string, kind: string): Promise<void> {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new CreationRequestRegistryError(`${kind} must not be accessible by group or other users: ${path}`);
  }
}

async function writeCompleteTemporaryFile(directory: string, targetName: string, contents: string): Promise<string> {
  const temporaryPath = join(directory, `.${targetName}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporaryPath;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function installWithoutOverwrite(directory: string, targetPath: string, contents: string): Promise<boolean> {
  const temporaryPath = await writeCompleteTemporaryFile(directory, basename(targetPath), contents);
  try {
    await link(temporaryPath, targetPath);
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function replaceAtomically(directory: string, targetPath: string, contents: string): Promise<void> {
  const temporaryPath = await writeCompleteTemporaryFile(directory, basename(targetPath), contents);
  try {
    await rename(temporaryPath, targetPath);
    await syncDirectory(directory);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export interface FileCreationRequestRegistryOptions {
  /** Per-install private registry directory. It is created with mode 0700. */
  directory: string;
  lockTimeoutMs?: number;
  /** Unreadable or legacy locks are recoverable only after this conservative boundary. */
  staleLockMs?: number;
}

/**
 * Atomic filesystem-backed request/run allocation registry. Claim documents
 * contain only HMAC digests and bounded lifecycle metadata. The HMAC key is
 * installed atomically beside them with owner-only permissions.
 */
export function createFileCreationRequestRegistry(
  options: FileCreationRequestRegistryOptions,
): CreationRequestRegistry {
  const directory = options.directory;
  const claimsDirectory = join(directory, 'claims');
  const keyPath = join(directory, 'installation.key');
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new RangeError('lockTimeoutMs must be a positive finite number');
  }
  if (!Number.isFinite(staleLockMs) || staleLockMs <= 0) {
    throw new RangeError('staleLockMs must be a positive finite number');
  }
  let keyPromise: Promise<Buffer> | undefined;

  async function installationKey(): Promise<Buffer> {
    if (keyPromise) return keyPromise;
    keyPromise = (async () => {
      await mkdir(claimsDirectory, { recursive: true, mode: 0o700 });
      await assertOwnerOnly(directory, 'creation registry directory');
      await assertOwnerOnly(claimsDirectory, 'creation claims directory');
      const proposed = randomBytes(32);
      await installWithoutOverwrite(directory, keyPath, `${proposed.toString('base64')}\n`);
      await assertOwnerOnly(keyPath, 'creation registry key');
      const encoded = (await readFile(keyPath, 'utf8')).trim();
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) {
        throw new CreationRequestRegistryError('creation registry key is invalid');
      }
      return key;
    })().catch((error) => {
      keyPromise = undefined;
      throw error;
    });
    return keyPromise;
  }

  async function digests(creationRequestId: string, canonicalFingerprint?: string) {
    validateCreationRequestId(creationRequestId);
    const key = await installationKey();
    return {
      requestDigest: createHmac('sha256', key).update('request\0').update(creationRequestId).digest('hex'),
      ...(canonicalFingerprint === undefined
        ? {}
        : {
            requestFingerprint: createHmac('sha256', key)
              .update('fingerprint\0')
              .update(canonicalFingerprint)
              .digest('hex'),
          }),
    };
  }

  const allocationPath = (requestDigest: string) => join(claimsDirectory, `${requestDigest}.json`);
  const statePath = (requestDigest: string) => join(claimsDirectory, `${requestDigest}.state.json`);
  const lockPath = (requestDigest: string) => join(claimsDirectory, `${requestDigest}.lock`);

  async function readClaim(requestDigest: string): Promise<StoredClaim> {
    const allocation = parseStoredClaim(await readFile(allocationPath(requestDigest), 'utf8'), requestDigest);
    if (allocation.runtimeEpoch !== 1 || allocation.state !== 'allocated') {
      throw new CreationRequestRegistryError('creation request allocation claim is not immutable allocation state');
    }
    try {
      const state = parseStoredClaim(await readFile(statePath(requestDigest), 'utf8'), requestDigest);
      if (
        state.requestFingerprint !== allocation.requestFingerprint ||
        state.runtimeRunId !== allocation.runtimeRunId ||
        state.operation !== allocation.operation ||
        state.runtimeEpoch < allocation.runtimeEpoch
      ) {
        throw new CreationRequestRegistryError('creation request state does not match its allocation');
      }
      return state;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return allocation;
      throw error;
    }
  }

  async function recoverAbandonedLock(path: string): Promise<boolean> {
    let metadata;
    try {
      metadata = await stat(path);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return true;
      throw error;
    }
    const ageMs = Math.max(0, Date.now() - metadata.mtimeMs);
    if (metadata.isDirectory()) {
      if (ageMs < staleLockMs) return false;
      return rmdir(path).then(
        () => true,
        () => false,
      );
    }

    let owner: { pid?: unknown } | undefined;
    if (metadata.size <= MAX_LOCK_BYTES) {
      try {
        owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
      } catch {
        owner = undefined;
      }
    }
    let ownerState: 'alive' | 'dead' | 'unknown' = 'unknown';
    if (typeof owner?.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        ownerState = 'alive';
      } catch (error) {
        ownerState = isNodeError(error, 'EPERM') ? 'alive' : 'dead';
      }
    }
    // A contender can observe the file after open('wx') but before the owner
    // metadata write completes. Treat that fresh unreadable window as owned,
    // and never steal from a PID that the OS still reports alive.
    if (ownerState === 'alive' || (ownerState === 'unknown' && ageMs < staleLockMs)) return false;
    return unlink(path).then(
      () => true,
      () => false,
    );
  }

  async function withClaimLock<T>(requestDigest: string, action: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const path = lockPath(requestDigest);
    const token = randomUUID();
    while (true) {
      let handle;
      let created = false;
      try {
        handle = await open(path, 'wx', 0o600);
        created = true;
        await handle.writeFile(
          `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          'utf8',
        );
        await handle.sync();
        await handle.close();
        break;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (created) await unlink(path).catch(() => undefined);
        if (!isNodeError(error, 'EEXIST')) throw error;
        if (await recoverAbandonedLock(path)) continue;
        if (Date.now() - startedAt >= lockTimeoutMs) {
          throw new CreationRequestRegistryError('timed out acquiring creation request claim lock', { cause: error });
        }
        await pause(10);
      }
    }
    try {
      return await action();
    } finally {
      try {
        const owner = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
        if (owner.token === token) await unlink(path);
      } catch {
        // A recovered/replaced owner must never be unlinked by its predecessor.
      }
    }
  }

  return {
    async claim(input): Promise<ClaimCreationRequestResult> {
      const { requestDigest, requestFingerprint } = await digests(input.creationRequestId, input.canonicalFingerprint);
      const proposed: StoredClaim = {
        schemaVersion: CLAIM_SCHEMA_VERSION,
        requestDigest,
        requestFingerprint: requestFingerprint!,
        runtimeRunId: input.proposedRuntimeRunId,
        runtimeEpoch: 1,
        operation: input.operation,
        state: 'allocated',
      };
      const created = await installWithoutOverwrite(
        claimsDirectory,
        allocationPath(requestDigest),
        `${JSON.stringify(proposed)}\n`,
      );
      const claim = created ? proposed : await readClaim(requestDigest);
      if (claim.requestFingerprint !== requestFingerprint || claim.operation !== input.operation) {
        return { status: 'conflict', claim: publicClaim(claim) };
      }
      return { status: created ? 'created' : 'existing', claim: publicClaim(claim) };
    },

    async markTerminal(input): Promise<{ applied: boolean; claim: CreationRequestClaim }> {
      if (!Number.isSafeInteger(input.runtimeEpoch) || input.runtimeEpoch < 1) {
        throw new RangeError('runtimeEpoch must be a positive safe integer');
      }
      const { requestDigest } = await digests(input.creationRequestId);
      const outcome = validateTerminalOutcome(input.outcome);
      return withClaimLock(requestDigest, async () => {
        const current = await readClaim(requestDigest);
        if (current.runtimeRunId !== input.runtimeRunId) {
          throw new CreationRequestRegistryError('runtime run does not own this creation request claim');
        }
        if (current.runtimeEpoch !== input.runtimeEpoch || current.state === 'terminal') {
          return { applied: false, claim: publicClaim(current) };
        }
        const next: StoredClaim = { ...current, state: 'terminal', terminalOutcome: outcome };
        await replaceAtomically(claimsDirectory, statePath(requestDigest), `${JSON.stringify(next)}\n`);
        return { applied: true, claim: publicClaim(next) };
      });
    },

    async incrementRuntimeEpoch(input): Promise<{ advanced: boolean; claim: CreationRequestClaim }> {
      if (!Number.isSafeInteger(input.expectedRuntimeEpoch) || input.expectedRuntimeEpoch < 1) {
        throw new RangeError('expectedRuntimeEpoch must be a positive safe integer');
      }
      if (input.expectedRuntimeEpoch === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('expectedRuntimeEpoch cannot be incremented beyond the safe integer range');
      }
      const { requestDigest } = await digests(input.creationRequestId);
      return withClaimLock(requestDigest, async () => {
        const current = await readClaim(requestDigest);
        if (current.runtimeRunId !== input.runtimeRunId) {
          throw new CreationRequestRegistryError('runtime run does not own this creation request claim');
        }
        if (current.state === 'terminal') {
          throw new CreationRequestRegistryError('cannot restore a terminal creation request claim');
        }
        if (current.runtimeEpoch !== input.expectedRuntimeEpoch) {
          return { advanced: false, claim: publicClaim(current) };
        }
        const next: StoredClaim = { ...current, runtimeEpoch: current.runtimeEpoch + 1 };
        await replaceAtomically(claimsDirectory, statePath(requestDigest), `${JSON.stringify(next)}\n`);
        return { advanced: true, claim: publicClaim(next) };
      });
    },
  };
}
