# OpenCode Adaptation Plan

Status: **Stages 1–5 and local Stage 6 reconciliation implemented; protected promotion remains gated**
Candidate: **OpenCode 1.18.16** (`v1.18.16`, source revision
`a3647eb025c7615159d417dcc49fc39fdaeba65b`)
Plan basis: `draft/ADAPTING-AN-AGENT.md` and the captured findings in
`packages/surface/vendors/opencode/findings.md`

## 1. Outcome and guardrail

Adapt OpenCode as a first-class native-TUI provider without deriving semantics
from terminal text. The finished path must obey the repository invariant:

> Surface records native evidence. Adapters normalize it. Imposter simulates
> it. Conformance cross-checks both. Promotion alone declares support.

This is a new-vendor candidate, so it proceeds as an ordinary reviewed change.
The generic upstream candidate workflow cannot bootstrap the vendor-specific
implementation. A `baseline-pending` support-ledger candidate may name the
reviewed manifest, but `currentManifest`, verification, and verified public
support remain outputs of the protected promotion transaction only.

## 2. Repository onboarding summary

The implementation crosses five deliberately separated layers:

| Layer                       | Responsibility for OpenCode                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/surface`          | pinned artifact, raw/sanitized evidence, ASM v2, drift audit                                 |
| `packages/imposter`         | OpenCode-compatible HTTP/SSE backend and persona scenarios                                   |
| `packages/adapter-opencode` | backend lifecycle, HTTP/SSE client, normalization, prompt confirmation, native attach recipe |
| `packages/runtime`          | register the provider behind the existing provider seam                                      |
| apps/support ledger         | developer tooling first; public support only after conformance/promotion                     |

`packages/core` stays zero-I/O. Its current `AgentSession`, event union, reducer,
and `AgentHost` are already sufficient for the first OpenCode slice. Question
events remain native rather than forcing a premature cross-vendor core type.

## 3. Stable names

Use these identities consistently:

| Purpose                    | Name                                    |
| -------------------------- | --------------------------------------- |
| Provider/vendor key        | `opencode`                              |
| Display name               | `OpenCode`                              |
| Adapter package            | `@vibecook/chopsticks-adapter-opencode` |
| Binary override            | `CHOPSTICKS_OPENCODE_BIN`               |
| Candidate version override | `CHOPSTICKS_OPENCODE_VERSION`           |
| Live-test opt-in           | `OPENCODE_LIVE=1`                       |
| Imposter selector          | `ai --opencode` / `AI_PERSONA=opencode` |
| Imposter shim              | `opencode`                              |

Account/quota reporting is out of scope for the first adapter unless a native,
evidence-backed account surface is found during the remaining survey.

## 4. Primary architecture decision

Use OpenCode's own headless backend and attach its own TUI to the same native
session:

```text
                         native events        normalized events
opencode serve ──────── GET /event (SSE) ─── adapter ─────────── runtime
      │                        ▲                 │
      │ REST create/history/   │                 │ AgentHost recipe
      │ prompt/abort/control    │                 ▼
      └────────────────────────┴──── opencode attach <url> --dir <cwd> --session <ses_id>
                                                │
                                           native terminal
