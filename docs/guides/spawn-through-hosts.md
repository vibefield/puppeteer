# Spawn-Through for Terminal Hosts

**Status:** Current host guide, 2026-09-27 (PU-17; PU-9a: what an invocation is, and strict)

**Audience:** Developers of an application that owns terminals — a desktop app, a daemon — and wants a command a
person types in one of them to start as a managed Puppeteer session

**Companions:** `docs/rfcs/004-layered-agent-runtime.md` defines the launch boundary (`launchProviders()` →
`prepareInvocation()` → `adoptPrepared()`, with `classifyInvocation()` to ask first what an invocation is); the kit
lives in `packages/runtime/src/host/spawn-through/` and is exported as `@vibecook/puppeteer-runtime/spawn-through`;
Godview (`apps/godview`) is the reference host.

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
7. [Strict: what an invocation is, and when a host refuses one](#7-strict-what-an-invocation-is-and-when-a-host-refuses-one)
8. [Security](#8-security)
9. [What a host does itself](#9-what-a-host-does-itself)
10. [Limits](#10-limits)

---

## 1. What the kit gives, and what a host supplies

| The kit gives | The host supplies |
| --- | --- |
| the shim (`./spawn-through/shim`) | its bundle, and the runtime that runs it (§5) |
| `materializeShims`: the home, a launcher per name, the zsh integration | the home's path; which names to intercept |
| `writeRendezvous` / `readRendezvous` / `clearRendezvous` | a fresh, random bearer, and its custody; its label |
| `startSpawnThroughGateway`: the loopback listener, the strict parser | the listener's lifetime |
| `prepareSpawnThroughLaunch`: classify → terminal → prepare → adopt | `resolveTerminal`: which terminal holds a pid; the words of a refusal |
| `writeTerminals` / `readTerminals`: the shells the host owns | the list, kept current (§7) |
| `findOwningProcess`, `readProcessTable`: a process's ancestry against a list of owners | — (a host's `resolveTerminal` can use them) |
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
   allow-listed variables, its own pid and its parent's, the name it was run as, and whether its input and output are a
   terminal (`interactive`).
4. The gateway checks the bearer and parses strictly; the host's handler calls `prepareSpawnThroughLaunch`. It asks the
   runtime what the invocation is (`classifyInvocation`: the adapter's grammar, nothing prepared), asks the host which
   terminal contains the pid, prepares the invocation (the adapter normalizes the argv and chooses its hooks, sockets
   and logs), adopts the preparation in that terminal with that pid (cancelling it if adoption fails), lets the host
   record the run, and answers `exec` with the adapter's recipe.
5. The shim `execve`s the recipe in place. The agent starts managed, in the terminal the person typed into.

Any other answer is a decline, with a code (§7): `fallback` execs the real executable with the original argv — a version
query, a one-shot run, an agent outside the host's terminals all run this way — and `refuse` (a strict host, in one of
its own terminals) execs nothing, prints the host's words and exits 75.

## 3. The shim home

The host chooses the path; the kit owns everything inside it.

```text
<home>/                       0700
  gateway.json                0600   the rendezvous (writeRendezvous)
  launch-providers.json       0600   AgentLaunchProvider[] with each command's real executable (writeRendezvous)
  terminals.json              0600   the shells the host owns (writeTerminals, §7)
  bin/<name>                  0700   one launcher per name — this directory is PUPPETEER_SHIM_DIR
  lib/agent-shim.cjs          0600   the bundled shim, copied from the host's build
  zsh/.zshenv                 0600   the zsh integration
```

`materializeShims({home, names, script, runtime, strict?, hostLabel?})` writes `bin/`, `lib/` and `zsh/`. It is
idempotent — an identical call rewrites no file, so a shell running a launcher at that moment is untouched — and it
removes the launcher of any name no longer asked for. It refuses, before writing anything, a name outside Core's
command-name rule (a name is written into a shell script), a relative home or runtime, runtime variables named `PATH`
or `PUPPETEER_SHIM_*`, and a label no shim could say. Every file is published by writing a temp file in the same
directory, setting its mode, and renaming it over the name: no reader sees a half-written file.
`spawnThroughLayout(home)` spells every path.

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
  "pid": 4242,
  "hostLabel": "<label>"
}
```

A host's shells can outlive it: a daemon restarts under panes a person is still using. A port and bearer baked into a
shell's environment at birth go stale at the first restart; files do not. The shim follows a host that restarted, moved
port, rotated its bearer, turned strict on, or installed another agent — with no change to any shell.

- `writeRendezvous(home, {port, token, strict, retryMs?, launchProviders, imposterExecutable?, hostLabel?})` publishes
  the provider table, then the rendezvous. It throws, before writing, on values no shim could use.
- `hostLabel` (1–64 printable characters) is the host's name. The shim prints it at the head of every line, where a
  host without one gets `puppeteer`, and says it in place of "the host" in its own sentences (§7). A label a shim
  cannot read is dropped, never a reason to lose the host.
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
export PUPPETEER_SHIM_LABEL='<label>'
export ELECTRON_RUN_AS_NODE='1'
exec '<runtime>' '<home>/lib/agent-shim.cjs' "$@"
```

The label line is written only for a `hostLabel`: the launcher's say, like `strict`, for when no rendezvous is
readable — the moment the shim speaks for a host that is gone.

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

## 7. Strict: what an invocation is, and when a host refuses one

A strict host runs an agent in its own terminals as a managed session, or not at all. It refuses nothing else: not a
command that is not a session, and not an agent outside its own terminals. The division of labour is the law of this
section: **the adapter states the fact of what an invocation is; the host owns the policy for its own terminals; the
kit never refuses what is not a session in a terminal the host owns.** The kit and the runtime hold no CLI grammar.

### What an invocation is

An adapter's normalizer reads the argv a person typed and answers one of three things:

| The adapter answers | What the invocation is | For example |
| --- | --- | --- |
| `accepted` | an interactive session here, every argument carried | `<name>`, `<name>` resuming a conversation |
| `passthrough`, kind `utility` | it runs no agent | a version query, help, a management subcommand |
| `passthrough`, kind `one-shot` | it runs an agent non-interactively, in this process | a print or exec mode |
| `passthrough`, kind `elsewhere` | it starts or opens an agent that does not live in this process | a background, cloud or attach command |
| `rejected`, with the `argument` | an interactive session here that the managed launch cannot carry | an option the adapter cannot pass on, or has never seen |

`runtime.classifyInvocation(invocation)` asks the adapter and nothing more: it makes the checks `prepareInvocation`
makes before it prepares anything (the schema, the provider and its capability, the environment allow-list, the
adapter's grammar) and starts no run, prepares nothing, writes no file and starts no process. It never returns the
adapter's options. The failures that are not the adapter's word come back as `unsupported`. `prepareInvocation` answers
a passthrough with `NATIVE_INVOCATION_PASSTHROUGH` (the kind in `error.passthrough`) and a rejection with
`INVALID_NATIVE_INVOCATION` (the argument in `error.argument`).

**Its input and output.** The shim says in its request whether its standard input and output are both a terminal
(`interactive`). A launch whose output is redirected (`<name> "…" > out.txt`) or whose input is piped is a one-shot run
whatever its argv says: the agent itself switches to non-interactive output. A request from a shim that predates the
field reads as interactive.

### What a host answers

| The launch | Not strict | Strict |
| --- | --- | --- |
| a passthrough, of any kind | runs as typed | runs as typed |
| accepted or rejected, but its input or output is not a terminal | runs as typed | runs as typed |
| in no terminal of the host's | runs as typed | runs as typed |
| accepted, interactive, in the host's terminal | managed | managed |
| rejected, interactive, in the host's terminal | runs as typed | refused, naming the argument |
| an agent the host cannot manage (unsupported, no imposter, a failed preparation or adoption), interactive, in the host's terminal | runs as typed | refused |

"Runs as typed" is `fallback`: the real executable, the original argv, unmanaged. **The rule of refusal:** the kit
answers `refuse` only when all three hold — the host is strict; the invocation is an interactive session (the adapter
did not call it a passthrough, and its input and output are a terminal); and the process is in a terminal the host
owns (`resolveTerminal` answered one). `prepareSpawnThroughLaunch` establishes them in that order: it classifies first,
so a version query never waits on a terminal lookup; then it resolves the terminal; only then does it decline.

### `classifies`: which agents get a launcher

`nativeInvocation.classifies` is `true` when the adapter's normalizer tells a utility, a one-shot and an elsewhere
invocation apart from a session, so that its `rejected` means "a session I cannot carry". An adapter that does not
classify answers `rejected` for its own version query too, and a strict host would refuse it. **A strict host gives a
launcher only to agents whose adapters classify** (read the flag from `runtime.launchProviders()`); typed by name, any
other agent runs as the shell runs it. Absent reads as `false`.

### Why a strict host never refuses outside its own terminals

The launcher's directory leaks. A shell the host births puts the shim directory at the head of `PATH`, and every
process started from that shell inherits it: an editor opened from it, a terminal multiplexer's server, a detached job.
An agent typed in that editor's terminal reaches the launcher but lives in no terminal of the host's. Refusing it there
would break the agent outside the host — and with the host down, a strict shim would first wait out its whole retry
time. A strict host governs its own terminals, and nothing else.

The host places a process with `resolveTerminal`. When the host cannot — the gateway is unreachable, a request fails,
an answer cannot be read, or the gateway refuses a request it could not read or trust — the shim holds the rule itself:
it reads the list of the host's shells (`terminals.json`), reads the process table once, and walks its own ancestors.
It waits, or refuses, only when the launch is interactive and one of its ancestors is a listed shell. Anywhere else, or
when there is no list, it runs as typed, at once: nobody can say it is one of the host's terminals.

### `terminals.json`: the shells the host owns

```json
{
  "format": 1,
  "writtenAt": "2026-09-27T21:00:00.000Z",
  "terminals": [{ "pid": 4242, "startedAt": "2026-09-27T20:58:41.000Z" }]
}
```

**The host writes it**, with `writeTerminals(home, terminals)`: at its start, and whenever a terminal of its own is
born or ends. Each entry is a shell's pid and its start as `processStartedAt(pid)` reports it, so a pid the system
reused is never taken for the shell. The file is 0600 and published whole; `readTerminals(home)` never throws. An
empty list is a list: the host owns no terminal now.

`findOwningProcess({pid, owners})` is the walk: the first owner that is `pid` or one of its ancestors, matched by pid
and start, over at most 32 processes (a cycle or pid 1 ends it). The process table is read once, with `ps`
(`readProcessTable`). A host's `resolveTerminal` can pass its own terminal records as the owners and get its record
back.

### The four places strictness lives

| Place | Its refusal |
| --- | --- |
| `SpawnThroughHost.strict`: the declines of `prepareSpawnThroughLaunch` | placed: it refuses only after `resolveTerminal` answered |
| `startSpawnThroughGateway({strict})`: a bad bearer, an oversize or unreadable request, a throwing handler | unplaced: the gateway cannot place what it could not read or trust |
| `writeRendezvous({strict})`: the gateway unreachable | the shim's own, by its ancestry |
| `materializeShims({strict})`: the launcher's word while no rendezvous is readable | the shim's own, by its ancestry |

A `refuse` answer carries `placed`. The shim obeys a placed refusal wherever it runs, and an unplaced one only under a
listed shell: an argv over 64 KiB typed in one of the host's terminals is still refused; typed in an editor's terminal,
it runs. When the gateway cannot be reached and an interactive launch is in one of the host's terminals, the shim
retries with backoff (100 ms doubling to 1 s) for `retryMs`, says once that it waits, re-reads the rendezvous every
try — a host that comes back is used — and then refuses with exit 75. A shim reads the host's latest readable
rendezvous first; the launcher speaks only while none has been readable. A name with no row in the provider table, or
a home with no table, is never refused: the table is the host's word on what it manages.

### A refusal's code, and the host's words

Every `fallback` and `refuse` answer carries a stable `code` (`SpawnThroughDeclineCode`) beside its `reason`; switch
on the code, never on the reason's words:

| Code | Where |
| --- | --- |
| `unauthenticated`, `request-too-large`, `handler-failed` | the gateway's own: a wrong bearer or a request of the wrong shape (one answer for both), over 64 KiB, a throwing handler |
| `invalid-request` | the request's process identity or intent does not parse |
| `passthrough`, `not-interactive` | not a session: the adapter's word, or its input or output is not a terminal |
| `outside-host-terminals` | no terminal of the host's holds the process |
| `unsupported-agent`, `invalid-invocation` | the runtime offers no managed invocation for it, or would not put it to the adapter |
| `rejected-argument` | the adapter's grammar: an argument the managed launch cannot carry |
| `imposter-unavailable` | the imposter route it asked for is not available beside the host |
| `prepare-failed`, `terminal-conflict`, `adopt-failed` | the preparation failed; the terminal already runs a managed session; the adoption failed |

A person in the host's terminal reads the host's own words, under the host's own name.
`SpawnThroughHost.refusal(refused)` receives `{code, reason, argument?, providerId, command}` — `command` is the name
the person typed — and returns one or two lines, which the shim prints after `<label>: <command>: `, where `<label>`
is the host's `hostLabel`, or `puppeteer` for a host that gave none. The kit keeps printable characters only, two
lines at most and 400 characters at most (`MAX_REFUSAL_MESSAGE_LENGTH`), and the shim holds what it prints to the
same bound, the label inside it: the longer the label, the less room for the words. Absent, throwing, or left empty
by the bound, the words are the kit's own (`spawnThroughRefusalMessage`, which a host can call for the codes it does
not word itself).

The shim speaks for itself when the host cannot answer ("waiting for the host to start it as a managed session…",
"the host did not answer within 8 s"). Give `writeRendezvous` and `materializeShims` the same `hostLabel` and every
line carries it, in the sentence as well as at its head:

```text
<label>: <name>: waiting for <label> to start it as a managed session…
<label>: <name>: not started: <label> did not answer within 8 s
```

### Before a host turns strict on

- launchers only for agents whose adapters classify;
- `terminals.json` kept current, from the host's start;
- its own words: `refusal`, and `hostLabel`;
- `strict` in all four places.

### The limit

An agent started inside a terminal multiplexer (tmux, screen) that runs in one of the host's terminals is not in that
terminal's process tree: the multiplexer's server is not a descendant of the shell. By the rule it runs unmanaged, just
as an agent in an editor's terminal does. A host that wants to refuse it needs a rule this kit does not have yet.

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
  gateway is printed as printable characters only, on two lines at most, bounded. A host must not log recipes or
  requests either. The one thing a host may keep is its own stable-ingress record (RFC 003), owner-only, beside its
  session records.
- **The list of the host's shells is a same-user file like the rest** (`terminals.json`, 0600). A process that
  rewrites it can make a strict shim wait and refuse, or let an agent run unmanaged — which it could do anyway, by
  running the real executable. The shim runs `ps` with its own directory taken off PATH, so no launcher stands in
  for it.

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
  findOwningProcess,
  materializeShims,
  prepareSpawnThroughLaunch,
  processStartedAt,
  shellIntegrationEnvironment,
  startSpawnThroughGateway,
  watchProcessExit,
  writeRendezvous,
  writeTerminals,
  type SpawnThroughHost,
} from '@vibecook/puppeteer-runtime/spawn-through';

const strict = true;
const hostLabel = '<label>';
// Each command's real executable, resolved on the host's own PATH to an absolute path; the names it offers. A strict
// host offers only agents whose adapters classify (§7).
const launchProviders = resolveExecutables(runtime.launchProviders()).filter(
  (provider) => !strict || provider.nativeInvocation?.classifies === true,
);
const names = launchProviders.flatMap((provider) => provider.nativeInvocation?.commands.map(({ name }) => name) ?? []);
await materializeShims({ home, names, script: bundledShim, runtime: { command: nodeExecutable }, strict, hostLabel });

const host: SpawnThroughHost = {
  runtime,
  strict,
  // The host's own shells ({pid, startedAt, terminalSessionId}), walked from the pid up.
  resolveTerminal: async ({ pid }) => findOwningProcess({ pid, owners: shells.all() }),
  // One or two lines, printed after `<label>: <command>: `.
  refusal: ({ command, code, argument }) => wordsFor(command, code, argument),
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
  strict,
  handle: async (request) => {
    if (request.type === 'launch') return prepareSpawnThroughLaunch(request, host);
    // exec-failed: the shim could not run the recipe; it falls back in the same pid (or, strict, exits).
    await runtime.cancelPrepared(request.preparationId);
    records.withdraw(request.preparationId); // and stop that pid's watch
    return { action: 'ack' };
  },
});
await writeRendezvous(home, { port: gateway.port, token, strict, launchProviders, hostLabel });
await writeTerminals(home, shells.all());

