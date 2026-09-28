# Codex 0.157.1 invocation-grammar probes

**Probed:** 2026-09-27 (US Pacific; `startedAt` in the results is UTC), `codex-cli 0.157.1` (npm
`@openai/codex`, darwin-arm64), macOS. Lane U3x of PU-9a. They settle the classes and landings in
`packages/adapter-codex/src/launch/invocation-grammar.ts`; each row there cites the probes below as its
`evidence`.

The question each probe answers: a person types `codex <args>` in a terminal a host owns, and the host runs it
as a managed session — the adapter's private `codex app-server`, a thread the adapter starts, and
`codex resume <thread> --remote <addr>` in the terminal. Does each typed argument land where it means what it
means typed?

## Bounds

The owner allowed short real sessions for this lane (ruled 2026-09-27). None used the owner's account: every
live session ran **hermetically** — an isolated `CODEX_HOME`, `HOME` and `TMPDIR` in a throwaway directory
outside any repository, a credential-free `config.toml` pointing at a loopback Responses endpoint
(`test-support/live-model.ts`), a pseudo-terminal the harness owns. No model was reached and no session file was
written under the owner's home. The only runs against the owner's real `CODEX_HOME` were help forms
(`codex --help`, `codex resume --help`, `codex <subcommand> --help` for all 27 subcommands); codex creates
`$CODEX_HOME/tmp` at every start, which already existed. 23 live sessions (S1–S23) of a permitted 25.

## Method 1 — session-free parse probes

`parse-probe.mjs` runs `codex` with each case as an explicit argv array (no shell), stdin not a terminal,
`TERM=dumb`, an empty isolated `CODEX_HOME` and `HOME`, and a throwaway working directory, so no form can start
the TUI (it refuses a non-terminal stdin and a dumb terminal) or reach an account. Results: `parse-results.json`
(argv, exit code, first line of output).

**The shape was proven before use.** The brief's shape `codex <opts> mcp --help` does NOT validate: clap leaves
the last root option's value pending when a subcommand follows, and `mcp --help` prints before it is checked
(`--sandbox bogus mcp --help` → exit 0, mcp's help). `codex <opts> --help` does (`--sandbox bogus --help` →
exit 2 "invalid value 'bogus'"; `--sandbox read-only --help` → the help), and so does
`codex resume <opts> --help`. Arity is read with `<opt> mcp --help`: an option that takes a value swallows `mcp`
and the root help (or a value error) prints; a flag leaves `mcp` to be the subcommand.

What clap does at 0.157.1 (batch in `parse-results.json`):