```

Why this rail:

- it preserves the real OpenCode terminal instead of emulating or scraping it;
- session identity is returned directly by `POST /session`;
- `/event` carries authoritative semantic events and correlated blockers;
- `/session/:id/message` provides durable resume/rehydration state;
- `prompt_async` accepts an exact caller-provided message ID;
- permissions and questions remain OpenCode-native and visible to the TUI.

Do not use ACP as the authoritative rail for this adapter. ACP remains a valid
generic compatibility mode, but it omits OpenCode-specific events and risks a
second controller racing the native TUI.

## 5. Process, security, and ownership contract

For the first implementation, use one backend per Chopsticks session. This
trades a small process cost for clear credential, directory, lifecycle, and
failure isolation.

Adapter-owned backend:

1. Resolve the exact executable (per-session override, runtime override, then
   `opencode`).
2. Generate a 256-bit random Basic-auth password.
3. Spawn `opencode serve --hostname 127.0.0.1 --port 0 --pure`.
4. Pass username/password in environment only.
5. Parse the canonical listening line; reject non-loopback URLs.
6. Leave mDNS disabled and provide no CORS origins.
7. Terminate the backend during adapter disposal after observers close.

Host-owned terminal:

1. The adapter returns or spawns a `TerminalSpec` for
   `opencode attach <url> --dir <cwd> --session <id> --pure`.
2. The password is passed in `TerminalSpec.env`, never as `--password`.
3. `runtimeSessionId` is the host terminal routing ID; `sessionId` is the
   OpenCode `ses_…` ID.
4. Closing observation/control does not silently claim the terminal process
   exited; runtime process-exit reporting stays separate.

Approval ownership defaults to **native TUI**. The SSE adapter observes and
normalizes permission/question decisions but does not answer them. A future
explicit `onApproval` host-controller option may answer REST requests, but it
must switch presentation to `host-ui` and establish a single controller lease;
it cannot race the native TUI.

## 6. Session bootstrap and resume algorithms

### Fresh session

1. Start the backend and wait for readiness.
2. Open `/event?directory=<cwd>` and wait for `server.connected`.
3. `POST /session` with optional title/model and the selected permission rules.
4. Record the returned native session ID.
5. Launch/adopt `opencode attach` for exactly that ID.
6. Emit a derived runtime `session.ready` only after the session is verified
   and the attach recipe has been handed to the host; do not invent a native
   readiness event.

### Resume

1. Start a private backend and connect SSE before reading history.
2. `GET /session/:id` in the requested directory; reject a missing/mismatched
   session rather than silently creating a new one.
3. Buffer live SSE events while fetching `/session/:id/message`, status, and
   pending permission/question requests.
4. Normalize the durable snapshot as `replay: true`.
5. Apply buffered live events using native event IDs and entity-state
   deduplication.
6. Launch `attach --session <id>`.

The SSE endpoint has no proven history cursor. After disconnect, reconnect,
rehydrate durable state, and reconcile. Never describe the result as gap-free
solely because event IDs exist.

## 7. Prompt submission contract

`submitPrompt` uses REST, not terminal paste:

1. Mint `msg_chopsticks_<random>`.
2. `POST /session/:id/prompt_async` with that `messageID`, model/agent, and one
   text part.
3. A `204` means accepted, not confirmed.
4. Confirm only when `message.updated` for role `user` echoes that exact ID (or
   durable rehydration finds it).
5. Return `uncertain` on timeout/disconnect after HTTP acceptance.
6. Return `rejected` for validation/auth/not-found responses before acceptance.
7. Serialize submissions per session until busy/concurrency semantics receive
   a dedicated capture.

This matches the core receipt contract and avoids false confirmation from an
unrelated concurrent user message.

## 8. Normalization table for the first adapter slice

All live SSE semantics use `source: native-protocol` and authoritative
confidence. Durable history uses the same source with `replay: true`.
Adapter lifecycle events use `source: runtime` and derived confidence.

| Native observation                                    | Normalized event/rule                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| created or verified resumed session                   | `session.started` once                                                                           |
| fork `session.created` without `parentID`             | independent `session.started`, never `subagent.started`                                          |
| child `session.created {parentID}` or task metadata `sessionId` | `subagent.started` keyed by the child session ID                                        |
| child idle/deleted joined through native child ID     | `subagent.stopped` once; do not stop the parent turn                                             |
| completed task carrier with `background:true`         | async handle only; keep the joined subagent active until child idle                              |
| archived `session.updated`                            | retain native visibility metadata without ending the session                                     |
| `session.deleted`                                     | terminal removal of that native session identity                                                 |
| first user `message.updated` for an unseen message ID | `turn.started`; use user message ID as OpenCode turn correlation                                 |
| text part start/delta/completion                      | accumulate by part ID; emit `assistant.message` non-final/final                                  |
| reasoning part start/delta/completion                 | reasoning start/summary/completion; do not expose hidden provider payload beyond native evidence |
| prompt `file` part and synthetic expansion siblings   | retain one native attachment on the correlated user turn; do not create extra turns              |
| tool `pending`                                        | `tool.requested` keyed by `callID`                                                               |
| tool `running`                                        | `tool.started` once per state transition                                                         |
| tool `completed`                                      | `tool.completed` with duration/output                                                            |
| tool `error`                                          | `tool.failed`                                                                                    |
| `file.edited` / `file.watcher.updated`                | retain `adapter.native-event`; workspace reconciliation uses native file identity                |
| `GET /vcs/diff?mode=git`                              | authoritative tracked-workspace query; do not replace it with an empty session snapshot diff     |
| `permission.asked`                                    | `permission.requested`, correlate request ID and tool call ID                                    |
| reply `once` or `always`                              | `permission.resolved {outcome:allowed}`                                                          |
| reply `reject`                                        | `permission.resolved {outcome:denied}`                                                           |
| question asked/replied/rejected                       | retain `adapter.native-event`; surrounding question tool still follows generic tool lifecycle    |
| `session.status {type:retry}`                         | retain `adapter.native-event`; keep the correlated turn active                                   |
| idle status with one active correlated turn           | `turn.completed` once                                                                            |
| `session.error` with an active turn                   | pending failure; `turn.failed` on idle unless automatic compaction recovers the same turn        |
| completed step tokens + resolved native model limit   | `context-window.updated`; prefer native total, otherwise sum input/output/cache                  |
| `session.compacted`                                   | `context-window.invalidated {reason:compacted}`                                                  |
| model/directory changes proven by session updates     | `session.environment.updated`                                                                    |
| recognized infrastructure/catalog churn               | drop from generic state but retain in Surface fixtures                                           |
| any other session-relevant event                      | `adapter.native-event {adapter:opencode}`                                                        |

Important ordering rules from the census:

- duplicate `message.updated` and `session.status` events are normal;
- a Bash tool may be running before `permission.asked`;
- a question may be asked before its tool publishes `running`;
- reject/dismiss leads to tool error and idle without a second provider turn;
- retry status returns to busy and reuses the active turn rather than starting
  another one;
- abort emits `MessageAbortedError`, but an interrupted Bash part can later
  publish `completed`; the failed turn remains authoritative;
- write/edit tools emit `file.edited` before watcher `add`/`change` and tool
  completion; `session.diff` can remain empty while `/vcs/diff?mode=git`
  returns the actual tracked patch;
- a text prompt attachment persists as one `file` part after two synthetic
  text expansions on the same user message;
- manual summarize emits a synthetic `compaction {auto:false}` message part,
  an assistant `mode:compaction` summary, then `session.compacted`;
- declared usage above the native model's usable limit emits
  `compaction {auto:true, overflow:false}`, a synthetic continuation,
  `session.compacted`, and a resumed build response;
- a replacement SSE stream emits `server.connected` but no session history;
  durable REST state is required to close the observation gap;
- a restarted private backend can recover the exact native session ID and
  accept another correlated prompt without another `session.created`;
- idle completes only a known active turn; ambient idle cannot create one.

Map `step-finish.tokens` to context pressure only when the active native model
limit is resolved. Prefer `tokens.total`; otherwise sum input, output, cache
read, and cache write, matching the exact-release threshold implementation.

## 9. Delivery stages and gates

### Stage 0 — scope and bootstrap (complete)

Delivered:

- stable vendor/package/environment names;
- current candidate selection and exact source pin;
- governed multi-platform acquisition policy;
- server+attach architecture decision;
- clean repository baseline (`pnpm test` passes when listener permissions are
  available).

Gate: `pnpm upstream:check` and artifact/version probe pass.

### Stage 1 — survey and evidence (complete for darwin-arm64)

Delivered:

- official binary flag probes;
- fake-provider HTTP/SSE census harness;
- baseline turn, permission accept/reject, question reply/reject captures;
- streamed-response abort, running-tool abort, retryable provider recovery, and
  terminal provider-error captures;
- SSE disconnect/durable-rehydration and exact-session backend-restart resume
  captures;
- exact-session native `attach` plus a TUI-originated, confirmed `always`
  permission capture;
- combined private-backend restart, exact-session recovery, fresh native
  `attach`, resumed prompt, and TUI-originated `always` permission capture;
- Git-backed file write/edit/delete tool captures, add/change/unlink watcher
  variants, pre/post snapshot hashes, patch parts, exact message-scoped diffs,
  empty unscoped diff behavior, and the tracked `/vcs/diff` result;
- manual compaction request, durable compaction messages/part, explicit
  `session.compacted`, and post-compaction idle capture;
- automatic declared-token threshold crossing, `auto:true` compaction,
  synthetic continuation, and resumed build-loop capture;
- provider HTTP 413 hard-overflow capture, `overflow:true` automatic
  compaction, synthetic continuation, and recovered build-loop completion;
- zero/unknown context-capacity capture proving that even very high reported
  usage does not trigger proactive compaction when `limit.context` is `0`;
- foreground task-tool and direct `subtask` message-part captures, with
  durable child-session/message lookup and verified parent/child ordering;
- direct `agent` message-part capture, generated synthetic task instruction,
  and resulting foreground child lifecycle;
- direct `background:true` task capture and foreground-task promotion through
  `POST /experimental/session/:id/background`, including parent-idle-before-child
  ordering and synthetic completion notification;
- prompt `file` message-part capture with the exact durable synthetic text
  expansion, plus an exact-release source audit that keeps the standalone
  schema-only `snapshot` part unverified;
- message-scoped and full session forks with new/remapped IDs, archive update
  and list-filter behavior, and permanent deletion through `session.deleted`;
- OpenCode privacy rules and capture tests;
- sanitized committed carrier fixtures;
- exact source inspection and current findings.

Initial candidate scope is explicitly `darwin-arm64`. Expanding to darwin-x64,
linux-x64, or windows-x64 requires independent governed acquisition, hashes,
launch probes, and drift review; no cross-platform behavior is inferred.

Gate: privacy tests pass; every claimed runtime behavior has a fixture; all
uncaptured schema/source facts are labeled unverified.

### Stage 2 — Agent Surface Model v2 (complete for the pinned evidence)

Delivered under
`packages/surface/vendors/opencode/model/opencode@1.18.16/`:

- ASM v2 manifest, detection, four-channel declaration, reviewed native
  behavior graph, and claim-addressable evidence index;
- 188 namespaced HTTP operation documents and 90 exact SSE event documents;
- capture-derived confidence for 21 HTTP operations, 24 SSE event types, and
  the interactive `permission.replied {reply:always}` variant;
- explicit unverified confidence for 233 schema-only documents and unobserved
  message-part branches;
- a runtime-only `server.heartbeat` document for the event emitted by the
  binary but omitted from its generated `/doc` `Event` union;
- deterministic generator, vendor audit, model tests, privacy gates, and 29
  digest-pinned evidence records.

Gate: complete. The model loads; all 2,775 SSE carriers, 209 HTTP requests, and
209 correlated results validate; evidence/privacy checks are clean; regeneration
from the pinned `/doc` produces the same 278 event documents.

### Stage 3 — Imposter persona (complete)

Add an OpenCode persona only after the ASM exists:

- HTTP server mode matching `serve` invocation;
- REST table for the exact endpoints the adapter consumes;
- workspace/directory routing and Basic auth behavior;
- SSE channel with exact `{id,type,properties}` envelopes;
- durable session/message/status/blocker store;
- `attach` viewer mode using the shared Imposter TUI;
- happy turn, permission allow/deny, question reply/reject, resume, reconnect,
  duplicate, late, out-of-order, failure, and unknown-event scenarios.

This likely requires a shared Imposter `http-sse` channel/serve transport; keep
OpenCode endpoint vocabulary in persona data rather than hard-coding it into
the generic scenario engine.

Gate: persona validates against the ASM and can drive the real adapter without
test-only adapter branches.

Implementation status (2026-08-11): complete on the Imposter side. The persona
owns 19 exact REST routes, an ASM-gated SSE rail, environment-only Basic auth,
directory-scoped streams, a persisted session/message/status/blocker store,
and the shared attached viewer. Twelve executable scenarios cover the planned
happy, blocker, recovery, ordering, failure, and unknown-event branches.
Focused server, scenario, CLI, restart-resume, and cross-persona regression
tests pass. The second half of this gate—driving the real adapter—necessarily
lands with Stage 4 and must not use a test-only transport branch.

### Stage 4 — adapter package (complete)

Create `packages/adapter-opencode` with focused components:

```text
src/
  backend.ts                 # serve lifecycle, readiness, secret handling
  client.ts                  # typed REST calls used by the adapter
  event-stream.ts            # SSE parsing/reconnect/buffering
  normalizer.ts              # stateful native -> AgentEvent mapping
  history.ts                 # durable message projection/reconciliation
  driver.ts                  # AgentSession + prepare/create native TUI recipe
  index.ts
