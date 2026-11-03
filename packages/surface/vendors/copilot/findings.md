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
`8ebdd48d2cd52586ee7c524b6a36261295ce4ead`, not yet landed upstream) from the
npm `@github/copilot-linux-x64` executable on linux-x64, offline, against
Rosetta's loopback BYOK mock model; the 1.0.80 corpus was farmed on
darwin-arm64. From 1.0.85 the platform package is a single-file executable whose
writer schema exists only after its first run unpacks the payload; Rosetta now
reads it from that unpacked payload.

Rosetta's canonical inventory is cumulative across its pinned versions, so the
imported reference and this model still list 1.0.80 writer/fixture shapes (for
example the allow-all pair of `session.permissions_changed`) beside 1.0.105's.
A field or event shown here is therefore proven for 1.0.80 or 1.0.105, not
necessarily both.

- Writer schema: 53 → 80 persisted event types, none removed (fusion,
  permission-authorization, `session.usage_record`, `subagent.configured`, …).
- `session.permissions_changed`: the 1.0.105 writer schema replaces the
  allow-all pair with `mode`/`previousMode` (`manual | assisted | allow-all`),
  yet the 1.0.105 captures still persist the allow-all pair. The adapter reads
  `mode` first and keeps the pair.
- `session.model_change` is no longer written at session start in these
  scenarios; `session.start.selectedModel` carries the model and was already
  consumed. The persona now mirrors that.
- `session.usage_record` is persisted once per model request. Usage stays
  `unsupported` (durable transcript usage is excluded), so it is retained as a
  native event.
- New optional fields: `user.message.messageId`/`turnId`,
  `assistant.message.originatingMessageId` (and no `outputTokens` in these
  captures), `tool.execution_start.toolTitle`,
  `tool.execution_complete.shellExecution`, and shutdown accounting snapshots.
- Invocation grammar (`--help`, 1.0.105): new `config`, `workflow` and
  `sandbox` commands and `--trust-folder`, `--disable-client-telemetry`,
  `--mcp-github-auth`, `--sync-session`, `--host-environment`,
  `--host-compute-id`; `--remote-export` and `--no-remote` are removed, while
  `--remote` and `--no-remote-export` still parse but are unlisted.

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
