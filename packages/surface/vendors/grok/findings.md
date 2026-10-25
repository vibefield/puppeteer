# Grok 1.0.70 Surface candidate

**Status:** baseline-pending candidate. It replaces the 1.0.0 candidate as the canonical `groundtruth.json`.
The 1.0.0 authoring model, captures, and reference stay unchanged under their versioned directories; Git
history keeps the 1.0.0 findings.

## Artifact and harness

| Field       | Value                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Artifact    | `https://x.ai/cli/grok-1.0.70-macos-aarch64`, darwin-arm64 standalone executable, 179 063 008 bytes |
| SHA-256     | `5c8a688251bf61e35370b828b6a353b0a20fcc3f64000de8a91d426039f29cec`                                  |
| `--version` | `grok 1.0.70 (f50904eaee6c)`. No `[stable]` suffix is printed in a disposable home.                 |
| Census      | 2026-10-25, `census/harness.mjs` (`pnpm --filter @vibefield/puppeteer-surface surface:census:grok`) |
| Probes      | `probes/grok@1.0.70/`: version, long/short help, subcommand help, `grok completions fish`           |
| Approvals   | `probes/grok@1.0.70/viewer-approvals.json` (`harness.mjs --approval-probe`, see Approval ownership) |
| Reference   | `references/grok@1.0.70/public-source-surface.json` (supplemental; see the evidence policy)         |

The harness runs the adapter's real composition, never a shadow process. Each scenario gets a short
disposable root (HOME, GROK_HOME, workspace, and a leader socket under 104 bytes), an explicit environment
with nothing inherited, and a deterministic loopback model provider. The provider serves the
chat-completions turn, the title/dashboard calls, the Responses-API stream with `sequence_number`, and
`GET /`. No credentials, account, or external model are used. Scenarios:

- `viewer-session`: leader, ACP controller, and the native viewer in a PTY. Covers a plain turn, a safe
  command, an allowed mutating command, a denied one, `session/cancel`, `_x.ai/auth/info`, and
  `session/list`, then a second controller runs `session/load`.
- `viewer-prompt`: a prompt typed into the viewer, to see which client gets the permission request.
- `headless-compact`: no viewer. A plain turn, `/compact`, and a plain turn, then a resume.
- `subagent`: subagents enabled; one approved `spawn_subagent`, then a resume.
- `hooks`: command hooks on six events, then a resume.
- `approvals-remembered-off`: `GROK_REMEMBER_TOOL_APPROVALS=0`.

The harness fails loudly when expected traffic is missing (57 expectations across the six scenarios; all
passed). It also refuses to copy `permission__*.toml`, even into the raw tree. Running the same harness
against the exact 1.0.0 bytes (sha256 `13c7f4f0…d21`, scratch output only) reproduces the drift recorded
below: three 1.0.70 expectations fail on 1.0.0 by design.

## Evidence policy: binary-only

`xai-org/grok-build` publishes HEAD/main only. Its newest commit is `2bdd1d6a` (SOURCE_REV `559751fd`,
crate `xai-grok-shell` 1.0.45, ACP crate 0.10.4 / schema 0.11.4). The binary's revision `f50904eaee6c` is
neither a mirror commit nor a SOURCE_REV value. The reference extractor checks this again on every run.
Therefore:

- Every **verified** claim rests on runtime captures or binary probes of the exact bytes.
- Mirror source (`exact-source`) and the ACP schema (`generated-schema`) are retained as **unverified**
  leads, attributed separately.
- An exact ACP 0.11.4 schema is used as a verified payload or result schema only because every captured
  1.0.70 carrier validates against it. The binary also embeds `agent-client-protocol-0.10.4` crate paths.
- Names found only in the binary's serde variant-name run are low-confidence leads: `login_refused`,
  `backend_responsive`, `session_ended`, and the fields `remedy`, `responsive`, `links_left_out`. Rust
  string pooling hides names the binary demonstrably emits, such as `background_tasks`,
  `hook_run_started`, and `subagent_spawned`. Absence from the run is therefore never evidence, and these
  leads never claim a shape.

`evidence.json` records this as `evidencePolicy.kind: "binary-only"`, and the audit requires the policy
whenever the binary revision is unpublished.

