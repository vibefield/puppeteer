# Kimi Code 2.4.1 Surface baseline candidate

Captured 2026-11-03 UTC with the official linux-x64 release executable
(`kimi-code-linux-x64.zip`, extracted `kimi`) reporting `2.4.1`, SHA-256
`f2b3634c17b604e5b0f0c578b6a787fd01bcafb40a3c0dd62203ae14ff2ea068`,
192,613,568 bytes. The corresponding official source is tag
`@moonshot-ai/kimi-code@2.4.1`, commit
`2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7`.

This candidate replaces the 0.34.0 candidate (darwin-arm64, commit
`f0614c53e59f7e1e257412063b059b9eb82764cf`). The 0.34.0 captures, probes,
reference, and model remain under their versioned directories as frozen history;
`groundtruth.json` now folds the 2.4.1 model.

This is a partial Surface census; promotion is recorded under Promotion status. The committed
fixtures are allowlisted, sanitized projections of gitignored raw captures.

## Method

The census ran the exact native executable in print mode with the same
hermetic harness as 0.34.0:

- a newly created, isolated `KIMI_CODE_HOME`, `HOME`, and XDG roots;
- an allowlisted environment that excluded parent credentials and proxy state;
- telemetry and automatic updates disabled;
- an empty replacement skills directory;
- a loopback OpenAI-compatible fake provider selected through `KIMI_MODEL_*`;
- external collectors registered for all 20 hook names through `config.toml`
  `[[hooks]]`, which 2.4.1 still accepts unchanged.

No Kimi account, user config, user session, external model request, or model
quota was used. Twelve scenarios were captured: the eleven 0.34.0 scenarios plus
`malformed-stream`, which 0.34.0 could not complete (it hung on invalid SSE until
the harness deadline). The harness change is that scenario's expectation only.

The source projection is generated from a clean checkout at the exact release
tag. The extractor verifies the generated wire manifest (67 durable record
types), each record's top-level fields and requiredness against the manifest,
protocol 1.5, all 20 hook declarations, the engine-journal and undo record
inventory outside the manifest, CLI option spellings, and SHA-256 digests for
every contributing file. Binary probes preserve `--version`, `--help`,
rejected-option behavior, native file identity, byte count, artifact SHA-256,
and the digest of the gitignored raw-capture tree.

The local audit validates all 470 captured records against the source-derived
schemas; exact pre-normalization replay passes over the same 470 frames with
digest `52c1a655a5cb34bf8c4ff257de57a554338ed0d4c134b673cfaff1164d592202`.

## Drift from 0.34.0

Overall classification: **adaptation-required**, within the same integration
family. 2.4.1 keeps the 0.34.0 architecture (`agent-core-v2`, wire protocol
1.5, `sessions/<workdir-key>/<session>/agents/<agent>/wire.jsonl`), so the
wire-first native-TUI adapter still fits. The major-version jump is mostly
additive records and newly durable lifecycle branches, plus one schema-breaking
requirement that broke the Imposter persona.

### Unchanged

- Release asset names for all four platforms, the single `kimi` executable,
  `--version` output format, and the `PUPPETEER_KIMI_BIN` override.
- Every launch option the adapter maps or refuses (`-S/--session`,
  `-r/--resume`, `-c/-C/--continue`, `-y/--yolo/--yes/--auto-approve`,
  `--auto`, `-m/--model`, `-p/--prompt`, `--output-format`, `--skills-dir`,
  `--agent`, `--agent-file`, `--add-dir`, `--plan`), and the rejected-option
  exit status 1. Only the help wording changed: `--yolo` now reads "Ask When
  Needed mode" and `--auto` "Never Ask mode"; the persisted
  `permission.set_mode` enum is still `manual | yolo | auto`.
- `KIMI_CODE_HOME`, the `KIMI_MODEL_*` provider overrides, and hook
  configuration through `config.toml`.
- Wire protocol `1.5` (no new migration), the metadata header, and the
  `wd_<slug>_<sha256-12>` workdir key (`_base/utils/workdir-slug.ts` differs
  only by a removed comment).
