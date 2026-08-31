/**
 * Center-owned native Imposter spawn capability.
 *
 * The spawner and native plane are deliberately pre-normalization: they launch
 * the vendor persona directly and observe the Surface Imposter emits. The
 * containing devkit may replay those immutable records through a downstream
 * projection, but an adapter never participates in spawning or native control.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EmulatorSpawner } from './plane.js';
import { createPersonaLaunchSpec, createPersonaSessionId } from '@vibecook/puppeteer-imposter';

export interface PersonaSpawnerOptions {
  /** Test overrides for the control channel the imposter dials. */
  controlSocketPath?: string;
  controlTokenPath?: string;
}

export function imposterBin(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@vibecook/puppeteer-imposter/package.json')), 'bin', 'ai.mjs');
}

/** Spawn one persona directly, preserving the native plane's boundary. */
export function createPersonaSpawner(
  vendor: string,
  label: string,
  options: PersonaSpawnerOptions = {},
): EmulatorSpawner & {
  disposeAll(): Promise<void>;
} {
  const bin = imposterBin();
  const children = new Map<string, ChildProcess>();
  const workingDirectories = new Map<string, string>();

  const removeWorkingDirectory = (sessionId: string): void => {
    const cwd = workingDirectories.get(sessionId);
    workingDirectories.delete(sessionId);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  };

  return {
    vendor,
    label,
    async spawn() {
      const cwd = mkdtempSync(join(tmpdir(), 'puppeteer-emulator-spawn-'));
      const sessionId = createPersonaSessionId(vendor);
      let child: ChildProcess | undefined;
      try {
        const launch = createPersonaLaunchSpec(vendor, sessionId, cwd);
        child = spawn(process.execPath, [bin, ...launch.args], {
          cwd,
          env: {
            ...process.env,
            ...launch.env,
            ...(options.controlSocketPath ? { PUPPETEER_IMPOSTER_SOCKET: options.controlSocketPath } : {}),
            ...(options.controlTokenPath ? { PUPPETEER_IMPOSTER_TOKEN_FILE: options.controlTokenPath } : {}),
          },
          stdio: ['pipe', 'ignore', 'inherit'],
        });
        children.set(sessionId, child);
        workingDirectories.set(sessionId, cwd);
        const cleanup = (): void => {
          children.delete(sessionId);
          removeWorkingDirectory(sessionId);
        };
        child.once('exit', cleanup);
        child.stdin?.on('error', () => undefined);
        await new Promise<void>((resolve, reject) => {
          child!.once('spawn', resolve);
          child!.once('error', reject);
        });
        return { sessionId };
      } catch (error) {
        child?.kill('SIGKILL');
        children.delete(sessionId);
        removeWorkingDirectory(sessionId);
        // `spawn()` may throw before the directory is entered in the maps.
        rmSync(cwd, { recursive: true, force: true });
        throw error;
      }
    },
    async disposeAll() {
      const active = [...children.entries()];
      children.clear();
      await Promise.all(
        active.map(
          ([sessionId, child]) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                removeWorkingDirectory(sessionId);
                resolve();
                return;
              }
              child.once('exit', () => {
                removeWorkingDirectory(sessionId);
                resolve();
              });
              child.kill('SIGKILL');
            }),
        ),
      );
    },
  };
}
