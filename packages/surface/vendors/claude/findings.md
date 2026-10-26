# Phase 0 — Hook Surface Findings

## 2.1.308 adaptation candidate (2026-10-25)

Claude Code **2.1.308** is the upstream stable release this candidate targets. The exact
darwin-arm64 standalone artifact (`downloads.claude.ai/claude-code-releases/2.1.308/darwin-arm64/claude`)
reports `2.1.308 (Claude Code)` and has SHA-256
`ca923c86ac84b30574a82331a05b6e066c27477a926ceaffe46a845a33e4dd37`. Its `--help`
(`probes/claude@2.1.308/help.txt`, SHA-256 `b10f5c36…7fbc`) is identical at COLUMNS 80, 200 and
unset. The identity, probes, reviewed hook reference, sanitized captures, and generated ASM v3
tree are digest-bound in `model/claude@2.1.308/evidence.json`. Only darwin-arm64 has artifact
and runtime evidence, so this is a candidate, not promoted support.

### Method

Every execution of the artifact — census lanes, `--version`/`--help` probes in the generator,
invocation and switch probes — runs in `census/isolation.mjs`: a throwaway HOME,
`CLAUDE_CONFIG_DIR`, TMPDIR and XDG tree, a minimal PATH whose first entry is a `security(1)`
stub (Claude looks credentials up through PATH on macOS), and **nothing inherited** from the
caller (no `ANTHROPIC_*`, `CLAUDE_CODE_*`, proxies, or PATH `claude`). No lane used an account,
a credential, or a billed model. Reproduce with:

```sh
node packages/surface/vendors/claude/census/harness.mjs --artifact <claude> --version 2.1.308
node packages/surface/vendors/claude/sanitize-captures.mjs packages/surface/vendors/claude/captures-raw/claude@2.1.308 packages/surface/vendors/claude/captures/claude@2.1.308
node packages/surface/vendors/claude/census/invocation-probes.mjs --artifact <claude> --previous packages/surface/vendors/claude/probes/claude@2.1.283/invocation-grammar.json --output <file>
node packages/surface/vendors/claude/census/switch-probes.mjs --artifact <claude> --output <file>
node packages/surface/vendors/claude/census/generate-model.mjs --artifact <claude> --version 2.1.308 --captured-at <iso> --retrieved-at <iso>
```

Census lanes (capture modes): `init` (`--init-only`), `headless` (print turn with no
credential), `api-error-{400,401,429,500,529}` (print turns against a loopback Messages API
that answers that status to a placeholder token, `CLAUDE_CODE_MAX_RETRIES=0`), and
`interactive` + `resume` (the native TUI in a harness-owned PTY against a scripted loopback
model, driven only by hook arrivals and fixed delays — terminal output is never read). Hooks
reach one loopback sink in the adapter's own shape: SessionStart and Setup through the command
forwarder, every other event over HTTP with a bearer interpolated from `PUPPETEER_HOOK_TOKEN`.
Every managed hook carried the bearer (63 interactive hook deliveries, 0 without it).

The lanes observed **24 of 33 events** in 103 records: ConfigChange, CwdChanged,
DirectoryAdded, FileChanged, InstructionsLoaded, MessageDisplay, Notification,
PermissionRequest, PostCompact, PostModelSwitch, PostToolBatch, PostToolUse,
PostToolUseFailure, PreCompact, PreModelSwitch, PreToolUse, SessionEnd, SessionStart, Setup,
Stop, StopFailure, SubagentStart, SubagentStop, UserPromptSubmit. Not reached:
UserPromptExpansion, PermissionDenied, TaskCreated, TaskCompleted, TeammateIdle,
WorktreeCreate (never registered: a registration replaces native creation), WorktreeRemove,
Elicitation, ElicitationResult. Print-lane events are `verified-headless`
(`claude-runtime-headless`); events seen only in the TUI lanes are `verified-interactive`
(`claude-runtime-interactive`); the rest stay `unverified` with documentation evidence only.

### Hook inventory: 33 events, two new

The binary's own hook-event arrays (the runtime registry and the bundled SDK schema, both 33
entries) equal `CLAUDE_HOOK_EVENTS`; the generator re-checks this
(`probes/claude@2.1.308/hook-events.json`) and fails on any addition or removal.

