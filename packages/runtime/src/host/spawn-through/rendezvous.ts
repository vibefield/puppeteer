import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentLaunchProviderSchema, type AgentLaunchProvider } from '@vibecook/puppeteer-core';
import { ensurePrivateDirectory, publishFile } from './files.js';
import { isSpawnThroughHostLabel } from './protocol.js';

/**
 * The rendezvous: how a shim finds its host, as FILES in the shim home rather
 * than variables in a shell's environment. A host's shells can outlive it, and
 * a port and bearer baked into a shell at birth go stale at the host's first
 * restart; the shim reads these files at every invocation, so it follows a
 * host that restarted, moved port, changed its bearer or installed another
 * agent. The bearer is a file (0600 in a 0700 home), never a variable: no
 * process inherits it.
 */
export const RENDEZVOUS_FILE = 'gateway.json';
/** `AgentLaunchProvider[]`, each command naming its REAL executable (absolute). */
export const LAUNCH_PROVIDERS_FILE = 'launch-providers.json';
/** How long a strict shim waits for an unreachable gateway before it refuses. */
export const DEFAULT_RETRY_MS = 8_000;

const SpawnThroughRendezvousSchema = z.object({
  format: z.literal(1),
  transport: z.literal('tcp'),
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(1).max(256),
  strict: z.boolean(),
  retryMs: z.number().int().min(0).max(120_000),
  writtenAt: z.string().min(1),
  /** The host's pid when it wrote the file: diagnostic, never a liveness proof. */
  pid: z.number().int().positive(),
  /** The imposter's `ai` the host chose. Absent: the first `ai` on PATH outside the shim directory. */
  imposterExecutable: z.string().min(1).max(8_192).optional(),
  /**
   * The host's name, said by the shim in place of "the host". A label this
   * shim cannot say is dropped, never a reason to lose the host.
   */
  hostLabel: z.string().refine(isSpawnThroughHostLabel).optional().catch(undefined),
});
export type SpawnThroughRendezvous = z.infer<typeof SpawnThroughRendezvousSchema>;

export interface WriteRendezvousOptions {
  port: number;
  token: string;
  strict: boolean;
  retryMs?: number | undefined;
  launchProviders: readonly AgentLaunchProvider[];
  imposterExecutable?: string | undefined;
  /** The host's name for the shim's own sentences: 1–64 printable characters. Bake the same into the launchers. */
  hostLabel?: string | undefined;
}

/**
 * Publish the rendezvous and the provider table. Throws on values no shim
 * could use (a host's bug). Idempotent: an identical call rewrites no file,
 * so a host can publish the same values again on a timer.
 */
export async function writeRendezvous(home: string, options: WriteRendezvousOptions): Promise<void> {
  if (options.hostLabel !== undefined && !isSpawnThroughHostLabel(options.hostLabel)) {
    throw new Error(`not a host label a shim can say: ${JSON.stringify(options.hostLabel)}`);
  }
  const rendezvous = SpawnThroughRendezvousSchema.parse({
    format: 1,
    transport: 'tcp',
    host: '127.0.0.1',
    port: options.port,
    token: options.token,
    strict: options.strict,
    retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
    writtenAt: new Date().toISOString(),
    pid: process.pid,
    ...(options.imposterExecutable === undefined ? {} : { imposterExecutable: options.imposterExecutable }),
    ...(options.hostLabel === undefined ? {} : { hostLabel: options.hostLabel }),
  });
  const launchProviders = AgentLaunchProviderSchema.array().parse(options.launchProviders);
  // A rendezvous that already says all of this keeps the time it was written: its bytes match, and nothing is written.
  const existing = await readRendezvous(home);
  if (existing && JSON.stringify({ ...existing, writtenAt: '' }) === JSON.stringify({ ...rendezvous, writtenAt: '' })) {
    rendezvous.writtenAt = existing.writtenAt;
  }
  await ensurePrivateDirectory(home);
  // The table first: a shim that reads the new rendezvous finds the table it was written with.
  await publishFile(join(home, LAUNCH_PROVIDERS_FILE), `${JSON.stringify(launchProviders, null, 2)}\n`, 0o600);
  await publishFile(join(home, RENDEZVOUS_FILE), `${JSON.stringify(rendezvous, null, 2)}\n`, 0o600);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The host's rendezvous, or `undefined` when there is none a shim could use. Never throws. */
export async function readRendezvous(home: string): Promise<SpawnThroughRendezvous | undefined> {
  const parsed = SpawnThroughRendezvousSchema.safeParse(await readJson(join(home, RENDEZVOUS_FILE)));
  return parsed.success ? parsed.data : undefined;
}

/** The provider table, or `undefined` when there is none a shim could use. Never throws. */
export async function readLaunchProviders(home: string): Promise<AgentLaunchProvider[] | undefined> {
  const parsed = AgentLaunchProviderSchema.array().safeParse(await readJson(join(home, LAUNCH_PROVIDERS_FILE)));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Withdraw the rendezvous at the host's exit, leaving the provider table: a
 * shim that runs while no host listens still finds the real executable. With
 * `token`, only the rendezvous that bearer wrote is withdrawn, so a host that
 * exits after its successor started does not take the successor's with it.
 */
export async function clearRendezvous(home: string, { token }: { token?: string | undefined } = {}): Promise<void> {
  if (token !== undefined && (await readRendezvous(home))?.token !== token) return;
  await rm(join(home, RENDEZVOUS_FILE), { force: true });
}
