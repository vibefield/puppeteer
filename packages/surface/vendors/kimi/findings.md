# Kimi Code 0.34.0 Surface baseline candidate

Captured from 2026-08-10 through 2026-08-11 UTC with the installed
darwin-arm64 executable reporting `0.34.0`, SHA-256
`9f4337e10da47843f6b550474012a53ba8b30dd665f83b176a5cd479c5f7e859`.
The corresponding official source is tag
`@moonshot-ai/kimi-code@0.34.0`, commit
`f0614c53e59f7e1e257412063b059b9eb82764cf`.

This is a partial Surface census, not a promoted baseline. The committed
fixtures are allowlisted, sanitized projections of gitignored raw captures.

## Method

The census ran the exact native executable in print mode with:

- a newly created, isolated `KIMI_CODE_HOME`;
- an allowlisted environment that excluded parent credentials and proxy state;
- telemetry and automatic updates disabled;
- an empty replacement skills directory;
- a loopback OpenAI-compatible fake provider selected through `KIMI_MODEL_*`;
- external collectors registered for all 20 Kimi 0.34.0 hook names.

No Kimi account, user config, user session, external model request, or model
quota was used. The eleven observed scenarios are a basic turn, a successful
`Bash` call, a `Bash` call exiting with status 7, a two-invocation resume, a
detached process task, a controlled provider-authentication rejection, a
`UserPromptSubmit` hook block, a `PreToolUse` hook deny, a 429 that the client
retried, a print-mode SIGINT abort, and a foreground `Agent` subagent.

The source projection is generated from a clean checkout at the exact release
tag. It verifies the generated wire inventory (40 persisted and 8 transient
operation types), protocol 1.5, all 20 hook declarations, CLI aliases, and
SHA-256 digests for every declaration file used by the projection. Separate
binary probes preserve `--version`, `--help`, rejected-option behavior, native
file identity, byte count, artifact SHA-256, and the digest of the gitignored
raw-capture tree.

## Durable wire

Every scenario created one session below
`sessions/<workdir-key>/<session-id>/`, one main-agent
`agents/main/wire.jsonl`, a `state.json`, and a matching entry in
`session_index.jsonl`. The first journal record declared wire protocol `1.5`.
The session id matched across state, index, hooks, and the print-mode resume
hint.

The observed no-tool order was:

```text
metadata
profile.bind
permission.set_mode
turn.prompt
context.append_message (user)
context.append_message (permission-mode injection)
context.append_loop_event (step.begin)
llm.tools_snapshot
llm.request
usage.record
context.append_loop_event (content.part: think)
context.append_loop_event (content.part: text)
context.append_loop_event (step.end)
turn.ended (completed)
```

The tool scenarios inserted `tool.call` and `tool.result` between the first
content part and first `step.end`, then began a second model step. The first
step ended with tool-use semantics; the second ended the turn.

The resume scenario invoked the executable twice against one isolated home and
used the first invocation's exact native session id on the second. The journal
remained append-only, emitted turns `0` then `1`, and the `SessionStart` hook
reported `startup` then `resume` for the same session. This verifies native
print-mode resume continuity, not PTY/adapter tail-offset behavior.

The background scenario persisted `task.started` followed by `task.terminated`
for one detached `process` task. The status changed from `running` to
`completed`, the exit code was 0, and the eventual context notification kept
the same task id. The provider-rejection scenario exited 1 and persisted
`turn.ended(reason: "failed")` with a non-retryable
`provider.auth_error`.

A `UserPromptSubmit` hook that exited 2 persisted a
`context.append_message` whose origin was
`{ kind: "hook_result", event: "UserPromptSubmit", blocked: true }`, then
exited 1 with `Prompt hook blocked the request.` It created a session and
wrote those messages, but it did not persist `turn.prompt` or `turn.ended`.
`lastTurnReason` remained null.

A `PreToolUse` hook that exited 2 did not open a permission dialog. The
journal recorded a normal `tool.call` / `tool.result(isError: true)` pair
whose output was the hook stderr, and the hooks were `PreToolUse` plus
`PostToolUseFailure`. The turn then completed.

A first-request HTTP 429 was retried against the loopback provider. The
durable journal kept a single `llm.request` and ended the turn
`completed`. Retry is therefore a client transport fact, not a second
persisted request.

Print-mode SIGINT after `llm.request` exited 130. The journal kept the
prompt, step begin, and request, and it did not persist `turn.ended`,
`turn.cancel`, or an `Interrupt` hook. This is a process abort, not the
interactive Esc-cancel path.

A foreground `Agent` call created `agents/agent-0/wire.jsonl` beside the
main journal, fired `SubagentStart` / `SubagentStop` for `coder`, and
recorded `TurnStarted(origin_kind: "system_trigger")` for the child. The
session `state.json` listed both `main` and `agent-0`. The child journal
continued into a second turn after the first child completion; that
continuation is native print-mode behavior under this hook configuration,
not a second user prompt.

Kimi serializes the same turn counter as the string `"0"` inside loop events
and the number `0` on `turn.ended`. The sanitizer and future normalizer must
preserve that native type difference while correlating the records.

`tool.result` did not repeat turn or step fields. It correlated to
`tool.call` through `toolCallId` and `parentUuid`. A successful result carried
`result.output` and no `isError`; the status-7 result carried the same output
field plus `result.isError: true`.

