# Claude transcript dependency cleanup

- Started: 2026-09-11
- Status: Steps 1, 5, 6, 7 and 8 complete; remaining items tracked below
- Context: Resuming large Claude sessions caused repeated transcript projection and expensive monitor updates. Commit `0296565` fixed that processing. This follow-up removes unnecessary dependencies one at a time.
- Current source contract: [RFC 003](../docs/rfcs/003-native-observation-sources.md)
- Cross-provider integration audit: [Transcript service needs](TRANSCRIPT-SERVICE-NEEDS.md) tracks the shared needs and proposed app-owned service boundary for Godview and Vibefield. This document remains the record of Claude-specific removals.

## Progress

| Item                                | Decision / next action                                                                                                                                                                       | Status          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1. Live request usage and burn rate | Deleted transcript token extraction and the mixed transcript/API usage reconciler. Only authenticated OTLP `api_request` events may publish settled request usage.                           | Complete        |
| 2. Historical usage totals          | Decide whether pre-attachment totals need a separate history load. Godview's saved ledger covers only previously observed activity.                                                          | Pending         |
| 3. Exact child usage attribution    | Audit native API identity coverage. Step 1 removes transcript corrections of usage actor IDs; requests keep their exact or derived telemetry identity.                                       | Pending         |
| 4. Live assistant messages          | Evaluate removing duplicate transcript delivery: `MessageDisplay` and `Stop.last_assistant_message` already provide live text.                                                               | Pending         |
| 5. Conversation replay              | Deleted historical prompt/reply and synthetic turn replay, resume bootstrap selection and the hook wait. Existing assistant messages form a silent baseline on every attachment.             | Complete        |
| 6. Model identification             | Deleted transcript model projection, replay, fingerprints and child transcript discovery/reads. Models come from session hooks, root/child status callbacks and request telemetry.           | Complete        |
| 7. Workflow membership/completion   | Deleted workflow journal discovery, reads, membership/completion projection and idle-timeout inference. Native OTLP retains run identity and name only.                                      | Complete        |
| 8. Unknown transcript metadata      | Deleted the metadata event catch-all, initial replay and per-record fingerprints. The remaining model projection was removed in step 6.                                                      | Complete        |
| 9. Resume/reattach file checks      | Retain file discovery/existence checks for resume, reattachment and native identity recovery after an unheard `/clear`. They do not parse transcript content.                                | Audited; retain |
| 10. Child status usage estimates    | Decide separately whether callback-time `tokenCount` estimates should remain eligible for burn rate. They are not transcript data.                                                           | Pending         |
| 11. Godview burn bars               | Align the bars' source/timing policy with the intended meter. They currently use 30-second cumulative-total differences, including cache tokens, without event source or replay eligibility. | Pending         |

Only item 4 still parses transcript content in the Claude adapter. Reattachment locates and starts that same root assistant observer before the next hook arrives. Item 9 also gates recovery of a rotated native session ID on an existing root transcript. Items 2 and 3 remain coverage/product decisions after transcript usage removal; items 10 and 11 concern native status estimates and Godview's rate policy, not transcript reads. Godview Find separately queries Rosetta's transcript-indexing daemon outside the adapter.

## Step 1: remove transcript usage

Completed on 2026-09-11. Removed the transcript usage parser, its numeric helper/export, usage capabilities, and the reconciler that accepted transcript token values or actor corrections. The driver now deduplicates OTLP requests directly with a bounded 20,000-entry fingerprint cache and accepts corrections from that source. Its event publication boundary rejects token usage from durable observers.

This applies to fresh sessions, resume bootstrap, child sidecars and later appends. Historical transcript usage is not imported into the live ledger under a different flag. A separate history feature, if approved in item 2, must have an explicit boundary that cannot generate live burn.

If OTLP is disabled, unavailable on the selected version, or conflicts with an existing exporter, settled request usage remains unavailable. Existing child status samples remain a degraded estimate pending item 10. Exact child IDs supplied by OTLP continue to work; otherwise its derived actor grouping is retained.