- **PreModelSwitch** (2.1.251+) fires before a requested switch (`/model`, a picker, `/config`,
  fast mode, SDK `set_model`) with `from_model`, `to_model`, `requested_model` (string or
  null), `source` (`command|picker|sdk`), `context_tokens`, `prompt_cache_warm`, `cache_ttl`
  (`5m|1h`), `estimated_cache_write_usd`, and `pricing` (`configured|catalog|default`). It can
  cancel the switch (exit 2, `decision: "block"`, or `hookSpecificOutput.permissionDecision`
  `allow|deny|ask`), and **a hook still running at its timeout (native default 30 s) blocks the
  switch**. It is therefore modeled with the new Surface observation mode **`timeout-blocks`**
  (`packages/surface/src/model.ts`): installing it is safe only while the observer answers in
  time, so the adapter's generated default (passive-only) registration must not include it.
  Captured over HTTP: `/model claude-opus-4-1-20250805` produced `to_model: claude-opus-5-5`
  (Claude resolved the requested id to another model); an immediate empty reply preserved
  native behaviour.
- **PostModelSwitch** (2.1.251+) is asynchronous and passive, with the same fields and
  `source` adding `auto` and `resume` (`requested_model` null for `auto`). It followed
  PreModelSwitch in the lane. The `resume` branch was **not** observed: the resume lane
  relaunched by id without `--model` or `ANTHROPIC_MODEL` and no PostModelSwitch arrived.

### StopFailure: fires on every failure path; record it over HTTP

The survey and its critic concluded that the credential-less print turn stopped emitting
StopFailure after 2.1.226. **That was a census artefact.** The committed captures below show
StopFailure arriving over HTTP on the credential-less and every API-error print path. Why the
2.1.226 harness missed it was observed during adaptation with an ad-hoc bisect that is **not
recorded as a probe** (so it is not reproducible from this repository): a 2.1.283+ print-mode
process exited before the harness's node command collector (≈100 ms to start) completed its
StopFailure hook, while a shell `cat` hook completed and an HTTP hook arrived; the same bisect
saw 2.1.226 await even a 1 s command hook and 2.1.283 and 2.1.308 not. The census now records
over HTTP, so StopFailure is runtime-verified on every path:

| Mode | HTTP status from the loopback API | `error` |
| --- | --- | --- |
| `headless` | none (no credential, no request) | `authentication_failed` (payload also carried `effort`) |
| `api-error-400` | 400 `invalid_request_error` | `unknown` |
| `api-error-401` | 401 `authentication_error` | `authentication_failed` |
| `api-error-429` | 429 `rate_limit_error` | `rate_limit` |
| `api-error-500` | 500 `api_error` | `server_error` |
| `api-error-529` | 529 `overloaded_error` | `server_error` (never `overloaded`) |

