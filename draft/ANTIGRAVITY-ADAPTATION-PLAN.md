# Antigravity Adaptation Plan

| Field | Value |
| --- | --- |
| Status | Stage 1 authorized print-mode/hook census in progress; native-TUI PTY still open |
| Target | Official Antigravity CLI native TUI (`agy`) |
| Initial surveyed release | `1.1.12`, observed 2026-08-10 |
| Canonical process | [ADAPTING-AN-AGENT.md](./ADAPTING-AN-AGENT.md) |

This document specializes the repository's normal first-vendor adaptation
process for Antigravity. It is a plan, not a support claim. Any preliminary
fact recorded here must be recaptured as claim-addressable Surface evidence
before it can support an implementation or promotion decision.

Implementation progress on 2026-08-12:

- pinned the exact `1.1.12` public release and all four required archives;
- captured all four archive and extracted-executable identities;
- captured `--version`, `--help`, rejected-option, and isolated-home evidence
  on `darwin-arm64`;
- found that both exact macOS archive members name signing team `EQHXZ8M8AV`
  but fail `codesign --verify --strict`; promotion is blocked pending an
  explanation, reviewed policy, or corrected upstream artifacts;
- retained a curated public-documentation projection and darwin-arm64
  static-string / subcommand-help extras; these remain documentation leads
  and unverified contracts, not live rail evidence;
- ran authorized print-mode slash, `--add-dir` hook, no-tool, resume, and
  tool-turn probes on the pinned `1.1.12` darwin-arm64 executable and
  committed sanitized fixtures only.

## 1. Outcome and primary decision

Adapt the official Antigravity CLI as one native TUI process owned by the host:

```text
AgentHost PTY -> one official `agy` TUI process
                 |-- command hooks -> authenticated loopback response bridge
                 |-- transcript JSONL -> bounded observer/replay
                 |-- diagnostic log -> diagnostics only
                 `-- status line -> optional, only if safely composable
                                      |
                                      v
                              stateful normalizer
                                      |
                                      v
                                AgentEvent