Conversation, model and workflow observations remain for their individual follow-ups. This step does not change the shared Core rate algorithm or Godview's bar calculation.

### Acceptance checks

- [x] Transcript records never publish token usage during bootstrap or live appends, including child sidecars.
- [x] Transcript data cannot alter the amount or actor of an OTLP request.
- [x] OTLP retains token buckets, meter tokens, cost, exact/derived actor identity, duplicate suppression and corrections.
- [x] Missing OTLP reports degraded capabilities without advertising a transcript fallback.
- [x] Conversation/model/workflow observations and the resume responsiveness regressions still pass.
- [x] Claude tests, relevant typechecks and Godview bundle pass.

### Validation

- Claude adapter: **244 tests passed**, three opt-in/live tests skipped. The driver regression sends conflicting root/child transcript records before and after authenticated telemetry, then verifies API corrections and duplicate suppression. Resume and disabled-OTLP cases cannot import transcript usage.
- Claude, Runtime and Godview typechecks passed.
- Godview bundle passed; the running app must reload the rebuilt main process to use the change.
- Formatting, whitespace and the generated agent support ledger checks passed.
- The repository ground-truth mapping audit reports an unrelated stale `packages/adapter-grok/groundtruth-map.json` alongside existing Grok edits. Claude's map is current; this step does not rewrite other adapters' maps.

## Step 5: remove conversation replay

Completed on 2026-09-11. Deleted historical conversation projection, including synthetic `turn:started`, `turn:completed` and `turn:failed` events. The durable observer no longer accepts a resume-bootstrap flag, and the driver no longer queues hooks behind the initial transcript read.

Every attachment silently baselines existing assistant messages, including direct UUID resume and resume-picker preview/selection rebinds. Later assistant changes still publish through the live observer pending item 4. A valid final JSON row without a trailing newline is included in the initial snapshot so an old reply cannot appear as a new message on the next poll.

The native Claude TUI continues to resume the same session and display its history. Puppeteer's conversation state now covers events observed since attachment; no replacement historical-conversation loader is introduced. Godview Find continues to use the separate history daemon. Initial model, diagnostic and workflow snapshots remain for items 6–8, and the native resume file-existence check remains for item 9.

### Acceptance checks

- [x] No historical prompt, assistant reply or synthetic turn outcome is published on attachment.
- [x] Direct resume and picker rebinds establish a silent baseline, including a valid EOF row without a newline.
- [x] Unchanged polls and later metadata appends cannot re-emit existing conversation.
- [x] Later live assistant changes still publish.
- [x] `UserPromptSubmit`, `MessageDisplay` and `Stop` are processed while the initial transcript read is blocked.
- [x] Native resume arguments and model/workflow observation remain supported.
- [x] Claude tests, relevant typechecks, Godview bundle and repository consistency checks pass.

### Validation

- Claude adapter: **249 tests passed**, three opt-in/live tests skipped. Coverage includes direct UUID resume, picker preview/selection rebinds, a blocked first transcript read, valid EOF rows without newlines, silent unchanged polls and new live messages.
- The conformance harness now declares identity-only resume observation and no longer fabricates a historical `Stop` hook. The opt-in native TUI test was updated to check that the TUI retains history while the adapter observes only the next live turn; that lane was not executed in this validation.
- Claude, Runtime and Godview typechecks passed.
- Godview bundle passed; restart the app to load the rebuilt main process.
- Formatting, whitespace, the generated agent support ledger and all nine adapter ground-truth maps passed.

## Step 6: remove transcript model identification

Audited on 2026-09-11; completed on 2026-09-12. Deleted the transcript model projector and export, initial model replay, model fingerprints, the session reader and its public exports/tests, child directory discovery, file probes, child readers and merged-record sorting.

The adapter already identifies models without transcript content:

