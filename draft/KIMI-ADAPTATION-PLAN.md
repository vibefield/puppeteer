# Kimi Code adaptation plan

Status: local ground-truth candidate hardened; native-interactive evidence and
protected promotion remain incomplete. Nothing in this document is a promoted
support claim.

Target candidate:

- Kimi Code `0.34.0`
- release tag `@moonshot-ai/kimi-code@0.34.0`
- source commit `f0614c53e59f7e1e257412063b059b9eb82764cf`
- locally inspected darwin-arm64 executable SHA-256
  `9f4337e10da47843f6b550474012a53ba8b30dd665f83b176a5cd479c5f7e859`
- initial support state: `baseline-pending`

This plan follows the repository invariant from `ADAPTING-AN-AGENT.md`:

> Surface records native evidence. Adapters normalize it. Imposter simulates it.
> Conformance cross-checks both. Promotion alone declares support.

The candidate currently has a sanitized Surface model, a wire-first adapter, a
Kimi Imposter persona, runtime/application/devkit composition, exact native
replay, and shared Core conformance. The support ledger therefore records
`baseline-pending`. It must stay there until the unchecked evidence and
promotion gates below pass.

## 1. Architecture decision

The first built-in Kimi adapter should host the native `kimi` TUI and observe its
durable v2 wire journal. It must not run `kimi acp` beside the TUI as a second
controller for the same session.

```text
native `kimi` process
  ├─ PTY ───────────────► native terminal rendering + guarded input
  ├─ agents/*/wire.jsonl ► authoritative semantic observer
  └─ external hooks ─────► optional identity/lifecycle enhancement
                              │
                              ▼
                    Kimi rail arbiter
                              │
                              ▼
                       Kimi normalizer
                              │
                              ▼
                         Core AgentEvent
```

`kimi acp` remains useful in two roles:

1. a hermetic survey/conformance oracle for the same agent-core-v2 engine; and
2. the already-supported generic ACP execution mode for users who do not need
   the native Kimi terminal.

It is not the control plane for a concurrent native-TUI process. In Kimi 0.34.0,
the TUI, ACP server, and web server are separate hosts over the same engine, not
documented attachable views of one live session.

### Why wire-first

Kimi's native CLI does not expose the SDK's `configPath` option. The only CLI
relocation mechanism, `KIMI_CODE_HOME`, moves config, credentials, plugins,
sessions, logs, and caches together. Temporarily rewriting the user's
`config.toml` to inject hooks would create a crash/race/data-loss boundary, and
an isolated overlay home could silently fork session history or auth state.

Therefore the first adapter candidate is wire-first (`native-log`). Hooks may
raise it to `native-hooks` only after a launch-scoped, non-mutating injection
mechanism is proven. Acceptable paths are:

- an upstream Kimi CLI config-path override;
- a tested overlay that preserves all required state and session continuity; or
- a documented, user-installed stable hook forwarder.

The adapter must not swap the user's global config before spawn and restore it
afterward.

## 2. Source-backed native facts

These facts are survey inputs, not normalized behavior claims:

- The interactive TUI uses `createKimiHarnessV2` by default in 0.34.0. ACP and
  web also use agent-core-v2 but each starts its own host process.
- New interactive sessions are created lazily on the first prompt. `--session`
  resumes an existing id; it does not accept a caller-minted new id.
- Session state lives below
  `$KIMI_CODE_HOME/sessions/<workdir-key>/<session-id>/`.
- The main agent journal is `agents/main/wire.jsonl`; subagents use
  `agents/<agent-id>/wire.jsonl`.
- Wire protocol 1.5 is append-only JSONL. The 0.34.0 source manifest contains
  48 operation types: 40 persisted and 8 transient. They cover turn, loop,
  content, tool, interaction, usage, compaction, task, plan, swarm, goal, and
  context records.