```

The first adapter must not:

- automate the Antigravity desktop or IDE UI;
- derive semantic events from terminal text or screen contents;
- launch `agy --print`, stream-JSON mode, an SDK controller, or a sidecar as a
  second agent session beside the TUI;
- replace, snapshot, restore, or otherwise mutate the user's global
  Antigravity configuration as part of normal launch;
- claim host-controlled approval support unless a native control-and-receipt
  path is demonstrated;
- claim verified support before the protected four-platform promotion lane has
  passed against exact artifacts.

Headless output may be used in a separate survey process as an oracle for
discovering schemas. It is not a runtime transport for the native-TUI adapter.

## 2. Gate -1 — authorization before authenticated testing

This gate precedes the repository's ordinary Stage 0.

The [current Antigravity terms](https://antigravity.google/terms) appear to
classify access through third-party tools, and use of the service with products
not provided by Google, as a breach. The same terms say that an applicable
Google Cloud, Workspace, or enterprise agreement may supersede the consumer
terms. This document does not make a legal determination.

Do not authenticate the CLI, submit model prompts, record live service
responses, or provision promotion credentials until the project has one of:

1. written confirmation from Google that this integration and its automated
   test usage are permitted; or
2. confirmation from the organization's counsel or contract owner that an
   applicable agreement expressly permits the planned use.

Record the decision owner, agreement or permission reference, scope, test
account requirements, retention requirements, and any restrictions in a
private project record. Do not commit confidential contract text or account
data to this repository.

Work allowed before this gate passes:

- inspect public documentation and public release metadata;
- download public release artifacts into temporary storage;
- verify hashes, signatures, archive layouts, `--version`, and `--help` without
  authenticating;
- design Surface fixtures and the Imposter architecture from public facts;
- scaffold code that neither authenticates nor makes service requests.

If the gate fails, stop the adaptation. An offline research model must not be
listed as a supported agent.

## 3. Repository constraints carried into this adapter

The following are hard requirements from the repository architecture:

- one native session corresponds to one vendor process;
- the native TUI remains visible, interactive, and authoritative;
- `AgentHost` owns PTY creation and terminal automation;
- the adapter owns its launch recipe, observers, correlation, and cleanup;
- Core remains provider-neutral and performs no I/O;
- every event is stamped once, in ingestion order, before fan-out;
- raw native records survive normalization, including unrecognized records;
- prompt receipts may be `uncertain`; they must never be upgraded from a
  terminal echo or elapsed time;
- semantic turn completion and process exit remain separate facts;
- observation level reflects the strongest rail actually active for that
  session, not the adapter's theoretical maximum;
- Surface, Imposter, adapter, and normalized event graphs remain distinct.

The closest implementation precedents are:

- Claude for native command hooks, transcript observation, guarded terminal
  submission, and an optional status-line rail;
- Kimi for a provisional session identity that becomes a native conversation
  identity after the first authoritative record;
- the existing first-vendor bootstrap path described in the canonical guide,
  rather than the candidate-refresh path used for already integrated vendors.

## 4. Stable identities and preliminary upstream facts

### 4.1 Proposed repository identities

| Concern | Proposed value |
| --- | --- |
| Vendor ID | `antigravity` |
| Display name | `Antigravity` |
| User-facing command | `agy` |
| Adapter package | `@vibecook/puppeteer-adapter-antigravity` |
| Adapter directory | `packages/adapter-antigravity` |
| Surface directory | `packages/surface/vendors/antigravity` |
| Imposter persona | `packages/imposter/personas/antigravity` |
| Execution mode | `native-tui` |
| Initial observation claim | determined per session after rails connect |
| Resume key | native conversation UUID |

The downloaded archive may contain an executable named `antigravity` even
though the installed user-facing command is `agy`. Detection and acquisition
must model those as separate facts rather than assuming their basenames match.

### 4.2 Preliminary public facts to recapture

The official [CLI overview](https://antigravity.google/docs/cli-overview),
[CLI reference](https://antigravity.google/docs/cli/reference), and
[1.1.12 release](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.1.12)
identify a native terminal client with conversation resume, hooks, interactive
prompting, headless output, models, agents, and update commands.

The initial release-policy target is the exact `1.1.12` assets for the
repository's required platforms:

| Puppeteer platform | Upstream release asset observed |
| --- | --- |
| `darwin-arm64` | `agy_cli_mac_arm64.tar.gz` |
| `darwin-x64` | `agy_cli_mac_x64.tar.gz` |
| `linux-x64` | `agy_cli_linux_x64.tar.gz` |
| `windows-x64` | `agy_cli_windows_x64.zip` |

The initial macOS arm64 offline probe observed:

- a single large Mach-O executable in the archive;
- CLI version output `1.1.12`;
- an embedded Apple signing team identifier `EQHXZ8M8AV`; exact probes later
  found that both required macOS members fail `codesign --verify --strict`;
- flags including `--add-dir`, `--conversation`, `--continue`, `--log-file`,
  `--model`, `--mode`, `--sandbox`, `--print`, `--output-format`, and
  `--prompt-interactive`.

These observations are not repository evidence yet. The Surface census must
repeat them from exact downloaded artifacts, retain full digests, and test all
four required platforms. It must also record that the public GitHub repository
primarily contains documentation, changelogs, and examples: a release tag is
release provenance, not proof that the binary corresponds exactly to public
source code.

### 4.3 Acquisition and update policy

`upstream.json` should use official immutable release assets, exact archive
digests, exact version detection, bounded extraction, and a single executable
selection. Redirect and host allowlists must remain narrow.

The CLI has an update mechanism. Before pinned-real testing, prove a supported
or otherwise auditable way to prevent the attached binary from replacing
itself. A string found in a binary is not sufficient evidence for an update
suppression contract. If exact artifact execution cannot be maintained during
an authenticated test, promotion is blocked.

## 5. Native rails and ownership

| Rail | Planned role | Authority | Runtime status |
| --- | --- | --- | --- |
| PTY/TUI | Visible native UI and user control | Control only; no semantic parsing | Required |
| Command hooks | Tool and invocation lifecycle, native IDs, stop state | Authoritative only for fields present | Preferred, pending neutral-response proof |
| Transcript JSONL | Prompt confirmation, assistant content, durable history | Authoritative after schema and durability proof | Required if available |
| Status line | Session/model/context/subagent/pending-input snapshots | Authoritative snapshot fields | Deferred pending safe composition |
| Diagnostic log | Failure diagnosis and retained unknown records | Native-log evidence only | Optional |
| Process lifecycle | PID, exit, crash, cleanup | Authoritative process facts | Required |
| Headless stream JSON | Schema-discovery oracle in separate survey runs | Survey only | Forbidden in runtime |
| Terminal text | Human-visible UI | Never semantic evidence | Never parsed |

Antigravity's [hook documentation](https://www.antigravity.google/docs/hooks)
defines these command-hook families:

- `PreToolUse` and `PostToolUse`;
- `PreInvocation` and `PostInvocation`;
- `Stop`.

Hook configuration may exist in workspace `.agents/hooks.json` or a global
Gemini/Antigravity configuration location. Hook programs synchronously receive
JSON on stdin and return JSON on stdout. Some replies can allow, deny, ask,
inject work, terminate, or continue execution. The bridge therefore sits in a
behavior-changing path even when Puppeteer intends only to observe it.

The separate [status-line documentation](https://antigravity.google/docs/cli/statusline)
describes a structured snapshot callback, while the
[conversation documentation](https://antigravity.google/docs/cli/conversations)
defines explicit UUID resume. Both still require census evidence for the exact
release before they can support normalization behavior.

No hook may be installed in production until its exact no-op response is
captured and tested. In particular:

- do not assume an empty `PreToolUse` response means allow;
- do not assume an empty `Stop` response means stop normally;
- do not translate an observation failure into allow, deny, continue, or
  terminate without an explicit, reviewed fail-open/fail-closed contract;
- prefer a smaller set of passive post-events over a broader set that changes
  native behavior.

## 6. Launch-scoped instrumentation hypothesis

The preferred experiment is:

1. Create a mode-`0700` temporary auxiliary workspace owned by the adapter.
2. Place an adapter-generated `.agents/hooks.json` and a small command
   forwarder inside it.
3. Start an authenticated loopback bridge on an ephemeral port.
4. Pass bridge address and a high-entropy per-session token only through the
   child process environment.
5. Launch `agy --add-dir <auxiliary-workspace>` in the user's real `cwd`.
6. Have the forwarder read one bounded hook record from stdin, authenticate to
   the bridge, wait for the event-specific neutral response, write only valid
   JSON to stdout, and exit within the native timeout.
7. Tail the native transcript separately and reconcile both rails in one
   normalizer.

Acceptance criteria:

- the auxiliary workspace's hooks load before the first agent turn;
- no file is created or changed in the user's workspace or global config;
- the extra workspace does not change the primary cwd, project identity,
  tool-permission scope, context, or resume behavior in a material way;
- hook invocation and output are bounded, authenticated, redacted, and
  deterministic;
- bridge loss has a documented and tested native outcome;
- the token never appears in hook files, argv, logs, captures, events, or
  errors;
- multiple simultaneous sessions cannot cross-deliver records;
- a resumed conversation reports the requested native conversation UUID;
- teardown removes adapter observers and temporary resources without claiming
  ownership of the native process.

If `--add-dir` does not safely compose workspace hooks, fall back to a
transcript-only adapter with an honestly lower observation level, or block the
adapter pending an upstream launch-scoped configuration seam. Do not implement
global settings swap-and-restore.

## 7. Process, credential, and privacy contract

- The native CLI owns authentication and credentials. The adapter must not
  read, copy, log, persist, or forward access tokens.
- An isolated `HOME` does not necessarily isolate the macOS keychain.
  Authenticated census and promotion must use a dedicated OS account/keyring or
  an approved enterprise credential mechanism, never a developer's personal
  session.
- Prompt text must not be placed in argv. `--prompt-interactive` is therefore a
  survey subject, not the default runtime submission path.
- Hook and transcript observers impose byte, depth, queue, and time bounds.
- Bridge listeners bind to loopback only and authenticate every record.
- Raw captures remain private. Tracked captures must remove account email,
  plan tier, quota, credential material, absolute user paths, repository
  secrets, prompt/output content not needed by a claim, and service tokens.
- Sanitization must preserve event names, ordering, identity joins, result
  variants, and other fields required by model claims.
- Status-line payloads are privacy-sensitive and must be minimized before
  retention.
- All adapter-owned temporary paths use narrow permissions and deterministic
  cleanup. Cleanup never recursively targets an unresolved path.

## 8. Session and prompt algorithms to prove

### 8.1 Fresh session

1. Resolve the exact `agy` executable and confirm supported version policy.
2. Start the bridge and transcript observer in a temporary session directory.
3. Generate a provisional Puppeteer session identity.
4. Ask `AgentHost` to spawn one native TUI in the requested cwd with the
   launch-scoped instrumentation arguments and environment.
5. Emit process facts independently from semantic session facts.
6. Wait for an authoritative readiness signal if one exists. Process liveness
   alone must not hide an authentication prompt, update prompt, or modal.
7. On the first authenticated hook or transcript record, bind the native
   conversation UUID and expose it through the session's identity.
8. Replay durable history only when the native transcript proves it is history;
   mark replay envelopes explicitly.

The Stage 0 census must decide what proves `session.ready`. If no native rail
can distinguish a prompt-ready input box from startup modals, document the
limitation and constrain automated submission rather than parsing the screen.

### 8.2 Prompt submission

1. Reject empty or policy-invalid submissions before terminal automation.
2. Ask the host for one atomic guarded paste operation.
3. Start a bounded receipt correlation window before the write.
4. Confirm only an exact native user-message/transcript record attributable to
   that submission.
5. Return `confirmed` with a native turn/prompt identity when proven.
6. Return `rejected` if the host rejects terminal automation.
7. Return `uncertain` after timeout, observer loss, ambiguous duplicate text,
   or a modal consuming input.

Terminal echo, cursor movement, elapsed time, or a later assistant message are
not exact prompt confirmation.

### 8.3 Resume

1. Require an explicit native conversation UUID.
2. Launch one TUI with `--conversation <uuid>`; do not use `--continue`.
3. Require the first native identity-bearing record to match the requested ID.
4. Replay existing transcript entries with `replay: true` before live entries,
   without duplicating records that arrive across the boundary.
5. Prove the actual prior user/assistant history is visible in the same native
   conversation.
6. Treat an already-open/concurrently-owned conversation as a distinct error or
   native UI condition, not a successful resume.

### 8.4 Interrupt and disposal

- Interrupt uses the host's native terminal interrupt operation.
- A successful byte write is not proof that the agent stopped.
- Completion, cancellation, and failure require native evidence.
- `dispose()` shuts down the bridge, observers, buffers, and temporary files;
  it does not kill a host-owned process or synthesize semantic completion.

## 9. Surface census

### 9.1 Offline census

Capture, per exact artifact and platform:

- immutable acquisition URL, redirect chain, archive digest, archive listing,
  extracted executable digest, size, type, and signature where applicable;
- `--version`, `--help`, invalid-option behavior, exit codes, stdout/stderr
  ownership, and relevant subcommand help;
- update-check behavior and exact-artifact preservation;
- installation basename versus archive executable basename;
- documented settings, hook, transcript, conversation, and status-line paths;
- source/release relationship without overstating public source availability.

### 9.2 Authorized live census

Use only a synthetic workspace, synthetic prompts/data, and an approved test
account. Capture the PTY action timeline for provenance, never semantics, plus
raw hook stdin/stdout, transcript JSONL, bounded log records, relevant durable
store snapshots/diffs, and status-line records if that rail is included.

Required scenarios:

| Area | Cases |
| --- | --- |
| Startup | first run, returning auth, update prompt, invalid config, bridge unavailable |
| Turn | simple response, multi-step response, empty/failed response, provider retry/error |
| Prompt control | confirmed paste, paste-only, queued prompt, ambiguous duplicate, modal conflict |
| Tools | success, failure, malformed args, repeated name, parallel calls, late post-event |
| Permission | allow once, deny, dismiss, persistent grant, hook timeout/failure |
| Interrupt | during model work, tool work, approval, idle, and immediately after submit |
| Conversation | new ID, explicit resume, completed resume, interrupted resume, concurrent open |
| Ordering | duplicate, reorder, disconnect/reconnect, transcript truncation/rotation |
| Context | model change, context update, explicit compaction, provider reset |
| Work graph | subagent, nested subagent, background task, artifact/review flow |
| Shutdown | clean exit, crash, host termination, observer-first failure |

Run `--print --output-format stream-json` only in separate survey sessions to
compare the provider's structured vocabulary with the TUI rails. Never merge
those records into a native TUI session or use them as evidence that the TUI
emitted an event.

### 9.3 Evidence handling

For every scenario retain:

- raw private capture with origin, command, exact artifact, platform, timestamp,
  and scenario inputs;
- sanitized tracked capture;
- sanitization audit result;
- finding that describes observed facts without proposing normalization;
- claim-to-evidence references precise enough to identify the record and field.

The sanitizer must be deterministic, fail closed on unknown secret-shaped
fields, preserve referential identity, and have positive and negative tests.

## 10. Candidate normalization map

This table is a hypothesis backlog. No row becomes adapter behavior until the
Surface model cites evidence for its carrier, identity, ordering, and variants.

| Native evidence candidate | Core event | Rule |
| --- | --- | --- |
| First authoritative conversation identity | `session.started` | Bind the native UUID once; reject conflicting IDs |
| Proven prompt-ready native state | `session.ready` | Never infer from rendered terminal text |
| Exact transcript user record | `turn.started` | Use native identity; may confirm prompt submission |
| Transcript assistant record/delta | `assistant.message` | Accumulate by stable message ID; preserve finality |
| Explicit public reasoning phase | reasoning events | Emit presence or public summary only, never hidden chain of thought |
| `PreToolUse` with stable call identity | `tool.requested` | Do not fabricate an ID from tool name alone |
| Separate proof execution began | `tool.started` | Do not equate request with execution without evidence |
| `PostToolUse` success | `tool.completed` | Correlate by native ID, or a proven unique composite key |
| `PostToolUse` error | `tool.failed` | Preserve native error and late/unmatched variants |
| Native approval request record | `permission.requested` | Presentation remains `native-tui` |
| Native approval outcome record | `permission.resolved` | Never infer outcome from tool execution alone |
| `Stop` with `fullyIdle: true` | `turn.completed` or `turn.failed` | Map only with an active turn and explicit termination semantics |
| `Stop` with `fullyIdle: false` | no completion | Retain/update state; do not report ready |
| Invocation boundary | usually no normalized event | Invocation is not automatically a user turn |
| Stable model/cwd snapshot | `session.environment.updated` | Emit sparse, changed fields only |
| Exact token counts/capacity | `context-window.updated` | Require compatible units and a stable model identity |
| Explicit compaction marker | `context-window.invalidated` | Never infer compaction from a token decrease |
| Stable subagent identity | subagent events | Require stable IDs and proven start/stop semantics |
| Stable background task identity | task events | Require stable IDs and terminal status evidence |
| Process spawn/exit | process events | Keep separate from session/turn completion |
| Unmapped native record | `adapter.native-event` | Retain raw payload and native type |

Correlation requirements:

- use native IDs wherever available;
- test whether `(conversationId, stepIdx)` is unique before considering it as a
  fallback tool key;
- keep bounded orphan buffers for post-before-pre, transcript-before-hook, and
  replay/live boundary races;
- define deterministic timeout and eviction behavior;
- make duplicate handling idempotent without deleting conflicting variants;
- assign one monotonically increasing sequence at ingestion;
- retain source, confidence, replay status, and raw native record on envelopes.

Observation level starts at `native-log` when only a transcript/log observer is
active and becomes `native-hooks` only after an authoritative native hook rail
has connected and produced valid evidence. This adapter is never `structured`
merely because a separate headless command supports structured JSON.

## 11. Surface and model layout

Create:

```text
packages/surface/vendors/antigravity/
  upstream.json
  findings.md
  privacy.mjs
  privacy.test.mjs
  captures.test.ts
  census/
    harness.mjs
  captures/
    antigravity@<version>/
      <scenario>/
  model/
    antigravity@<version>/
      manifest.json
      evidence.json
      detection.json
      channels.json
      behavior.json
      events/