## Topology

1. `grok agent leader --no-exit-on-disconnect --relay-on-demand --leader-socket <sock>` is ready in about
   150 ms. On SIGTERM, 1.0.70 drains for about **2 s** (2007–2075 ms), exits 143, and unlinks the socket;
   `leader.lock` remains. 1.0.0 exits in under 10 ms and leaves both files.
2. `grok agent --leader --leader-socket <sock> stdio` is a strict JSON-RPC 2.0 ACP controller.
3. `grok --leader --leader-socket <sock> --resume <id>` is the native viewer for the same session. The
   leader **fans session traffic out to every attached client**, including `session/request_permission`.
   The 1.0.70 viewer renders the permission choices and the person can answer them there, also for a
   request issued before the viewer attached. The first answer from any client wins; the leader logs late
   answers as `received response for unknown request id` (also on 1.0.0) and ignores them. A prompt typed
   in the viewer still sends its permission request to the ACP controller. See Approval ownership.
4. Attaching the viewer, or `session/load`, broadcasts `background_tasks`, `model_changed`,
   `available_commands_update`, and `config_option_update` to the attached clients. With no viewer, a
   fresh controller sees none of these after `session/new`.
5. `GROK_HOME/sessions/<encodeURIComponent(cwd)>/<session>/` holds append-only `updates.jsonl` and the
   replace-in-place `signals.json`, `summary.json`, and (new) `usage.json`. It also holds raw-only files:
   `events.jsonl`, `chat_history.jsonl`, `rewind_points.jsonl`, `tool_definitions.json`,
   `system_prompt.txt`, `prompt_context.json`, `resources_state.json`, `title_refresh_idx`, and, for a
   subagent, `subagents/<child>/{meta,output}.json`. A subagent child session is a **sibling** session
   directory in the same cwd bucket, with `summary.json` `session_kind: "subagent"`.
6. Right after `session/new`, 1.0.70 sends an un-routed `GET /` to the custom model's base-URL origin,
   about 10–15 ms later. 1.0.0 never does.
7. `grok memory serve` (a per-user memory socket in GROK_HOME) exists but was not exercised; memory is
   disabled in the census.

These are separate truth rails in Surface and Imposter. Only `adapter-grok` reconciles them into Core
events.

## ACP surface (standard methods)

All are runtime-captured with directional correlation. The exact ACP 0.11.4 schema validates every
payload; agent results are `allOf(exact ACP, sampled Grok)`.

| Method                       | Direction      | 1.0.70 facts                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                 | client → agent | `promptCapabilities {image: true, audio: false, embeddedContext: true}` (image was false in 1.0.0), `mcpCapabilities {http, sse}`, `sessionCapabilities {list, resume, close}`, `authMethods [xai.api_key, grok.com]`. `_meta` holds a stable machine `agentId` (UUIDv5) and `feedbackTraceOffer`. No `additionalDirectories`.                                                                                                               |
| `session/new`                | client → agent | Result adds ACP `configOptions` (model select). `_x.ai/session/setup` phases bracket the result.                                                                                                                                                                                                                                                                                                                                             |
| `session/load`               | client → agent | History is replayed **before** the result as `_x.ai/session/update` and `session/update` frames with `_meta.isReplay` and `x.ai/leaderClientId`. The replay is a reconstruction: tools replay as `tool_call` only, and hook records are grouped differently from `updates.jsonl`.                                                                                                                                                            |
| `session/list`               | client → agent | `sessions[]` with `_meta["x.ai/session"]` facets.                                                                                                                                                                                                                                                                                                                                                                                            |
| `session/prompt`             | client → agent | `turn_completed` and `_x.ai/session/prompt_complete` precede the result. Result `_meta` has token counters plus `cancellationCategory` (`MidTurnAbort` \| `PermissionRejected` \| `PermissionCancelled`) and `cancellationContext`.                                                                                                                                                                                                         |
| `session/cancel`             | client → agent | `stopReason: cancelled`, `MidTurnAbort`, and no turn usage. A permission request still pending is resolved by the cancel (`interaction_resolved`, no `tool_call_update`).                                                                                                                                                                                                                                                                      |
| `session/request_permission` | agent → client | Shell commands with remembered approvals (the default) offer `always-allow/allow_always, allow-once/allow_once, reject-once/reject_once, reject-always/reject_always` (1.0.0: allow-once and reject-once only). `spawn_subagent` (new in 1.0.70) and any request under `GROK_REMEMBER_TOOL_APPROVALS=0` offer allow-once and reject-once. A bare `echo` is classed safe and runs without a request (`rawOutput.was_bare_echo`); 1.0.0 asked. |
| `session/update`             | agent → client | 8 of 11 ACP branches are captured: user/agent/thought chunks, `tool_call`, `tool_call_update`, `available_commands_update`, `config_option_update`, and `session_info_update`. `plan`, `current_mode_update`, and `usage_update` are unverified.                                                                                                                                                                                             |

