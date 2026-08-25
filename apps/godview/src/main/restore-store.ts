import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readRestoreSnapshot, type RestoreSnapshot } from '../restore-snapshot.js';

const STORE_KIND = 'godview-durable-restore';
const STORE_VERSION = 1 as const;
const SLOT_NAMES = ['restore-state-0.json', 'restore-state-1.json'] as const;
const TEMP_PREFIX = '.restore-state-';
const MAX_RESTORE_FILE_BYTES = 8 * 1024 * 1024;

interface RestoreEnvelopeBody {
  kind: typeof STORE_KIND;
  storageVersion: typeof STORE_VERSION;
  generation: number;
  snapshot: RestoreSnapshot;
}

interface RestoreEnvelope extends RestoreEnvelopeBody {
  checksum: string;
}

export interface DurableRestoreState {
  generation: number;
  snapshot: RestoreSnapshot;
}

function checksum(body: RestoreEnvelopeBody): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function sameChecksum(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return false;
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(actual, 'hex');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function readSlot(path: string): DurableRestoreState | undefined {
  try {
    if (statSync(path).size > MAX_RESTORE_FILE_BYTES) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    const envelope = value as Partial<RestoreEnvelope>;
    if (envelope.kind !== STORE_KIND || envelope.storageVersion !== STORE_VERSION) return undefined;
    if (!Number.isSafeInteger(envelope.generation) || Number(envelope.generation) <= 0) return undefined;
    const rawBody: RestoreEnvelopeBody = {
      kind: STORE_KIND,
      storageVersion: STORE_VERSION,
      generation: Number(envelope.generation),
      snapshot: envelope.snapshot as RestoreSnapshot,
    };
    // Verify the exact persisted logical body before normalization. Otherwise
    // an added unknown field would be stripped by the schema reader and evade
    // the digest even though the committed file had changed.
    if (!sameChecksum(checksum(rawBody), envelope.checksum)) return undefined;
    const snapshot = readRestoreSnapshot(envelope.snapshot);
    if (!snapshot) return undefined;
    return { generation: rawBody.generation, snapshot };
  } catch {
    return undefined;
  }
}

function removeAbandonedTemps(directory: string): void {
  try {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(TEMP_PREFIX) && name.endsWith('.tmp')) {
        rmSync(join(directory, name), { force: true });
      }
    }
  } catch {
    // The directory may not exist on first launch, or cleanup may race an OS
    // shutdown. Neither affects the two committed generations.
  }
}

/** Read both generations and select the newest one whose schema and digest verify. */
export function readDurableRestoreState(directory: string): DurableRestoreState | undefined {
  const candidates = SLOT_NAMES.map((name) => readSlot(join(directory, name))).filter(
    (candidate): candidate is DurableRestoreState => candidate !== undefined,
  );
  removeAbandonedTemps(directory);
  return candidates.sort((left, right) => right.generation - left.generation)[0];
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not expose directory handles with POSIX fsync semantics.
    // File fsync plus replace is the strongest portable sequence there.
    if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'EPERM'].includes(code ?? '')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Commit one generation without touching the other known-good generation.
 *
 * The ordering is intentional: flush the temporary file, atomically publish
 * it over the older slot, then flush the directory entry. A crash at any point
 * leaves either the new generation or the other slot readable.
 */
export function writeDurableRestoreState(
  directory: string,
  snapshot: RestoreSnapshot,
  previousGeneration = readDurableRestoreState(directory)?.generation ?? 0,
): DurableRestoreState {
  const normalized = readRestoreSnapshot(snapshot);
  if (!normalized) throw new Error('refusing to persist an empty or invalid restore snapshot');
  const generation = previousGeneration + 1;
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error('restore generation overflow');
  const body: RestoreEnvelopeBody = {
    kind: STORE_KIND,
    storageVersion: STORE_VERSION,
    generation,
    snapshot: normalized,
  };
  const envelope: RestoreEnvelope = { ...body, checksum: checksum(body) };
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RESTORE_FILE_BYTES) {
    throw new Error('restore snapshot exceeds the durable-store size limit');
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = join(directory, SLOT_NAMES[generation % SLOT_NAMES.length]!);
  const temporary = join(directory, `${TEMP_PREFIX}${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, serialized, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  removeAbandonedTemps(directory);
  return { generation, snapshot: normalized };
}

export function discardDurableRestoreState(directory: string): void {
  if (!existsSync(directory)) return;
  for (const name of SLOT_NAMES) rmSync(join(directory, name), { force: true });
  removeAbandonedTemps(directory);
  syncDirectory(directory);
}

export function durableRestoreSlotPaths(directory: string): readonly string[] {
  return SLOT_NAMES.map((name) => join(directory, name));
}
