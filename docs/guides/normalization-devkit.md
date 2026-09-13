# Agent Normalization Devkit

Status: normalization workbench plus automated runflows, 2026-08-09

## Purpose

Pre-normalization work answers, “What did this pinned vendor artifact actually expose?” Normalization work answers a different question: “Which of those native facts should become portable Puppeteer semantics, with what correlation, confidence, and state effect?”

The Agent Normalization Devkit turns the existing Imposter Control app into the place where that second question can be inspected. It does not weaken the Surface/Imposter boundary. The native control plane remains independently runnable and vendor-neutral; the Electron app composes an optional downstream projection that imports adapters and Core.

```text
Surface model ──> Imposter ──> native control plane
                                    │ exact EmittedEntry records
                                    ▼
                              folding ledger
                          (real adapter normalizer)
                                    │ AgentEvent envelopes
                                    ▼
                           Core session-state facets
```

Removing the projection leaves the native stream unchanged. Imposter never imports an adapter, and the adapter never defines what Imposter is allowed to emit.

## The three stages

The workbench is deliberately three-stage rather than a direct left/right comparison:

1. **Native evidence** shows the versioned Surface partial-order graph, exact native names and payloads, observed order, channel controls, and raw log.
2. **Folding ledger** gives every native record an explicit disposition and correlates it with zero or more portable events. This is where abstraction decisions are reviewed.
3. **Normalized session facets** shows the portable envelopes and their effect on Core lifecycle, turn, reasoning, tools, permissions, context, environment, counters, and diagnostics.

Selecting a visible ledger row time-travels all three stages to that native sequence. “Live” returns to the newest projection. The normalized side is a set of orthogonal facets, not a fabricated claim that every vendor has one exclusive state machine.

## Automated runflows

Each persona may publish a curated `runflows.json` catalog in the native-evidence stage. A catalog entry is deliberately only developer-facing metadata—stable id, cross-persona intent, title, category, tags, default stimulus/speed, and a reference to an existing scenario. It is not a second workflow language. The persona loader resolves that scenario and derives its step count, emitted native names, native channels, and live-client requirement from the executable JSON, refusing missing references or malformed catalogs at startup.

The devkit offers **run** and **step through** for every available entry. One scenario may be active per Imposter session; overlapping starts are refused. `pause`, `next step`, and `resume` operate the same validated scenario gate as the advanced controls. Runs append to the current session, so flows that establish terminal native state are explicitly marked disruptive. A Codex approval flow remains visible but disabled on a detached Imposter because a real server request needs a live app-server client to answer it.

Run identity and progress travel as `session.scenario-run` control metadata. They never enter an `EmittedEntry`, native payload, adapter normalizer, or Core reducer. Inclusive native sequence boundaries let the browser compute an actual per-run report from the independent streams: native records, ledger dispositions, portable event types, changed facets, projection completeness, and runtime errors. On completion the plane requests authoritative log/projection synchronization, repairing any emission pushes intentionally dropped under saturation.

## Decision taxonomy

Every observed native record receives one of these dispositions:

| Disposition       | Meaning                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `mapped`          | The adapter emitted at least one portable semantic event.                                                              |
| `retained-native` | There is no portable interpretation; the adapter preserved native identity as `adapter.native-event`.                  |
| `buffered`        | A stateful normalizer consumed correlation evidence and intentionally waits for a later record.                        |
| `no-output`       | The adapter intentionally emitted nothing, such as filtered ambient protocol churn.                                    |
| `driver-owned`    | Correct normalization requires transport/runtime facts absent from an emitted-record replay.                           |
| `unsupported`     | This vendor has no pure emitted-record normalizer wired into the lab.                                                  |
| `blocked`         | The native record arrived after a sequence gap and is held until authoritative backfill supplies the missing evidence. |
| `error`           | The actual adapter normalizer rejected the replayed record.                                                            |

These categories must remain distinct. Treating all zero-output records as “ignored” would hide both valid correlation and missing driver coverage.

## Current implementation

`apps/imposter-control/src/main/plane.ts` owns a generic `ControlPlaneProjection` seam. It knows only how to join, ingest, synchronize, snapshot, and leave a projection. It does not import adapters or Core. Projection work runs on a per-session asynchronous queue, so a slow projection cannot block native control messages. Projection failures—including JSON publication failures—are logged and isolated from native traffic.

`apps/imposter-control/src/main/normalization-lab.ts` is the app-owned implementation:

