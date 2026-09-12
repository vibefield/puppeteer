# Claude transcript dependency cleanup

- Started: 2026-09-11
- Status: Steps 1 and 5 complete; remaining items tracked below
- Context: Resuming large Claude sessions caused repeated transcript projection and expensive monitor updates. Commit `0296565` fixed that processing. This follow-up removes unnecessary dependencies one at a time.
- Current source contract: [RFC 003](../docs/rfcs/003-native-observation-sources.md)

## Progress

| Item                                | Decision / next action                                                                                                                                                                       | Status          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1. Live request usage and burn rate | Deleted transcript token extraction and the mixed transcript/API usage reconciler. Only authenticated OTLP `api_request` events may publish settled request usage.                           | Complete        |
| 2. Historical usage totals          | Decide whether pre-attachment totals need a separate history load. Godview's saved ledger covers only previously observed activity.                                                          | Pending         |
| 3. Exact child usage attribution    | Audit native API identity coverage. Step 1 removes transcript corrections of usage actor IDs; requests keep their exact or derived telemetry identity.                                       | Pending         |
| 4. Live assistant messages          | Evaluate removing duplicate transcript delivery: `MessageDisplay` and `Stop.last_assistant_message` already provide live text.                                                               | Pending         |
| 5. Conversation replay              | Deleted historical prompt/reply and synthetic turn replay, resume bootstrap selection and the hook wait. Existing assistant messages form a silent baseline on every attachment.             | Complete        |
| 6. Model identification             | Evaluate removing transcript fallback in favor of session hooks, status callbacks and request telemetry.                                                                                     | Pending         |
| 7. Workflow membership/completion   | Keep the small workflow journals; separate their observer from conversation transcript processing.                                                                                           | Pending         |
| 8. Unknown transcript metadata      | Evaluate removing diagnostic-only replay from normal monitoring.                                                                                                                             | Pending         |
| 9. Resume existence check           | Retain the file-existence check; it does not parse transcript content.                                                                                                                       | Audited; retain |
| 10. Child status usage estimates    | Decide separately whether callback-time `tokenCount` estimates should remain eligible for burn rate. They are not transcript data.                                                           | Pending         |
| 11. Godview burn bars               | Align the bars' source/timing policy with the intended meter. They currently use 30-second cumulative-total differences, including cache tokens, without event source or replay eligibility. | Pending         |

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