- `session_index.jsonl` entries and the `state.json` session record (2.4.1 adds
  `isCustomTitle` and writes a sibling `notify/state.json`, which is not the
  session record).
- The 20-hook inventory and the common hook envelope.
- The successful turn's prompt → user message → step → content → step.end →
  `turn.ended` order, tool call/result correlation through `toolCallId` and
  `parentUuid`, `isError: true` on a failed tool result (absent on success),
  the `"0"`/`0` turn-counter type split between loop events and `turn.ended`,
  and usage persisted before content parts.

### Schema-breaking

- Every agent-scoped durable record now requires `agentId` (`"main"` or the
  child's journal id). The manifest-generated sketch and the Zod source agree.
  The exceptions are `cron.*` and the `subagent.*` mirror records, which carry
  `subagentId` instead. The adapter takes the agent from the journal path and
  was unaffected; the Imposter persona emitted off-model payloads until it
  was updated.
- `profile.bind`/`config.update` `environmentDisclosure` no longer carries a
  `date` member (observed; 0.34.0 source left the object untyped, 2.4.1 types
  it as `{ cwd }`). Instead, every captured 2.4.1 session that reaches a turn
  (all but `hook-block-prompt`) persists a `context.append_message` injection
  with `origin: { kind: "injection", variant: "date_change", disclosure: {
kind: "date", renderGeneration, localDate, timeZone } }` (observed; no
  0.34.0 capture has one). The `origin.disclosure` slot itself is not new:
  0.34.0 source already declared it as a fully typed, all-required date
  object, and 2.4.1 loosened its source type to an unconstrained `{}`.
- `plan.revision.path` became `key`; `context.apply_compaction` gained
  `wireLines`; `task.*` info gained `resumeReminded`, `parentToolCallId`, and
  `stopCode`. Further field drift is listed under "Additive fields" below;
  neither list is exhaustive, and the source contract is the full record.
- The manifest is now drained from `EVENT2_REGISTRY`, where every listed type
  is durable. The 0.34.0 transient `cron.*` and `token_counting.*` types are now
  durable; `permission.rules.add` and `skill.activate` are retired.
- Hook declarations moved from `src/agent/externalHooks` to
  `src/features/externalHooks`. `Notification` now requires `agent_id`
  (observed), and `PermissionRequest`/`PermissionResult` now always carry
  `agent_id` (source only).

### Lifecycle branches that became durable

- **Print-mode SIGINT is now a cancelled turn.** 0.34.0 exited 130 with no
  terminal record. 2.4.1 still exits 130 but persists
  `turn.cancel(target: active, reason: user_cancelled)` →
  `step.end(finishReason: interrupted)` → `turn.step.interrupted(reason:
aborted)` → `turn.ended(reason: cancelled)` → an `interruption` injection →
  `prompt.aborted`, and fires the `Interrupt` hook (`reason: cancelled`). The
  interactive Esc path is still unverified.
- **Retries are durable steps.** A first-request 429 previously left one
  `llm.request`. 2.4.1 ends the step with `finishReason: "error"`, persists
  `turn.step.retrying` (`failedAttempt`, `nextAttempt`, `maxAttempts`,
  `delayMs`, `errorName`, `statusCode`), and opens a new step with a second
  `llm.request`, all inside turn 0. A malformed SSE chunk now takes the same
  path (`ChatProviderError`) instead of hanging. Source
  (`loopService.closeFailedMachineStep`) drains a failed step's partial content
  parts before its `step.end`, and Kimi's own context fold keeps them as a
  separate assistant message. Neither capture forced partial content.
- **A provider rejection** now persists `step.end(error)` →
  `turn.step.interrupted(reason: error)` before `turn.ended(failed)`, followed by
  `prompt.completed(reason: failed)`.
- **Prompt lifecycle.** `turn.prompt` now carries the native numeric `turnId`
  and a `promptId` (`msg_…`, equal to the user message id), and every prompt
  settles with `prompt.completed(completed | failed | blocked)` or
  `prompt.aborted` after `turn.ended`. A `UserPromptSubmit` hook block still
  persists no `turn.prompt` or `turn.ended`. It now ends with
  `prompt.completed(reason: blocked)` whose `promptId` is the blocked user
  message's id.
- **Subagents are mirrored into the parent journal.** A foreground `Agent`
  call persists `subagent.spawned` (`subagentId`, `subagentName`,
  `parentToolCallId`, `parentAgentId`, `runInBackground: false`, `model`,
  `thinkingEffort`, `taskId`) → `subagent.started` → `subagent.completed`
  between the parent's `tool.call` and `tool.result`. The child journal
  (`agents/agent-0/wire.jsonl` natively, `agents/agent-0.jsonl` in the
  capture) and the `state.json` `agents` map remain. That map already carried
  `parentAgentId` and `labels.parentAgentId` in 0.34.0; 2.4.1 adds only
  `labels.profileName` (`coder`). The parent now reads `main` only because the
  sanitizer keeps that structural id, which the 0.34.0 captures aliased.
  Source routes background and swarm runs through the same mirror; background
  runs also keep `task.*(kind: agent)`.
- **The foreground child journal runs one turn.** In 0.34.0 it continued into
  a second `system_trigger`/`subagent` turn (`turnId` 1) after the first
  completed, and that was recorded as native behavior. In 2.4.1 it holds a
  single `turn.prompt` → `turn.ended(completed)` followed by
  `prompt.completed`, and its context gains a `context.append_message`
  injection with variant `subagent_background_task`, next to the engine
  `agent.turn.*` records. The census provider script may contribute to the
  turn-count difference; the cause is unconfirmed.
- **Engine-journal interleaving.** The loop engine appends `agent.turn.started`,
  `agent.message.appended`, and `agent.turn.ended` (with a `kind: "event"`
  discriminator and no `agentId`) into the same `wire.jsonl`
  (`agent/loop/machine/storeJournal.ts`). They are not in the generated
  manifest. Their `time` values are stamped earlier than neighbouring records,
  so file order, not `time`, is the native order.
- **Undo is a branch switch** in source: `wire/tree/fork.ts` writes
  `agent.switched` (branch edge), the paired legacy `context.undo`, and
  `context.undone`. Records on an abandoned branch stay in the file. Undo was
  not captured.

### Additive records

There are 21 new manifest types: `changeNotifier.snapshot`,
`file_history.checkpoint|tracked`, `mcp.server_failed|server_failure_resolved`,
`plugin.session_start`, `prompt.aborted|completed|steered`,
`runtime.set_binding`, `subagent.spawned|started|completed|failed|cancelled`,
`task.waitDelivered`, `token_counting.turn_recorded`, `tower_mode.enter|exit`,
and `turn.step.interrupted|retrying`. There are also 5 records outside the
manifest: `agent.message.appended`, `agent.turn.started|ended`,
`agent.switched`, and `context.undone`. Every successful session now opens with
`runtime.set_binding` and `changeNotifier.snapshot`, and its first turn emits
`plugin.session_start`.

### Additive fields

Notable, not exhaustive:

- `turn.ended` gains optional `stopReason` and `traceId` (source only; no
  capture carries either).
- `turn.steer` gains `messageId`, `promptIds`, and `turnId` (source only).
- `llm.request.projection` adds `strict-media-degraded` and
  `strict-media-stripped` to `strict | media-degraded | media-stripped`.
- The `PermissionRequest` and `PermissionResult` hooks gain `id` (source only).
- Observed loop-event fields: `tool.call` `display`, `tool.result`
  `result.durationMs`, `step.end` `llmClientBlockedMs`, and the think part's
  `reasoningKey`.
- `llm.request.maxTokens` is still declared optional in source, but no 2.4.1
  capture persists it, where every 0.34.0 `llm.request` did.

### CLI commands

Against the 0.34.0 root help, 2.4.1 adds `fork [options] [sessionId]`,
`session`, `rc|remote [options]`, `install-desktop`, `app [path]`, and
`import-sessions`, and `login`, `migrate`, and `upgrade|update` now take
`[options]`. The adapter's invocation grammar had already classified all of
these from its 2.0.2 help fixture except `app` and `import-sessions`, which are
the only commands new relative to that fixture.

### Hooks

The observed hook set per scenario matches 0.34.0 except that `Interrupt` now
fires on SIGINT. `PostToolUse` is dispatched fire-and-forget in both versions.
In this run it was collected for the background-task scenario but not for
`tool-success` or `subagent-turn`, whose print-mode processes exited first. That
gap belongs to this capture lane; it is not a removed hook. `SessionEnd` still
did not fire on clean print-mode exit.

## Adapter and Imposter implications

The adapter changes trace to captures or pinned source:

- `normalization/delegation.ts` maps the parent-journal `subagent.*` mirror to
  `delegation:subagent-started` (with `agentType` from `subagentName`) and
  `delegation:subagent-stopped`. It keys both this mirror and the existing
  `task.*(kind: agent)` path by subagent id and tracks whether that child's
  current run is open, so a background run settles once while a resumed child
  that reuses its id opens a new start/stop pair. 0.34.0 emitted no delegation
  events for a foreground subagent.
- `normalization/monitor.ts` projects the same records onto the delegation
  family. spawned/started/completed are exact; source-only failed/cancelled are
  provisional. A child stopped by its parent's record cannot be reopened by
  child-journal records tailed later; only a parent-journal
  `subagent.spawned`/`started` (a resume) reopens it.
- `normalization/adapter.ts` classifies the engine-journal projections
  (`agent.message.appended`, `agent.turn.started|ended`) and the
  configuration snapshots (`runtime.set_binding`, `changeNotifier.snapshot`,
  `plugin.session_start`) as known no-output records. Every other new record,
  including `prompt.*`, `turn.cancel`, `turn.step.*`, `token_counting.*`,
  `agent.switched`, and `context.undone`, is retained as `adapter:native-event`.
- Cancellation needs no new mapping. The durable `turn.ended(cancelled)`
  already closes the turn as `turn:completed(stopReason: cancelled)`, and a
  retried step stays inside one turn.
- `turn:completed.stopReason` is still taken from `turn.ended.reason`. The
  new native `turn.ended.stopReason` is source-only and never observed, so the
  adapter does not read it; preferring it when present is a follow-up once a
  capture shows its values.
- `launch/invocation-grammar.ts` is now census-checked against the 2.4.1 help.
  Relative to its previous 2.0.2 help fixture, only `app` and
  `import-sessions` are new (the other commands added since 0.34.0 were
  already classified). It classifies `app [path]` (hands the directory to the
  desktop app through `kimi-code://`) as `elsewhere`, and `import-sessions` (a
  standalone interactive import screen) as `utility`. The nested `fork` and
  `session` help fixtures are still the 2.0.2 captures.
- Prompt confirmation still waits for a durable `turn.prompt` echo. A
  hook-blocked prompt therefore still resolves `uncertain` on timeout, although
  2.4.1 now records `prompt.completed(blocked)`. Turning that into an early,
  explicit outcome is a possible follow-up.

The Imposter persona now stamps `agentId` on every agent-scoped record. It emits
`runtime.set_binding` at boot, gives `turn.prompt` the native `turnId` and a
`msg_` `promptId` shared with the user message, and settles each turn with
`prompt.completed`. It drops the removed `environmentDisclosure.date`, adds
`isCustomTitle`, and passes the 2.4.1-required permission-hook fields through.

Locally, the opt-in adapter-through-real-native-TUI lane (`KIMI_LIVE=1`)
was reported passing against this exact linux-x64 artifact with the loopback
provider. It covered TUI startup, first-prompt session discovery, durable
`turn.prompt` confirmation, normalized assistant output, and native
`--session` resume with replayed history. That run is unattested: it left no
committed receipt and is not a workflow-bound platform report, so the support
ledger counts it only as a local observation. Folder-trust behavior changes,
Esc-cancel, permission accept/deny, questions, steer, and resume tail offsets
under engine-journal interleaving were not exercised through the adapter.

## Privacy transformations

Native carriers are type-preserving redactions. These Kimi rules are new in
2.4.1:

- The structural identifiers `main`, `agent-<n>`, and `local` are kept under
  id keys. Agent ids already name the journal directory that the fixture path
  discloses, and aliasing them would break the parent/child join. The shared
  detector now accepts a vendor-declared structural value under an id key,
  matching what the redactor already did, and the repository capture gate
  applies only that allowance for Kimi. Task ids are still aliased, as in
  0.34.0.
- `wd_<slug>_<hash12>` workspace ids keep their shape with an aliased hash,
  and the slug is pinned to the harness `workspace`, so a real cwd basename
  cannot pass; both the Kimi detector and the repository gate admit only
  `wd_workspace_a11a5ed0<hex4>`. ISO wall-clock strings (`finishedAt`,
  `abortedAt`, engine `meta.createdAt`) are pinned to the shared redacted
  epoch, with a paired detector pattern. The new
  date-disclosure `localDate`/`timeZone` values are redacted, as in 0.34.0.
- The new free-text fields `subagent.completed.resultSummary` and the
  `errorMessage` of `turn.step.retrying`/`agent.turn.ended` are redacted, as
  their hook copies already were; `errorName` and `statusCode` stay
  structural.

## Unverified boundaries

- Interactive TUI paths beyond the unattested basic local lane: resize, clean/abrupt
  exit, explicit folder trust behavior changes, guarded paste under manual
  input, question dismissal, queueing and steer (`turn.steer`, `prompt.steered`). Permission accept/deny, question submission and Esc-cancel now have retained native-TUI records.
- Undo/branch switching (`agent.switched`, `context.undone`) and its effect on
  observers that tail an append-only file containing abandoned branches.
- Compaction, swarm, tower mode, goals, file history, MCP failure records, and
  non-success process-task or subagent outcomes.
- Partial content persisted by a mid-stream step failure before a retry.
- Interactive/adapter resume tail offsets under the 2.4.1 engine-journal
  interleaving.
- ACP request/result shapes for this binary.
- The account, profile, extension, and managed-platform services, whose
  evidence is still from the 2.0.2 binary and current source. This hermetic
  census never signs in.
- The 52 of 95 modelled surfaces that have only exact-source evidence; runtime
  evidence covers 43.
- Four-platform protected native-TUI/runtime verification. Artifact acquisition has passed for all four platforms; local native-TUI coverage now includes darwin-arm64.

## Attached native-TUI interactions (2026-11-04)

The exact acquired darwin-arm64 2.4.1 executable (`sha256:1a8539eae87ffbd9bf480b8a47beafc9668f66b048b96cfa631310dc12dab3a7`) now passes native permission allow/deny, question answer with its separate review/submit step, and Escape cancellation. The same live suite proves startup, native folder-trust acceptance, prompt confirmation and resume. All 167 tests passed with live mode enabled (one unrelated opt-in test skipped). The retained records and ordinary replay tests are in [`native-interactions`](../../../adapter-kimi/src/test-support/fixtures/native-interactions/README.md).

Approval resolution records report `approved` or `rejected`; the adapter reports allowed or denied. A question resolves with `{answers: {SURFACE_KIMI_QUESTION: "Alpha"}, method: "enter"}`, and the monitor moves it from pending to resolved. Escape writes `turn.cancel` with `reason: "user_cancelled"`, `turn.step.interrupted` with `reason: "aborted"`, and `prompt.aborted`; the adapter finishes that turn once with `stopReason: "cancelled"` and preserves its partial response.

This run used disposable state and a loopback model provider without an OS network-deny boundary. It is local survey evidence, not a protected promotion receipt. The earlier Surface model's runtime/source classifications and source-census claims are unchanged by these additional adapter fixtures.

## Promotion status

Four-platform artifact acquisition passed in [run 41785477841](https://github.com/vibefield/puppeteer/actions/runs/41785477841), and those identities are recorded. Protected promotion [run 41798646315](https://github.com/vibefield/puppeteer/actions/runs/41798646315) passed native-TUI/resume verification on all four platforms, so 2.4.1 is verified.