```

Tests:

- captured-fixture normalizer tests;
- duplicate/out-of-order/late event tests;
- prompt-ID confirmation and timeout tests;
- backend startup/auth/cleanup tests;
- resume/hydration continuity tests;
- shared reducer and conformance assertions;
- pinned-real opt-in lane using `OPENCODE_LIVE=1`.

Gate: package build/typecheck/tests pass; every mapping cites ASM evidence;
unknown events survive; no terminal-output parser exists.

Implementation status (2026-08-12): complete for the first adapter slice, plus
the captured child-session mapping. The package owns a loopback-only `serve`
process with a 256-bit environment-only secret, typed authenticated REST
calls, bounded exact SSE framing and reconnect, revision-aware durable history
reconciliation (including `GET /session/:id/children`), a stateful ASM-cited
normalizer, exact message-ID prompt receipts, and the prepared
`attach --session` native-TUI recipe. Child `session.created {parentID}` and
task-metadata `sessionId` joins emit `subagent.started`; child idle/deleted
emits `subagent.stopped`; forks without `parentID` stay independent. A
background task completion does not stop the joined child. The default suite
covers captured-fixture mappings, foreground/background child lifecycles,
adversarial ordering/deduplication, prompt timeout, backend auth/cleanup,
exact attach, restart/resume hydration, and all seven shared `AgentSession`
conformance assertions against the real Imposter HTTP/SSE transport. Build,
typecheck, formatting, and package-layout gates pass; production code contains
no terminal-output parser and has no runtime Surface dependency.

### Stage 5 — runtime, devkit, and application integration (complete)

Register one new provider in `createBuiltinProviders`; do not branch inside the
generic runtime.

Expected integration touches:

- runtime package dependency/import/provider entry;
- `BuiltinAgentKind`, executable kind, and typed `OpenCodeAgentOptions`;
- executable resolution via `CHOPSTICKS_OPENCODE_BIN`;
- app/provider selectors, labels/icons only where agents are enumerated;
- adaptation devkit persona/runflow discovery;
- restore/spawn-through tests for the `serve` + `attach` split lifecycle.

Gate: runtime provider tests, app typechecks/tests, prepare/adopt recovery, and
real-adapter-vs-Imposter conformance pass.

Implementation status (2026-08-11): complete. Runtime exposes `opencode` as a
typed built-in provider, resolves `CHOPSTICKS_OPENCODE_BIN`, and forwards the
private-backend, model, permission, context, timeout, and reconnect options to
both create and prepare paths. Godview and Workbench discover and shim the real
binary, accept exact `-s`/`--session` resume selection, and expose OpenCode in
their application labels/selectors. Godview additionally routes `ai
--opencode` through one isolated durable store shared by the Imposter backend
and exact native attach. The adaptation devkit discovers the OpenCode persona,
shows its runflows/native SSE surface, and replays immutable control-log
records through the stateful OpenCode normalizer while explicitly leaving
duplicate-id, reconnect, REST hydration, prompt-receipt, and attach behavior to
adapter conformance.

The full repository test command passes, including 38 runtime tests, 86
Godview tests, 13 Workbench tests, 46 adaptation-devkit tests, all 239 Imposter
tests, and the OpenCode adapter's 34 default tests (with its pinned-real test
remaining opt-in). Workspace typecheck/build, all three app bundles,
package-layout, upstream-config, support-ledger, and OpenCode-scoped formatting
checks are clean. The explicit adaptation, promotion, and scheduled-live
workflow seams now include OpenCode with `OPENCODE_LIVE=1` and
`CHOPSTICKS_OPENCODE_BIN`; workflow regression tests keep those security-policy
choices visible.

### Stage 6 — reconcile and promote

Run a fresh governed acquisition/census against the candidate immediately
before promotion. Reconcile:

```text
upstream binary ↔ captures ↔ ASM ↔ Imposter ↔ adapter ↔ core reducer
```

Only after protected conformance succeeds:

- add the adapter to package/release validation as required;
- update support metadata and generated documentation in the same reviewed
  promotion change;
- declare only the platforms and observation mode actually attested.

`baseline-pending` is the strongest acceptable pre-promotion support state.

Local readiness status (2026-08-11): the reviewed manifest is recorded as
`baseline-pending`, with no `currentManifest` or verification claim, and the
generated README support block is in sync. Exact pre-normalization replay now
understands OpenCode's native `{id,type,properties}` SSE carriers and correlated
HTTP request/result carriers. It passes 3,421 frames and 209 results with zero
issues at replay digest
`7460849ef3c456197500d6292a3d95e6d62ce75d7a56428fc4278a1b093f4544`.

Reconciliation correctly remains `unsafe-or-unknown` because the declared
four-platform policy has immutable evidence only for `darwin-arm64`.
`darwin-x64`, `linux-x64`, and `windows-x64` must still be acquired and execute
successfully in the credential-isolated pinned-real matrix. The final workflow
also requires GitHub Actions run/commit attestation and protected-environment
human approval, so no local command can promote this candidate.

## 10. Expected file-touch map

Evidence slice (already started):

- `packages/surface/vendors/opencode/upstream.json`
- `packages/surface/vendors/opencode/probes/opencode@1.18.16/*`
- `packages/surface/vendors/opencode/census/{harness,sanitize}.mjs`
- `packages/surface/vendors/opencode/{privacy,privacy.test}.mjs`
- `packages/surface/vendors/opencode/captures.test.ts`
- `packages/surface/vendors/opencode/captures/opencode@1.18.16/**`
- `packages/surface/vendors/opencode/findings.md`

Completed Imposter slice:

- `packages/imposter/personas/opencode/**`
- shared Imposter HTTP/SSE transport and its tests

Completed adapter/integration/reconciliation slices:

- new `packages/adapter-opencode/**`
- `packages/runtime/{package.json,src/providers.ts,src/types.ts}` and tests
- workspace lockfile/package-layout expectations
- application agent enumerations and restore tests
- explicit adaptation, protected-promotion, and scheduled-live workflow seams
- exact OpenCode HTTP/SSE replay and `baseline-pending` support-ledger entry

Protected promotion slice:

- remaining three platform artifact identities and pinned-real reports
- `currentManifest`, promotion verification, and the generated verified badge
  **only through the protected Stage 6 workflow**

Concurrent unrelated UI/upstream work currently present in the worktree is
outside this plan and must remain untouched.

## 11. Validation matrix

Run proportionally after each slice:

```text
node --check packages/surface/vendors/opencode/census/harness.mjs
pnpm --filter @vibecook/chopsticks-surface exec vitest run \
  vendors/opencode/privacy.test.mjs vendors/opencode/captures.test.ts
node packages/surface/vendors/opencode/census/sanitize.mjs \
  --version 1.18.16 --check-only
pnpm upstream:check
pnpm packages:check
pnpm support:check
pnpm typecheck
pnpm test
```

Loopback/Unix-socket suites need an execution environment that permits local
listeners. Live-vendor tests stay opt-in and must never borrow credentials for
the default test lane.

## 12. Principal risks and mitigations

| Risk                                                   | Mitigation                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| HTTP/event API is evolving rapidly                     | pin exact binary/source/OpenAPI; generate ASM; drift audit every candidate               |
| SSE reconnect loses events                             | buffer, durable rehydrate, entity dedupe; report uncertainty rather than gap-free claims |
| native TUI and host both answer blockers               | one explicit controller lease; native TUI default                                        |
| backend secret leaks                                   | per-session random env-only secret; strip auth headers/logs; privacy tests               |
| REST `204` falsely confirms a prompt                   | require exact caller-supplied message-ID echo                                            |
| duplicate updates double-complete turns/tools          | stateful normalizer keyed by native message/part/call/request IDs                        |
| rejection semantics get treated as normal continuation | conformance asserts one provider turn and tool error → idle                              |
| OpenCode-specific questions distort core               | retain native event; defer core extension until a second provider-neutral need exists    |
| schema breadth is mistaken for verified behavior       | claim-level confidence; source/schema-only branches stay unverified                      |
| same-day upstream release drifts during implementation | re-run detection/census before each candidate review and final promotion                 |

## 13. Recommended next implementation slice

Stages 1–5 and local Stage 6 replay/reconciliation are complete for the pinned
darwin-arm64 evidence candidate. The captured child-session mapping now lands
in the adapter. Remaining local mapping that still needs a product decision:

- optional `workspace.changed` from `file.edited` / watcher events (today
  retained as native events, matching the first-slice table).

The remaining support work is the protected promotion path:

1. acquire and hash OpenCode 1.18.16 for `darwin-x64`, `linux-x64`, and
   `windows-x64` alongside the existing `darwin-arm64` evidence (or restart
   candidate review if upstream has moved);
2. execute the complete pinned-real matrix on the declared isolated runners;
3. review the resulting artifact, Surface, adapter, and replay attestation in
   the protected environment;
4. let the guarded promotion transaction set `currentManifest`, verification,
   and the generated verified support badge atomically.

Until that workflow succeeds, the implementation remains a complete local
candidate rather than promoted public support.
