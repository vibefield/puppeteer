# Phase 0 — Hook Surface Findings

## 2.1.226 adaptation candidate (2026-08-09)

Claude Code **2.1.226** was the official latest release when this candidate was
prepared. The exact installed darwin-arm64 artifact reported
`2.1.226 (Claude Code)` and has SHA-256
`013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe`.
The release identity, binary probes, reviewed hook reference, sanitized
captures, and generated ASM v2 tree are independently digest-bound in
`model/claude@2.1.226/evidence.json`.

A bounded static probe of that same digest-pinned executable also verifies the
`subagentStatusLine` input surface. Claude passes a full `tasks[]` snapshot
whose task rows expose `id`, `name`, `type`, `status`, `description`, `label`,
`startTime`, `model`, `effort`, `contextWindowSize`, `tokenCount`,
`tokenSamples`, and `cwd`. The probe stores only those derived facts, its byte
window coordinates, and the window digest in
`probes/claude@2.1.226/status-channels.json`; it does not retain bundled source
text. The rolling history is capped at 16 numeric totals and the command has a
nominal 5-second timer, but individual history entries carry no timestamps.
The adapter therefore samples the current `tokenCount` at callback receipt
time and does not invent times for `tokenSamples`. This verifies presence and
shape in the exact artifact, but not an authenticated runtime invocation.

The repeatable census in `census/harness.mjs` used a disposable
`CLAUDE_CONFIG_DIR`, no credentials, and two authentication-independent paths:
`--init-only` and a minimal failed print-mode turn. It observed ten records
covering seven events: `SessionStart`, `Setup`, `InstructionsLoaded`,
`UserPromptSubmit`, `MessageDisplay`, `StopFailure`, and `SessionEnd`. In
particular, `prompt_id` is absent from the init-only `SessionEnd`, so it is now
modeled as optional instead of universally required.

Anthropic's [current hook reference](https://code.claude.com/docs/en/hooks)
declares 31 events for this release. Compared with the 2.1.207 model, the
candidate adds `Setup`, `UserPromptExpansion`, `PostToolBatch`,
`PermissionDenied`, and `DirectoryAdded`; the field-level review is frozen in
`references/claude@2.1.226/hooks.json`. Events not forced by the isolated
census remain explicitly `unverified` even though the adapter wires the whole
official set.

The material protocol correction is permission ordering. In 2.1.226,
`PreToolUse` runs before every tool call, then `PermissionRequest` runs only if
a decision is needed. `PermissionRequest` still has no `tool_use_id`. The
adapter now correlates the two by prompt, tool name, and canonical tool input;
`PostToolUse` or `PostToolUseFailure` proves allow, `PermissionDenied` closes an
auto-mode denial, and turn/session boundaries close manual denials so no
permission remains orphaned. The reverse 2.1.207 order is retained as a tested
compatibility path, not the primary lifecycle.

The Imposter persona points at this candidate and its permission scenarios use
the 2.1.226 ordering. Command-only `SessionStart` and `Setup` hooks now use a
generated Node forwarder instead of the old POSIX `curl` command; all other
official events use the HTTP bridge. Shared conformance exercises resume and
owned-resource cleanup through both the synthetic adapter harness and the real
Imposter subprocess.

This is intentionally staged as a **candidate**, not promoted support. Only
darwin-arm64 currently has immutable artifact and runtime-census evidence; the
protected four-platform workflow must attest darwin-arm64, darwin-x64,
linux-x64, and windows-x64 before `currentVersion` can move.

---

> **Current location (2026-08-08):** sanitized captures live in `packages/surface/vendors/claude/captures/claude@2.1.207/` (`headless/` + `interactive/`) and are distilled into `packages/surface/vendors/claude/model/claude@2.1.207/`.
>
> **Compatibility status (2026-08-09):** this historical ASM/evidence v1 baseline is `legacy-verified`. Its original darwin-arm64 census did not retain the exact binary digest, and the other three required platform artifacts were not acquired. It remains the current compatibility projection, but the guarded promotion path will not label it unqualified `verified`; a future Claude candidate must be rebuilt as claim-addressable ASM v2 and pass the complete platform matrix.