A live `user_message_chunk` echo reaches the prompting controller **only while another client (the viewer)
is attached**. 1.0.0 always echoed. The durable log always keeps it. Live `tool_call_update` goes
`null → in_progress → completed | failed`, while the durable log keeps only `null` and the terminal status.
A denied tool carries `_meta.toolNotRun: "rejected"`.

## xAI extensions

- `_x.ai/session_notification` is the live spelling. Fourteen kinds are captured: `turn_completed`,
  `response_completed`, `hook_execution`, `hook_run_started` (new), `background_tasks` (new),
  `model_changed`, `pending_interaction`, `interaction_resolved`, `tool_call_delta_chunk`,
  `session_summary_generated`, `last_turn_summary`, `auto_compact_completed`, `subagent_spawned`
  (adds `attempt_id` and live-only `agentAddress`), and `subagent_finished`. The other 47 public-enum
  kinds are unverified source leads, and the 3 binary-only names are unverified leads with no shape.
- `_x.ai/session/update` is the durable spelling (seven captured kinds). Over ACP it appears **only**
  during `session/load` replay.
- `response_completed` on the loopback chat-completions backend is `{usage}` only: snake_case
  `input_tokens` (cache reads excluded), `output_tokens` (reasoning included), cache buckets, and
  `reasoning_tokens`, with no `signature` and no `_meta.eventId`. The public enum keeps `message_id`,
  `stop_reason`, `signature`, and `stop_sequence` optional; the xAI backend's signature is unverified.
- `turn_completed.usage` (camelCase totals that include cache reads) is absent only on `MidTurnAbort`.
  1.0.70 adds `elapsed_ms` and the cancellation `_meta`.
- Other captured methods:
  - `_x.ai/session/setup` (new): `auth`, `resolve_workspace`, `folder_trust`, `plugin_registry`, and
    `mcp_merge` come before the result with a null sessionId. `finalize_response` and `tool_overrides`
    follow when subagents are enabled, then `response_ready`.
  - `_x.ai/queue/changed`, `_x.ai/sessions/changed`, `_x.ai/session/prompt_complete`,
    `_x.ai/mcp_initialized`, `_x.ai/mcp/servers_updated` (field `mcpServers`), and the client request
    `_x.ai/auth/info`.
- The ambient `_x.ai/models/update`, `_x.ai/settings/update`, `_x.ai/announcements/update`, and
  `_x.ai/mcp/init_progress` are not emitted hermetically. They stay unverified and conditional: their
  method literals are in the binary and the public pager dispatches them.

## Ordering and conditional behavior

- **Live turn:** `session/prompt` → `_x.ai/sessions/changed` → `_x.ai/queue/changed` ×2 → [echo, with a
  viewer] → [`hook_run_started`/`hook_execution` user_prompt_submit, with hooks] →
  [`session_summary_generated` → `session_info_update`] → thought → message → `response_completed` →
  [stop hook] → `_x.ai/queue/changed` → `turn_completed` → `prompt_complete` → result →
  `last_turn_summary`.
- **Tools:** `tool_call_delta_chunk` ×3 → `tool_call` → [pre_tool_use hook] → `pending_interaction`,
  which is followed by one of two paths:
  - `session/request_permission` → `interaction_resolved` (mutating command or spawn);
  - `interaction_resolved` with no request (safe command).

  Allowed tools then go `tool_call_update` in_progress → [post_tool_use hook] → completed; rejected ones go
  failed and the turn is cancelled.