// Every shell the host births — and, when one ends, the list again:
const environment = { ...base, ...shellIntegrationEnvironment({ home, shell, environment: base }) };
shells.add({ pid: shellPid, startedAt: await processStartedAt(shellPid), terminalSessionId });
await writeTerminals(home, shells.all());

// At exit:
await gateway.close();
await clearRendezvous(home, { token });
```

The duties, one by one:

- **Choose the runtime**: an absolute Node.js ≥ 22.15, or the host's Electron binary with `ELECTRON_RUN_AS_NODE=1`.
- **Resolve the real executables** before writing the table, and decide the names; a name the table lacks is never
  intercepted by the gateway.
- **Resolve terminals from your own evidence** (Godview matches the shell's pid to the request's `parentPid`, then its
  `pid`; `findOwningProcess` walks the pid's ancestors against your shells, which also finds an agent a subshell
  started); answer `undefined` for anything else.
- **Keep `terminals.json` current**: write the list at your start and whenever one of your terminals is born or ends,
  each shell with its start from `processStartedAt`. It is how a strict shim knows your terminals while you are away.
- **Word your refusals, and name yourself**: `refusal` for the sentence a person reads, and the same `hostLabel` in
  `writeRendezvous` and `materializeShims` for the name at the head of every line the shim prints and in its own
  sentences. Without one, a person reads `puppeteer`, a name they never chose.
- **Watch the adopted pid and report its exit.** The agent is the shell's child, not yours: no exit event reaches you.
  `watchProcessExit` polls; `graceMs` gives your terminal's own exit event (completed, crashed, asked to stop) a turn
  to arrive first. Call `handleProcessExit` when it fires.
- **Handle `exec-failed`**: cancel the preparation, withdraw what `onAdopted` recorded and stop the pid's watch — the
  shim falls back to the real executable in that pid, unmanaged, or exits when strict — then answer `ack`.
- **Survive your own restart**: persist what `onAdopted` gave you with `processStartedAt(processId)`, and re-attach only
  a pid whose start time still matches — a reused pid is not your agent.

## 10. Limits

- **POSIX only.** The shim needs `execve`; a Windows host does not intercept. The shim's own walk needs a `ps` that
  prints `lstart` (procps and the BSDs do; BusyBox does not — there the walk finds no shell, and the launch runs).
- **zsh only**, for now (§6).
- **Strict needs adapters that classify** (§7). An agent whose adapter does not gets no launcher from a strict host.
- **A strict host that is down still refuses in its own terminals.** The shim cannot ask an adapter what an invocation
  is — the grammar lives in the runtime, not in the shim — so while the host cannot answer, an interactive invocation in
  one of its terminals waits `retryMs` and is refused, a version query among them. Only a launch whose input or output
  is not a terminal runs at once.
- **Multiplexers** (§7): an agent inside tmux or screen in one of the host's terminals runs unmanaged.
- **The pid is self-asserted** (§8): the host's `resolveTerminal` is the whole binding.
- **A slow preparation outlives the shim's patience.** The shim waits 28 s for an answer. If a preparation takes longer,
  the shim gives up — falling back, or refusing when strict — while the host may still adopt; a fallen-back pid then
  runs the real executable under a record that receives no events until it exits. Keep preparation well inside the
  bound.
- **Every intercepted command pays the shim's start.** The bundle is about 640 KB, mostly Core's schemas and zod;
  measure it against the bare executable on your hardware before saying anything about how it feels. A strict shim
  that cannot reach its host also reads the whole process table, once.