| Native source           | Model evidence                                                | Current wiring                                                                                                                  |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` hook     | Root session `model`, including resume                        | [Session model normalizer](../packages/adapter-claude/src/normalization/model.ts), invoked by the hook pipeline                 |
| Root status line        | Current `model.id` and `model.display_name`                   | [Status channel](../packages/adapter-claude/src/observation/status-channel.ts) emits model events and root monitor evidence     |
| Child status line       | Visible `tasks[].model`                                       | [Child monitor normalization](../packages/adapter-claude/src/normalization/monitor.ts) publishes actor model observations       |
| OTLP `api_request` logs | Actual request `model`, with native or derived actor identity | [OTLP model normalizer](../packages/adapter-claude/src/observation/otel/model.ts), published by the driver when OTLP is enabled |

These sources feed the model state displayed by Godview. Configured launch options also publish a separate configured model; they do not establish the actual observed model.

The [transcript provider](../packages/adapter-claude/src/observation/transcript/provider.ts) now reads only the root transcript through the existing bounded, append-aware reader. Session filtering, silent attachment baselines, assistant deduplication, cooperative yielding, disposal and coalesced polling remain for item 4. Root or child transcript model values cannot publish model observations, including during resume and later appends. Model-only changes cannot republish unchanged assistant text.

Historical last-used models are no longer imported. Child status covers visible tasks with a model and joins a native child only when its ID matches an observed hook identity. OTLP may be disabled or unavailable, or may identify only a derived actor group rather than an exact child. Missing observations remain unknown until suitable native evidence arrives; a historical response model is not proof of the model selected for the resumed session. Model capabilities now name the native sources and report unavailable or unverified OTLP explicitly.

The observer never scans exact-session or shared child transcript directories, including when child files change or those paths are malformed. API usage attribution and the resume file-existence check retain their existing behavior.

### Acceptance checks

- [x] Delete transcript model projection, replay, fingerprints and public exports.
- [x] Delete child transcript discovery, probes, reads and merged-record sorting.
- [x] Verify attachment and later transcript changes cannot publish model observations or alter native model state.
- [x] Verify `SessionStart`, root/child status and OTLP request models; hook/status models work with OTLP disabled.
- [x] Verify native resume uses the hook model, with no historical conversation or model replay.
- [x] Preserve root session filtering, live assistant delivery, cooperative yielding, disposal, error recovery and concurrent poll coalescing.
- [x] Run Claude tests, relevant typechecks, Godview bundle and repository consistency checks; the unrelated package-layout failure is recorded below.

### Validation

- Claude adapter: **243 tests passed**, three opt-in/live tests skipped. Regression coverage checks both exact-session and shared child paths for zero discovery/probe/read calls, transcript model changes before/after native observations, OTLP model attribution and deduplication, and hook/status models with OTLP enabled or disabled.
- Resume, live root messages, session filtering, error recovery and cooperative polling regressions pass. The four tests specific to the deleted child reader were removed; the live observer retains the relevant isolation and responsiveness coverage.
- Claude, Runtime and Godview typechecks passed; Godview bundle passed. Restart the app to load the rebuilt main process.
- Formatting, whitespace, the generated agent support ledger and all nine adapter ground-truth maps passed.
- The repository package-layout check reports the existing provider-specific `codex` token in `apps/godview/src/main/terminal-links-smoke.ts`. That file and the layout checker are unchanged by this step.

## Step 7: remove workflow journal observation

Follow-up on 2026-09-12: the remaining public workflow/team and monitor-artifact APIs were removed. OTLP workflow identity stays native evidence; child status no longer publishes context occupancy as usage. See the [subagent cleanup](WORKFLOW-TEAM-SUBAGENT-AUDIT.md). The step history below describes its earlier boundary.

Completed on 2026-09-11, replacing the original proposal to retain a separate journal observer. Deleted the workflow journal reader, its public exports and tests, directory discovery, per-worker state, idle-timeout completion inference, provider polling and replay, fingerprints and journal capability declarations.

The transcript observer no longer enters workflow directories or reads `journal.jsonl`, during attachment or subsequent polls. Existing journals, later appends and malformed workflow paths cannot publish workflow events or affect transcript observation.

Authenticated OTLP logs still identify workflow runs and names, with duplicate suppression and name updates. Exact workflow membership and completion are unavailable; no replacement file reader or timeout inference is introduced. The workflow capability is degraded when OTLP is enabled and unsupported when it is disabled or unavailable. Native subagent hooks and child status remain the sources of child lifecycle observations.

### Acceptance checks

- [x] Delete the journal reader, all polling/replay wiring, retained membership state and idle-timeout completion logic.
- [x] Remove journal capability claims and document the remaining OTLP limitations.
- [x] Verify that neither attachment nor later polls read workflow journals, including malformed workflow paths.
- [x] Verify authenticated OTLP workflow identity, duplicate suppression and name updates despite journal changes.
- [x] Verify transcript error recovery, live observations and resume regressions.
- [x] Run Claude tests, relevant typechecks, Godview bundle and repository consistency checks; the unrelated package-layout failure is recorded below.

### Validation

- Claude adapter: **246 tests passed**, three opt-in/live tests skipped. The provider regression checks filesystem calls during attachment and later polls, ignores journal appends, and continues transcript observation with an invalid workflow path. The driver regression sends authenticated OTLP workflow records, rejects foreign-session records, suppresses duplicates and accepts name updates without journal-derived members or completion.
- Capability regressions cover enabled, unverified and unavailable OTLP. Transcript error recovery and the existing live message, usage and resume regressions pass.
- Claude, Runtime and Godview typechecks passed; Godview bundle passed. Restart the app to load the rebuilt main process.
- Formatting, whitespace, the generated agent support ledger and all nine adapter ground-truth maps passed.
- The repository package-layout check reports a pre-existing provider-specific `codex` token in `apps/godview/src/main/terminal-links-smoke.ts`. That file and the layout checker are unchanged from HEAD by this step.

## Step 8: remove transcript metadata events

Completed on 2026-09-11. Deleted the catch-all that converted otherwise unhandled root and child transcript rows into `adapter:native-event` records with `transcript:*` labels. This removes initial metadata replay, live metadata publication, metadata event construction and per-record fingerprint retention. The remaining event cache tracks models by actor.

These metadata events had no Godview feature consumer. They passed through runtime validation and publication and incremented the session's unknown-event counter, while the monitor skipped them because they supplied no monitor evidence.

The transcript provider now emits only live assistant changes and model observations. Transcript reads, parent-link ordering and shared identity/evidence helpers remain for items 4 and 6. Native hook diagnostics and actual observer failures continue through their existing error paths.

### Acceptance checks

- [x] Delete metadata event generation, replay and per-record deduplication state.
- [x] Verify that existing root/child metadata and later appends emit no events or unknown-event counter increments.
- [x] Verify direct resume and reattachment remain silent for metadata.
- [x] Verify live root assistant text, root/child models, model deduplication and cooperative polling still work.
- [x] Run Claude tests, relevant typechecks, Godview bundle and repository consistency checks; the unrelated package-layout failure is recorded below.

### Validation

- Claude adapter: **247 tests passed**, three opt-in/live tests skipped. The driver regression checks 2,000 existing root metadata rows, child metadata and later typed/untyped appends, with no transcript events or unknown-event counter increments. Subsequent root assistant text and root/child models still arrive.
- Direct resume and reattachment regressions include ignored metadata. Large model snapshots retain cooperative scheduling and disposal coverage, and model deduplication remains silent when only metadata changes.
- Claude, Runtime and Godview typechecks passed; Godview bundle passed. Restart the app to load the rebuilt main process.
- Formatting, whitespace, the generated agent support ledger and all nine adapter ground-truth maps passed.
- The repository package-layout check still reports the unrelated `codex` token in `apps/godview/src/main/terminal-links-smoke.ts`, as recorded in step 7.
