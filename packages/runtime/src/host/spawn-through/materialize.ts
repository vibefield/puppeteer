import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ensurePrivateDirectory, publishFile } from './files.js';
import { spawnThroughLayout } from './layout.js';
import { isSpawnThroughHostLabel } from './protocol.js';
import { ZSH_INTEGRATION } from './shell-integration.js';

/** Core's rule for an intercepted command name. A name is written into a shell script, so it is enforced here too. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * The program a launcher execs on the bundled shim. A host cannot assume a
 * `node` on a pane's PATH, or a new enough one (`process.execve` came in Node
 * 22.15.0 and 23.11.0; 23.0–23.10 lack it), so it names its own: an absolute
 * path, leading arguments, and variables such as Electron's
 * `ELECTRON_RUN_AS_NODE=1`. The shim removes every one of those variables
 * before it execs anything, so the agent never sees them — name only
 * variables the runtime needs.
 */
export interface SpawnThroughShimRuntime {
  command: string;
  args?: readonly string[] | undefined;
  env?: Readonly<Record<string, string>> | undefined;
}

export interface MaterializeShimsOptions {
  /** The shim home: the host chooses it, the kit owns what is inside. */
  home: string;
  /** Command names to intercept; launchers for any other name are removed. */
  names: readonly string[];
  /** The bundled shim (`@vibefield/puppeteer-runtime/spawn-through/shim`, one CommonJS file), copied into the home. */
  script: string;
  runtime: SpawnThroughShimRuntime;
  /**
   * The launcher's say when no rendezvous can be read at all: refuse rather
   * than fall through. A readable rendezvous's own `strict` always wins.
   */
  strict?: boolean | undefined;
  /**
   * The host's name for the shim's own sentences, baked in for when no
   * rendezvous is readable — the one moment the shim speaks for a host that
   * is gone. The rendezvous's own label wins. 1–64 printable characters.
   */
  hostLabel?: string | undefined;
}

export interface MaterializedShims {
  /** `<home>/bin`: `PUPPETEER_SHIM_DIR`, the directory a shell puts first on PATH. */
  shimDirectory: string;
  names: string[];
}

/** Quote one word for POSIX `sh`: every byte literal, a single quote included. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * One launcher. `exec` all the way down: the launcher, the shim and the agent
 * are one pid, whose parent is the shell — the process the host's
 * `resolveTerminal` looks for. The variables are exported on their own lines
 * rather than prefixed to `exec`, whose export of prefix assignments POSIX
 * leaves unspecified.
 */
export function launcherScript(options: {
  name: string;
  home: string;
  runtime: SpawnThroughShimRuntime;
  strict?: boolean | undefined;
  hostLabel?: string | undefined;
}): string {
  const { name, home, runtime, hostLabel } = options;
  const environment = Object.entries(runtime.env ?? {});
  const command = [runtime.command, ...(runtime.args ?? []), spawnThroughLayout(home).script];
  return [
    '#!/bin/sh',
    `# ${name} — puppeteer spawn-through launcher (generated)`,
    `export PUPPETEER_SHIM_NAME=${shellQuote(name)} PUPPETEER_SHIM_HOME=${shellQuote(home)}`,
    `export PUPPETEER_SHIM_STRICT=${options.strict === true ? "'1'" : "'0'"} PUPPETEER_SHIM_STRIP=${shellQuote(
      environment.map(([variable]) => variable).join(' '),
    )}`,
    ...(hostLabel === undefined ? [] : [`export PUPPETEER_SHIM_LABEL=${shellQuote(hostLabel)}`]),
    ...(environment.length === 0
      ? []
      : [`export ${environment.map(([variable, value]) => `${variable}=${shellQuote(value)}`).join(' ')}`]),
    `exec ${command.map(shellQuote).join(' ')} "$@"`,
    '',
  ].join('\n');
}

function validate(options: MaterializeShimsOptions): string[] {
  if (!isAbsolute(options.home)) throw new Error(`spawn-through home must be an absolute path: ${options.home}`);
  for (const name of options.names) {
    if (name.length > 128 || !COMMAND_NAME.test(name)) {
      throw new Error(`not a command name a launcher can be written for: ${JSON.stringify(name)}`);
    }
  }
  if (!isAbsolute(options.runtime.command)) {
    throw new Error(`spawn-through runtime must be an absolute path: ${options.runtime.command}`);
  }
  if (options.hostLabel !== undefined && !isSpawnThroughHostLabel(options.hostLabel)) {
    throw new Error(`not a host label a shim can say: ${JSON.stringify(options.hostLabel)}`);
  }
  for (const variable of Object.keys(options.runtime.env ?? {})) {
    // PATH is the shim's to compute for the agent, and PUPPETEER_SHIM_* the launcher's own.
    if (!ENVIRONMENT_NAME.test(variable) || variable === 'PATH' || variable.startsWith('PUPPETEER_SHIM_')) {
      throw new Error(`not a runtime variable a launcher can set: ${JSON.stringify(variable)}`);
    }
  }
  return [...new Set(options.names)].sort();
}

/**
 * Write the shim home: the bundled shim, one launcher per name (and none for
 * a name no longer asked for), the zsh integration. Idempotent: an identical
 * second call rewrites no file. The rendezvous is `writeRendezvous`'s.
 */
export async function materializeShims(options: MaterializeShimsOptions): Promise<MaterializedShims> {
  const names = validate(options);
  const layout = spawnThroughLayout(options.home);
  const script = await readFile(options.script);
  for (const directory of [layout.home, layout.shimDirectory, dirname(layout.script), layout.zshDirectory]) {
    await ensurePrivateDirectory(directory);
  }
  await publishFile(layout.script, script, 0o600);
  await publishFile(layout.zshenv, ZSH_INTEGRATION, 0o600);
  const wanted = new Set(names);
  for (const entry of await readdir(layout.shimDirectory)) {
    if (!wanted.has(entry)) await rm(join(layout.shimDirectory, entry), { recursive: true, force: true });
  }
  for (const name of names) {
    await publishFile(
      join(layout.shimDirectory, name),
      launcherScript({
        name,
        home: options.home,
        runtime: options.runtime,
        strict: options.strict,
        hostLabel: options.hostLabel,
      }),
      0o700,
    );
  }
  return { shimDirectory: layout.shimDirectory, names };
}