Usage was persisted before content parts in each observed step. It used
`usageScope: "turn"` and the native counters `inputOther`, `output`,
`inputCacheRead`, and `inputCacheCreation`. This ordering must not be rewritten
to match a normalized UI expectation.

## Hooks

All successful turn scenarios observed:

- `SessionStart`
- `UserPromptSubmit`
- `TurnStarted`
- `Stop`

The successful tool scenario additionally observed `PreToolUse` and
`PostToolUse`. The status-7 scenario observed `PreToolUse` and
`PostToolUseFailure` instead. Both pre/post paths carried the same native
`tool_call_id` as the durable journal.

The resume scenario observed both `SessionStart(source: "startup")` and
`SessionStart(source: "resume")`. The background process scenario observed
`TaskStarted` and `Notification(sink: "context", severity: "info")`. The
provider-rejection scenario observed `StopFailure` instead of `Stop`. The
hook-block scenario observed `UserPromptSubmit` without `TurnStarted` or
`Stop`. The hook-deny scenario observed `PreToolUse` and `PostToolUseFailure`.
The subagent scenario observed `SubagentStart` and `SubagentStop`.

`SessionEnd` was configured but did not fire in these clean print-mode exits.
That absence is evidence only for this lane; interactive TUI shutdown still
needs a PTY census. It also means the adapter cannot use the hook name alone as
its universal final-session signal.

## Adapter implication

The observed wire has enough structure to justify a wire-first adapter spike:
native prompt echo, turn outcome, thinking/text parts, step boundaries, usage,
tool identity, output, and failure are all durable and correlated. A blocked
`UserPromptSubmit` never persists `turn.prompt`, so a control receipt cannot
become confirmed from that path. Print-mode SIGINT likewise leaves no
`turn.ended`. External hooks are valuable cross-checks, but the CLI currently
has no launch-scoped config-path override; injecting them into a user's native
TUI without mutating global config remains unresolved.

The target composition is therefore native `kimi` TUI + PTY + durable wire
observer. `kimi acp` remains a separate generic execution mode and survey
oracle, not a concurrent controller for the TUI session.

The candidate adapter now implements that composition. It discovers a lazily
created session only through a unique matching durable prompt, observes all
agent journals with bounded append-safe tailing, normalizes the main journal,
retains non-main and unknown records, and confirms injected prompts only after
`turn.prompt` is durable. Disposal performs one final bounded journal read.
The shared `AgentHost` contract does not yet notify adapters of process exit,
so the host must still sequence disposal after terminal exit for that read to
serve as an exit drain.

The Kimi Imposter independently materializes the observed nested main journal,
replace-in-place session state, and root-level `session_index.jsonl`. Its index
emission is validated against the Surface event and is idempotent when an
existing session is resumed.

## Unverified boundaries

The following remain explicitly unverified:

- true interactive TUI startup, first-prompt session discovery, resize, and
  clean/abrupt exit;
- guarded paste confirmation under manual user input;
- permission accept/deny and question answer/dismiss paths;
- prompt queueing and steer;
- interrupt during provider streaming and during a tool (print-mode SIGINT is
  a process abort without `turn.ended`/`Interrupt`; TUI Esc-cancel is still
  unverified);
- interactive/adapter resume journal tail offsets (native headless resume is
  captured);
- question/agent task variants and non-success process-task outcomes
  (a successful foreground `coder` subagent journal is captured);
- compaction begin, completion, cancellation, and failure;
- malformed-stream failure (the pinned binary hung on invalid SSE until the
  harness deadline; a 429 is retried without a second durable `llm.request`);
- ACP request/result shapes for the pinned binary;
- Imposter native session-id and turn-counter fidelity across process resume;
- the 29 persisted wire operations and 8 hooks not present in the eleven
  captures;
- darwin-x64, linux-x64, and windows-x64 artifact/runtime coverage.

## Promotion status

Kimi now has an acquisition definition, a hermetic census harness, eleven
sanitized runtime scenarios, a 63-event ASM v2/evidence v2 candidate with 26
runtime-verified and 37 source-only surfaces, exact
pre-normalization replay, a wire-first adapter, an Imposter persona, shared
AgentSession conformance, and runtime/workbench/Godview/devkit composition.
These are candidate implementation facts, not a promotion claim.

The remaining gates are the interactive scenarios listed above, automatic
process-exit/drain integration, exact protected artifact reacquisition,
declared-platform pinned-real adapter reports, and evidence reconciliation.
Support remains `baseline-pending`; only the protected promotion workflow may
change it to `verified`.

The local no-run promotion audit passes identity, privacy, model,
adapter-fixture, Imposter, exact-replay, hermetic, packaging, and documentation
gates. It intentionally fails `pinnedArtifact` and `platforms` because there
are no protected reports for darwin-arm64, darwin-x64, linux-x64, or
windows-x64. Local artifact evidence covers darwin-arm64, but it is not a
workflow-bound pinned-real platform report.

The refreshed local candidate reconciliation passed exact replay (266 frames,
digest
`f71bc4eea060dcadc878b9362b4cb3d94fb8f684383c2742b28741b3422b9e60`)
and then classified the candidate `unsafe-or-unknown`, as designed, because
darwin-x64, linux-x64, and windows-x64 artifact evidence is incomplete.
