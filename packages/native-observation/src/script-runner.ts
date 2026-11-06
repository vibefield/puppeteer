/**
 * Which program runs a JavaScript file in a child process: an adapter's staged forwarder, a script executable (the
 * Imposter's bin, a PATH shim), a script a metadata probe names. The one authority every adapter asks; no site reads
 * `process.execPath` as a Node on its own.
 *
 * A script is never exec'd directly: POSIX needs an exec bit nobody guarantees, and Windows has no shebang handling.
 * So it runs under a Node, and which Node is a fact of the process asking:
 *
 * - A single executable (Node SEA: a packaged daemon) has no runner. Its `process.execPath` runs only its own sealed
 *   entry, so a script handed to it would boot that entry instead. A host of that kind lends the program itself
 *   (core `AgentHost.forwarderRuntime`), or the adapter refuses; a packaged build names no program the person
 *   installed, so no Node on PATH is looked for either.
 * - Under Electron `process.execPath` is the Electron binary. A Node on PATH runs the script: Electron as Node has
 *   stdin and event-loop quirks that broke the Imposter's control channel (probed 2026-08-07). With no Node on PATH
 *   the Electron binary runs as Node (`ELECTRON_RUN_AS_NODE=1`), the documented fallback.
 * - A real Node runs the script itself.
 */
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';

/** A program that runs a script: `<command> <args...> <script> <script args...>`, with `env` over the child's. */
export interface ScriptRunner {
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>> | undefined;
}

/** What decides the runner, injected so the decision is a pure function of them. */
export interface ScriptRunnerFacts {
  /** The process is Electron (`process.versions.electron`). */
  electron: boolean;
  /** The process is a Node single executable (`node:sea` `isSea()`). */
  sea: boolean;
  execPath: string;
  /** The first executable `node` on PATH; read only where it can be chosen (Electron). */
  pathNode: string | undefined;
}

export function resolveScriptRunner(facts: ScriptRunnerFacts): ScriptRunner | undefined {
  if (facts.sea) return undefined;
  if (!facts.electron) return { command: facts.execPath, args: [] };
  if (facts.pathNode !== undefined) return { command: facts.pathNode, args: [] };
  return { command: facts.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** The first executable `node` in a PATH value, or undefined. */
export function nodeOnPath(pathVariable: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const names = platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const directory of pathVariable.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // the next entry
      }
    }
  }
  return undefined;
}

/** This process's facts. */
export function ownScriptRunnerFacts(): ScriptRunnerFacts {
  const electron = process.versions.electron !== undefined;
  return {
    electron,
    // Read through getBuiltinModule rather than imported: a runtime without the module (an embedder's Node) loads
    // this file all the same, and is no single executable.
    sea: process.getBuiltinModule('node:sea')?.isSea() === true,
    execPath: process.execPath,
    pathNode: electron ? nodeOnPath(process.env.PATH ?? '') : undefined,
  };
}
