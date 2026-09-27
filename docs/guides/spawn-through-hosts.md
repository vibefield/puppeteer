# Spawn-Through for Terminal Hosts

**Status:** Current host guide, 2026-09-27 (PU-17)

**Audience:** Developers of an application that owns terminals — a desktop app, a daemon — and wants a command a
person types in one of them to start as a managed Puppeteer session

**Companions:** `docs/rfcs/004-layered-agent-runtime.md` defines the launch boundary (`launchProviders()` →
`prepareInvocation()` → `adoptPrepared()`); the kit lives in `packages/runtime/src/host/spawn-through/` and is exported
as `@vibecook/puppeteer-runtime/spawn-through`; Godview (`apps/godview`) is the reference host.

A person types `<name> …` in a shell your application gave them. With spawn-through, that command becomes a managed
session in the same terminal, with the same pid, before the agent draws its first byte: Runtime, its monitor and every
control see it exactly as they see a session the host spawned. Nothing proxies the terminal and nothing reads it. The
invariant is:

> **The shim asks. The host decides. The adapter prepares. The shim execs in place.**

`<name>`, `<home>` and similar values below are placeholders.

## Contents

1. [What the kit gives, and what a host supplies](#1-what-the-kit-gives-and-what-a-host-supplies)
2. [One launch, end to end](#2-one-launch-end-to-end)
3. [The shim home](#3-the-shim-home)
4. [The rendezvous, and why it is files](#4-the-rendezvous-and-why-it-is-files)
5. [The launcher, and why](#5-the-launcher-and-why)
6. [Shell integration](#6-shell-integration)
7. [Strict](#7-strict)
8. [Security](#8-security)
9. [What a host does itself](#9-what-a-host-does-itself)
10. [Limits](#10-limits)

---

## 1. What the kit gives, and what a host supplies

| The kit gives | The host supplies |
| --- | --- |
| the shim (`./spawn-through/shim`) | its bundle, and the runtime that runs it (§5) |
| `materializeShims`: the home, a launcher per name, the zsh integration | the home's path; which names to intercept |
| `writeRendezvous` / `readRendezvous` / `clearRendezvous` | a fresh, random bearer, and its custody |
| `startSpawnThroughGateway`: the loopback listener, the strict parser | the listener's lifetime |
| `prepareSpawnThroughLaunch`: provider → terminal → prepare → adopt | `resolveTerminal`: which terminal holds a pid |
| `shellIntegrationEnvironment`: what a born shell needs | the shells, and their environment |
| `watchProcessExit`, `processStartedAt`: an adopted pid's exit and identity | its records, and reporting the exit |

The kit knows no terminal library and no vendor. The names it intercepts come from `launchProviders()`: each adapter
that supports native invocation declares its command names, its real executable, and the complete allow-list of
environment variables the adapter accepts from a shell. The host decides which of those it offers.

## 2. One launch, end to end

1. The person types `<name> --flag` at a prompt. The shim directory is first on the shell's PATH, so the shell runs the
   launcher `<home>/bin/<name>`.
2. The launcher `exec`s the host's runtime on `<home>/lib/agent-shim.cjs`. The launcher, the shim and — later — the
   agent are one pid, and its parent is the shell.
3. The shim reads `<home>/launch-providers.json` and `<home>/gateway.json`, finds the provider that owns `<name>` and
   the real executable, and sends one JSON line to the gateway: the provider, the cwd, the argv after the name, only the
   allow-listed variables, its own pid and its parent's.
4. The gateway checks the bearer and parses strictly; the host's handler calls `prepareSpawnThroughLaunch`. It resolves
   the provider and its capability, asks the host which terminal contains the pid, prepares the invocation (the adapter
   normalizes the argv and chooses its hooks, sockets and logs), adopts the preparation in that terminal with that pid
   (cancelling it if adoption fails), lets the host record the run, and answers `exec` with the adapter's recipe.
5. The shim `execve`s the recipe in place. The agent starts managed, in the terminal the person typed into.

Any other answer is a decline: `fallback` execs the real executable with the original argv, and `refuse` (strict hosts
only) execs nothing, prints the host's message and exits 75.

## 3. The shim home

The host chooses the path; the kit owns everything inside it.

```text
<home>/                       0700
  gateway.json                0600   the rendezvous (writeRendezvous)
  launch-providers.json       0600   AgentLaunchProvider[] with each command's real executable (writeRendezvous)
  bin/<name>                  0700   one launcher per name — this directory is PUPPETEER_SHIM_DIR
  lib/agent-shim.cjs          0600   the bundled shim, copied from the host's build
  zsh/.zshenv                 0600   the zsh integration
```

`materializeShims({home, names, script, runtime, strict?})` writes `bin/`, `lib/` and `zsh/`. It is idempotent — an
identical call rewrites no file, so a shell running a launcher at that moment is untouched — and it removes the
launcher of any name no longer asked for. It refuses, before writing anything, a name outside Core's command-name rule
(a name is written into a shell script), a relative home or runtime, and runtime variables named `PATH` or
`PUPPETEER_SHIM_*`. Every file is published by writing a temp file in the same directory, setting its mode, and
renaming it over the name: no reader sees a half-written file. `spawnThroughLayout(home)` spells every path.

Call `materializeShims` at every start: the launchers name the runtime and the bundle of the host that wrote them.

## 4. The rendezvous, and why it is files

A shell's environment names only its shim directory. Everything that changes with the host lives in files the shim
reads at **every** invocation:

```json
{
  "format": 1,
  "transport": "tcp",
  "host": "127.0.0.1",
  "port": 50123,
  "token": "<bearer>",
  "strict": false,
  "retryMs": 8000,
  "writtenAt": "2026-09-27T21:00:00.000Z",
  "pid": 4242
}
```

A host's shells can outlive it: a daemon restarts under panes a person is still using. A port and bearer baked into a
shell's environment at birth go stale at the first restart; files do not. The shim follows a host that restarted, moved
port, rotated its bearer, turned strict on, or installed another agent — with no change to any shell.

- `writeRendezvous(home, {port, token, strict, retryMs?, launchProviders, imposterExecutable?})` publishes the provider
  table, then the rendezvous. It throws, before writing, on values no shim could use.
- `readRendezvous(home)` and `readLaunchProviders(home)` never throw: a missing, unreadable or invalid file is
  `undefined`.
- `clearRendezvous(home, {token})` at exit removes `gateway.json` only. The provider table stays, so a shim that runs
  while no host listens still finds the real executable. With the bearer it wrote, a host withdraws only its own
  rendezvous, never a successor's that started before it finished exiting.
- `imposterExecutable` names the imposter's `ai` a host chose; without it the shim takes the first `ai` on PATH outside
  the shim directory.

## 5. The launcher, and why

A host cannot assume `node` on a pane's PATH, or a new enough one: the shim execs in place with `process.execve`, which
needs Node.js 22.15. So a launcher is a POSIX `sh` file that execs the runtime the **host** names:

```sh
#!/bin/sh
# <name> — puppeteer spawn-through launcher (generated)
export PUPPETEER_SHIM_NAME='<name>' PUPPETEER_SHIM_HOME='<home>'
export PUPPETEER_SHIM_STRICT='0' PUPPETEER_SHIM_STRIP='ELECTRON_RUN_AS_NODE'
export ELECTRON_RUN_AS_NODE='1'
exec '<runtime>' '<home>/lib/agent-shim.cjs' "$@"
```

- `runtime.command` is an absolute path; `runtime.args` lead the shim; `runtime.env` holds what the runtime itself needs
  (a packaged Electron app runs the shim with its own binary and `ELECTRON_RUN_AS_NODE=1`). Every word is single-quoted
  for `sh`, so a home under `Application Support`, or with a quote in it, is safe.
- The shim removes every `runtime.env` name before it execs anything, so the agent never inherits them — name only
  variables the runtime needs. A recipe that sets one of those names itself keeps its value: the recipe is exact.
- The variables are exported on their own lines: POSIX leaves unspecified whether assignments prefixed to `exec` are
  exported.
- `exec` all the way down: one pid from the shell's fork to the agent. The host's `resolveTerminal` looks for exactly
  that process.

## 6. Shell integration

`shellIntegrationEnvironment({home, shell, environment})` returns the variables to add to (or replace in) the
environment of a shell the host births.

### zsh — give `ZDOTDIR` back first

For zsh it returns `ZDOTDIR=<home>/zsh`, `PUPPETEER_ORIGINAL_ZDOTDIR` (the person's own, or empty) and
`PUPPETEER_SHIM_DIR`. zsh reads `<home>/zsh/.zshenv` first, and the integration's **first lines** restore the person's
`ZDOTDIR` (or unset it). This is the law of the integration: left pointed at the host's directory, every later
startup file would be looked for there, and macOS's `/etc/zshrc` (`HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`) would put
the person's history — and compinit its dump — in the host's home. With `ZDOTDIR` given back, `.zshenv`, `.zprofile`,
`.zshrc`, `.zlogin`, the history file and the completion dump are all the person's.

In an interactive shell the integration registers a `precmd` hook that puts the shim directory first on PATH, once,
before every prompt — so after every startup file. A profile that reorders PATH (`path_helper`, a version manager, a
framework) cannot put the real executable ahead of the launcher; another `precmd` hook registered after this one can
(direnv's does, for a directory whose `.envrc` adds to PATH). A person leaves by unsetting `PUPPETEER_SHIM_DIR`; the
hook then stands aside. A non-interactive `zsh -c` is not integrated, and neither is an interactive shell a person
starts inside an integrated one: it reads only the person's own files.

The tests prove this in a real zsh with a throwaway `HOME` and `ZDOTDIR`: `ZDOTDIR` restored or unset, the person's
files read, the history file theirs, the hook present only when interactive, and a piped `zsh -i` resolving `<name>` to
the launcher at its first prompt and again after `export PATH=<real dir>:$PATH`.

### bash, fish and the rest — not yet integrated

For any other shell the function puts the shim directory first on the PATH the shell is born with. That is best
effort: the shell's own startup files may reorder PATH, and nothing puts it back. Bash (through `--posix` and `ENV`)
and fish (through a `vendor_conf.d` on `XDG_DATA_DIRS`) are later slices.

## 7. Strict

A strict host refuses a launch it cannot manage instead of letting it run unmanaged. Strictness has four places, and a
host that turns it on sets all of them:

- `SpawnThroughHost.strict`: every decline of `prepareSpawnThroughLaunch` answers `refuse` with a readable message;
- `startSpawnThroughGateway({strict})`: so do the gateway's own failures (a bad bearer, an oversize or unreadable
  request, a throwing handler) — an argv over 64 KiB would otherwise fall through;
- `writeRendezvous({strict})`: when the gateway cannot be reached, the shim retries with backoff (100 ms doubling to
  1 s) for `retryMs`, says once that it waits, re-reads the rendezvous every try — a host that comes back is used —
  and then refuses with exit 75;
- `materializeShims({strict})`: the launcher's word when no rendezvous has been readable at all.

A shim reads the host's latest readable rendezvous first; the launcher speaks only while none has been readable. A
name with no row in the provider table, or a home with no table at all, is never refused: the table is the host's
word on what it manages.

**The limit — do not turn strict on yet.** Today every adapter's normalizer answers one `rejected` for two different
things: an invocation that is not a session at all (a version query, a one-shot print mode) and a session whose
arguments it cannot carry. The kit answers `fallback` for a rejection when not strict and `refuse` when strict, so a
strict host refuses both — the first wrongly, which breaks the CLI's own non-session commands. PU-9a adds a
`passthrough` status that answers `fallback` in every mode. No host turns strict on before PU-9a lands.

## 8. Security

The adversary is a process of the same user. What the gateway's bearer lets its holder do is one thing: ask that a
process be prepared and adopted as a managed run in the terminal that contains it. The holder receives the launch
recipe of the run it asked for, and nothing of any other run.

- **The bearer is a file, never a variable.** It lives in `gateway.json` (0600, in a 0700 home), so no process
  inherits it. A same-user process can read the file, as it could read an environment: the file is not a stronger
  secret, it is a fresher one, and it never reaches an agent by inheritance.
- **The gateway listens on 127.0.0.1 only**, parses every request strictly (unknown keys and unbounded strings are
  refused; the intent is held to Core's schema), and gives a wrong bearer and a request of the wrong shape the same
  answer.
- **A request's pid is self-asserted.** Anything that holds the bearer can name any pid. The host's `resolveTerminal`
  binds it: answer only for a terminal whose own evidence — the shell's pid, an ancestor walk — shows it contains that
  process. A caller can then ask only for runs in terminals where the named pid really lives; one active run per
  terminal and the host's own caps bound the rest.
- **The shim strips its own variables** (`PUPPETEER_SHIM_*`, `PUPPETEER_ORIGINAL_ZDOTDIR`, the runtime's names) and
  removes its directory from PATH — under any spelling, symlinks included — before any exec. An agent's tools that run
  the same command reach the real executable: nested runs are not managed.
- **Launch environments carry bearer tokens.** The shim never logs the token, a recipe or an environment; text from the
  gateway is printed with control characters removed. A host must not log recipes or requests either. The one thing a
  host may keep is its own stable-ingress record (RFC 003), owner-only, beside its session records.

## 9. What a host does itself

**Bundle the shim.** The entry is `@vibecook/puppeteer-runtime/spawn-through/shim`; importing it runs it. Bundle it into
one CommonJS file and hand the file to `materializeShims`:

```ts
import { build } from 'esbuild';

await build({
  stdin: { contents: "import '@vibecook/puppeteer-runtime/spawn-through/shim';", resolveDir: hostRoot },
  outfile: join(dist, 'agent-shim.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});
```

**Compose it.** A sketch of the whole host side:

```ts
import { randomBytes } from 'node:crypto';
import {
  clearRendezvous,
  materializeShims,
  prepareSpawnThroughLaunch,
  processStartedAt,
  shellIntegrationEnvironment,
  startSpawnThroughGateway,
  watchProcessExit,
  writeRendezvous,
  type SpawnThroughHost,
} from '@vibecook/puppeteer-runtime/spawn-through';

// Each command's real executable, resolved on the host's own PATH to an absolute path; the names it offers.
const launchProviders = resolveExecutables(runtime.launchProviders());
const names = launchProviders.flatMap((provider) => provider.nativeInvocation?.commands.map(({ name }) => name) ?? []);
await materializeShims({ home, names, script: bundledShim, runtime: { command: nodeExecutable } });

const host: SpawnThroughHost = {
  runtime,
  resolveTerminal: async ({ pid, parentPid }) => terminals.containing(pid, parentPid),
  // The ingress the adapter binds, so a run can be re-attached after the host restarts.
  launchOptions: () => ({ ingress: { onBound: rememberIngress } }),
  onAdopted: async ({ info, terminalSessionId, processId, preparationId }) => {
    records.add(info, { preparationId, startedAt: await processStartedAt(processId) });
    watchProcessExit(processId, { graceMs: 500 }, () => {
      void runtime.handleProcessExit(terminalSessionId, { exitCode: null, signal: null, reason: 'process exited' });
    });
  },
};
const token = randomBytes(32).toString('hex');
const gateway = await startSpawnThroughGateway({
  token,
  handle: async (request) => {
    if (request.type === 'launch') return prepareSpawnThroughLaunch(request, host);
    // exec-failed: the shim could not run the recipe; it falls back in the same pid (or, strict, exits).
    await runtime.cancelPrepared(request.preparationId);
    records.withdraw(request.preparationId); // and stop that pid's watch
    return { action: 'ack' };
  },
});
await writeRendezvous(home, { port: gateway.port, token, strict: false, launchProviders });

// Every shell the host births:
const environment = { ...base, ...shellIntegrationEnvironment({ home, shell, environment: base }) };

// At exit:
await gateway.close();
await clearRendezvous(home, { token });
```

The duties, one by one:

- **Choose the runtime**: an absolute Node.js ≥ 22.15, or the host's Electron binary with `ELECTRON_RUN_AS_NODE=1`.
- **Resolve the real executables** before writing the table, and decide the names; a name the table lacks is never
  intercepted by the gateway.
- **Resolve terminals from your own evidence** (Godview matches the shell's pid to the request's `parentPid`, then its
  `pid`); answer `undefined` for anything else.
- **Watch the adopted pid and report its exit.** The agent is the shell's child, not yours: no exit event reaches you.
  `watchProcessExit` polls; `graceMs` gives your terminal's own exit event (completed, crashed, asked to stop) a turn
  to arrive first. Call `handleProcessExit` when it fires.
- **Handle `exec-failed`**: cancel the preparation, withdraw what `onAdopted` recorded and stop the pid's watch — the
  shim falls back to the real executable in that pid, unmanaged, or exits when strict — then answer `ack`.
- **Survive your own restart**: persist what `onAdopted` gave you with `processStartedAt(processId)`, and re-attach only
  a pid whose start time still matches — a reused pid is not your agent.

## 10. Limits

- **POSIX only.** The shim needs `execve`; a Windows host does not intercept.
- **zsh only**, for now (§6).
- **Strict waits for PU-9a** (§7).
- **The pid is self-asserted** (§8): the host's `resolveTerminal` is the whole binding.
- **A slow preparation outlives the shim's patience.** The shim waits 28 s for an answer. If a preparation takes longer,
  the shim gives up — falling back, or refusing when strict — while the host may still adopt; a fallen-back pid then
  runs the real executable under a record that receives no events until it exits. Keep preparation well inside the
  bound.
- **Every intercepted command pays the shim's start.** The bundle is about 640 KB, mostly Core's schemas and zod;
  measure it against the bare executable on your hardware before saying anything about how it feels.