- `turn.ended` carries `completed`, `cancelled`, `failed`, or `blocked`.
- External hooks include session, prompt, turn, tool, permission, interruption,
  compaction, task, notification, and subagent events.
- Official native release assets are ZIP archives containing exactly one flat
  `kimi` or `kimi.exe` executable.

## 3. Truth-rail ownership

The normalizer needs one owner per semantic fact. Duplicate native evidence is
retained for diagnostics but must not produce duplicate Core events.

| Fact                                               | Primary rail                                   | Secondary/check rail                      | Rule                                                                         |
| -------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| Process spawn/exit, PTY dimensions, terminal bytes | host/PTY                                       | none                                      | Terminal bytes never establish semantic completion.                          |
| Native session id and journal path                 | wire metadata/path                             | `SessionStart` hook when available        | Bind only when the join is unique; never choose the newest session by guess. |
| User prompt observed                               | `turn.prompt`                                  | `UserPromptSubmit`                        | A control receipt becomes confirmed only after native echo.                  |
| Turn start/end                                     | `turn.prompt` / `turn.ended`                   | `TurnStarted`, `Interrupt`, failure hooks | `Stop` is step-oriented and must not terminate a turn by name alone.         |
| Assistant/reasoning content                        | `context.append_loop_event` content parts      | ACP survey                                | Preserve native part kind and streaming order.                               |
| Tool call/result                                   | loop `tool.call` / `tool.result`               | pre/post tool hooks                       | Correlate by native `toolCallId`; wire owns deduplication.                   |
| Approval/question lifecycle                        | `interaction.request` / `interaction.resolved` | permission hooks                          | Native TUI remains the responder unless a proven control rail is added.      |
| Usage                                              | `usage.record` and step-end usage              | none                                      | Keep cumulative and per-step meanings distinct.                              |
| Compaction                                         | `full_compaction.*`                            | pre/post compact hooks                    | Do not infer compaction from context-size changes.                           |
| Tasks/subagents                                    | task and agent-specific wire records           | task/subagent hooks                       | Preserve parent, agent, task, and tool ids independently.                    |
| Unknown/new native record                          | raw wire record                                | raw hook payload                          | Emit `unknown`; never silently discard it.                                   |

## 4. Surface census before adapter code

The Kimi Surface harness will use an isolated `KIMI_CODE_HOME` and a loopback
fake OpenAI-compatible provider configured through `KIMI_MODEL_*`. This gives a
real 0.34.0 engine, real hook execution, real wire persistence, and no account,
token, model cost, or external network dependency.

Raw captures stay under the gitignored `captures-raw` tree. Only allowlisted,
sanitized projections may be committed.

### Scenario matrix

1. [x] Identity: version, help, rejected option, exact release/source relation,
       artifact bytes/SHA-256, first wire metadata, and raw-capture attestation.
2. [x] Basic turn: user prompt, streamed assistant text, reasoning, usage, and
       terminal completion.
3. [x] Tool success and nonzero result: exact tool names, inputs, outputs, ids,
       and order.
4. [ ] Permission accept and deny in the native TUI.
5. [ ] Question request, answer, and dismissal if exposed by a built-in tool.
6. [ ] Interrupt/cancel during model streaming and during tool execution.
       Print-mode SIGINT is captured as exit 130 without `turn.ended` or
       `Interrupt`. Native TUI Esc-cancel remains open.
7. [ ] Queued prompt and steer while a turn is active.
8. [x] Detached process-task start, completion, context notification, and id
       continuity.
9. [x] Foreground `Agent` subagent journal plus `SubagentStart`/`SubagentStop`.
       Question tasks and non-success process-task outcomes remain open.
10. [ ] Manual and automatic compaction, including cancellation/failure if
        reachable hermetically.
11. [x] Resume of a completed session through a second native invocation.
12. [ ] Resume of an interrupted session and PTY/adapter offset behavior.
13. [x] Provider authentication rejection, failed turn, process exit, and
        `StopFailure` hook.
