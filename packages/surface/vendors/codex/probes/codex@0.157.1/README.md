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
`$CODEX_HOME/tmp` at every start, which already existed. 35 live sessions: S1–S23 within the lane's bound of 25,
and S24–S35 for the follow-up on the person's own permissions, on the orchestrator's allowance of 12 more — all
hermetic. Two rollouts appeared under the owner's home during that follow-up; both are the owner's own (a
`vscode` session born before it began and its `guardian` subagent, working in the owner's checkout), not these
probes', whose homes were isolated.

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
| The config loader rejects a bad `approval_policy`/`sandbox_mode` in `config.toml` or `-c`; `approval_policy = "untrusted"` is "no longer supported; remove this setting"; `on-failure` still loads | config1, config3 |
| Both homes of the follow-up load, and so do its `-c`/`-s`/`-a` forms; a bad value under `-c` fails the load | config2, config3 |

`config-probe.mjs` is the method behind the config batches: each case writes `config.toml` lines into an empty
isolated `CODEX_HOME` and runs `codex [options] features list`, which loads the configuration and starts no
session.

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
issue. `live-cases.json` is the case list as run, prompts redacted the same way. From S24 on, each request also
records `permissionsDigest` and `filesystemDigest`: the first 16 hex of the sha256 of the exact
`<permissions instructions>` and `<filesystem>` blocks codex writes for the model (the case directory replaced
by `<root>`). Equal digests mean the model was told, byte for byte, the same thing about its sandbox, its
approvals and its writable roots.

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

The follow-up: the person's own permissions. Home A's `config.toml` sets `sandbox_mode = "read-only"` and
`approval_policy = "never"`; home B's `sandbox_mode = "danger-full-access"` and `approval_policy = "on-request"`
(plain values: no profiles). Digests are permissions / filesystem.

| # | Home | Mode | Typed / started | Observed |
| --- | --- | --- | --- | --- |
| S24 | A | control | `codex` | `29dad5ed6993c5e7` / `cad731d04e12db55`: read-only, "Approval policy is currently never" |
| S25 | A | managed | `thread/start {cwd}` — sandbox and approvalPolicy left out | = S24; the server answers `readOnly`/`never`; the TUI's `turn/start` says never |
| S26 | A | managed | as the recipe was: explicit `workspace-write`/`on-request` | `5f3fe02bf1469a5e` / `cf88e8febcedab0d`: workspace-write, on-request — the config.toml ignored; the TUI's `turn/start` says on-request, adopting the thread's policy over its own configuration |
| S27 | B | control | `codex` | `937f202d991330e3` / `f921d4975ea6ea88`: danger-full-access, live web search |
| S28 | B | managed | `thread/start {cwd}`, both left out | = S27; the server answers `dangerFullAccess`/`on-request` |
| S29 | B | control | `-a never -c sandbox_mode="read-only"` | `29dad5ed6993c5e7` / `cad731d04e12db55` (= S24) |
| S30 | B | recipe | the same, the `-c` on both lines | the TUI refused: "Error: Permission overrides are not supported when resuming a remote task." |
| S31 | B | control | `-s workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=true -c 'sandbox_workspace_write.writable_roots=["<extra>"]'` | `b45c9df489c442b6` / `fcfa7dc79c8fc410`: workspace-write, never, the extra directory writable |
| S32 | B | recipe | the same, the `-c`s on both lines | the TUI refused: "Error: sandbox_workspace_write.writable_roots overrides are not supported with --remote. Configure additional workspace roots on the server." |
| S33 | A | recipe | `codex` (production: `permissionDefaults: 'configuration'`) | = S24 |
| S34 | B | recipe | as S30, the permission `-c` on the app-server's line alone | = S29 |
| S35 | B | recipe | as S32, the permission `-c`s on the app-server's line alone | = S31 |

## What they settle

- **Start parameters.** `-m`, `-s`, `-a` and `--dangerously-bypass-approvals-and-sandbox` land on the thread's
  start parameters (S3/S4, S10/S11, S22, S23). The TUI refuses `-s`/`-a` on a remote resume (S7), so they have
  no other place.
- **Settings.** A thread takes its settings from the server that starts it: config sent on `thread/resume` for
  a thread the controller already holds is ignored (S13, S14). `-c`, `--enable`, `--disable` go on the private
  app-server's own command line, where codex parses them itself, and on the TUI's, which reads its own
  (S19 = S17/S18; S22). `--search` is the server's `web_search = live` — what the typed TUI makes of it (S14,
  S18) — plus the TUI's own flag.
- **The person's own permissions.** Left out of `thread/start`, the sandbox and the approval policy come from
  the app-server's own configuration, byte for byte what a typed `codex` tells the model (S24 = S25,
  S27 = S28); the explicit defaults the recipe used to send override a `config.toml` (S26). A typed launch now
  leaves out whichever the person did not type (S33 = S24; `-a` alone S34 = S29; `-s` alone S35 = S31).
- **Permission settings.** `-c sandbox_mode`, `-c approval_policy` and `-c sandbox_workspace_write.*` reach the
  thread from the app-server's line as they do typed (S34 = S29, S35 = S31). They go to that line alone: the
  TUI refuses them on a remote resume (S30, S32) and takes the thread's policy instead (S25, S26).
  `approvals_reviewer`, `default_permissions`, `permissions`, `sandbox_permissions`, `profile` and `projects`
  are unprobed and stay refused.
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
- **S30 and S32 are the first recipe runs of the permission settings,** which then went to the TUI's line as
  well; the TUI refused to start. The recipe changed (the app-server's line alone) and S34/S35 re-ran them.
- **Home B is not `untrusted`.** 0.157.1's config loader refuses `approval_policy = "untrusted"` (config1,
  config3), so the second home pairs `danger-full-access` with `on-request`.
- **Three managed starts for home A, two for home B.** S26 measures the old explicit defaults once; home B has
  no such run, as its divergence is the same explicit parameters overriding a `config.toml`.

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
| `-c approvals_reviewer` | the reviewer a typed thread starts with (typed-remote with `-C`, or the model's permission text if it shows), and the recipe's with the setting on the app-server's line |
| `-c default_permissions`, `-c permissions.*` | a permission profile: typed vs the recipe (both on the app-server's line), equal permission and filesystem digests |
| `-c sandbox_permissions` | the same comparison for the legacy list |
| `-c profile`, `-c projects.*` | a selected settings profile, and an untrusted working directory made trusted: typed vs managed. Every probe here ran in a trusted workspace; what an untrusted directory gives typed and managed is not measured |