```

The model should distinguish at least these channels:

- argv/version and artifact identity;
- terminal actions, for control provenance only;
- hook-command input and output;
- native transcript;
- native log/durable state, if used;
- native status line, if admitted;
- process lifecycle;
- separate survey-oracle output.

The vendor audit must validate schemas, provenance, sanitization, evidence
references, model coverage, artifact drift, event/result variants, behavioral
partial orders, and unknown-event retention.

## 12. Imposter plan

Create an exact Antigravity native persona rather than a normalized-event
fixture:

```text
packages/imposter/personas/antigravity/
  persona.json
  ops.json
  behavior.json
  scenarios/
  runflows.json
```

The current generic command-hook support is Claude-shaped. Generalize delivery
configuration only as far as the captured Antigravity grammar requires:

- top-level Antigravity hook bundles and event arrays;
- regex tool matchers;
- command handlers with stdin JSON and stdout JSON;
- event-specific neutral and decision replies;
- timeout, non-zero exit, malformed reply, duplicate, late, and reordered
  variants;
- transcript creation, append, replay, truncation, and rotation behavior;
- optional status-line callback shape if that rail passes its gate.

Do not teach Imposter to emit Core events. It must project the exact native
records and behaviors that the real CLI was observed to produce.

Minimum scenarios/runflows:

- startup and first confirmed prompt;
- assistant response and clean idle stop;
- tool success and failure;
- approval allow, deny, dismiss, and unresolved/native-only cases;
- interrupt during model and tool work;
- duplicate, out-of-order, malformed, and orphan hook/transcript records;
- hook process timeout and bridge disconnect;
- transcript replay followed by live resume;
- model/context update and explicit compaction, if observed;
- subagent/background task lifecycle, if observed;
- process crash independent from semantic turn completion;
- unknown future native event.

Every runflow must identify its native channels, required capabilities,
expected ledger dispositions, and reset behavior.

## 13. Adapter package plan

Proposed package shape:

```text
packages/adapter-antigravity/
  package.json
  tsconfig.json
  src/
    index.ts
    detection.ts
    launch/
      prepare.ts
      hooks.ts
      forwarder.ts
    bridge.ts
    transcript.ts
    normalizer.ts
    prompt-driver.ts
    tui-session.ts
    test-support.ts
    *.test.ts
  test/
    conformance.test.ts
    imposter-integration.test.ts
    pinned-real.test.ts