- it runs the real `ClaudeHookNormalizer` and `CodexNotificationNormalizer`;
- it stamps their `AgentEvent`s and applies the real Core reducer;
- it folds each contiguous native sequence exactly once into a persistent logical normalizer and reducer state;
- it deduplicates overlapping live delivery and authoritative log synchronization by native sequence;
- it pauses at a sequence gap, labels later evidence `blocked`, and resumes deterministically only after backfill closes the gap;
- it records state before/after and a bounded structural diff for every fold;
- it retains a shared 300-record presentation window for the native pane and folding ledger without truncating logical state;
- it bounds reducer changes per trace to 200 and records when an unresolved gap exceeds the 500-record pending-evidence limit.

The browser gets a revisioned authoritative snapshot from:

```text
GET /api/sessions/:sessionId/projections/normalization?vendor=:vendor
```

and revisioned window updates from the `projection-normalization` SSE event. Initial join, a detected sequence jump, a short post-burst quiet period, an explicit snapshot request, and graceful goodbye all reconcile against the Imposter's authoritative rolling log. Recovered native entries are published through `native-snapshot`, while the existing `emitted` event remains the independent low-latency native stream.

Curated capabilities arrive in `session.hello`; run lifecycle arrives through the `scenario-run` SSE event and the latest run is retained in `SessionView` for browser reconnection.

Snapshots and updates carry the processed and observed sequence cursors, completeness, missing ranges, revision, and presentation-window boundaries. The browser ignores older revisions and uses those boundaries to keep native evidence, ledger rows, and normalized time travel aligned.

Run the devkit with:

```sh
pnpm agent-devkit
```

`pnpm agent-devkit` is the single canonical command for this application.

## Honest limits of the first slice

- Claude and Codex use their pure normalizer classes, not their complete live launch/transport drivers.
- Codex JSON-RPC server requests are marked `driver-owned`: an Imposter emission record does not contain the request id, the client decision, or the resulting request/response correlation.
- Transcript and statusline observations are not mirrored into the Imposter control log yet.
- Grok composes multiple native rails in its driver and currently has no pure emitted-record normalizer, so its records are marked `unsupported`.
- The Imposter's authoritative log is intentionally byte- and count-bounded. If a sequence gap is older than that rolling log, the projection stays visibly incomplete instead of inventing state; a wider persisted replay source would be required to repair it.
- This is a design and conformance tool. Its projected state is not a second production session-state API and is not consumed by Godview.

The next fidelity step is a **paired-driver mode**: run an adapter against the same Imposter session, capture the adapter’s actual envelopes, and correlate them with native emissions and request/response records. Pure-normalizer replay remains valuable because it isolates mapping policy; paired mode adds driver-owned facts and detects divergence between the replay and the complete integration.

## Normalization design loop

For each vendor/version and semantic area:

1. Choose evidence-backed native paths and an Imposter scenario that exercises normal, optional, repeated, and adversarial orderings.
   Prefer a curated runflow when one expresses the intent; add a catalog entry only after the referenced scenario is executable and schema-valid.
2. Inspect every ledger disposition. Unknown retention is a valid result; unexplained loss is not.
3. Review correlation joins explicitly—prompt/turn, tool/permission, stream/final message, subagent/task, and compaction/context invalidation.
4. Review the smallest portable event vocabulary that preserves product-relevant meaning without pretending vendors are identical.
5. Compare state diffs and reducer diagnostics across vendors. Shared facets should have shared invariants, not necessarily identical native routes.
6. Turn accepted traces into adapter and conformance fixtures before changing the next semantic area.
7. Re-run duplicate, out-of-order, late-after-exit, missing-boundary, and unknown-event cases.

Useful review questions are:

- Which native fact justifies this portable event?
- Is the mapping one-to-one, many-to-one, one-to-many, buffered, or deliberately absent?
- Which identifier proves correlation, and what happens when it is missing?
- Does the reducer state change add portable value, or merely rename a vendor detail?
- Does a new native variant remain inspectable before anyone assigns semantics to it?
- Would the mapping still be honest if another vendor reached the same portable facet through a different route?

## Guardrails

- Never generate an Imposter persona or Surface claim from adapter mapping code.
- Never promote a normalization because the diagram looks tidy; require native evidence and focused fixtures.
- Never force every native record into a portable event.
- Never silently drop a session-relevant unknown native record.
- Never reduce later native evidence across an unresolved sequence gap; expose the gap and hold the state at the last contiguous record.
- Never truncate logical normalized state merely to bound the browser's presentation window.
- Never mistake scenario-driver state for vendor state or normalized Core state.
- Keep projection dependencies in the app composition layer; the generic native plane and Imposter package stay adapter-free.
- Keep Godview on the runtime adapter contract. The devkit projection is for design, replay, and conformance analysis.