- **Subagent:** the approved `spawn_subagent` completes, then `subagent_spawned` arrives live. The child
  session's traffic (`_x.ai/mcp_initialized`, `_x.ai/queue/changed`, chunks, `response_completed`,
  `turn_completed`) reaches the **parent** controller under the child sessionId. After
  `subagent_finished` (`will_wake: true`), the parent runs a host turn without `session/prompt`.
- **Durable order** (1.0.70): `pre_tool_use` is written after `tool_call`, and `stop` after the final
  chunk. A cancelled turn's final chunk precedes `turn_completed`. `/compact` writes
  `compaction_checkpoint`, then `auto_compact_completed`, then the host-turn chunk. Each controller close
  with hooks writes `session_end` then `stop`, and `session/load` fires `session_start` again.
- **`signals.json`** is rewritten asynchronously after the result: it is absent at the first result and
  appears 51–108 ms later, and it is stale (previous turnCount) at later results. Cancelled and
  permission-rejected turns count toward `turnCount`/`cancellationCount`. On 1.0.0 it was current at the
  result and cancelled turns did not count.

## Live monitor follow-up (1.0.25, 2026-09-11)

A read-only attachment to a running Grok 1.0.25 session confirmed that `signals.json` can remain at the previous turn's context occupancy throughout a long tool loop. Live `updates.jsonl` records carry the advancing occupancy in `params._meta.totalTokens`; `agentTimestampMs` is milliseconds, while the outer durable `timestamp` is Unix seconds. Before the first signals snapshot, `models_cache.json` supplies capacity at `models[modelId].context_window`, using the current model from `summary.json`. Occupancy never contributes to billed token usage.

