# Monitor V2 Canary Runbook

This runbook supplies the manual evidence required by RFC-001 Stage C. It keeps
the provider's native TUI authoritative while recording the renderer-safe
monitor revision stream beside it.

## Flags

- `--chopsticks-monitor-shadow` enables v2 accumulation and v1/v2 comparison
  while leaving the legacy renderer authoritative.
- `--chopsticks-godview-monitor-v2` enables the Godview v2 renderer and v2
  accumulation.
- `--chopsticks-monitor-canary-trace` writes one prefixed JSON record to stderr
  for every accepted state, notification, removal, and shadow mismatch. It
  enables v2 accumulation but does not switch the renderer by itself.

Use all three flags for an opt-in Stage C run:

```sh
pnpm --filter godview exec electron . \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace \
  2>/tmp/chopsticks-monitor-canary.log
```

Lines that begin with `[monitor-canary] ` contain the trace. Other stderr lines
are normal host and provider diagnostics.

The trace contains only public monitor and IPC contracts, never private source
records, hook secrets, transcript paths, or artifact bodies. Public monitor
state can still contain user-visible question text, task labels, model names,
and the working directory. Store the log in a private temporary location,
sanitize it before sharing, and never commit an unsanitized trace.

For a credential-free wiring check before the real native matrix, run the
Claude Imposter through the same spawn-through path used by a terminal pane:

```sh
CHOPSTICKS_SPAWN_SMOKE_COMMAND='ai --claude' \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace
```

This proves host/runtime/adapter wiring and clean terminal flow. It does not
replace the supported-version native Claude matrix. The command does not
require a real Claude executable or Claude credentials; if it succeeds with a
real executable absent, that is useful evidence that the host did not silently
fall through to the vendor binary.

When exercising configuration propagation, pin every Claude model explicitly
and assert the resulting monitor state before sending a prompt. For example:

```sh
CHOPSTICKS_SPAWN_SMOKE_COMMAND='ai --claude --model haiku --effort low --permission-mode plan' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=plan \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace
```

The smoke harness fails before its scripted prompts unless the monitor confirms
the requested model, effort, and permission mode. Use `--model sonnet` for
scenarios that need Sonnet. During a model-restricted canary, never rely on the
Claude CLI's default model.

To verify live configuration changes, provide an ordered command and
expectation sequence. Only `/model` and `/effort` are accepted by this canary
surface:

```sh
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model sonnet --effort low --permission-mode manual' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=sonnet \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL_INTENT=observed \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT_INTENT=configured \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=manual \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE_INTENT=configured \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE_AFTER_PROMPT=manual \
CHOPSTICKS_SPAWN_SMOKE_CONFIG_COMMANDS='/effort max|/model haiku' \
CHOPSTICKS_SPAWN_SMOKE_CONFIG_EXPECTATIONS='effort=max,effortIntent=observed|model=haiku,modelIntent=observed,effort=low,effortIntent=configured' \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Reply with exactly CONFIG_CHANGE_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=CONFIG_CHANGE_OK \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2
```

Each expectation must be false before its command and become true afterward.
Model matching accepts a card-name fragment; model intent, effort, effort
intent, permission mode, and permission intent are exact case-insensitive
matches. Initial expectations default to observed model plus configured effort
and permission intent, and those defaults can be overridden explicitly with
the three `*_INTENT` variables above. To prove effective permission mode, the
example also requires observed evidence at the first prompt boundary. The optional
`CHOPSTICKS_SPAWN_SMOKE_CONFIG_SETTLE_MS` is bounded to 0-120000 ms.

## Before a native run

1. Record `claude --version` and the selected Chopsticks commit.
2. Confirm `claude auth status` reports an authenticated session, or configure a
   supported credential through the operator's normal secure environment. Never
   put credentials in the canary command, trace, or committed files.
3. Run both app test, typecheck, bundle, and smoke commands from the RFC plan.
4. Start with shadow-only mode and confirm the native TUI behaves normally.
5. Repeat with the v2 renderer and canary trace enabled.

For an explicitly pinned native Haiku run:

```sh
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode plan' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=plan \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace \
  2>/tmp/chopsticks-monitor-canary.log
```