| Fact | Probe |
| --- | --- |
| Every option's arity at the root and after `resume` matches the help | batch2 |
| A value-taking option never takes a token that starts with `-` (`-` alone is a value) | batch2, batch5 |
| `-i/--image` is variadic: `-i a.png mcp --help` prints the ROOT help (`mcp` became an image) | batch3 |
| An attached value ends the variadic: `--image=a.png mcp --help` prints mcp's help | batch5 |
| `-c`, `--enable`, `--disable`, `--add-dir`, `-i` repeat; `-m -s -a -p -C --search --last` error on a second use | batch3, batch2 |
| `-a` takes `on-request` and `never` only (`untrusted`, `on-failure`, `granular` are refused) | batch3 |
| `--model=x`, `-m=x`, `-mx`, `-sread-only`, `-s=read-only`, `-c=k=v`, `-ck=v` all parse; a flag with `=v` errors | batch3 |
| No long-option inference: `--mod x` and `--sea` are unknown | batch5 |
| Flag clusters act in order: `-hV` prints help, `-Vh` the version | batch5 |
| One root prompt (`hello world` errors); `resume` takes two positionals (`a b c` errors) | batch3 |
| A subcommand is recognized even after a prompt: `hello mcp --help` prints mcp's help | batch3 |
| Hidden subcommands: `execpolicy`, `responses-api-proxy`, `stdio-to-uds`, `tcp-tunnel`; hidden alias `cloud-tasks`; `r`, `f`, `mcp-server`, `proto`, `tui` are NOT subcommands (they become the prompt) | batch3 |
| `-V` works after `resume`, `exec`, `fork`; `login -V` is an error | batch3 |
| A root value before a subcommand is validated when the subcommand runs (`--sandbox bogus mcp list` → exit 2) | batch4 |
| `codex --no-daemon` cannot be combined with `--remote` (the binary's own message) | strings |

## Method 2 — live, hermetic

`packages/adapter-codex/src/launch/invocation-probe.live.test.ts` (opt-in, `CODEX_INVOCATION_LIVE=1`) runs the
cases in `live-cases.json`. Modes:

- `control` — the typed command in a PTY. Controls pass `--no-daemon`: a plain 0.157.1 `codex` installs and
  starts a shared daemon under its `CODEX_HOME` (S2), which this harness must not leave behind.
- `managed` — the recipe by hand: a private app-server (websocket transport, so no socket file lands outside the
  throwaway directory), a controller that `thread/start`s with the case's parameters, materializes and resumes
  exactly as the observer does, and `codex resume <thread> … --remote <tap>` in a PTY. The adapter's own tap
  records what the TUI sends.
- `typed-remote` — `codex --remote <tap> <typed>`: a typed TUI that starts its OWN thread on a tapped server,
  the path a typed `codex` takes to the shared daemon, so its `thread/start` is visible.
- `recipe` — the production path: `normalizeCodexNativeInvocation`, then `prepareCodexTuiSession`.

What a session means is read from the request that reaches the loopback model: `model`, the tools (including
`web_search.external_web_access`), `reasoning`, the permission text codex writes for the model, image inputs,
whether the prompt arrived; and from the PTY, whether the alternate screen was entered. The harness's raw
output stays with the prober; `live-results.json` is a whitelisted digest of it — screens, directories and
prompts dropped, thread ids and every other UUID redacted (UUIDv7 encodes the capture time), the worktree path
scrubbed — and every file here passes `checkCaptureFile` from `@vibecook/puppeteer-surface/sanitize` with no
issue. `live-cases.json` is the case list as run, prompts redacted the same way.

| # | Mode | Typed / carried | Observed |
| --- | --- | --- | --- |
| S1 | managed | bare recipe | TUI's `thread/resume` sends `model/sandbox/approvalPolicy: null`, `config: {web_search: cached}`; its `turn/start` carries `approvalPolicy`, `model`, `runtimeWorkspaceRoots` |
| S2 | control | bare `codex` | installs the shared daemon into the isolated `CODEX_HOME`, then fails: socket path longer than `SUN_LEN`; the detached daemon was killed by pid |
| S3 | managed | start `{model, sandbox: read-only, approvalPolicy: never}`; TUI `--no-alt-screen` | model, `sandbox_mode` read-only, "Approval policy is currently never"; the TUI's `turn/start` adopts `never` and the model; no alternate screen |
| S4 | control | `-m -s read-only -a never --no-alt-screen` | the same permission lines as S3, word for word; no alternate screen |
| S5 | managed | TUI `-c … --search --add-dir X` | TUI exited at once (cause recorded in S15) |
| S6 | control | `-c model_reasoning_effort=high --search --add-dir X` | `effort: high`, `external_web_access: true`, X a writable and workspace root; alternate screen on |
| S7 | managed | TUI `-m -s read-only -a never` | TUI: "Error: Permission overrides are not supported when resuming a remote task." |
| S8 | managed | TUI `resume <t> <prompt> --remote <addr> -i img` | the TUI submits `[image, text]` at once; image and prompt reach the model |
| S9 | control | `<prompt> -i img` | the same |
| S10 | managed | start `{sandbox: danger-full-access, approvalPolicy: never}` | "No filesystem sandboxing", "Approval policy is currently never", profile `disabled`, live web search |
| S11 | control | `--dangerously-bypass-approvals-and-sandbox` | identical to S10 |
| S12 | typed-remote | `--add-dir X` among others | "Error: --add-dir is not supported with --remote. Configure additional workspace roots on the server." |
| S13 | managed | TUI `-c model_reasoning_effort=high` | TUI sends it in `thread/resume` config; the request has NO effort — resume-time config does not reach the held thread |
| S14 | managed | TUI `--search` | TUI sends `web_search: live` on resume; the request keeps `external_web_access: false` |
| S15 | managed | TUI `--add-dir X` | the S12 error |
| S16 | managed | start `runtimeWorkspaceRoots: [ws, X]` | "thread/start.runtimeWorkspaceRoots requires experimentalApi capability" — no thread |
| S17 | control | `-c … --search --add-dir X --disable goals` | `effort: high`, live web search, no goal tools, X writable |
| S18 | typed-remote | `-c … --search --disable goals` | the typed TUI starts with `config: {web_search: live, features: {goals: false}, model_reasoning_effort: high}`, explicit `sandbox`/`approvalPolicy`; request `effort: high`, `summary: auto` (see deviations) |
| S19 | managed | server `-c model_reasoning_effort=high -c web_search=live --disable goals`, the same on the TUI's line | = S17/S18: `effort: high`, `summary: auto`, live web search, no goal tools |
| S20 | managed | TUI `--image=img`, prompt pasted | the TUI submits the image as its own first turn, then the pasted text |
| S21 | control | `-i img`, prompt pasted | the same |
| S22 | recipe | `-m -s read-only -a never --no-alt-screen -c … --search --disable goals --enable multi_agent_v2 -i img -- "- <prompt>"` | every observable above at once; `--enable multi_agent_v2` swaps the `multi_agent_v1` tools for `collaboration`; the dash-leading prompt arrives |
| S23 | recipe | `--dangerously-bypass-approvals-and-sandbox <prompt>` | = S11; the prompt arrives |

## What they settle

- **Start parameters.** `-m`, `-s`, `-a` and `--dangerously-bypass-approvals-and-sandbox` land on the thread's
  start parameters (S3/S4, S10/S11, S22, S23). The TUI refuses `-s`/`-a` on a remote resume (S7), so they have
  no other place.
- **Settings.** A thread takes its settings from the server that starts it: config sent on `thread/resume` for
  a thread the controller already holds is ignored (S13, S14). `-c`, `--enable`, `--disable` go on the private
  app-server's own command line, where codex parses them itself, and on the TUI's, which reads its own
  (S19 = S17/S18; S22). `--search` is the server's `web_search = live` — what the typed TUI makes of it (S14,
  S18) — plus the TUI's own flag. A `-c` for the sandbox, approvals, permissions, a profile or a project's trust
  would be overridden by the recipe's explicit start parameters, so it is rejected.