Order: UserPromptSubmit → MessageDisplay(final) → StopFailure → SessionEnd. The binary enum
has 13 values (the official list's 12 plus `verification_required`); the model takes the
superset. `error_details` is a string in the bundled schema and absent from every capture.
Adapter consequence: StopFailure stays on HTTP; given that observation, a command-forwarder
fallback for it could lose the event whenever a print-mode process exits.

### Payload changes

- **SessionStart** `source: resume|fork` carries `seconds_since_last_response`,
  `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` (observed on the
  resume lane). SessionStart `model` is absent after `/clear`, as documented; the TUI lane's
  compact SessionStart did carry it.
- **scratchpad_dir** (2.1.257+) is a common field only when a scratchpad exists (the runtime
  input builder adds it; the bundled SDK base schema omits it). No capture carried it.
- **mcp_server** `{name, source}` (2.1.274+) on PreToolUse, PermissionRequest, PostToolUse,
  PostToolUseFailure and PermissionDenied for `mcp__*` tools; `source` is an open set. Schema
  only (no MCP lane).
- Enums: StopFailure.error (13), Notification.notification_type adds `plugin_notification`
  (13), InstructionsLoaded `memory_type` (`User|Project|Local|Managed`) and `load_reason`
  (`session_start|nested_traversal|path_glob_match|include|compact`) plus optional `globs`,
  `trigger_file_path`, `parent_file_path`; UserPromptExpansion `expansion_type`
  (`slash_command|mcp_prompt`) with `command_source` optional. UserPromptSubmit gains a
  `source` enum (… `poll_event`) in the bundled schema, but **both runtime builders compile it
  out**: no payload carries it, including the background-agent task-notification turn.
- Required lists follow the bundled schema: Stop requires only `stop_hook_active` (the schema
  marks `background_tasks`, `session_crons` and `last_assistant_message` optional, although every
  captured 2.1.308 Stop payload — 7 interactive, 1 resume — carries all three, the lists as empty
  arrays); SubagentStop no longer requires `last_assistant_message`; PostToolBatch
  `tool_calls[].tool_response` is optional.
- Callback additions: PostToolUse `classifierContext`/`updatedMCPToolOutput`, UserPromptSubmit
  and UserPromptExpansion `suppressOriginalPrompt`, SessionStart `initialUserMessage`,
  `sessionTitle`, `watchPaths`, `reloadSkills`; CwdChanged/FileChanged `watchPaths`;
  PreModelSwitch decisions and PostModelSwitch `additionalContext`; PreToolUse
  `permissionDisplay` (desktop-internal). The new handler field `onFailure: continue|block`
  (2.1.295) is a settings field the adapter does not set; a managed HTTP 500 stayed
  non-blocking (switch probe F13). SessionEnd hooks share a 1.5 s budget that a per-hook
  `timeout` raises (the adapter's 5 s applies).
- **PostToolUse(Bash) `tool_response.bashEditDiff`** (2.1.269, documentation, beta) lists files a
  Bash command changed; not captured and not modeled beyond the open `tool_response`.

### Ordering observed in the TUI lane

From the committed projection `captures/claude@2.1.308/ordering.json` (sink arrival order;
command-forwarded SessionStart/Setup can arrive after HTTP hooks emitted later, as in the print
lanes, where InstructionsLoaded arrives first):

- Tool turn: UserPromptSubmit → PreToolUse → PostToolUse | PostToolUseFailure → PostToolBatch →
  MessageDisplay → Stop.
- Permission: PreToolUse → PermissionRequest (no `tool_use_id`) → Notification
  `permission_prompt` after Claude's ≈6 s idle gate; Esc denied it with no Post*, no Stop.
- **Background agent re-entry**: the Agent tool runs in the background by default —
  PreToolUse → SubagentStart → PostToolUse (`tool_response.status: async_launched`) →
  PostToolBatch → SubagentStop → MessageDisplay → Stop, then the completion **re-enters as a new
  UserPromptSubmit turn** (a `<task-notification>` prompt) → MessageDisplay → Stop. The hook
  payload has no discriminator for that system-injected turn; the transcript has one
  (`turnOrigin: task_notification`, below).
- Files and settings: rewriting a FileChanged-matched file in the session cwd → FileChanged
  (`event: change`); rewriting `.claude/settings.json` → ConfigChange (`project_settings`).
  Bash `cd sub` → CwdChanged between PreToolUse and PostToolUse. (FileChanged watches literal
  names in the current cwd; the survey lane missed it because it wrote the file after the cd.)
- **Compaction**: `/compact` → PreCompact(manual) → SubagentStop with an **empty `agent_type`
  and no SubagentStart** (Claude's internal compaction agent) → SessionStart(compact) →
  PostCompact. SessionStart(compact) arrived via the slower command forwarder and still before
  the HTTP PostCompact, so it precedes PostCompact natively; the model's relation is corrected.
- `/model` → PreModelSwitch → PostModelSwitch; `/add-dir` → DirectoryAdded(`slash_command`);
  `/clear` → SessionEnd(clear) → SessionStart(clear) with a new session id; `/exit` →
  SessionEnd(`prompt_input_exit`). Resume: SessionStart(resume) → InstructionsLoaded → turn →
  SessionEnd.

### Transcript bookkeeping rows

Since 2.1.300 (`--system-prompt-snapshot` on by default) the session JSONL records each API
request. The committed projection `captures/claude@2.1.308/transcript-shape.json` (record
types, key names and counts only) of the TUI lane shows, beside `user` (29), `assistant` (14),
`system` (19) and `attachment` (40): `api-request` (13), `api-request-shape` (2),
`api-request-blob` (17), `atis-latch` (8), `cost-state` (5), plus `agent-name`, `custom-title`,
`last-prompt`, `mode`, `permission-mode`, `file-history-snapshot`, `file-history-delta`,
`queue-operation`. **`api-request-blob` rows carry `message.role` `user` (and once
`assistant`) with no `uuid` and no `timestamp`** — a reader that keys on `message.role` instead
of `type` projects phantom messages. `user` rows now carry `turnOrigin` (this lane: `human` |
`task_notification`; the binary's enum also has `sdk`, `scheduled`, `auto_continuation`, `peer`,
`host_synthetic`, `system`, `unknown`) and `turnPosition`; assistant rows `requestRef`,
`requestedModel`, `apiBlockIndex`, `perTurnEffort`. Volume grew about 9×: 533 KB across 201
rows for this lane (attachments 292 KB, one `api-request-shape` row up to 63 KB); the subagent
transcript is 124 KB for 15 rows. Subagent `*.meta.json` adds `launchedWithDefaults`,
`requestShape`, `requestNonInteractive`, `finished`.

### Status lines

The statusLine payload adds a `prompt_cache` object (`warm`, `ttl`, `hit_ratio`, `misses`, …);
`rate_limits` appears only for subscription accounts. subagentStatusLine task rows add
`agentType` (2.1.293; `probes/claude@2.1.308/status-channels.json`). The static probe that
reads the subagent timing is now structural: the cap from the bound in `X.length>CAP)X.splice`,
the interval from the self-rescheduling snapshot timer. Validated on the 2.1.226, 2.1.283 and
2.1.308 windows (16 samples, 5000 ms in each; the first timer in every window is a one-shot
300 ms kick that an identifier-agnostic "first setTimeout" probe would have reported).

### Invocation grammar (2.1.308 changes to §7)

`probes/claude@2.1.308/invocation-grammar.json` re-binds every 2.1.283 static fact to its
relocated anchor (each anchor and 8 KiB window re-hashed from the artifact) and adds the new
ones. All 59 recorded parse probes read identically; 17 new ones and 8 runtime probes (each in a
disposable environment, credential-less, on 2.1.308 and 2.1.283) cover the changes:

| Change | Evidence |
| --- | --- |
| `purge [path]` is a root subcommand (`--dry-run`, `-y`, `-i`, `--all`; asks unless `-y`); `project` is hidden (`project purge` still works) | `purge --help`; R04 `purge --dry-run` and R05 `-- purge` enter purge (no exit within 15 s, non-TTY) where 2.1.283 refused or started a session; R06 `--verbose -- purge --dry-run` treats `--dry-run` as purge's path |
| Background verbs dispatch behind safe root options: first operand, an 8-hex id (or `respawn --all`) next, every preceding token a safe root option, never directly after `--`, not inside a bg session | R01 `--verbose attach 1a2b3c4d` → "No job matching" (2.1.283: a session); R02 `-- attach …` is still a session; R03 argv[0] unchanged |
| `--bg/--background` count only as option tokens before `--`, value-aware | static `background-flag-value-aware` (not executed: it would start a background session) |
| `--desktop` (listed) opens the Desktop app from the root command's action (commander parses it: static `desktop-root-action`); a raw scan before `--` refuses it on the background and tmux fast paths; also refused with print, SDK, restricted, safe, bare, restrict-personal-config | parse probe reads mcp help; static only (never executed) |
| hidden `drop-worktree-registrations` (VS Code helper, requires `--json` on stdin) | R07 → "required option '--json' not specified" (2.1.283: a session) |
| `--client-data-url` no longer listed, still parses; hidden `--fast-mode <on\|off>`, `--allow-other-models`, `--include-unsupported-models`, `--host-auth-is-org-sign-in`, `--proactivity <ask\|default\|proactive>` (choices checked), `--runner-declares <names>` | parse probes (2.1.283 read root help for each new name) |
| argv[0] `--gh-standin` is the per-session gh shim's entry | R08 refuses direct use |

The 16 live sessions L01–L16 of §7 were not repeated; each rests on a static fact whose
anchor re-read unchanged and on parse probes that read identically. `cloudSessionsByDefault`
and the new `sandboxVmByDefault` are still hard-coded false.

### What blinds a session without a flag (2.1.308 re-verification of §7.5)

`probes/claude@2.1.308/hook-switches.json` re-binds the 16 static facts and re-runs the switch
sessions live with `census/switch-probes.mjs` (managed hooks in the adapter's shape, plus "the
person's" own user-settings command hooks and status line). F01–F11 reproduce the 2.1.283
results exactly. Two switches are new in 2.1.308's env registry (absent from 2.1.283's):

| Variable | Probe | Result |
| --- | --- | --- |
| `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` | F12 | does **not** blind: managed hooks fire with the bearer; the person's own command hooks and status line still run |
| | F14 (managed PreToolUse answered HTTP 500) | non-blocking: the allowed tool ran, as without the switch (F13) |
| | F16 (the person's own PreToolUse HTTP hook answered 500) | **fails closed**: the tool did not run, where F15 (no switch) and 2.1.283 ran it |
| `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` | static | no persisted trust record counts, so hooks wait for the trust dialog; not blinding once answered |

Neither needs adapter handling: the managed `--settings` layer is not "personal", and the
person's own fail-closed hooks are their configuration.

### Privacy

Claude's capture rules now live in `privacy.mjs` and extend the shared engine: `scratchpad_dir`
(the uid plus the slug-encoded project path), DirectoryAdded `directory` and permission
`directories` are paths; `mcp_server.name`, Elicitation `mcp_server_name`, `compact_summary`,
`custom_instructions`, UserPromptExpansion `command_name` and `command_args`, InstructionsLoaded
`globs`, StopFailure `error_details` (the API's own error text), task subjects and descriptions,
background-task `description`, permission `ruleContent`, PermissionDenied `reason`, and
team/teammate names are redacted; an MCP elicitation's `requested_schema` and its `content`
answers are containers (keyed by the server's own field names, so every string inside is
redacted); the closed StopFailure `error` and SessionEnd `reason` enums and the CLI's own
provenance values (`mcp_server.source`, `command_source`) are kept. Each rule has a paired
detector test. None of the newer fields occurs in the 2.1.308 captures: re-sanitizing the raw
census with these rules is byte-identical to the committed set.
The repository-wide gate applies only the closed-enum allowance on top of the shared defaults to
Claude's committed sets (historical 2.1.207/2.1.226 sets predate the stricter keys; the 2.1.207
interactive fixture carries one MCP plugin tool name and two permission-suggestion paths that the
2.1.308 rules would redact).

### Documentation versus artifact

`references/claude@2.1.308/hooks.json` is the reviewed field-level summary of
`https://code.claude.com/docs/en/hooks` (Markdown snapshot SHA-256 `3ce0f8a0…eb47`, retrieved
2026-10-25T02:31:24Z), reconciled with the hook schemas bundled in the artifact. Its
`contradictions` list records each disagreement and how the model resolves it, including
`verification_required` (binary only), StopFailure command-hook delivery, `scratchpad_dir`,
UserPromptSubmit `source`, Stop's schema-optional fields (present in every capture),
`bypass_permissions_disabled` (docs only, removed), PostModelSwitch `resume` (unobserved), and
`effort`. The page already mentions a later release (v2.1.309) in one Windows-only note.

### Adapter and Imposter (2.1.308 candidate)

`packages/adapter-claude` projections are regenerated from this model (`CLAUDE_SURFACE_VERSION`
2.1.308; 33 events, 24 runtime-verified) and its ground-truth map is re-locked: PostModelSwitch is
semantic, PreModelSwitch observed-or-controlled, none unmapped. Decisions, each with its evidence
above:

- **PreModelSwitch** (`timeout-blocks`) is not in the default registration; a caller that selects
  it explicitly gets it with the native 30 s timeout. When it arrives it is retained as
  `adapter:native-event`: a request that may still be cancelled is not a model.
- **PostModelSwitch** `to_model` → `model:updated` (observed). The root model card last published
  by either rail is the reference: a status-line card is published whenever it differs from that
  card (so the refresh after a switch away and back restores its display name, and corrects a
  switch the hooks reported out of order); a root hook model (PostModelSwitch, SessionStart
  `model`) is published only when it moves the id, so a hook never erases the status line's display
  name or repeats it. Claude runs PostModelSwitch as a detached task (two quick switches can land
  out of order), so a switch whose `from_model` is not the model currently reported is stale and
  dropped. The live proof switches with `/model` on the pinned artifact and sees the normalized
  model.
- **StopFailure** stays on HTTP (see the StopFailure section on command-hook delivery).
- **Interrupted permission prompts**: Esc at a permission prompt ends the turn with no Stop (TUI
  lane: PermissionRequest at seq 31, the next UserPromptSubmit at seq 34). The next accepted prompt
  closes every earlier main-thread request with outcome `unknown` and a `permission-outlived-turn`
  diagnostic; a subagent's request is left to its own boundary. A replay of the committed
  interactive lane pins this.
- **Compaction**: the compact SessionStart between PreCompact and PostCompact no longer closes the
  attempt; PostCompact completes it once. The internal compaction agent's SubagentStop (empty
  `agent_type`, never started) stays native, and an empty `agent_type`/`agent_id` is never stamped
  on a candidate (Runtime refuses empty actor metadata, so that SubagentStop was dropped before).
- **Transcript**: only `type` user/assistant rows are projected, and rows that are neither a
  message nor a parent-graph node (no `uuid`: every bookkeeping and side row) are dropped before the
  bounded reader window. On the lane's real 2.1.308 transcript 189 rows keep 99, with 8 replies, no
  phantom message and every turn id a prompt row's `uuid`. Which user rows open a turn follows the
  binary's own user-started test. A row with the native `isCompactSummary` marker never does: it
  continues the interrupted turn. Auto and prompt-too-long compactions copy the active prompt's
  `promptId`/`turnOrigin`/`turnPosition` onto the summary (a hermetic TUI capture shows
  `turnOrigin: human` there; manual `/compact` stamps nothing), and a summary of artifact content
  written by others starts with `<artifact-content-authored-by-others/>`, not the preamble.
  Otherwise the row's own `turnOrigin` decides, whatever its text: `human` (typed) and `sdk`
  (print-mode / Agent SDK) open a turn, and every other native value is system-injected. Rows
  without the field (2.1.226 and earlier; 2.1.308's slash/local-command, `/compact` echo,
  interruption-marker and tool-result rows) keep the `<task-notification>`/preamble prefix
  heuristic. The test is per row, never per transcript: a session begun under an older release and
  resumed under 2.1.308 mixes both kinds in one file, and a file-wide switch would re-key (and
  re-announce) its earlier replies. Across 132 real 2.1.226/2.1.283/2.1.308 adaptation and critic
  lane transcripts (136 replies) the projection is unchanged from the heuristic-only one.
- **Status lines**: subagent task rows' `agentType` names a status-only child's agent definition
  (task `type` is the task kind, `local_agent`).
- **Invocation grammar** (`CLAUDE_INVOCATION_GRAMMAR_VERSION` 2.1.308, help fixture byte-identical
  to `probes/claude@2.1.308/help.txt`): `purge` and the hidden `project` and
  `drop-worktree-registrations` are utility subcommands; background verbs dispatch as argv[0] or
  behind safe root options before an 8-hex id; `--bg/--background` anywhere, `--` or not, is
  `elsewhere` — broader than 2.1.299+, which counts them only as option tokens before `--`, because
  the reader is not version-gated and 2.1.283 matched them anywhere: accepting `-- --bg` or
  `--model --bg` would hand an older release a managed launch that starts in the background;
  `--desktop` is an `elsewhere` option; `--client-data-url` is a hidden carried option.
  An accepted session's managed `-- <prompt>` may never hand a subcommand its first operand.
  Classification per row: `probes/claude@2.1.308/invocation-grammar.json#adapterClassification`.
- **Imposter** (`personas/claude`): a resumed launch boots with SessionStart `source: resume` and
  the four prompt-cache fields (the committed resume capture's values: 19 s, 3005 tokens, likely
  expired, $0.0113); new `model-switch` and `compact-lifecycle` scenarios follow the TUI lane's
  orders, and the `incident-investigation` runflow starts with a `/model` switch. The session
  serves the model an explicit status line names, so later refreshes stay on the switched model.
  The `model-switch` transcript carries a typed prompt row with `turnOrigin`/`turnPosition` and an
  `api-request-blob` row (role `user`, no `uuid` or `timestamp`); `api-error-overloaded` replays the
  api-error-529 lane (final error message, then StopFailure `server_error`, no Stop).

### Known gaps / follow-ups

- **Platforms**: only darwin-arm64 evidence; darwin-x64, linux-x64 and windows-x64 are required
  before promotion.
- **Unreached events**: UserPromptExpansion, PermissionDenied (auto mode), TaskCreated,
  TaskCompleted, TeammateIdle, WorktreeCreate/WorktreeRemove, Elicitation/ElicitationResult,
  PostModelSwitch `auto`/`resume`, `mcp_server`, `scratchpad_dir`, `bashEditDiff`, and the
  diskless (`transcript_path: ""`) and served (`session_id: "served:<caller>"`) input variants.
- **Adapter follow-ups (deferred, design-level)**:
  - `PostToolUse(Bash).tool_response.bashEditDiff` → `workspace:file-operation`: documentation-only
    beta field (2.1.269+, recorded only with `bashEditDiffEnabled` or when Claude edits through
    Bash in auto/bypass modes); not captured, so its `shared`/`unavailable`/`skipped` semantics are
    unverified. It stays inside the retained `tool_response`.
  - Transcript user rows without `turnOrigin` still go through the prefix heuristic, which reads
    2.1.308's `/compact` input echo and its `[Request interrupted by user for tool use]` marker as
    prompts that open a turn (unchanged from earlier releases; only a reply written before the next
    typed prompt is keyed to them). The binary's user-started test also excludes `isMeta` rows,
    rows whose `origin.kind` is not `human`, and the interruption markers; the decoder reads none of
    them, and the `origin` / `promptSource` keys (in the 2.1.308 shape capture; the 2.1.226 survey
    lane's typed and notification rows carried them too) may discriminate system turns for
    releases without `turnOrigin`. Every observed meta row is a `<local-command-caveat>` the
    heuristic already skips.
  - `turnOrigin: unknown` (no `origin`, not meta, no host initiator, `promptSource` not `sdk`) is
    read as system-injected, as the binary's own test reads it. Every observed 2.1.308 typed TUI
    prompt carries `origin.kind: human` → `human`; whether a typed prompt can land on `unknown` is
    unverified.
  - `<pasted_content id=…>` wrapper lines in `UserPromptSubmit.prompt` (feature-flag gated, strings
    only, not reproduced): prompt confirmation compares exactly and would answer `uncertain`.
  - Closing an open turn at `SessionEnd`: every observed failing print turn reached StopFailure
    over HTTP before SessionEnd (the census table above); only a process that exits before the
    StopFailure delivery would leave a turn open; Core's `session:exited` then clears it and
    diagnoses it as orphaned, without a turn outcome.
  - PostModelSwitch `auto`/`resume`: unobserved. The adapter treats every `to_model` as the model
    now serving; whether an automatic fallback is reverted with another PostModelSwitch is unknown.
  - `CLAUDE_CODE_SESSION_KIND=bg`: inside a background session the CLI dispatches a background
    verb only as argv[0]; the reader does not see that variable and reads a verb behind root
    options as dispatched (a passthrough, the safe direction).
  - Hidden root options without a row (`--fast-mode`, `--proactivity`, `--runner-declares`,
    `--allow-other-models`, `--include-unsupported-models`, `--host-auth-is-org-sign-in`) are
    refused as unknown; whether any should be carried is open.
  - A `<task-notification>` UserPromptSubmit (the background-agent re-entry, TUI lane seq 42) still
    normalizes as a user `turn:started` carrying the notification as its prompt. The hook payload
    has no discriminator (`UserPromptSubmit.source` is compiled out of both runtime builders) and
    Core's `turn:started` has no origin field, so marking it a system turn needs a Core contract
    change; a prompt-prefix test on the hook rail would be a text heuristic. The transcript rail
    already reads the row's `turnOrigin` (no turn of its own for the re-entry's reply), but it
    neither opens nor closes turns, so it cannot correct the hook rail's `turn:started`.
  - An Esc-interrupted turn's open `turn:started` and its permission-gated `tool:requested` are
    not closed by the adapter: nothing native reports the interruption, and Core has no interrupted
    outcome for either (`turn:failed`/`tool:failed` would assert a failure). Core diagnoses the
    overlap (`turn-overlap`) when the next turn starts; only the pending permission is resolved.
  - The root model rail can still show a stale card for one refresh: a status line rendered before
    a switch but delivered after its PostModelSwitch is published (it differs from the hook's
    card) until the next refresh (in the TUI lane the status line refreshed right after the switch).
- **MCP tool names**: `tool_name` for `mcp__<server>__<tool>` embeds the server's config key and is
  not redacted by any rule (it is the structural tool id).
- **Agent types and model ids are kept verbatim**: `agent_type` is a built-in agent name
  (`general-purpose`, `Explore`, `Plan`), the empty compaction marker, or a custom subagent
  definition's name, which is user-authored. The 2.1.308 census runs only built-in agents, and the
  empty value is evidence the adapter depends on, which a sensitive-text rule would rewrite. Model
  ids (`model`, `from_model`, `to_model`, `requested_model`) are first-party ids in every lane; a
  census on Bedrock or Vertex, whose ids can be ARNs naming an account, or with custom agents must
  add rules for these keys first (a built-in allowlist for `agent_type`).
- **StopFailure command-hook delivery**: the cross-version bisect behind the StopFailure section
  (2.1.226 awaited a 1 s command hook; 2.1.283 and 2.1.308 did not) is not a committed probe;
  folding it into the census as a recorded lane would make that rationale reproducible.
- **Not probed live**: `--desktop` (would open the Desktop app), `-- --bg`/`--model --bg` (would
  start a background session), `CLAUDE_CODE_IGNORE_PERSISTED_TRUST`, policy-layer settings, and
  §7's L01–L16 sessions on 2.1.308.

---

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

> **2.1.308:** what changed since this probe (purge, background verbs behind root options, value-aware `--bg`, `--desktop`, `drop-worktree-registrations`, new hidden options, `--gh-standin`) and the re-verification evidence are in the 2.1.308 section at the top, *Invocation grammar*; `probes/claude@2.1.308/invocation-grammar.json` supersedes the 2.1.283 record for the candidate.

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

> **2.1.308:** F01–F11 re-ran with identical results; `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` and `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` are new (see *What blinds a session without a flag* in the 2.1.308 section and `probes/claude@2.1.308/hook-switches.json`).

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

**A host's own spawn has the same blindness.** Its launch reads the same settings layers. The allow-list restatement applies to it too, and `disableAllHooks` refuses it as it refuses a typed launch: the host's creation fails with the adapter's sentence (`AGENT_LAUNCH_REFUSED`, its code `CLAUDE_HOOKS_OFF` beside it) instead of starting a session that looks managed and is not. (Corrected 2026-09-27: this paragraph said `disableAllHooks` does not refuse a host's own spawn, which launched unobserved; that held until the runtime could carry an adapter's refusal to the person.) Whether a host's own environment reaches the sessions it spawns is its terminal layer's to say (Godview spawns through its terminal daemon, outside this repository); where it does, `CLAUDE_CODE_SIMPLE` or `CLAUDE_CODE_SAFE_MODE` there blinds them too, and the adapter does not read a host's environment.

**Not read, and why.** Policy settings (`disableAllHooks`, `allowManagedHooksOnly`, `strictPluginOnlyCustomization` covering hooks, the two HTTP lists) rank above `--settings` and blind the same way, but come from a chain the adapter cannot read in full (the admin directory's `managed-settings.json` and `managed-settings.d/`, the Windows registry, WSL inheritance, remote and helper policy), and probing them would write system files. Workspace trust holds every hook until the trust dialog is answered, typed and managed alike. On the session-id and directory paths the scan found nothing a person's shell or settings set: `CLAUDE_CODE_SESSION_ID` is exported by Claude, not read; `CLAUDE_CODE_RESUME_FROM_SESSION`, the bridge and remote session ids, `CLAUDE_BG_WORKSPACE_TRUSTED` and `CLAUDE_CODE_DISABLE_HOOK_FORWARDING` live on the SDK, cloud, Remote Control and background paths; `CLAUDE_CODE_PROJECT_DIR_NAME` names only the transcripts' folder under a relocated config root; `CLAUDE_CODE_TMUX_SESSION` is display only.