```

Responsibilities:

- generate detection and launch facts from the accepted Surface model where
  repository tooling permits;
- construct a launch-scoped recipe without modifying user configuration;
- validate and authenticate bounded hook input;
- tail transcript data across partial writes, truncation, rotation, resume, and
  shutdown;
- reconcile multiple rails in a stateful normalizer with bounded buffers;
- implement honest prompt receipts behind `AgentSession`;
- expose a provisional session ID until the native conversation UUID is known;
- preserve unknown native records;
- support dependency injection for clocks, files, bridge transport, and host;
- leave process lifecycle with `AgentHost`.

The adapter must not add Antigravity branches to provider-neutral Core or to the
runtime's common session logic.

## 14. Integration and file-touch map

### Surface and acquisition

- `packages/surface/vendors/antigravity/**`
- `packages/surface/package.json`
- vendor lists in detection, acquisition, reconciliation, and promotion scripts
- tests for upstream schema, redirects, extraction, and artifact identity

### Imposter and normalization devkit

- `packages/imposter/personas/antigravity/**`
- generic delivery/config support needed by the captured native grammar
- persona loading, scenario, runflow, and behavior tests
- `apps/imposter-control` spawnable persona, native controls, normalization
  ledger, restore path, and renderer tests

### Adapter and runtime

- `packages/adapter-antigravity/**`
- root workspace/lockfile/package-layout allowlists
- runtime provider types, registration, and provider tests
- provider options for cwd, resume, executable, model/mode/sandbox only when
  backed by the native launch contract

### Product applications

After the adapter-against-Imposter topology passes:

- Godview built-in agent list and spawn/restore wiring;
- Godview built-in agent list, shim/spawn-through wiring, and restore;
- app tests proving both surfaces invoke the runtime provider rather than
  reconstructing an Antigravity launch recipe.

### Publication, support, and automation

- public package list and release configuration;
- support ledger entry with `baseline-pending` only after the candidate is
  integrated and green;
- generated README/support artifacts via `pnpm support:write`;
- adaptation, live, and protected promotion workflows;
- exact platform matrices and credential isolation;
- no `currentManifest`, `verification`, or verified badge before promotion.

Because this is the first Antigravity integration, it requires an ordinary
reviewed bootstrap change. Do not add `antigravity` to a workflow that assumes
the vendor directory, adapter, persona, runtime provider, and support entry
already exist and then call that bootstrap complete.

## 15. Delivery stages and gates

### Gate -1 — authorization

Deliverables:

- permission/agreement review recorded privately;
- approved account, retention, and CI credential model;
- explicit authorization scope for hooks, automated prompts, captures, and
  regression testing.

Exit: authenticated census is permitted. Otherwise stop.

### Stage 0 — identity and feasibility spike

Deliverables:

- stable repository identities;
- exact `1.1.12` four-platform artifact policy and offline evidence;
- isolated experimental harness, not production adapter code;
- proof or rejection of auxiliary-workspace hook composition;
- neutral hook response matrix;
- transcript path/schema/identity/durability findings;
- readiness, guarded prompt, explicit resume, and update-pinning decisions;
- documented fallback or stop decision for every failed experiment.

Exit: one-process native-TUI architecture is feasible without global config
mutation, screen semantics, a shadow agent, or behavioral hook interference.

### Stage 1 — survey exact native surface

Deliverables:

- vendor-owned census harness;
- raw private and sanitized tracked captures;
- privacy audit and tests;
- findings organized by scenario, rail, identity, ordering, and variants.

Exit: the survey gate in the canonical guide passes; normalization code is not
used as evidence.

### Stage 2 — Agent Surface Model v2

Deliverables:

- manifest, evidence, detection, channels, behavior, and event models;
- claim-addressable evidence;
- partial-order behavior rather than one accidental total trace;
- vendor audit and model tests.

Exit: every modeled claim resolves to sanitized evidence and every unexplained
capture record is explicitly classified.

### Stage 3 — Imposter persona

Deliverables:

- native persona and Antigravity delivery grammar;
- executable scenarios and curated runflows;
- fault, ordering, replay, decision-response, and unknown-event coverage;
- native projection tests.

Exit: the persona reproduces modeled native behavior without importing adapter
or Core semantics.

### Stage 4 — adapter and normalization

Deliverables:

- adapter package, launch preparation, bridge, observers, normalizer, prompt
  driver, and session driver;
- raw-record, normalization, driver, cleanup, concurrency, and receipt tests;
- ledger review for mapped, retained, buffered, no-output, and driver-owned
  native records.

Exit: no unexplained ledger entries, unbounded buffers, invented identities, or
overstated receipts/observation levels.

### Stage 5 — conform and integrate

Deliverables:

- shared `AgentSession` conformance;
- adapter-against-Imposter integration lane;
- runtime provider and product app wiring;
- package/publication/release policy;
- candidate workflows and `baseline-pending` support entry.

Exit: repository checks, relevant focused tests, full test suite, app smoke
tests, package checks, and support checks are green.

### Stage 6 — reconcile and promote

Deliverables:

- exact artifacts attached through the repository's acquisition path;
- local replay/reconcile verification;
- protected pinned-real jobs on all required platforms;
- reviewed support promotion generated by repository tooling.

Exit: promotion alone writes the current manifest and verified support state.

## 16. Verification matrix

At minimum, require:

- Surface schema, privacy, provenance, drift, replay, and audit tests;
- Imposter persona, scenario, runflow, hook response, transcript, ordering, and
  fault tests;
- normalizer fixtures for every captured variant and unknown-event retention;
- property tests for monotonic sequence, idempotent duplicate handling, bounded
  buffers, and correlation isolation;
- driver tests for fresh launch, resume, prompt receipt outcomes, interrupt,
  observer loss, bridge failure, disposal, and concurrent sessions;
- shared conformance lifecycle, reply, sequence, resume-history, and cleanup;
- real adapter-against-Imposter transport tests;
- runtime provider registration and option pass-through tests;
- Godview and Imposter Control spawn/restore tests;
- package-layout, publication, support-rendering, and workflow checks;
- protected pinned-real smoke tests for `darwin-arm64`, `darwin-x64`,
  `linux-x64`, and `windows-x64`.

Repository-wide completion checks include:

```sh
pnpm surface:audit
pnpm packages:check
pnpm support:check
pnpm test
```

Run focused package and application tests during each slice rather than waiting
for the repository-wide gate.

## 17. Principal risks and stop conditions

| Risk | Required response |
| --- | --- |
| Terms or contract do not permit integration | Stop authenticated work and do not list support |
| No passive/no-op hook response | Omit that hook family or stop hook-based observation |
| `--add-dir` changes user project or permissions materially | Reject the auxiliary-workspace design |
| Only global settings can install required observers | Use transcript-only observation or block; never swap user config |
| No structured startup/readiness evidence | Constrain automation and report uncertainty; never screen-scrape |
| Transcript lacks stable prompt/message/tool identities | Reduce mappings; do not fabricate correlation |
| Resume does not prove the same native conversation/history | Fail conformance and block integration |
| Attached binary can self-update during tests | Block pinned-real promotion |
| Exact macOS archive member fails signature verification | Require an upstream explanation, reviewed exception, or corrected artifact before promotion |
| Auth isolation depends on a developer's personal keychain | Block live and promotion workflows |
| Native payload contains sensitive account/quota data | Minimize capture and strengthen fail-closed sanitization |
| Hook latency/failure changes agent decisions | Redesign or remove the hook rail |
| Headless oracle differs from native TUI rails | Model them as different surfaces; never merge evidence |
| Public repository cannot prove binary source correspondence | State the provenance limit; do not claim source equivalence |

## 18. Recommended first implementation slice

The next slice should stop before product/runtime wiring:

1. Start ASM v2 event/channel models from the sanitized print-mode and hook
   fixtures. Keep print-mode labeled as a survey oracle, not the TUI rail.
2. Capture a native-TUI PTY session with the same `--add-dir` hook seam and
   compare hook/transcript records to the print-mode oracle.
3. Add permission, interrupt, and hook-fault variants before treating
   `--add-dir` as the production observer.
4. Do not add a runtime provider, app entry, or support-ledger claim yet.

That slice is complete when the architecture has evidence-backed yes/no answers
to its dangerous assumptions. It should not yet add a runtime provider, app
entry, support-ledger claim, or verified badge.
