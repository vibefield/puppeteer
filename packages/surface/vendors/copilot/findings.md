# GitHub Copilot CLI 1.0.105 surface findings

Status: canonical ground truth, adapter, Imposter persona, built-in provider,
and local conformance are implemented. The baseline remains
`baseline-pending` until a guarded, matching-platform native-TUI/resume lane is
implemented and records artifact-bound durable-observation receipts on all
four platforms.

## Ground truth and identity

The vendor-root `groundtruth.json` is the single Puppeteer truth artifact. It
is generated from the complete Rosetta `rosetta-groundtruth/1` inventory,
controlled `1.0.105` fixtures, and the pinned writer schema. The schema defines
many persisted event variants that controlled fixtures do not exercise; such
variants remain schema-backed rather than being presented as runtime-observed.

Official acquisition uses the four platform-specific `@github/copilot-*`
packages from the npm registry. The executable version is probed from the
extracted artifact before it can enter the evidence workflow.

## 1.0.105 capture and drift from 1.0.80

The 1.0.105 corpus was farmed by Rosetta (commit
`8ebdd48d2cd52586ee7c524b6a36261295ce4ead`, on branch `groundtruth/upstream-rosetta-trio`,
vibefield/rosetta#39, not yet merged) from the
npm `@github/copilot-linux-x64` executable on linux-x64, offline, against
Rosetta's loopback BYOK mock model; the 1.0.80 corpus was farmed on
darwin-arm64. Unlike the 1.0.80 package, the 1.0.105 platform package is a
single-file executable whose writer schema exists only after its first run
unpacks the payload; Rosetta now reads it from that unpacked payload. Rosetta's
farm notes (commit `8ebdd48`) place that packaging change at 1.0.85, but no
release between 1.0.80 and 1.0.105 was acquired or probed here.

Rosetta's canonical inventory is cumulative across its pinned versions: the
imported `rosetta-groundtruth.json` still sums the 1.0.80 darwin-arm64 fixtures
and 2026-09-24 census with the 1.0.105 corpus. The model is version-scoped
(`versionScopedSources`): every record's shape, occurrence count and evidence
come from the digest-pinned 1.0.105 writer schema and fixture documents only.
A record that only older releases wrote (for example `session.model_change`,
the session-store `turns` table and `search_index*`) stays in the inventory as
an unverified contract lead with zero 1.0.105 occurrences.

- Writer schema: 53 → 80 persisted event types, none removed (fusion,
  permission-authorization, `session.usage_record`, `subagent.configured`, …).
- `session.permissions_changed`: the 1.0.105 writer schema replaces the
  allow-all pair with `mode`/`previousMode`, yet the 1.0.105 captures still
  persist the allow-all pair. Rosetta's derived writer document types `mode`
  only as a string; the value set `manual | assisted | allow-all` is the
  `PermissionMode` enum of the npm package's own
  `schemas/session-events.schema.json` (1.0.105, vendored by Rosetta as
  `groundtruth/copilot/sources/vendor/1.0.105.session-events.schema.json`,
  sha256 `f360052b…2f66`), and the `--help` text names `assisted` as a
  `/permissions` mode. No committed capture writes `mode`, so these values are
  schema-declared, not observed. The adapter reads `mode` first and keeps the
  pair; it labels `allow-all` as auto, `manual` as manual, `assisted` as its own
  mode, and keeps any other value raw.
- `session.model_change` (including the resume form with `previousModel`) is no
  longer written in these scenarios, neither at session start nor after
  `session.resume`; `session.start.selectedModel` and
  `session.resume.selectedModel` carry the model, and the adapter already reads
  both. The persona now mirrors that.
- `system.message` is now written after the turn's `user.message` (whose id is
  its `parentId`), where 1.0.80 wrote it before; it still carries the same
  `interactionId` as that `user.message`. It gains
  `metadata.variables.gitCommitTrailer`, and 1.0.105 no longer writes a fresh
  `system.message` for the first turn after `session.resume`.
- Dropped fields: `user.message` no longer writes `attachments` (always `[]` in
  the 1.0.80 captures) and `tool.execution_start` no longer writes `rte`. The
  adapter consumes neither, nor `system.message`, and the persona writes
  neither field.
- `session.usage_record` is persisted once per model request. Usage stays
  `unsupported` (durable transcript usage is excluded), so it is retained as a
  native event.
- New optional fields: `user.message.messageId`/`turnId`,
  `assistant.message.originatingMessageId` (and no `outputTokens` in these
  captures), `assistant.message.toolRequests[].toolTitle`,
  `tool.execution_start.toolTitle`, `tool.execution_complete.shellExecution`,
  and shutdown accounting snapshots. `session.resume.sessionWasActive` was
  already declared by the 1.0.80 writer schema but first appears in the 1.0.105
  captures.
- Invocation grammar (`--help`, 1.0.105): new `config`, `workflow` and
  `sandbox` commands and `--trust-folder`, `--disable-client-telemetry`,
  `--mcp-github-auth`, `--sync-session`, `--host-environment`,
  `--host-compute-id`; `--remote-export` and `--no-remote` are removed, while
  `--remote` and `--no-remote-export` still parse but are unlisted. The strict
  grammar reads `--sync-session[=<on|off>]` as require-equals (a following
  command is never its value), passes `--host-environment` through as
  `elsewhere` (a headless Mission Control environment, like `--acp`), and
  classes the `workflow` group as `one-shot`: its captured `workflow --help`
  lists a single subcommand, `run <name>`, which runs a registered workflow
  "without a parent agent turn" (`workflow --help` and `workflow run --help`
  captured offline in a network-deny namespace, 2026-11-04).

## Adapter boundary

The adapter launches the native `copilot` TUI and tails only
`COPILOT_HOME/session-state/<session>/events.jsonl`, the append-only source of
truth. It does not parse terminal output, consume the rebuildable
`session-store.db`, or combine the headless stdout rail with the TUI session.
Fresh launches assign `--session-id`; native resume uses only
`--resume=<session-id>`. A caller-supplied `--session-id` is not reinterpreted
as resume.

Persisted events normalize session/environment, turn, assistant, reasoning,
tool, permission, model, effort, mode, usage, compaction, delegation,
workflow, and workspace-file activity. Actor-local correlation state prevents
root and subagent turn/tool identities from colliding. Writer-only subagent,
workflow, and compaction variants are declared degraded until a pinned runtime
fixture exercises them. `session.plan_changed` proves mutation but carries no
steps, so planning remains unsupported rather than projecting `plan.md`
non-atomically.

Prompt submission uses guarded terminal paste and is confirmed only when the
durable `user.message` echoes the submitted text. Resume captures the byte
boundary before launch so historical rows cannot become fresh live events.
Observer corruption, truncation, or replacement emits an explicit degraded
monitor batch without changing native TUI liveness.

## Verification and remaining gate

Deterministic tests cover detection, managed argv and continuation state,
fresh and resumed journal observation, prompt confirmation, normalization,
actor-scoped correlation, failed compaction, observation degradation, and the
shared agent/monitor conformance suites.

Promotion still requires protected matching-platform runs through each exact
acquired executable proving native TUI launch, durable `events.jsonl`
attachment, prompt receipt, normalized completion, and native resume. Hosted
model parity with the controlled BYOK fixtures is also an explicit ongoing
reconciliation concern, not an assumption baked into normalization.
