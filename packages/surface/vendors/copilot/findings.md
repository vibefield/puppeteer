# GitHub Copilot CLI 1.0.80 surface findings

Status: canonical ground truth, adapter, Imposter persona, built-in provider,
and local conformance are implemented. The baseline remains
`baseline-pending` until a guarded, matching-platform native-TUI/resume lane is
implemented and records artifact-bound durable-observation receipts on all
four platforms.

## Ground truth and identity

The vendor-root `groundtruth.json` is the single Puppeteer truth artifact. It
is generated from the complete Rosetta `rosetta-groundtruth/1` inventory,
controlled `1.0.80` fixtures, and the pinned writer schema. The schema defines
many persisted event variants that controlled fixtures do not exercise; such
variants remain schema-backed rather than being presented as runtime-observed.

Official acquisition uses the four platform-specific `@github/copilot-*`
packages from the npm registry. The executable version is probed from the
extracted artifact before it can enter the evidence workflow.

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