14. [x] HTTP 429 retry without a second durable `llm.request`, plus
        `UserPromptSubmit` block and `PreToolUse` deny. Malformed SSE still
        hangs the pinned binary and is not a committed capture.
15. [x] An injected future/unknown wire record through Imposter/conformance
        replay, proving retention; a native runtime capture remains outstanding.

Each scenario captures, with timestamps and provenance:

- client input and PTY actions;
- native hook stdin;
- every wire record for main and subagents;
- fake-provider request/response frames;
- process exit and stderr;
- ACP frames for the corresponding oracle scenario where ACP exposes it.

The ASM v2 model is generated only from these captures plus exact-source facts
whose source relationship is recorded. Every edge carries confidence and
provenance; unobserved branches remain `unverified`.

## 5. Candidate normalization map

This is a work queue for the census, not a final event map.

| Native record                           | Candidate normalized intent                       | Verification concern                             |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| first wire metadata + bound path        | `session.started`, environment snapshot           | Determine whether a distinct ready fact exists.  |
| `turn.prompt`                           | user message + `turn.started`                     | Preserve steer/queue origin and prompt id.       |
| `context.append_loop_event(step.begin)` | step boundary metadata                            | A step is not a turn.                            |
| `content.part`                          | assistant/reasoning delta                         | Map every part variant; retain unknown variants. |
| `tool.call`                             | `tool.started`                                    | Keep native args and `toolCallId`.               |
| `tool.result`                           | `tool.completed` / `tool.failed`                  | Confirm error and truncation semantics.          |
| `interaction.request`                   | permission/question requested                     | Preserve interaction kind and native id.         |
| `interaction.resolved`                  | permission/question result                        | Prove cancelled/expired forms.                   |
| `step.end`                              | usage/model/finish metadata                       | Do not emit `turn.completed` from a step end.    |
| `turn.ended`                            | completed/cancelled/failed/blocked terminal event | Establish exact Core outcome mapping.            |
| `full_compaction.*`                     | context compaction lifecycle                      | Preserve before/after ids and failure reason.    |
| `task.*` and per-agent journals         | task/subagent lifecycle                           | Establish parentage across journals.             |

## 6. Session join and control receipts

### New native session

1. Resolve the effective Kimi home without changing it.
2. Snapshot the workdir's session directory and index offset.
3. Spawn exactly one native `kimi` process in a PTY.
4. Guarded-paste the first prompt.
5. Watch for newly created candidate journals and validate their metadata/cwd.
6. Bind only when exactly one candidate records the matching `turn.prompt`.
7. Return `confirmed` for the prompt only after that native record is observed.

No candidate by the deadline returns `uncertain`. Multiple valid candidates
emit a diagnostic/unknown event and return `uncertain`; the adapter does not
pick one by mtime.

### Resume

For `--session <id>`, the id and expected path are known before spawn. The
observer opens at the pre-launch end offset, replays only the configured
history window, then tails new records without duplicating the snapshot.

### Shutdown

On terminal/process exit, drain all journals to a stable offset before emitting
the adapter's final session lifecycle. A missing `turn.ended` remains a native
abrupt-exit fact; it must not be fabricated as successful completion.

## 7. Implementation slices

### A. Bootstrap and acquisition

- [x] Read the adaptation guide and repository architecture.
- [x] Pin Kimi 0.34.0 to its exact source tag/commit and local artifact digest.
- [x] Add reviewed ZIP acquisition support with path and executable-count
      validation.
- [x] Add `packages/surface/vendors/kimi/upstream.json`.
- [ ] Acquire and attest all declared platform artifacts in the protected lane.

### B. Surface

- [x] Add `vendors/kimi/census/harness.mjs` and a loopback fake provider for
      basic, tool-success, tool-nonzero, resume, detached-task,
      provider-rejection, hook-block, hook-deny, HTTP-retry, print-mode
      SIGINT abort, and foreground-subagent scenarios.