Substitute `sonnet` only for matrix cases assigned to Sonnet. The explicit CLI
option is the execution guard; the expectation variables independently verify
that Chopsticks observed the intended runtime configuration.

Claude's `--setting-sources` option must also flow through spawn-through. The
adapter uses the same selected `user`, `project`, and `local` layers when it
discovers status-line delegates, while Chopsticks' generated `--settings` file
continues to compose at CLI precedence. Source order on the command line does
not change Claude's native precedence: user < project < local. An empty list or
an unknown source fails before launch. See the official
[CLI reference](https://code.claude.com/docs/en/cli-reference) and
[settings precedence](https://code.claude.com/docs/en/settings).

For the no-user-statusline case, use a disposable project and exclude the user
layer explicitly:

```sh
CHOPSTICKS_SPAWN_SMOKE_CWD=/absolute/disposable/project \
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode manual --setting-sources project' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=manual \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Reply with exactly NO_STATUSLINE_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=NO_STATUSLINE_OK \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2
```

For delegation cases, configure the selected settings layers' `statusLine`
and `subagentStatusLine` commands to append to separate marker files inside
the disposable smoke cwd. Set
`CHOPSTICKS_SPAWN_SMOKE_EXPECT_DELEGATE_MARKERS` to their absolute paths,
separated by `|`. The harness snapshots their initial sizes and requires each
to grow, proving that observation did not replace the user's root or child
command. Marker paths outside the smoke cwd are rejected.

To exercise native mode cycling, set
`CHOPSTICKS_SPAWN_SMOKE_SHIFT_TAB_COUNT=1` for Accept Edits or `2` for Plan,
and set `CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE_AFTER_PROMPT` to
`acceptEdits` or `plan`. The expectation is checked on the next submitted
prompt. Claude's statusline does not include permission mode, so an idle
Shift+Tab has no authoritative observation boundary until a hook such as
`UserPromptSubmit` reports `permission_mode`. Auto mode remains account- and
eligibility-gated and is not synthesized when unavailable.

To exercise a native structured choice through the same terminal path, add the
question expectations and an innocuous prompt:

```sh
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode manual' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=manual \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Use AskUserQuestion exactly once. Ask "Pick a canary color" with options Red, Green, and Blue. After the answer, reply with exactly QUESTION_CANARY_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_QUESTION='Pick a canary color' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_QUESTION_CHOICES='Red|Green|Blue' \
CHOPSTICKS_SPAWN_SMOKE_QUESTION_KEY=enter \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=QUESTION_CANARY_OK \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace \
  2>/tmp/chopsticks-monitor-question-canary.log
```

`CHOPSTICKS_SPAWN_SMOKE_QUESTION_KEY` accepts `enter`, `down-enter`,
`space-enter`, `multi-first-two`, or `other-text`. The harness waits for a
distinct question blocker, validates labels from the matching question and the
absence of a permission blocker, then answers with protocol-aware native key
events. It sends both key-down and key-up because Claude enables an extended
terminal keyboard protocol.

Set `CHOPSTICKS_SPAWN_SMOKE_EXPECT_QUESTION_ALLOW_MULTIPLE` and
`CHOPSTICKS_SPAWN_SMOKE_EXPECT_QUESTION_ALLOW_FREE_FORM` to `0` or `1` to
assert those structured fields. `multi-first-two` selects the first two
options, advances to Claude's Submit field, enters the review screen, and
confirms the final submission. `other-text` navigates to Claude's built-in
free-form choice and requires `CHOPSTICKS_SPAWN_SMOKE_QUESTION_INPUT`; moving
onto that choice opens its editor immediately, so the harness pastes the text
without first submitting an empty answer. These paths are canary automation
only; they do not add an answer control to either product renderer.

Set `CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY` (and `_2` for the optional second
prompt) to an exact final sentinel. A canary that receives a clarification,
refusal, or partial response then fails instead of accepting any completed
assistant turn as success. Between scripted prompts the harness waits 500 ms
for Claude's input editor to finish its final redraw; override this with
`CHOPSTICKS_SPAWN_SMOKE_INTER_PROMPT_SETTLE_MS` (0-120000) only when diagnosing
terminal timing.

For a native task lifecycle, set `CHOPSTICKS_SPAWN_SMOKE_EXPECT_TASK` to a
stable task ID/description fragment and
`CHOPSTICKS_SPAWN_SMOKE_EXPECT_TASK_STATUSES='pending|in-progress|completed'`.
The harness samples monitor revisions throughout the turn, so this verifies
the intermediate states rather than only the final task snapshot.

For plan-mode observation, set
`CHOPSTICKS_SPAWN_SMOKE_EXPECT_PLAN_STEPS='step one|step two'`. Set
`CHOPSTICKS_SPAWN_SMOKE_STOP_AFTER_PLAN=1` to terminate the canary after the
matching plan has remained observable for the optional
`CHOPSTICKS_SPAWN_SMOKE_PLAN_SETTLE_MS` interval. This validates the
pre-approval plan without choosing an implementation mode or allowing edits.
Claude 2.1.234 supplies this plan through `PreToolUse(ExitPlanMode)` after the
native plan file is written. The plan is provisional until successful
`PostToolUse`; ending a blocked canary leaves it provisional. The approval
blocker is observable, but the hook payload does not provide the individual
menu choices, so the monitor does not synthesize them.

For repeated same-name tool correlation, use a harmless read-only prompt and
require the exact count and terminal outcome:

```sh
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode manual' \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Use Read exactly twice on package.json, then reply with exactly REPEATED_TOOL_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=REPEATED_TOOL_OK \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_TOOL=Read \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_TOOL_COUNT=2 \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_TOOL_OUTCOME=completed \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2
```

The two requests must have distinct tool-call IDs. For denial, use only a
disposable project whose audited, project-local official `PermissionRequest`
hook deterministically denies one harmless Bash request. Set the expected tool
to `Bash`, count to `1`, outcome to `denied`, and
`CHOPSTICKS_SPAWN_SMOKE_ALLOW_HOOK_DENIAL=1`. That last variable is an explicit
canary safety acknowledgement and assertion gate; it does not install or
change a hook. The harness requires a correlated permission resolution with
outcome `denied` and does not attempt fragile screen-coordinate or key-sequence
automation of Claude's permission modal.

For a native standard-subagent lifecycle with per-child telemetry, explicitly
pin both the root and child models:

```sh
CLAUDE_CODE_SUBAGENT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode manual' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=manual \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Use Agent exactly once with subagent_type Explore and run_in_background false to inspect only the root package.json and report its package name. Do not set name, team_name, or any other team field. After the Agent result, reply with exactly SUBAGENT_CANARY_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=SUBAGENT_CANARY_OK \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_SUBAGENT_TYPE=Explore \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_SUBAGENT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_REQUIRE_SUBAGENT_TELEMETRY=1 \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace \
  2>/tmp/chopsticks-monitor-subagent-canary.log
```

The harness requires one stable child identity to become active and then
stopped, and requires that same child to expose activity, nonzero cumulative
tokens and burn rate, context percentage, and the expected model card. Claude
status snapshots may repeat older token samples; Chopsticks preserves each
sample's first observation boundary so repetition cannot manufacture a burn
spike. An explicit `SubagentStop` also seals the child lifecycle against a
late, stale status row.

On Claude 2.1.234, adding the optional `name` field to the `Agent` call produced
an `in_process_teammate` in an implicit team rather than a standard subagent.
Keep `name` and team fields absent in this canary. Named Agent calls belong in
the separate team canary and must not be accepted as proof of the ordinary
subagent case.

For that separate native team-member path, pin both models and require the
durable Spaghetti affiliation to reconcile with the low-latency activity hook:

```sh
CLAUDE_CODE_SUBAGENT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode manual' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=manual \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Use Agent exactly once with subagent_type Explore, name team-canary-researcher, and run_in_background false to inspect only the root package.json and report its package name. After the Agent result, reply with exactly TEAM_CANARY_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=TEAM_CANARY_OK \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_TEAM_MEMBER=team-canary-researcher \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_TEAM_MEMBER_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_TEAM_MEMBER_IDLE=1 \
CHOPSTICKS_SPAWN_SMOKE_REQUIRE_TEAM_MEMBER_TELEMETRY=1 \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace \
  2>/tmp/chopsticks-monitor-team-canary.log
```

This gate rejects a hook-only provisional team. It requires a durable team and
member identity plus activity, nonzero cumulative usage, nonzero burn rate,
the expected observed model, and the idle transition. Add
`CHOPSTICKS_SPAWN_SMOKE_EXPECT_TEAM_MEMBER_EFFORT` when the installed Claude
surface supplies applied child effort. Context remains a separate gate via
`CHOPSTICKS_SPAWN_SMOKE_REQUIRE_TEAM_MEMBER_CONTEXT=1`, because the current
scoped transcript contract declares child context unsupported unless the
status-line rail supplies it.

To exercise a short-session `/compact` cancellation without confusing the
local command with a conversation turn:

```sh
CLAUDE_CODE_SUBAGENT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode manual' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=manual \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Reply with exactly PRECOMPACT_CANARY_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=PRECOMPACT_CANARY_OK \
CHOPSTICKS_SPAWN_SMOKE_PROMPT_2='/compact' \
CHOPSTICKS_SPAWN_SMOKE_PROMPT_3='Reply with exactly POSTCOMPACT_CANARY_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY_3=POSTCOMPACT_CANARY_OK \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_COMPACTION=1 \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_COMPACTION_OUTCOME=unknown \
CHOPSTICKS_SPAWN_SMOKE_ALLOW_COMPACTION_BOUNDARY_FALLBACK=1 \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace \
  2>/tmp/chopsticks-monitor-compaction-canary.log
```

Claude 2.1.234 emits `PreCompact` before deciding that a short conversation has
too few messages, then emits no `PostCompact`. The next accepted
`UserPromptSubmit` is therefore evidence that the attempt ended, but not that
it succeeded. Chopsticks projects `lastOutcome: unknown`, clears the compacting
activity, and emits no false `compaction.completed` notification. Omit the
boundary-fallback flag and expect `completed` for a long-session canary that
must receive the native `PostCompact` boundary.

To close the real observation listener after the first completed turn while
leaving Claude and its semantic transcript observer alive:

```sh
CLAUDE_CODE_SUBAGENT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode manual' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_MODEL=haiku \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_EFFORT=low \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_PERMISSION_MODE=manual \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Reply with exactly RAIL_BEFORE_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=RAIL_BEFORE_OK \
CHOPSTICKS_SPAWN_SMOKE_PROMPT_2='Reply with exactly RAIL_AFTER_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY_2=RAIL_AFTER_OK \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_RAIL_FAILURE=1 \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2 \
  --chopsticks-monitor-canary-trace \
  2>/tmp/chopsticks-monitor-rail-canary.log
```

This fault is canary-only and closes the actual loopback hook/status bridge
after its first accepted `Stop`; it does not stop Claude or the semantic
observer. The expected result is `alive: true`, lifecycle `ready`, freshness
below `native-hooks`, explicitly degraded hook-owned families, and the exact
second reply observed through `native-log`. The second user row may be absent:
`UserPromptSubmit` belonged to the deliberately removed rail, so its absence
must remain unavailable evidence rather than a fabricated prompt event.

To prove `/clear` rotates native identity without replacing the runtime run or
terminal, run a normal turn, the literal local command, and another normal
turn. Combining it with the rail fault also proves that the semantic transcript
observer reattached to the new transcript:

```sh
CHOPSTICKS_SPAWN_SMOKE_COMMAND='claude --model haiku --effort low --permission-mode manual' \
CHOPSTICKS_SPAWN_SMOKE_PROMPT='Reply with exactly BEFORE_CLEAR_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY=BEFORE_CLEAR_OK \
CHOPSTICKS_SPAWN_SMOKE_PROMPT_2='/clear' \
CHOPSTICKS_SPAWN_SMOKE_PROMPT_3='Reply with exactly AFTER_CLEAR_OK.' \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_REPLY_3=AFTER_CLEAR_OK \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_CLEAR=1 \
CHOPSTICKS_SPAWN_SMOKE_REQUIRE_POST_CLEAR_TRANSCRIPT=1 \
CHOPSTICKS_SPAWN_SMOKE_EXPECT_RAIL_FAILURE=1 \
CHOPSTICKS_SPAWN_SMOKE_RAIL_FAILURE_OCCURRENCE=2 \
pnpm --filter godview exec electron . \
  --spawn-through-smoke=claude \
  --chopsticks-monitor-shadow \
  --chopsticks-godview-monitor-v2
```

The harness sends `/clear` as native terminal text, not bracketed paste. It
requires the same runtime/terminal identity, a different native session ID, an
increased native-session revision, `startSource: clear`, lifecycle `ready`, and
an authoritative post-clear assistant event from `native-transcript`. Set the
rail-failure occurrence to the `Stop` boundary that should remove hooks while
leaving the new transcript observer alive; with one pre-clear turn, that is
normally occurrence 2.

Termination has three independent modes:

- `CHOPSTICKS_SPAWN_SMOKE_EXIT_MODE=host` terminates the terminal host and
  requires `runtime-terminated`.
- `CHOPSTICKS_SPAWN_SMOKE_EXIT_MODE=clean` sends native `/exit`, requires
  Claude's `SessionEnd`, process death, and reason `completed`.
- `CHOPSTICKS_SPAWN_SMOKE_EXIT_MODE=crash` sends `SIGKILL` only to the freshly
  adopted canary process, requires a retained `blocked` crash failure, then
  acknowledges it and verifies removal.

Never use the crash mode against a session containing work that must be
preserved. All three modes require one matching `process.exited` event, strict
final shadow convergence, and no monitor left after the expected removal.

Claude may accept `manual` as launch intent while reporting the effective raw
permission mode as `default`. Chopsticks preserves that raw value and displays
both values as the provider-normalized label `Manual`; canary startup accepts
the documented alias transition rather than treating it as a mode change.

## Non-Claude provider spot checks

The same spawn-through smoke supports `codex`, `grok`, `kimi`, `opencode`, and
`hermes` when the executable, credentials, and provider-specific prerequisites
exist. A fresh Kimi TUI is intentionally prompt-lazy: its durable native
session and `session.started` record may not exist until the first prompt. The
harness permits that initial `starting` state only when a scripted Kimi prompt
is present, then requires durable binding and normal ready/turn evidence before
passing. Kimi's verified wire exposes response-boundary burn and input
occupancy, but no context capacity; the monitor must keep percentage
unavailable rather than treating `llm.request.maxTokens` as capacity.

Record each installed provider version. A run against a version newer than its
pinned Surface is useful drift evidence, not a provider/version release gate.
Do not weaken shadow comparison to make an unverified version pass; reconcile
and promote a new sanitized Surface first when its protocol actually changed.

## Claude matrix

Exercise the matrix in RFC-001 section 11.4 for every supported Claude
version/configuration. At minimum, cover:

1. No user statusline command.
2. An existing root statusline command.
3. Existing root and subagent statusline commands.
4. Mid-session model and effort changes.
5. Plan and permission-mode changes.
6. Choice, multi-choice, and free-form `AskUserQuestion` flows.
7. Repeated same-name tools and a denied tool.
8. Subagent start, activity, usage, and stop.
9. Team-member idle and workflow evidence when the installed version exposes
   those surfaces.
10. Pre/post compaction, `/clear`, transcript rotation, and observer restart.
11. Observation-rail failure while the TUI stays alive.
12. Clean exit, crash, and host termination.

## Review each trace

- `(runtimeEpoch, revision)` strictly increases for each `runtimeRunId`.
- A removal seals its epoch; a later state requires a newer runtime epoch.
- Headline status is only `idle`, `working`, or `blocked`.
- Questions expose their structured choices and do not masquerade as
  permissions.
- Rail loss degrades freshness without setting `alive=false`.
- Model, effort, mode, plan, task, actor, compaction, and terminal transitions
  appear at the first evidence boundary their capability permits.
- Bootstrap/replay creates no notification or artificial burn spike.
- Root and child usage are not added twice.
- Every shadow mismatch is classified and explained or fixed before promotion.
- The native TUI's output, prompts, user commands, and interaction behavior are
  unchanged by observation.

Keep the v1 bridge enabled throughout Stage C. Default promotion requires two
canary release cycles with no unexplained status, terminal-flow, or usage
accounting mismatches.
