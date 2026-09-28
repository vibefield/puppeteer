import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import type { SpawnThroughShimRuntime } from '@vibecook/puppeteer-runtime/spawn-through';

export type ShimRuntimeChoice =
  | { kind: 'node'; runtime: SpawnThroughShimRuntime; command: string; version: string }
  | { kind: 'electron'; runtime: SpawnThroughShimRuntime; command: string; version: string; reason: string };

/** What `process.versions.node` prints. */
const NODE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u;

/** `process.execve`, the shim's exec in place, exists from 22.15.0 on the 22 line and 23.11.0 on the 23 line, and after. */
export function nodeCanExecInPlace(version: string): boolean {
  const match = NODE_VERSION.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 23 && minor >= 11) || (major === 22 && minor >= 15);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The first executable `node` on `path`, made absolute. Never one in a
 * spawn-through shim directory, under any spelling: a symlink to the
 * directory, a trailing slash, or a link elsewhere to a launcher inside it.
 */
export function firstNodeOnPath(path: string, shimDirectories: readonly (string | undefined)[]): string | undefined {
  const shims = shimDirectories.filter((directory): directory is string => Boolean(directory));
  const spelled = new Set(shims.map((directory) => resolve(directory)));
  const canonicalShims = new Set(shims.map(canonical));
  const isShimDirectory = (directory: string): boolean =>
    spelled.has(resolve(directory)) || canonicalShims.has(canonical(directory));
  for (const entry of path.split(delimiter)) {
    if (!entry || isShimDirectory(entry)) continue;
    const candidate = resolve(entry, 'node');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile() && !isShimDirectory(dirname(canonical(candidate)))) return candidate;
    } catch {
      // Not here: the next entry.
    }
  }
  return undefined;
}

/** `<node> -p process.versions.node`, run without a shell and bounded: the version it reports, or `undefined`. */
export function probeNodeVersion(command: string, timeoutMs = 5_000): Promise<string | undefined> {
  return new Promise((answer) => {
    // At the timeout execFile closes the pipes before it kills, so a child the probe started cannot hold the answer.
    execFile(command, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
      answer(error ? undefined : stdout.trim() || undefined);
    });
  });
}

/**
 * The runtime Godview's launchers run the spawn-through shim on, chosen once
 * at startup. A real node comes first: under Electron as Node the shim's exec
 * in place stalled for seconds where it was measured (median 4.3 s, against
 * 65 ms under node), and every agent typed in a pane waits for it. Godview's
 * own binary is the fallback, for a PATH with no node that can exec in place.
 */
export async function chooseShimRuntime(options: {
  /** Godview's own PATH, as it started. */
  path: string;
  shimDirectories: readonly (string | undefined)[];
  /** Godview's own binary, and the Node it carries. */
  electron: { command: string; version: string };
  probe?: (command: string) => Promise<string | undefined>;
}): Promise<ShimRuntimeChoice> {
  const { electron, probe = probeNodeVersion } = options;
  const fallback = (reason: string): ShimRuntimeChoice => ({
    kind: 'electron',
    runtime: { command: electron.command, env: { ELECTRON_RUN_AS_NODE: '1' } },
    command: electron.command,
    version: electron.version,
    reason,
  });
  const node = firstNodeOnPath(options.path, options.shimDirectories);
  if (!node) return fallback('no node on PATH');
  const version = await probe(node);
  if (version === undefined || !NODE_VERSION.test(version)) return fallback(`${node} reported no node version`);
  if (!nodeCanExecInPlace(version)) return fallback(`node ${version} at ${node} cannot exec in place`);
  return { kind: 'node', runtime: { command: node }, command: node, version };
}

/** The one line Godview logs: the runtime's path and version, and why, when it is the fallback. */
export function describeShimRuntime(choice: ShimRuntimeChoice): string {
  return choice.kind === 'node'
    ? `spawn-through runtime: node ${choice.version} at ${choice.command}`
    : `spawn-through runtime: Godview's own binary as node ${choice.version} at ${choice.command} (${choice.reason})`;
}