- [x] Add a raw-capture sanitizer plus privacy and capture tests.
- [x] Add machine-generated binary probes, a raw-capture tree attestation, and
      a digest-pinned source projection checked against the exact clean release
      checkout.
- [ ] Extend the census across the remaining native-interactive permission,
      interruption, steer, task/subagent, compaction, retry, and malformed
      response scenarios.
- [x] Generate the initial 63-event ASM v2/evidence v2 with audit, evidence,
      privacy, capture, and exact pre-normalization replay tests.
- [x] Write initial `findings.md` with verified/unverified boundaries.

### C. Imposter

- [x] Add a Kimi persona driven from the ASM, including late/duplicate/unknown
      scenarios.
- [x] Model the observed main flat journal plus curated tool, compaction,
      duplicate, late, and unknown-record behavior.
- [x] Materialize the native root-level session index as an independently
      modeled, ASM-validated `native-index` rail.
- [ ] Complete native session-id minting plus interactive permission,
      multi-process resume-counter, and abrupt-exit behavior. A print-mode
      foreground subagent journal is now captured.
- [x] Add the persona to `ai`, Imposter Control, and the normalization devkit.

### D. Adapter

- [x] Scaffold `@vibecook/chopsticks-adapter-kimi`.
- [x] Implement binary/version detection and explicit capability reporting.
- [x] Implement exact workdir/session discovery and append-safe multi-journal
      tailing with bounded replay and record sizes.
- [x] Implement the rail arbiter and stateful wire-to-Core normalizer.
- [x] Implement guarded PTY prompt submission with durable native-echo receipts.
- [x] Retain unknown records and bound memory/backpressure.
- [x] Perform a final bounded journal drain on adapter disposal.
- [ ] Add a host process-exit notification so disposal/drain is automatically
      sequenced after native terminal exit.
- [ ] Add hook observation only after its non-mutating launch design passes
      transparency tests.

### E. Conformance and composition

- [x] Replay every sanitized wire capture through the real normalizer.
- [x] Run shared AgentSession conformance through the adapter against both a
      deterministic durable store and the real Kimi Imposter subprocess.
- [ ] Add pinned-real hermetic tests against the acquired 0.34.0 binary.
- [x] Wire runtime composition, package layout, root scripts, Godview,
      Godview, and Imposter Control.
- [x] Add support-ledger entry as `baseline-pending`.
- [x] Run repository typecheck, package/support/upstream checks, unit tests,
      Surface audit/privacy/evidence checks, exact replay, app bundles, public
      package builds/pack checks, and the full local conformance matrix.
- [x] Run candidate reconciliation and confirm it fails closed as
      `unsafe-or-unknown` while declared-platform artifacts are incomplete.
- [ ] Rerun reconciliation and protected verification with complete pinned-real
      platform reports.

### F. Promotion

- [ ] Reacquire exact artifacts in the protected workflow.
- [ ] Pass declared-platform pinned-real reports.
- [ ] Reconcile candidate evidence without unresolved semantic drift.
- [ ] Promote through the protected workflow only; no ordinary PR edits the
      support state to verified.

## 8. Stop conditions

Pause implementation rather than guess if any of these occurs:

- the installed binary does not match the selected candidate version;
- release assets cannot be related to the inspected source tag;
- session discovery is ambiguous in a controlled single-process run;
- the wire manifest and observed wire records disagree materially;
- hook injection requires mutation of the user's live config;
- a native fact has no faithful Core representation;
- sanitization cannot prove removal of prompts, model output, credentials,
  paths, or host-specific data.

The next evidence step is the native interactive PTY census for permissions,
interrupts, steer, interrupted-session resume, subagents, compaction, and
exit/drain behavior. It can use the existing loopback provider without user
credentials or network access.
Credential-backed Kimi testing remains a separate, explicit opt-in lane.