**Probed:** 2026-07-12, Claude Code **2.1.207**, macOS (darwin)
**Historical method:** generated per-event command-hook settings plus a live loopback HTTP listener. The exact accepted settings are retained under `packages/surface/vendors/claude/references/claude@2.1.207/`; the productized equivalent is `packages/surface/vendors/claude/census/harness.mjs`. Six headless (`-p`) sessions, runs A–F.
**Plan reference:** `IMPLEMENTATION-PLAN.md` §5.

---

## 1. Verdicts

| Question (DESIGN ref)                                                                               | Verdict                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--session-id`, `-n/--name`, `--settings`, `--permission-mode` exist (§16.3)                        | **YES**, all four                                                                                                                                                               |
| `--session-id <uuid>` → transcript at `~/.claude/projects/<slug>/<uuid>.jsonl` (§2.1 join contract) | **YES** — validated end-to-end, run A                                                                                                                                           |
| `type: "http"` hooks accepted and actually POST (§16.4)                                             | **YES** — POST received, JSON body identical to command-hook stdin, `Authorization: Bearer $VAR` interpolated via `allowedEnvVars`, 200 accepted                                |
| `MessageDisplay` exists (§16.7 warning)                                                             | **YES** — but payload differs from DESIGN's guess (see §3)                                                                                                                      |
| `UserPromptSubmit` carries `prompt_id` + `prompt` (§17.2 confirmation match)                        | **YES**, both                                                                                                                                                                   |
| `PreToolUse`/`PostToolUse` carry `tool_use_id` (§14.4)                                              | **YES**, plus `tool_response` and `duration_ms` on Post                                                                                                                         |
| Unknown event names in settings                                                                     | **Silently tolerated** — no validation error, no capture. Registry may include speculative names safely                                                                         |
| `PermissionRequest` fires headless when a tool is denied                                            | **NO** — print-mode denial fires `PreToolUse` only, then nothing. Captured interactively instead (M1 done — see §3.1); it fires when the dialog is _shown_, before approve/deny |

**Go/no-go on HTTP hooks: GO.** Hybrid bridge per DESIGN §16.4 stands; the command-forwarder is fallback only.

---

## 2. Common envelope (observed on every event)

```
session_id        uuid (equals our --session-id)
transcript_path   absolute path to the session JSONL  ← handed to us; no path construction needed
cwd               session working directory
hook_event_name   the event name
```

Post-prompt events additionally carry `prompt_id` (uuid), and most carry `permission_mode`; tool/stop events carry `effort: { level }`.

**`prompt_id` is the native turn ID** — DESIGN's `turn.started { turnId }` maps directly. Note: `MessageDisplay` carries **both** `prompt_id` and a distinct `turn_id` (plus `message_id`) — there are two correlation levels (user prompt vs. assistant response cycle). Normalizer should preserve both.

---

## 3. Event census (headless runs A–F)

| Event                                     | Fired              | Notable payload fields beyond envelope                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`                            | ✓                  | `source: "startup"`, `session_title` (from `-n`)                                                                                                                                                                                              |
| `SessionEnd`                              | ✓                  | `reason` (`"other"` observed), `prompt_id`                                                                                                                                                                                                    |
| `UserPromptSubmit`                        | ✓                  | `prompt`, `prompt_id`, `session_title`, `permission_mode`                                                                                                                                                                                     |
| `InstructionsLoaded`                      | ✓                  | `file_path`, `memory_type` (`"User"`), `load_reason` (`"session_start"`)                                                                                                                                                                      |
| `PreToolUse`                              | ✓                  | `tool_name`, `tool_input`, `tool_use_id`, `prompt_id`, `permission_mode`, `effort`                                                                                                                                                            |
| `PostToolUse`                             | ✓                  | ditto + `tool_response` (full result object), `duration_ms`                                                                                                                                                                                   |
| `MessageDisplay`                          | ✓                  | **streaming**: `delta`, `index`, `final`, `turn_id`, `message_id` — not the single-`text` shape DESIGN §16.7 sketched                                                                                                                         |
| `Stop`                                    | ✓                  | `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]`                                                                                                                                                         |
| `PermissionRequest`                       | ✓ interactive (M1) | envelope + `prompt_id`, `permission_mode`, `effort`, `tool_name`, `tool_input`, `permission_suggestions[]`. **No `tool_use_id`** (see §3.1)                                                                                                   |
| `PostToolUseFailure`                      | ✓ interactive (M1) | envelope + `tool_name`, `tool_input`, `tool_use_id`, `duration_ms`, `error` (string), `is_interrupt` (bool). Fires when an **approved** tool executes and fails (exit≠0)                                                                      |
| `Notification`                            | ✓ interactive (M1) | `message`, `notification_type` (`"permission_prompt"` observed). Envelope + `prompt_id`; no `permission_mode`/`effort`                                                                                                                        |
| `SubagentStart`                           | ✓ interactive (M1) | envelope + `prompt_id`, `agent_id` (17-hex, **not** a uuid), `agent_type` (`"general-purpose"`)                                                                                                                                               |
| `SubagentStop`                            | ✓ interactive (M1) | envelope + `agent_id`, `agent_type`, `agent_transcript_path` (subagent's own JSONL), `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]`. **Fires repeatedly** — 1× `stop_hook_active:false` then N× `true` |
| `TaskCreated`, `TaskCompleted`            | ✗                  | did **not** fire when the Task tool spawned a subagent (that path fires `Subagent*`). Distinct task system; needs a different trigger                                                                                                         |
| `Task*`, `PreCompact/PostCompact`, others | not exercised      | need targeted triggers                                                                                                                                                                                                                        |

The original raw headless and interactive probe captures were sanitized into the current Surface capture tree. The tracked set covers 13 events: the 8 headless events plus `PermissionRequest`, `Notification`, `PostToolUseFailure`, `SubagentStart`, and `SubagentStop`. Adapter tests load this canonical set directly; Testing carries no vendor fixtures.

### 3.1 Interactive census (M1)

**Historical method:** the now-retired `packages/node/scripts/interactive-census.mjs` drove a real Claude Code TUI through `node-pty` (the script remains available in repository history). Two authorized sessions forced a denied Bash permission dialog, then an approved-but-failing Bash plus one Task subagent. Every wait was bounded; the driver group-killed on timeout and verified no `claude` process survived.

**PermissionRequest correlation (priority finding):** the payload has **no `tool_use_id`** and no dedicated request-id. The permission gate fires _before_ the tool call is assigned an id, so the bridge must correlate a PermissionRequest to its later `PreToolUse`/`PostToolUse` by **`prompt_id` + `tool_name` + `tool_input`** (a PreToolUse for the same call carries `tool_use_id`). `permission_suggestions[]` is the dialog's "always allow" options (`addRules` / `addDirectories` / `setMode`, each with a `destination` such as `session` / `localSettings`).

**Denial signal:** a denied tool fires `PreToolUse` with **no matching `PostToolUse` and no `PostToolUseFailure`** — the same "Pre without Post" absence pattern seen headless (§4.4). Only an _approved_ tool that then errors yields `PostToolUseFailure`.

**`Notification`** fired once when the permission dialog appeared (`notification_type: "permission_prompt"`).

---

## 4. Adapter implications (feed into `adapter-claude/registry.ts`)

1. **Bridge:** HTTP transport for everything we verified; keep the command-forwarder path implemented but demoted to fallback. Residual unknown: whether _every_ event type supports `type: "http"` — probe per-event during M2-2 registry work.
2. **Normalizer changes vs DESIGN §16.7:**
   - `assistant.message` builds from `MessageDisplay` **deltas** (accumulate by `message_id`, emit on `final: true`) — or skip display events entirely and take message content from the transcript observer; decide in M2-4 with both sources in hand.
   - `turn.started` uses `prompt_id`; keep `turn_id` as a secondary correlation field.
   - `session.ready` proxy: `SessionStart` arrives at process start; `InstructionsLoaded` (`load_reason: "session_start"`) is a useful "boot finished" refinement.
3. **Prompt confirmation (§17.2):** `UserPromptSubmit.prompt` is verbatim — exact-match against injected text is viable (normalize trailing newline only).
4. **Permission observation:** denial (headless AND interactive) is invisible beyond `PreToolUse` with no matching Post — the _absence_ pattern (Pre without Post/Failure within timeout) is the "denied or stuck" signal. `PermissionRequest` itself fires at dialog-show time with no `tool_use_id` (§3.1) — the normalizer must synthesize a request id (e.g. from `prompt_id` + `tool_name` + input hash) since core's `PermissionRequestedEvent.requestId` is required.
5. **Envelope:** every event self-identifies session + transcript path — the bridge needs zero session inference; reject requests whose `session_id` isn't ours (DESIGN §16.6 rule) is trivially implementable.

---

## 5. Open items carried to M1/M2

- [x] Interactive census (M1) via the retired node-pty driver: captured `PermissionRequest`, `Notification`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`—see §3.1 and the Surface captures.
- [ ] `TaskCreated` / `TaskCompleted`: **not** fired by the Task-tool subagent path (that fires `Subagent*`). Find the trigger — likely the FleetView task/todo system, not the subagent tool.
- [ ] `PreCompact` / `PostCompact`: not yet exercised (needs a long/compacting session or a manual `/compact`).
- [ ] `Elicitation` / `ElicitationResult`, `TeammateIdle`, `StopFailure`: not yet exercised.
- [ ] Per-event HTTP support matrix (M2-2).
- [ ] `SessionEnd.reason` value set (only `"other"` observed).
- [ ] Whether MessageDisplay fires for thinking/tool-progress displays or only assistant text.

---

## 6. Resume semantics (M4 probe, 2026-07-13)

`claude --resume <session-id>` **continues the same session in place**: verified that the original transcript `<slug>/<id>.jsonl` GREW (28192 → 34366 bytes) with no new JSONL created, and the agent retained context across the resume (recalled a number from the pre-resume turn). Implications for the runtime:

- Resume is spawn configuration, not storage: pass `--resume <id>` and **do NOT** also pass `--session-id` (the resumed session keeps its own id + transcript, so the puppeteer↔spaghetti join contract is preserved automatically).
- `--settings` composes with `--resume` (the hook bridge still attaches to a resumed session) — the generated settings file is passed exactly as for a fresh spawn.
- Gotcha: `-p --resume <id> "<prompt>"` warns "no stdin data received in 3s" before proceeding — a print-mode quirk; interactive (native-TUI) resume is unaffected.

### 6.1 Native picker and continue order (2.1.269 probe, 2026-09-11)

Probed the interactive TUI with an isolated `CLAUDE_CONFIG_DIR`, a loopback model, and `--settings` carrying `hooks` (http + command) plus a `statusLine` that POST to a sink, with one session of the workspace on disk. Order observed, by launch form:

| Launch | Order |
| --- | --- |
| `claude --resume` (picker) | `InstructionsLoaded` (`load_reason: session_start`) for a **fresh boot session id**, before the picker is shown → user selects → `SessionStart` (`source: resume`, the selected id, its `transcript_path`) → status line for the selected id → … → `SessionEnd`. The selected session never re-fires `InstructionsLoaded`. |
| `claude --continue` | `SessionStart` (`source: resume`) → status line → `InstructionsLoaded` (`session_start`), all for the resumed id. |
| `claude --resume <id>` | Same as `--continue`. |

Implications for the adapter (`driver.ts` allow-list and transcript attachment):

- The boot session's hooks carry an id that never becomes a session. They must not bind the bridge; answering them 403 only makes Claude record a hook failure, so the bridge acknowledges and drops them.
- The announcement of the chosen session is the `SessionStart` whose `source` is `resume`; a `startup` SessionStart in a resume launch is the boot shell. The transcript to observe is the one that SessionStart names.
- `InstructionsLoaded` is not a boot-finished signal on the picker path, so `session:ready` is not available there; `session:started` alone marks the run alive.

---

## 7. Invocation grammar (2.1.283 probe, 2026-09-27)

**Probed:** 2026-09-27, Claude Code **2.1.283**, darwin-arm64, native installer, SHA-256 `d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`. The adapter's table is `packages/adapter-claude/src/launch/invocation-grammar.ts`; its census test holds it to `claude --help` (captured as `probes/claude@2.1.283/help.txt` and the adapter fixture `claude-help-2.1.283.txt`, identical). Every probe below is recorded in `probes/claude@2.1.283/invocation-grammar.json`.

**Three probe forms**, cheapest first:

- **Parse probe** (59, session-free): `claude <flags under test> mcp --help`. Usage `claude mcp` means the flags parse and leave `mcp` the first operand; the root usage means a flag took `mcp` as its value (or an unknown option pushed it to commander's unknown list); exit 1 is commander's own error. The help is the same at any width and under an empty `CLAUDE_CONFIG_DIR`: the grammar does not depend on configuration.
- **Static inspection** (13 facts) of the digest-pinned executable, each bound to its anchor by digest and offset and to an 8 KiB window by digest; no source text retained.
- **Live** (16 sessions) in the repository's isolated rig (`adapter-claude/src/test-support/live-model.ts`): a throwaway `HOME` and `CLAUDE_CONFIG_DIR`, a loopback Messages API, a placeholder token, command hooks logging each event, a node-pty the harness owns. No account was used; nothing of the owner's was read or written.

### 7.1 How the CLI reads argv

Two stages, and the adapter's reader mirrors both in this order:

1. **The entry, on the raw argv, before any parser.** An argv of exactly `--version|-v|-V` (optionally with `--verbose`) prints the version (`-V` works only here). As **argv[0] only**: `logs`, `attach`, `stop|kill`, `respawn`, `rm` (background sessions — *not* commander subcommands; the help splices them in for display), `remote-control|rc|remote|sync|bridge` (Remote Control), `self-hosted-runner`; `plugin test`; `daemon` as the first argument after any `--dangerously-skip-permissions`/`--allow-dangerously-skip-permissions`. **Anywhere**: `--bg`/`--background` (even after `--`); `--tmux` or `--tmux=classic` together with `-w`/`--worktree`/`--worktree=…` execs into tmux. A lone `--update`/`--upgrade` becomes `update`. `--bare` and `--safe-mode` **before the first `--`** turn hooks off whatever the parser later makes of the token (`claude --append-system-prompt --bare` is bare). `--handle-uri <x>` anywhere opens a deep link. `claude [options] import [codex|gemini|cursor|--dry-run|--yes[=…]]` is rewritten to `claude [options] -- "/import …"`: an interactive session that runs /import.
2. **Commander 12** (`enablePositionalOptions()`): options anywhere until `--`; a `<value>` option takes the next token whatever it is (`--model --verbose` sets the model to `--verbose`); `[value]` takes it unless it looks like an option (length > 1, leading `-`: a lone `-` is a value); `<values...>` takes the next token unconditionally, then every token until one looks like an option; `--flag=value` takes one value (no variadic continuation), and a flag given `=value` is unknown; short clusters split as commander does (`-cd` is `-c -d`, `-dc` is debug filter `c`, `-hc` is unknown because the help option is kept apart, `-d2e` is one hidden name); unknown options are refused; **excess operands are dropped** — only the first operand is the prompt (live L12); the first operand selects a subcommand **even after `--`** (live L14); and **in print mode no subcommand is registered** (an exact `-p`/`--print` option token before `--`, value-aware): `claude -p mcp list` is a one-shot whose prompt is `mcp` (`claude -p --help` prints a usage without `[command]`).

### 7.2 Classes, and where they depart from the brief's reading

| Rows | Class | Evidence |
| --- | --- | --- |
| `-h/--help`, `-v/--version`; every management subcommand; hidden `sandbox`, `import-conversations`, `daemon`, the VS Code helpers `edit-*`/`design-login` | utility | help; static (registrations, entry dispatch) |
| `--bg/--background`, `--cloud`, `--environment`, hidden `--remote`/`--pool` (aliases); `attach`, `ultrareview`; hidden `remote-control\|rc`, `remote`, `sync`, `bridge`, `self-hosted-runner`; `-w … --tmux` | elsewhere | help; static — Remote Control's own refusal names "the sessions Remote Control starts"; the tmux fast path execs into tmux |
| `-p/--print` | one-shot | help |
| `--output-format`, `--input-format`, `--include-partial-messages`, `--max-budget-usd`, `--no-session-persistence`, `--permission-prompts`, `--json-schema`, `--replay-user-messages`, `--forward-subagent-text`, `--include-hook-events`, **`--prompt-suggestions`**, hidden `--max-turns`/`--permission-prompt-tool` | rejected without `-p` | help "(only works with --print)"; static action checks; live L13 (`--prompt-suggestions` exits "requires --print") |
| `--session-id`; `--settings` | rejected: owned | live L02 — a second `--settings` **replaces** the first (only its hooks ran); static — the eager load reads the last value |
| `--bare`, `--safe-mode` | rejected: blinding | help; live L09/L10 — no hook fires (L10 still ran a model turn); static — raw scan before `--` |
| `--fork-session`; **`--teleport`** | rejected: identity | help; static — teleport runs the teleported session in this terminal ("Teleporting session…") under that session's id |
| `-w/--worktree`; `--tmux` alone | rejected: place | live L15 — every hook came from `<workspace>/.claude/worktrees/<name>`; static — `--tmux` without `--worktree` exits "requires --worktree" |
| `claude import` in the rewrite's shape | rejected | static — the rewrite to a /import session |
| `--model`, `--effort`, `--permission-mode` (accepts `default`, the former name of `manual`: parse probe), `--setting-sources`, `-c`, `-r`, `--from-pr`, `-n/--name` | accepted: mapped | help; existing findings §6 |
| every other listed option, hidden `-d2e`, `--system-prompt-file`, `--append-system-prompt-file`, `--rc`; **`--dangerously-skip-permissions`** | accepted: carried verbatim | help; live L11/L16 (carried options take effect, hooks fire), L03/L04 |

Departures from the brief's reading, each on the evidence above: `--teleport` elsewhere → rejected; `--prompt-suggestions` carried → rejected without `-p`; `import` utility → rejected in the rewrite's shape (utility otherwise); `--tmux` place → elsewhere with `-w` (rejected alone); `--dangerously-skip-permissions` mapped → carried.

### 7.3 Facts the recipe rests on

- **Permission mode (live L03–L07; static).** The session's mode is the first of `--dangerously-skip-permissions`, `--permission-mode`, the agent's frontmatter, the settings `defaultMode`. So the skip flag wins over any `--permission-mode` (L03), and the recipe's `--permission-mode default` — added since DESIGN §16.3's "recommended command", with no reason recorded there that applies to a typed launch — **overrides a person's `defaultMode`** (L05 typed: acceptEdits; L07 with `default`: default; L06 with none: acceptEdits). A typed launch's recipe now passes only the mode the person gave; a host's own spawn keeps `default`.
- **Settings.** User-settings hooks and the managed `--settings` hooks both run (L06); two `--settings` do not compose (L02).
- **`--restricted`** keeps `--settings` (the managed hooks fire, L08) and reads no user/project/local settings (their hooks and status line do not run, L08): the recipe delegates to no status line under it.
- **Order.** Managed flags first, carried arguments next, the prompt last after `--`: a trailing variadic (`--add-dir a b`) cannot take the prompt (L16), and `-r`'s optional value cannot take it either.

### 7.4 Not modeled, and open

- **Configuration the pure reader cannot see.** A global config with `defaultToAgentsView` makes a bare `claude` (or one with only debug flags) open the agents view on a TTY, typed; managed, it is a session. `cloudSessionsByDefault` would turn a plain start into a cloud session unless `--session-id` is given — hard-coded false in 2.1.283, so dead today; a later release that turns it on flips typed and managed apart. (Corrected 2026-09-27: this entry said `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_SAFE_MODE` and `CLAUDE_CODE_RESTRICTED` were kept from the normalizer by the allow-list; they are read now — §7.5.)
- **Refused by design, though the CLI would run it:** an unknown token is refused even when a later `-v`/`-h` would have printed version or help (its arity is unknown); `claude --cwd x agents` (a flag only the agents fast path reads) is refused as unknown.
- **`--fork-session` could compose:** the CLI accepts `--session-id` together with `--continue`/`--resume` only when `--fork-session` is also given, so a fork could take the managed id — unprobed, and the recipe does not pass `--session-id` with a resume form today.
- **Rejected and unprobed** (a live probe would need a cloud session or the account): `--teleport` (would show whether the teleported session keeps its own id under the managed `--session-id`), `--fork-session` (whether the fork honours a managed `--session-id`), `claude import` in the rewrite's shape (whether a managed launch could carry the /import prompt, and what it does when the feature is off).
- **Passthrough on static evidence alone** (a live probe would act outside the throwaway directory): `--bg` and the background commands (start or open a background session), `-w … --tmux` (opens tmux or iTerm2 panes), `--cloud`/`--environment`/`--remote`/`--pool` and `ultrareview` (create cloud sessions), the Remote Control family (registers with claude.ai).
- **Accepted without a live probe of their own:** `--from-pr` (a resume form, like `-r`), `--remote-control`/`--rc` (enabling Remote Control would register with claude.ai), `--agent`, `--agents`, `--plugin-dir`, `--plugin-url`, `--client-data-url`, `--file`, `--betas`, `--ide`, `--chrome`.

### 7.5 What blinds a session without a flag (2.1.283 probe, 2026-09-27)

A managed session is one the host can observe through its hooks, and Claude can be told to skip them from outside argv. Recorded in `probes/claude@2.1.283/hook-switches.json`: 16 static facts (anchored as in §7), the scan of every name on the paths to hook registration, the session id and the working directory, and 11 live sessions (F01–F11) in the isolated rig with managed settings in the adapter's own shape (SessionStart by the command forwarder, the rest over HTTP with the bearer from `$PUPPETEER_HOOK_TOKEN`).

**Environment.** A typed `claude` inherits the whole shell environment at exec. One parser reads every switch: on only for `1`, `true`, `yes` or `on`, in any case, trimmed; unset, empty or anything else is off (F02: `0` is off).

| Variable | Stands for | Probe | What the adapter does |
| --- | --- | --- | --- |
| `CLAUDE_CODE_SIMPLE` | `--bare` | F01: no hook fires, the person's status line still runs | refused: "it turns off the hooks a managed session is observed through (CLAUDE_CODE_SIMPLE=1)" |
| `CLAUDE_CODE_SAFE_MODE` | `--safe-mode` | F03 (`true`): no hook, no status line | refused, same reason, named as set |
| `CLAUDE_CODE_RESTRICTED` | `--restricted` | F04: the managed hooks fire; the person's hooks and status line do not | accepted; no status-line delegate, no settings layer read |

The provider's allow-list is the config root plus these three (`CLAUDE_INVOCATION_ENVIRONMENT`), so a shim forwards them to the normalizer.

**Settings.** The layers rank user < project < local < `--settings` (flag) < policy; the enabled ones are the `--setting-sources` list plus flag and policy, and `--restricted` or `CLAUDE_CODE_RESTRICTED` drops the person's three. For each key the last enabled layer that states it wins.

- `disableAllHooks: true` in the person's user or project settings silences the managed hooks (F05, F08; local by the same merge). A `disableAllHooks: false` in the launch's own `--settings` turns them back on, **and turns the person's own hooks and status line back on with them** (F06), so the session would no longer be the one typed. A typed launch is therefore refused before anything is written (`ClaudeHooksOffError`, `CLAUDE_HOOKS_OFF`: "your user settings turn hooks off (disableAllHooks), and a managed session is observed through hooks"). A later layer's `false`, `--setting-sources` without that layer (F07), `--restricted`, and the imposter all launch.
- `allowedHttpHookUrls` in a person's layer blocks every managed HTTP hook; only the command-forwarded SessionStart arrives (F09). `httpHookAllowedEnvVars` keeps the bearer from being interpolated (F10). The launch's own settings restate each list with the bridge's entry added (`http://127.0.0.1:<port>/*`, `PUPPETEER_HOOK_TOKEN`), and every managed hook arrives with its bearer while the person's own hooks behave as before (F11). No list is written where the person has none: that would restrict their hooks.

**A host's own spawn has the same blindness.** Its launch reads the same settings layers. The allow-list restatement applies to it too. `disableAllHooks` does not refuse it: it still launches unobserved, as it did before this slice. Whether a host's own environment reaches the sessions it spawns is its terminal layer's to say (Godview spawns through its terminal daemon, outside this repository); where it does, `CLAUDE_CODE_SIMPLE` or `CLAUDE_CODE_SAFE_MODE` there blinds them too, and the adapter does not read a host's environment.

**Not read, and why.** Policy settings (`disableAllHooks`, `allowManagedHooksOnly`, `strictPluginOnlyCustomization` covering hooks, the two HTTP lists) rank above `--settings` and blind the same way, but come from a chain the adapter cannot read in full (the admin directory's `managed-settings.json` and `managed-settings.d/`, the Windows registry, WSL inheritance, remote and helper policy), and probing them would write system files. Workspace trust holds every hook until the trust dialog is answered, typed and managed alike. On the session-id and directory paths the scan found nothing a person's shell or settings set: `CLAUDE_CODE_SESSION_ID` is exported by Claude, not read; `CLAUDE_CODE_RESUME_FROM_SESSION`, the bridge and remote session ids, `CLAUDE_BG_WORKSPACE_TRUSTED` and `CLAUDE_CODE_DISABLE_HOOK_FORWARDING` live on the SDK, cloud, Remote Control and background paths; `CLAUDE_CODE_PROJECT_DIR_NAME` names only the transcripts' folder under a relocated config root; `CLAUDE_CODE_TMUX_SESSION` is display only.