The live ACP `response_completed` extension supplies per-response usage and a signature. The newer payload uses `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `reasoning_tokens`. Input excludes the separate cache buckets; output already includes reasoning. The durable `turn_completed.usage` uses camelCase totals that already include cached input. The adapter hashes response identities for deduplication, publishes live response contributions, and reconciles the final turn total against those contributions. Replayed history restores totals without generating live burn.

These follow-up observations do not promote any Surface baseline or platform support claim. The 1.0.70
census reproduces their shapes on the loopback backend, without a `response_completed` signature.

## Corrections to the survey and critic

- Durable `subagent_spawned` is written right after the spawn's first `tool_call_update` in this census
  (the 1.0.0 position). The critic saw it just before `turn_completed`. The position varies, so it is
  modeled as `concurrent`, not as a fixed order.
- `config_option_update` and `background_tasks` do not "follow session/new". They follow a client
  attaching (the viewer) or `session/load`.
- The `tool_overrides` setup phase is tied to subagents being enabled, not to a TUI-typed prompt.
- `error_kind` is in the public 1.0.45 enum (`turn_completed`); it is not a binary-only lead.

## Defects of the 1.0.0 model fixed here

- `mcpServers`, not `servers`.
- `response_completed` usage is snake_case and `signature` is optional.
- `turn_completed.usage` is optional.
- `tool_call_update.content` is the real array union.
- The durable `timestamp` is Unix seconds: the carrier is bounded to `[1e9, 1e11)`, and the sanitizer pins
  it to `1000000000` rather than to the millisecond epoch.
- The ACP request methods, permission, cancel, load, and tool branches are now verified.
- Compaction (`auto_compact_completed`, `compaction_checkpoint`) and subagent
  (`subagent_spawned`/`subagent_finished`) paths are now runtime-captured and verified.
  `auto_compact_started`/`failed`/`cancelled`, `subagent_progress`, workflow, and goal updates remain
  unverified source leads.
- (adapter stage) `modelUsage` is a map keyed by model id. The sampled schemas had made the census model's
  name (`puppeteer-grok-live`) a required property of `turn_completed.usage`, the `session/prompt` result
  `_meta.usage`, and `usage.json`, so any other model was off-model. The generator now models it as
  `additionalProperties` (`model.test.ts` holds it, with a payload for another model id).

## Approval ownership (probe, 2026-10-25)

`harness.mjs --approval-probe` runs the exact artifact with a controller that leaves
`session/request_permission` unanswered and the native viewer in a PTY, then answers in the viewer with
keystrokes. Keystrokes are control input only: every outcome is read from the controller's ACP frames,
the workspace file the mutating command writes, and the persisted-rule count. The sanitized digest is
`probes/grok@1.0.70/viewer-approvals.json` (no ids, paths, or terminal bytes); the generator refuses to
write the model if the digest contradicts any fact below, and cites it as the `grok-approval-probe`
claim.

| Case                                    | What the controller observes                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Viewer allow-once (`2`)                 | `interaction_resolved {tool_call_id}`, then `tool_call_update` `in_progress` → `completed`; `end_turn`; the tool ran           |
| Viewer reject-once (`3`)                | `interaction_resolved`, then `tool_call_update` `failed` with `_meta.toolNotRun: "rejected"`; `cancelled`/`PermissionRejected` |
| Viewer Ctrl+C on the prompt             | `interaction_resolved`, then `failed` with `_meta.toolNotRun: "cancelled"`; `cancelled`/`PermissionCancelled` (new category)   |
| Controller `session/cancel`             | `interaction_resolved`, no `tool_call_update`; `cancelled`/`MidTurnAbort`                                                      |
| Viewer allow on `spawn_subagent` (`1`)  | 2-option request; `interaction_resolved`, `tool_call_update` `completed`, `subagent_spawned`                                   |
| Viewer attaches while a request pends   | attach broadcasts, then the late viewer answers it (`2`); the tool ran                                                         |

In every case the leader sends the controller **no `$/cancel_request`**: its copy of the request simply
stays open. `interaction_resolved` carries no outcome. A later controller answer to the resolved id —
`cancelled`, or the opposite decision — produces no frame, changes nothing (the tool ran or did not), and
is logged as `received response for unknown request id`. No once-answer writes a `permission__*.toml`.

**Adapter policy (the user's decision: defer to Grok's TUI).** `adapter-acp` gains an explicit
`unhandledApproval: 'deny' | 'defer'` option; the default stays `deny` for every other consumer
(`builtin-providers`' generic ACP provider). `adapter-grok` selects `defer` only for its managed
composition, whose launch recipe always attaches the viewer to the controller's leader session; a
controller-only composition (`openGrokControl` without `{ viewer: 'attached' }`) keeps the immediate
deny, which would otherwise hang the turn. A host `onApproval` handler always decides (once-first option
selection). With `defer` the request is published as `interaction:permission-requested` with
`presentation: "native-tui"` and is settled only from native evidence: the tool call's next update
(ACP's `in_progress`/`completed` → allowed; Grok's `toolNotRun` `rejected` → denied, `cancelled` →
dismissed) or, with no tool update, the turn's `cancellationCategory` (`PermissionRejected` → denied,
`PermissionCancelled`/`MidTurnAbort` → dismissed, otherwise unknown). A request still open at the
prompt's end, transport close, or disposal resolves `unknown`. Every settled request then releases the
SDK reply with a `cancelled` outcome, which the leader ignores as shown above.

## Privacy

The previous `sanitize-captures.mjs`/`privacy.mjs` passed their own gate while leaking several kinds of
data:

- absolute paths, with only the user segment redacted (`currentWorkingDirectory`, `x.ai/facets`,
  `rawOutput.output_file`);
- prompt and model text (`runningText`, `session_summary`, `last_turn_summary`, `arguments_delta`);
- raw tool arguments, and tool output encoded as **byte arrays** (`rawOutput.output`);
- the stable machine `agentId`;
- second- and millisecond-precision clocks.

The replacement gate is described in `captures/grok@1.0.70/SANITIZATION.md`. The detector runs the shared
engine with Grok rules, the shared engine with its default rules (the repository-wide gate), and
Grok-only detectors. `privacy.test.mjs` shows that every surveyed leak passed the previous rules and fails
the new detector. On the survey's leaky output, the new gate reports 499 issues across all 12 leak classes.

## Adapter and Imposter (implemented in the adapter stage)

- **Approvals (`adapter-acp/src/services/approvals.ts`).** `acpPermissionOutcome` used to pick the first
  `allow*` option, which on 1.0.70 is `allow_always`. That persisted `permission__<argv>.toml` allow rules
  in GROK_HOME and silently auto-approved later commands. It now selects the exact `allow_once` /
  `reject_once` kind, and falls back to `*_always` only when no single-use kind is offered. Unit tests use
  the captured 4-option and 2-option lists. The live proof asserts that a host approval writes no
  `permission__*.toml`. As a negative control, restoring the old selection makes the live proof fail, with
  the rule file present. Without a host handler the managed composition now defers to Grok's TUI (see
  Approval ownership); `approvals.live.test.ts` answers through the TUI and asserts the normalized
  `allowed`/`denied`, the tool's effect, and no rule file.
- **Detection.** The pin is `1.0.70`/`f50904eaee6c`. `detection.test.ts` holds the version, revision,
  version pattern, flag, and env var to the stable vendor-root ground truth. `GROK_CONTRACT` is
  `grok-native@1.0.70+acp@1.2.1`, and its limitations follow this census.
- **Normalization provenance and confidence.** Every non-ACP `sessionUpdate`, and every
  `_x.ai/session/update` record, is retained as `adapter:native-event` with adapter `grok`. The generic
  `acp` label no longer applies to them (`background_tasks`, `hook_run_started`, `login_refused`, …).
  Kinds this census verified (`_x.ai/session_notification` ∪ `_x.ai/session/update` verified variants) are
  `authoritative`. That includes `subagent_spawned`/`subagent_finished` →
  `delegation:subagent-started|stopped`. Mirror- and serde-only kinds stay `inferred`.
  `normalization/adapter.test.ts` holds both sets to this ground truth.
- **Invocation grammar 1.0.70.**
  - Fixtures are the exact artifact's `grok help` (long form) and nested helps.
  - The census reads `[aliases: …]` lines, so `--effort` and `--ref` need no special case, and checks arity.
  - Hidden alias rows (`--print` → `--single`; `--yolo`/`--dangerously-skip-permissions` →
    `--always-approve`; `--append-system-prompt` → `--rules`; `--allowed-tools`/`--allowedTools` →
    `--allow`; `--disallowedTools` → `--deny`; `--system-prompt` → `--system-prompt-override`) must classify
    exactly as the option clap names in `probes/grok@1.0.70/parse-probes.txt`. The harness records that
    file through new parse probes.
  - Hidden headless/daemon-only options (`--mode`, `--header`, `--harness`, `--conversation-history-file`,
    `--background-shell-timeout`, `--exclude-workspace-context`, `--endless-retries`,
    `--retry-all-inference-errors`) are held to the `completions.fish` optspec arity. They are refused for
    an interactive session and pass through beside a one-shot.
  - `--add-dir` is refused: a resumed session keeps its creation folders, and `initialize` advertises no
    `additionalDirectories`.
  - `worker` and the hidden `cursor-worker` (an adapter-local command table with probe evidence; core is
    unchanged) are `elsewhere`.
  - `leader` has a nested grammar held to `leader --help`: `leader worker` is `elsewhere`; `list`, `info`,
    `kill`, and `help` are utility.
- **Leader shutdown.** Disposal now sends SIGTERM and awaits the exit before removing the leader directory.
  The wait is capped at 3 s, then SIGKILL; the 1.0.70 drain is ~2 s. `GrokBackend.dispose()` now returns a
  promise.
- **Control path (`services/control-session.ts`).**
  - ACP candidates whose params carry `_meta.isReplay` (session/load history) are published as replay.
  - ACP frames under another sessionId (a subagent child) keep only their raw native events. They add no
    monitor evidence and no normalized state to the root session.
  - ACP's `session/new|load` `session:started` is admitted once when the observer is active, deduplicated
    against a live hook-derived start.
- **`--continue`/`resumeLatest`** skips sessions whose `summary.json` says `session_kind: "subagent"`.
- **Live test support.**
  - The provider answers `GET /` as an origin probe kept apart from model calls.
  - Responses SSE events carry `sequence_number`.
  - 1.0.70's tool-less title request (a final user `Generate a session title` reminder) is classified as a
    title.
  - The live proof waits for the asynchronous context sample instead of asserting it.
  - The live proof runs a mutating, approved shell command and checks the 4-option inventory, the
    written file, and the absence of rule files.
- **`groundtruth-map.json` review.**
  - Semantic: `session/update` and `_x.ai/session/update` (the durable pipeline), and
    `_x.ai/session_notification` (`normalization/interaction.ts` reads its `turn_completed` cancellation
    category to settle a deferred approval).
  - Observed or controlled: `initialize`, `signals.json`, `summary.json`, and now `_x.ai/auth/info`
    (`services/profiles.ts`).
  - The 17 unmapped events are accepted as listed. The other `_x.ai/*` notifications are consumed
    generically by `grokExtensionEvents` and the monitor rather than by literal. `session/new|load|prompt|cancel|request_permission` are consumed in `adapter-acp`.
    `usage.json` and `session/list` are unused.
- **Imposter persona.**
  - Content: `mcpServers` after the `initialize` reply; the 1.0.70 `initialize`, `session/new`, and
    `session/load` results (`image: true`, embedded context, http/sse MCP, `sessionCapabilities`, auth
    methods, `configOptions`, Grok `_meta`); setup phases around `session/new` (`response_ready` after the
    result); `session/list` and `_x.ai/auth/info` handlers; the four permission options with their native
    ids, kinds, and order, bracketed by `pending_interaction`/`interaction_resolved`; snake_case
    `response_completed` usage without a signature; no chunk `messageId`; durable user chunks without a
    `promptId`; and `prompt_complete`.
  - Store and timing: the durable `timestamp` is Unix seconds and `_meta.eventId` is `<sessionId>-<n>`
    (persona-scoped native-store options; Codex keeps the legacy millisecond envelope). `signals.json` is
    written after the prompt result, with the full 1.0.70 key set and an integer-percent
    `contextWindowUsage`. Resume replays each record under its own method with `_meta.isReplay`, so
    `_x.ai/session/update` is replayed as itself.
  - Hooks and ambient notifications are only in conditional scenarios (`configured-hooks`,
    `remote-ambient`). The approval behavior uses a mutating command.
  - Serve roles (`serve.json` `viewer.answers`): the controller process routes `session/request_permission`
    to its stdio client **and** through the leader relay to every viewer; the first successful answer wins
    and the loser's request is abandoned, so its late answer is logged as `received response for unknown
    request id` and dropped. The relay shows a viewer that registers late every request still open, until
    a viewer answers it or the session broadcasts its `interaction_resolved`. The Imposter viewer answers
    with a number key or cancels with Ctrl+C, and dismisses its prompt (replying `cancelled`) when another
    client answered first (`cli/leader-approvals.test.ts`).

## Open questions

- Which installer or channel state produces the `[stable]` suffix that the 1.0.0 evidence recorded?
  `GROK_UPDATE_CHANNEL`/`GROK_CHANNEL` are new in 1.0.70; the detection pattern keeps the suffix optional.
- What is `GET /` to the model origin: a connectivity probe or a preconnect? Is it always sent?
- Does the xAI Responses backend send `signature` or `_meta.eventId` on `response_completed`?
- Are the `session/prompt` result `_meta` token counters on a `MidTurnAbort` turn per-turn or cumulative?
- Does `session_end` fire when an ACP controller closes while the viewer stays attached?
- Can remote settings, announcements, or MCP initialization be produced hermetically to verify the ambient
  methods?
- What are the shapes of `models_cache.json`, `_x.ai/billing`, `grok update --check --json`, and
  `installed-plugins/registry.json` in 1.0.70?
- Do the binary-only `login_refused`, `backend_responsive`, and `session_ended` kinds occur, and with what
  payloads?

## Known gaps / follow-ups

Deferred design-level work, each with its evidence:

- **Platforms:** only darwin-arm64 is captured. darwin-x64, linux-x64, and windows-x64 (named-pipe leader,
  `leader.lock` readiness) need `surface:download` plus a census per platform. The ledger blocker for
  the protected four-platform lane still applies.
- **Deferred approvals, residual edges.** If the viewer exits while a request is pending and the binding
  stays alive, nothing answers it until the turn is cancelled or the binding is disposed (disposal
  releases it). A subagent child's request is keyed by its own sessionId and settles from that session's
  evidence or at disposal, not at the parent's prompt end. The Imposter `approval-turn` still emits the
  allowed tool path whatever the answer (its ops do not branch on `$response`), so an Imposter reject is
  normalized from that allowed evidence.
- **Child usage attribution.** Child-session frames no longer reach root state or usage (control path).
  Attributing them to the subagent actor, keyed by `child_session_id` from `subagent_spawned`, is not done.
  `adapter-acp`'s own monitor evidence for a foreign-session `usage_update`/`config_option_update` is
  also still unfiltered; the census captured neither on a child.
- **Response usage identity:** live `response_completed` has no signature or eventId on this backend, so
  per-response monitor usage is never attributed (`*/acp-controller.jsonl`); `turn_completed` reconciles
  the turn. MidTurnAbort turns (`session/cancel`) carry no `turn_completed.usage`, so their tokens are not
  counted. The prompt result `_meta` counters' semantics are unverified.
- **Managed environment:** `GROK_CONFIG_PATH`/`GROK_CONFIG` overlays (new in 1.0.70, binary strings) reach
  managed launches through the merged host environment (`driver.ts`). `GROK_REMEMBER_TOOL_APPROVALS`
  decides the option set (`approvals-remembered-off`); the adapter does not pin it.
- **Invocation edge:** an unknown `leader` subcommand is now refused (the nested grammar), where the flat
  row answered utility. The remaining 1.0.0-era hidden root options (`--trust`, `--load`,
  `--compaction-mode`, …) are still unknown and refused, per the unknown-is-refused policy.
- **Unverified service surfaces:** `grok update --check --json`, the plugin registry, the downloads
  layout, `models_cache.json`, `_x.ai/billing`, the xAI Responses-backend `signature`, and the memory
  socket.
- **Imposter fidelity left:**
  - Not emulated: the attach-time broadcasts (`background_tasks`, `model_changed`,
    `config_option_update` when a viewer attaches) and a live user echo that depends on a viewer being
    attached (the persona always echoes, as in the adapter's viewer-attached composition).
  - The served `session/prompt` result's `_meta.promptId` is bound per request and is not the stream's
    per-turn `$uuid:prompt`.
  - `modelUsage` uses the persona's default model id as its key.
  - The §6.1 scenario set is still partial: compaction, team, configured hooks, and remote ambient only.

## Reproduce

```sh
TMPDIR=<short dir> pnpm --filter @vibefield/puppeteer-surface surface:census:grok -- \
  --artifact <grok@1.0.70> --version 1.0.70 --source-url https://x.ai/cli/grok-1.0.70-macos-aarch64
