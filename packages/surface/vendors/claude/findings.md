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
linux-x64, and windows-x64 before `currentManifest` can move.

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

- Resume is spawn configuration, not storage: pass `--resume <id>` and **do NOT** also pass `--session-id` (the resumed session keeps its own id + transcript, so the chopsticks↔spaghetti join contract is preserved automatically).
- `--settings` composes with `--resume` (the hook bridge still attaches to a resumed session) — the generated settings file is passed exactly as for a fresh spawn.
- Gotcha: `-p --resume <id> "<prompt>"` warns "no stdin data received in 3s" before proceeding — a print-mode quirk; interactive (native-TUI) resume is unaffected.