- **TUI.** The prompt (after `--`), `-i` with or without a prompt, and `--no-alt-screen` land on the TUI's line
  (S8/S9, S20/S21, S3/S4, S22).
- **Rejected on evidence:** `--add-dir` (S12, S15; the start parameter needs the experimental API, S16);
  `-p/--profile` (the app-server takes no `--profile`, and settings on the TUI's line do not reach the thread,
  S13/S14); `--no-daemon` (it cannot be combined with `--remote`).

## Deviations

- **Two accidental launch attempts, before the first probe of this record.** zsh does not split an unquoted
  variable, so `codex $args` passed ONE argument; `"mcp --sandbox bogus --help"` and
  `"resume --sandbox bogus --help"` were read as prompts and reached the TUI, which exited at
  "stdin is not a terminal" in a scratch directory. No session started (no session file under the owner's
  home is newer than the attempt). Every parse probe since runs from `parse-probe.mjs` with argv arrays.
- **S2 left a detached daemon.** A plain `codex` starts the shared daemon on its own
  (`daemon_auto_start` is a stable, on-by-default feature in 0.157.1); the daemon's socket could not bind (path
  too long) but its process stayed alive under launchd. It ran from the isolated home and was killed by pid; the
  harness now sweeps every process whose command line names a case's directory, and controls use `--no-daemon`.
- **S18 ran in the harness's directory.** A typed TUI on a bare `--remote` sends no `cwd`, so the server used
  its own working directory — the lane's worktree. The turn was the harmless prompt, answered with text only by
  the loopback model; nothing was written there. The harness now refuses a typed-remote case without `-C`.
- **The controls ran in-process (`--no-daemon`).** Their requests carry no `reasoning.summary`; every run
  against a separate server — the managed recipe and the typed-remote S18 alike — carries `summary: auto`. A
  typed `codex` on the owner's machine uses the shared daemon, a separate server, so the recipe matches it there.
- **No typed control for `--enable`.** S22 shows the feature switched on in the managed session; that it means
  the same typed rests on the help ("Equivalent to `-c features.<name>=true`") and on `--disable`'s controls.

## Rejected and unprobed — what a probe would have to show

| Row | The probe |
| --- | --- |
| `--oss`, `--local-provider` | a local model server; the `thread/start` a typed `--oss` sends (typed-remote with `-C`), reproduced by the recipe |
| `--approve-for-me` | the approvals reviewer a typed `--approve-for-me` starts its thread with, and a managed thread started with it |
| `--dangerously-bypass-hook-trust` | where the typed flag reaches the server (typed-remote with `-C` and a hook), reproduced managed |
| `--strict-config` | a `config.toml` with an unknown field: typed and managed must fail the same way, visibly |
| `resume --include-non-interactive` | a home holding one exec session; managed `resume --last --include-non-interactive` must pick it as typed does |
| `resume --last --all`, a word after `--last`/`--all`, `resume <name>` | the same picker probe, per form |
| `-c`/`--enable`/`--disable`/`--search` into `resume` | a resumed thread's settings, typed vs managed |
| `fork` | a managed fork recipe first; there is none |