pnpm --filter @vibefield/puppeteer-surface surface:sanitize:grok
pnpm --filter @vibefield/puppeteer-surface surface:reference:grok -- \
  --grok-source <xai-org/grok-build clone> --acp-source <agent-client-protocol clone> --artifact <grok@1.0.70>
pnpm --filter @vibefield/puppeteer-surface surface:model:grok
pnpm --filter @vibefield/puppeteer-surface surface:audit:grok
```

Run every command that executes the vendor binary with a scrubbed environment; the harness passes only its
explicit environment to Grok. The adapter's live proof against the exact artifact (loopback model only):

```sh
TMPDIR=<short dir> GROK_LIVE=1 PUPPETEER_GROK_BIN=<grok@1.0.70> \
  pnpm --filter @vibefield/puppeteer-adapter-grok exec vitest run src/acp.live.test.ts
```

## Promotion status

This is an executable baseline candidate, not a promoted support baseline. Its ASM v3 claims, exact
darwin-arm64 digest, and pre-normalization replay are machine-checked against type-preserving 1.0.70
captures under an explicit binary-only evidence policy. Promotion is still blocked on the darwin-x64,
linux-x64, and windows-x64 artifacts and censuses, and on the protected four-platform
adapter-through-native-TUI lane. `support/agents.json` therefore remains `baseline-pending`.
