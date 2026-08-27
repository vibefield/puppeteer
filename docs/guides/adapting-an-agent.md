# Adapting Any Coding Agent to Puppeteer

**Status:** Canonical end-to-end developer workflow, 2026-08-09

**Audience:** Developers adding a new built-in agent or adapting a new version of an existing agent

**Companions:** `docs/guides/surface-adaptation.md` defines ownership and promotion; `docs/archive/EMULATOR.md` defines the Agent Surface Model; `docs/archive/IMPOSTER.md` defines personas and native emulation; `docs/guides/normalization-devkit.md` defines the normalization workbench; `docs/rfcs/004-layered-agent-runtime.md` defines the runtime architecture.

This guide is the operational path from an unknown vendor binary to a supported Puppeteer agent. It tells you what to investigate, which artifacts to create, where each fact belongs, how to use the adaptation devkit, what to test, and what must be true before support is promoted.

The invariant to remember is:

> **Surface records native evidence. Adapters normalize it. Imposter simulates it. Conformance cross-checks both. Promotion alone declares what Puppeteer supports.**

All values written as `<vendor>`, `<version>`, `<ground-truth>`, `<platform>`, or similar are placeholders. Replace them before running a command; do not type the angle brackets literally.

## Contents

1. [What “adapted” means](#1-what-adapted-means)
2. [Architecture and ownership](#2-the-architecture-and-ownership-boundaries)
3. [Stage 0 — scope and bootstrap](#3-stage-0--scope-the-integration-before-writing-it)
4. [Stage 1 — survey](#4-stage-1--survey-the-exact-native-surface)
5. [Stage 2 — model](#5-stage-2--build-the-agent-surface-model)
6. [Stage 3 — emulate](#6-stage-3--create-the-imposter-persona)
7. [Stage 4 — adapt and normalize](#7-stage-4--implement-the-adapter-and-normalization)
8. [Normalization devkit loop](#8-use-the-normalization-devkit-as-the-design-loop)
9. [Stage 5 — conform and integrate](#9-stage-5--conform-and-integrate)
10. [Stage 6 — reconcile and promote](#10-stage-6--reconcile-review-and-promote)
11. [Verification matrix](#11-required-verification-matrix)
12. [Complete file touch map](#12-complete-file-touch-map-for-a-new-vendor)
13. [Definition of done](#13-definition-of-done)
14. [Common failure modes](#14-common-failure-modes)
15. [Suggested PR description](#15-suggested-pr-description)

---

## 1. What “adapted” means

An agent is not adapted merely because its process launches or one happy-path turn works. A complete adaptation has all of these properties:

1. A pinned vendor artifact and its platform-specific bytes are identifiable.
2. Every native channel Puppeteer relies on is backed by sanitized evidence and explicit provenance.
3. A versioned Agent Surface Model (ASM) describes the native names, shapes, directions, channels, variants, and partial ordering without normalized interpretation.
4. The `ai` Imposter can reproduce that native contract from a persona and execute realistic and adversarial scenarios.
5. An adapter observes and controls the real agent, maps native facts into the portable `AgentEvent` contract, and retains unknown native events.
6. The same normalization can be inspected record by record in the adaptation devkit where the architecture permits pure replay.
7. The adapter passes the shared `AgentAdapterBinding` conformance contract, hermetic adapter-against-Imposter tests, and pinned-real tests.
8. Runtime registration, package publication, upstream detection, and ongoing live reconciliation are wired.
9. A protected promotion records the exact canonical ground truth, vendor version, model digest, replay digest, tested commit, workflow run, and platform artifact hashes in `support/agents.json`.

Until the last item is complete, use `baseline-pending` or `unsupported`. Do not describe an executable candidate as verified support.

### The formal stages

| Stage                    | Purpose                                                       | Primary output                                                                   | Exit gate                                                                        |
| ------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0. Scope and bootstrap   | Choose the native integration and establish repository seams  | vendor identity, package/persona/support scaffolding plan                        | no unresolved ownership or transport question blocks the design                  |
| 1. Survey                | Observe the exact vendor artifact                             | raw private captures, sanitized tracked captures, `findings.md`, `upstream.json` | every relied-on channel has admissible evidence and privacy passes               |
| 2. Model                 | Formalize pinned native truth                                 | versioned ASM v2 inputs plus vendor-root `groundtruth.json`                      | model, evidence, behavior, capture, and vendor audit gates pass                  |
| 3. Emulate               | Reproduce the native surface independently                    | Imposter persona, behavior pack, scenarios, runflows, optional server table      | persona loads, scenarios validate, replay is exact, native devkit view is honest |
| 4. Adapt and normalize   | Build the real native integration and portable interpretation | adapter normalizer, driver, detection/launch projections, focused fixtures       | mapping is evidence-traceable; adapter unit and devkit review gates pass         |
| 5. Conform and integrate | Prove the product contract                                    | shared conformance, Imposter E2E, runtime provider, package wiring               | hermetic/full tests and packaging pass; no resources are orphaned                |
| 6. Reconcile and promote | Bind the candidate to real artifacts and declare support      | reconciliation report, platform reports, protected ledger transaction            | every promotion gate passes on exact reacquired bytes                            |

Do these in order. In particular, never derive Surface from adapter code, and never derive the adapter from authored Imposter scenarios. That makes both projections agree with each other while being wrong about the vendor.

---

## 2. The architecture and ownership boundaries

```text
release metadata + shipped artifacts + exact source/schema + official docs
                                  |
                         acquire / probe / capture
                                  |
                                  v
                  Surface evidence + versioned native ASM
                         /                         \
                        v                           v
             real agent or Imposter          native devkit view
                        |
                        v
                 adapter projection
           native observation/control <-> AgentEvent
                        |
                        v
                 Core reducer facets
                        |
                        v
                 runtime / Godview
```

| Owner          | Owns                                                                                                                             | Must not own                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Surface        | artifact/source provenance, census harnesses, sanitizers, captures, findings, ASM documents, native behavior graph, audits       | `AgentEvent` mappings, launch policy, authored agent behavior                                |
| Adapter        | detection integration, launch/attach policy, observation, native control, correlation, normalization, honest prompt receipts     | copies of real-vendor captures/models, Imposter scenarios, claims inferred from its own code |
| Imposter       | persona boot, semantic-op-to-native bindings, service behavior, deterministic scenarios, fault injection, native store emulation | real-vendor evidence, native-to-`AgentEvent` mapping                                         |
| Devkit         | independent native view plus an optional downstream normalization projection                                                     | mutation of native records, a second production state API                                    |
| Core           | portable event/session contracts and a pure reducer                                                                              | vendor-specific I/O or terminal scraping                                                     |
| Runtime        | provider composition and application-facing lifecycle                                                                            | vendor-specific branches in `runtime.ts`                                                     |
| Support ledger | the exact baseline Puppeteer currently promotes                                                                                  | “latest upstream” versions that have not passed promotion                                    |

### Keep the four graphs distinct

The repository contains concepts that can look similar in a UI but have different authority:

1. `Surface .../behavior.json` is an evidence-backed partial-order graph of exact native events for one vendor version.
2. `personas/<vendor>/behavior/happy-turn.json` is authored Imposter behavior used to produce an organic simulated turn.
3. `session/scenario-driver.ts` is a vendor-neutral state machine over Imposter authoring ops. It reports off-model authoring intent but never blocks adversarial traffic and is not vendor state.
4. Core reducer state is the adapter-normalized set of portable session facets.

Never use an Imposter scenario or scenario-driver transition as evidence that a vendor emits or means something. Never put portable states such as “thinking” or “compacting” in Surface unless the vendor literally emits that native fact.

---

## 3. Stage 0 — scope the integration before writing it

### 3.1 Establish the identities

Choose these once and use them consistently:

| Token               | Rule                                                            | Example                            |
| ------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `<vendor>`          | lowercase letters, digits, and hyphens; stable product identity | `claude`, `codex`, `grok`          |
| `<version>`         | exact normalized vendor artifact version                        | `2.1.226`                          |
| display name        | user-facing vendor/product name                                 | `Claude Code`                      |
| adapter package     | `@vibecook/puppeteer-adapter-<vendor>`                          | `@vibecook/puppeteer-adapter-grok` |
| executable override | `PUPPETEER_<VENDOR>_BIN`                                        | `PUPPETEER_GROK_BIN`               |
| persona selector    | `ai --<vendor>` and a vendor-named shim                         | `ai --codex`                       |

Track the vendor artifact version, artifact SHA-256/protocol identity, ASM format version, and Puppeteer package version separately. They answer different questions and must never be collapsed into one “version.”

### 3.2 Choose the integration family from observation, not branding

Answer these questions with probes:

- What starts a session: terminal input, a structured request, a leader/controller handshake, or something else?
- Which native channel provides lifecycle and turn boundaries?
- Where do final messages, tool activity, approvals, usage, compaction, tasks, and subagents appear?
- Are events notifications, requests requiring results, append-only records, mutable state files, or several at once?
- Which native identifier survives resume?
- Can a programmatic prompt be confirmed deterministically, or only guarded and observed later?
- Does the native TUI attach to the same session, or would a second process create a shadow session?
- Which processes and sockets must coexist, and who owns their lifecycle?
- Is there a standard protocol such as ACP, and are vendor extensions or durable rails still needed?

Use the closest reference only as a code-shape guide:

| Family                | Reference                 | Typical shape                                                                                                      |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Hook + transcript     | `packages/adapter-claude` | generated settings, loopback hooks, transcript/statusline observation, guarded terminal paste                      |
| Structured app server | `packages/adapter-codex`  | bidirectional JSON-RPC, server requests for approval, deterministic prompt correlation, separate native TUI attach |
| Protocol composition  | `packages/adapter-grok`   | ACP plus leader process, native viewer, extension events, and durable session files                                |
| Generic ACP           | `packages/adapter-acp`    | provider-neutral ACP session through a supplied connector                                                          |

If an agent is fully usable through generic ACP and does not need built-in binary resolution, native terminal composition, vendor-specific observation, or a promoted vendor support baseline, prefer the generic ACP provider. If any of those are product requirements, create a vendor adapter and compose `adapter-acp` where useful, as Grok does.

### 3.3 Plan the first-vendor bootstrap explicitly

The generic candidate workflow automates a new version of an already-known vendor. It does **not** bootstrap a brand-new vendor:

- `scripts/stage-agent-candidate.mjs` requires an existing support-ledger entry and persona.
- `scripts/validate-agent-candidate-changes.mjs` intentionally rejects adding/removing support entries and rejects arbitrary adapter source changes.
- the workflow dispatch choices and pinned-real jobs currently enumerate known vendors.

Therefore, the first adaptation needs an ordinary reviewed candidate PR. That PR may be assembled across the stages below, but it must be green as a whole and normally includes:

- the first Surface vendor directory, captures, audit, and ASM;
- a valid Imposter persona targeting that ASM;
- the adapter package and tests;
- a `baseline-pending` entry in `support/agents.json` with stable `groundTruth` and `candidateVersion` fields;
- runtime, devkit, package, and workflow wiring.

After this seam exists, later releases can use the generic adaptation workflow. Do not merge broken placeholder models or personas just to satisfy the automation.

### 3.4 Start from a green tree

Use Node.js 22.18 or newer and the repository-pinned pnpm version. Before changing anything, establish that failures are not pre-existing:

```sh
pnpm install
pnpm packages:check
pnpm support:check
pnpm upstream:check
pnpm test
```

---

## 4. Stage 1 — survey the exact native surface

The goal of Survey is to replace assumptions with observations. Documentation and source are leads; the shipped artifact is the runtime authority.

### 4.1 Add release and acquisition policy

Create:

```text
packages/surface/vendors/<vendor>/upstream.json
```

Follow `packages/surface/upstream.schema.json`. Define:

- stable and optional preview detectors;
- the upstream repository and exact source relationship when one exists;
- every required platform;
- allowlisted HTTPS artifact URLs, archive format, expected executable basenames, and a bounded maximum size;
- the vendor-specific analyses required for every candidate;
- debounce policy.

Validate it with:

```sh
pnpm upstream:check
```

For a reviewed artifact, the generic acquisition commands are:

```sh
pnpm surface:download --vendor <vendor> --version <version> --platform <platform> --output <path>
pnpm surface:acquire --vendor <vendor> --version <version> --artifact <platform>=<path> --version-output <platform>=<text>
```

`surface:download` only downloads allowlisted, bounded bytes. Survey harnesses may execute the artifact only in a disposable, isolated environment appropriate for that vendor.

### 4.2 Build a vendor-owned census harness

Create the vendor-specific tools under:

```text
packages/surface/vendors/<vendor>/
  census/
    harness.mjs
    generate-model.mjs       # optional but recommended for repeatable schema-derived parts
  sanitize-captures.mjs      # or another clearly named sanitizer/checker
  audit.mjs
```

The generic workflow cannot invent this harness. It must understand the vendor’s actual launch, authentication isolation, protocol, and trigger conditions.

Probe at least:

- `--version`, `--help`, accepted/rejected flags, exit codes, and settings/config acceptance;
- clean start, one no-tool turn, one tool turn, allow and deny approval paths, failure, interruption, and clean exit;
- new session and resume/load of the same native session;
- duplicate, late, reordered, and disconnected behavior where the transport permits it;
- transcript/native-log/state-file creation and replay behavior;
- server requests and their correlated results, in both directions;
- optional or rare branches such as compaction, tasks, subagents, notifications, and usage updates;
- PTY-only paths that headless execution cannot reach;
- every required platform when behavior or packaging may vary.

Do not spawn a shadow non-interactive agent to “observe” the native TUI session. One native session must remain one agent process/thread; use its real side channels and attach mechanisms.

### 4.3 Store raw and sanitized evidence separately

```text
packages/surface/vendors/<vendor>/
  captures-raw/<vendor>@<version>/   # verbatim; gitignored/private
  captures/<vendor>@<version>/       # sanitized, shape-faithful, tracked
  probes/<vendor>@<version>/         # safe artifact/version/help metadata when applicable
```

The wildcard for `captures-raw` is already in `.gitignore`. Never commit prompts, responses, account identifiers, home paths, repository contents, bearer tokens, API keys, or raw authenticated state.

Use the shared sanitizer in `@vibecook/puppeteer-surface/sanitize` and extend its rules for vendor-specific fields. Redaction and leak detection must remain paired. Sanitization must preserve types, identifier formats, and cross-record correlation; a fixture whose request and response IDs no longer join is not useful evidence.

After sanitizing, inspect the result manually and run the detector. Treat a privacy failure as a release blocker, not a test to waive.

### 4.4 Write findings before normalization

Create:

```text
packages/surface/vendors/<vendor>/findings.md
```

At minimum record:

- exact artifact identity, version output, SHA-256, platform, date, and harness;
- source/schema/doc references and how strongly they correspond to the artifact;
- channel inventory and directionality;
- common envelopes and session/turn/tool/approval correlation identifiers;
- per-event or per-method shapes and triggers;
- observed ordering, optionality, duplication, concurrency, and resume behavior;
- control semantics and approval result values;
- durable storage and replay rules;
- adapter and Imposter implications;
- privacy transformations;
- contradictions between artifact, generated schema, source, and docs;
- known unknowns and unverified branches.

Do not resolve disagreements by choosing the most convenient source. Record them and lower the affected claim’s confidence.

### Survey exit gate

Survey is complete when:

- every channel the adapter will rely on has a clear go/no-go verdict;
- each relied-on runtime path has raw protected evidence and a sanitized tracked fixture;
- request/result direction and correlation are retained;
- privacy checks are clean;
- artifact/source correspondence is explicit;
- missing platform or rare-path coverage is listed as a limitation rather than implied complete.

---

## 5. Stage 2 — build the Agent Surface Model

The ASM is the repository’s best-supported native contract for one pinned artifact. It contains native facts only.

### 5.1 Required layout

```text
packages/surface/vendors/<vendor>/model/<vendor>@<version>/
  manifest.json
  evidence.json
  detection.json
  channels.json
  behavior.json
  events/
    <exact-native-event-or-method>.json
```

These files are versioned authoring inputs. Generate the sole runtime authority at `packages/surface/vendors/<vendor>/groundtruth.json`; never add `groundtruth.json` or `groundtruth.html` inside this model directory.

```sh
pnpm surface:groundtruth:write -- packages/surface/vendors/<vendor>/model/<vendor>@<version>
```

For slash-delimited protocol methods, mirror the slash path under `events/`, as Codex does.

Use ASM v2 for every new candidate:

```json
{
  "asmVersion": 2,
  "vendor": "<vendor>",
  "vendorVersion": "<version>",
  "generatedAt": "YYYY-MM-DD",
  "source": "How this candidate was produced",
  "evidence": "evidence.json"
}
```

### 5.2 Model detection and channels

`detection.json` is the source for Imposter’s `--version`/`--help` behavior and for generated adapter detection projections. Record executable names, binary override environment variable, version parsing, and observed launch flags. Do not hand-copy those facts into runtime adapter code.

`channels.json` names the vendor’s rails and their native kinds. Keep simultaneous rails distinct. A live notification and its durable JSONL copy may be the same event on two channels; a leader socket may be topology rather than an event source.

If a new channel kind has no Imposter delivery implementation, that is an implementation task—not a reason to relabel it as an existing channel. You may need to extend `OpChannel`, the `DELIVERY_KIND` mapping in `packages/imposter/src/persona/load.ts`, and the corresponding channel implementation.

### 5.3 Model every event, direction, result, carrier, and variant

Each event file names the exact native event or method and includes the evidence-backed parts that apply:

```json
{
  "surface": "<vendor>",
  "surfaceVersion": "<version>",
  "event": "native/method",
  "channel": "protocol",
  "channels": ["protocol", "session-log"],
  "transport": "jsonrpc-request",
  "direction": "agent-to-client",
  "payloadSchema": {
    "type": "object",
    "properties": {
      "sessionId": { "type": "string" }
    },
    "required": ["sessionId"]
  },
  "resultSchema": {
    "type": "object",
    "properties": {
      "decision": { "type": "string" }
    },
    "required": ["decision"]
  },
  "evidence": {
    "existence": ["runtime-approval"],
    "shape": ["runtime-approval"],
    "result": ["runtime-approval"]
  },
  "confidence": "verified-headless"
}
```

Rules:

- Required fields must be present on every qualifying observation, not merely one example.
- Use only the recursive JSON-schema subset supported by `packages/surface/src/model.ts`.
- Model both protocol directions. A request whose reply is consumed or emulated needs a `resultSchema`.
- When captures retain the whole carrier, add `recordSchema` and, for multi-rail events, `recordChannel`.
- Use `variants` with scalar dotted-path `match` selectors for discriminated branches within one method.
- A generated schema proves a possible shape, not that every branch occurs. Runtime confidence comes from runtime evidence.
- An observed event missing from `events/` is drift. An unobserved source/doc branch remains explicitly `unverified`.
- `channel` is the primary/default rail; `channels` is every observed rail.

### 5.4 Make evidence claim-addressable

`evidence.json` must bind exact claims to exact records. Evidence claim kinds are:

- `runtime-capture`
- `binary-probe`
- `generated-schema`
- `exact-source`
- `official-doc`
- `inference`

Runtime capture and binary probe claims include the record, artifact, platform, harness, and capture timestamp. Records point to tracked trees and use `sha256-path-content-v1`. Artifacts carry platform-specific version output and SHA-256 integrity. Source references use full immutable revisions and state their relation to the artifact.

Refresh record digests only after the tracked model/capture content is final:

```sh
pnpm --filter @vibecook/puppeteer-surface surface:evidence:write
```

Do not use that command to legitimize an unexplained change. Review the changed tree first, then refresh its digest.

### 5.5 Model native behavior as a partial order

`behavior.json` is for native topology, not a normalized lifecycle:

- every node references an exact `events/` name;
- repeated methods use `match` selectors to identify a native branch;
- each node and relation has its own evidence and confidence;
- relations are `sequence`, `conditional`, `loop`, `resume`, `async`, or `concurrent`;
- lanes and numeric `order` are display layout only;
- optional, concurrent, re-entrant, and asynchronous paths remain explicit.

A hook named `PreCompact` proves that interception point fired; it does not prove compaction is in progress or will complete. Model `PreCompact` natively here. Decide whether it contributes to portable context/compaction semantics later in the adapter.

### 5.6 Add the vendor audit and model tests

Add `packages/surface/vendors/<vendor>/audit.mjs` and focused tests beside the vendor directory. The audit should cover, as applicable:

- model loading and identity;
- every captured event/method has a model document;
- every captured payload satisfies its schema;
- request results correlate and satisfy `resultSchema`;
- whole carriers satisfy `recordSchema`;
- variants do not claim stronger confidence than their evidence;
- committed captures pass the privacy detector;
- an exact binary-generated schema or source comparison detects drift;
- artifact identity and evidence digests remain valid.

Add a package script in `packages/surface/package.json` named `surface:audit:<vendor>`. The root `surface:audit` discovers vendor `audit.mjs` files, while adaptation and promotion workflows call the vendor-specific script directly.

### Model exit gate

Run:

```sh
pnpm --filter @vibecook/puppeteer-surface typecheck
pnpm --filter @vibecook/puppeteer-surface test
pnpm --filter @vibecook/puppeteer-surface run surface:audit:<vendor>
pnpm surface:audit
```

The stage is complete when the ASM loads, all tracked captures are represented and accepted, every behavior endpoint resolves, every v2 claim resolves to admissible evidence, privacy is clean, and gaps remain visibly unverified.

---

## 6. Stage 3 — create the Imposter persona

The Imposter is an independent native projection of the Surface model. There is one executable, `ai`; a new agent adds data and only the transport code that data cannot express.

### 6.1 Persona layout

```text
packages/imposter/personas/<vendor>/
  persona.json
  ops.json
  serve.json                     # only for a served protocol/leader persona
  behavior/
    happy-turn.json
    approval-turn.json           # when applicable
  scenarios/
    happy-turn.json
    permission-allow.json
    permission-deny.json
    duplicate-out-of-order.json
    late-after-exit.json
    unknown-event.json
    flood.json
    crash-mid-turn.json
    channel-disconnect.json
    token-usage-refresh.json
  runflows.json
```

If a capability truly does not exist on the native surface, document it as not applicable rather than fabricating an event. Keep the normal, failure, ordering, unknown, and channel-fault coverage that does apply.

### 6.2 Define `persona.json`

The persona points to Surface; it does not copy the model:

```json
{
  "vendor": "<vendor>",
  "asm": {
    "package": "@vibecook/puppeteer-surface",
    "path": "vendors/<vendor>"
  },
  "shimNames": ["<vendor-binary>"],
  "envelope": {},
  "bindings": {
    "$threadId": "$uuid:thread"
  },
  "boot": [{ "op": "session.start" }, { "op": "session.ready" }]
}
```

Use:

- `envelope` for vendor-native fields merged into every emission;
- `eventNameField` only when the vendor puts its event name inside the payload;
- `bindings` for session-scoped vendor vocabulary such as thread IDs;
- `nativeStore` for a vendor-native durable session layout;
- `boot` for authoring intent at session start.

An authoring op may intentionally have no native binding. For example, if a vendor has no boot-ready notification, `session.ready` may advance the scenario driver without inventing a wire message.

### 6.3 Map semantic ops to exact native emissions

`ops.json` maps the deliberately small shared vocabulary:

```text
session.initialize
session.start
session.ready
session.end
turn.start
assistant.delta
tool.start
tool.end
permission.ask
turn.end
usage.refresh
```

One op may emit on several native channels. Use payload templates and stable bindings such as `$op.*`, `$stimulus.*`, `$sessionId`, `$uuid:<name>`, and `$now`. For a real server-initiated request, set `await: true`; do not send an approval request as a notification.

The loader rejects:

- unknown op names;
- an event absent from the ASM;
- a known event bound to a native rail the ASM does not declare;
- malformed persona and op document fields.

Resolved scenario and op payloads are separately checked against the ASM before they are emitted.

Do not expand the op vocabulary to mirror every vendor event. Raw scenarios exist for native traffic that has no portable authoring intent.

### 6.4 Add `serve.json` only when the vendor serves a protocol

A served entry must correspond to an ASM event with:

- `direction: client-to-agent`;
- `transport: jsonrpc-request`;
- a modeled `resultSchema`.

Model notifications as notifications. Preserve native initialization gates, request ordering, session/thread binding, resume/load semantics, attach roles, and server-request routing. A viewer and a controller may be separate native roles; do not let both answer one approval.

If the vendor needs a transport the Imposter does not implement, add the transport deliberately. Current socket serving supports `unix`; silently falling back to stdio would make the adapter wait for a socket that never appears.

### 6.5 Write executable scenarios

A scenario is either a direct action list or a sorted `at`/`do` timeline. Each step contains exactly one of:

- `emit`
- `transcript`
- `statusline`
- `delay`
- `fault`

Supported fault kinds are `crash`, `exit`, `hang`, `flood`, and `channel-drop`. `emit.request: true` performs a real server request and requires a connected client. The entire scenario is structurally and ASM-schema validated before the first side effect.

Keep the intentional exception visible: `unknown-event.json` should use a name the model does not know so ADR-008 retention is actually tested. Every other raw emission should be Surface-declared.

Create `packages/imposter/src/persona/scenarios.<vendor>.test.ts` to execute every required scenario at high speed, validate every payload through the loaded persona, assert native order and request-vs-notification behavior, and drive important adversarial scripts through the real adapter when possible.

### 6.6 Curate runflows for the devkit

`runflows.json` is metadata pointing to existing scenarios, not a second workflow language:

```json
{
  "version": 1,
  "flows": [
    {
      "id": "happy-turn",
      "intent": "turn.basic",
      "scenario": "happy-turn",
      "title": "Basic assistant turn",
      "summary": "Native start, reply, and clean completion.",
      "kind": "typical",
      "danger": "safe",
      "tags": ["turn"],
      "defaultStimulus": { "text": "Explain this repository." },
      "defaultSpeed": 4
    }
  ]
}
```

Allowed `kind` values are `typical`, `lifecycle`, `vendor`, `adversarial`, and `fault`. Allowed danger values are `safe`, `disruptive`, and `terminal`. Use the same `intent` across personas for semantically comparable flows.

The loader derives the step count, native event names, channels, and `requiresClient` flag from the scenario. It refuses missing references and malformed catalogs, so catalog prose cannot become executable truth.

Prefer a small catalog that covers real design questions:

- basic turn;
- tool with allow and deny decisions;
- usage/context refresh;
- resume or vendor-specific lifecycle;
- duplicate/reordered correlation;
- late event after terminal state;
- compaction, task, or subagent paths the vendor actually exposes.

### 6.7 Verify the native projection

Run:

```sh
node packages/imposter/bin/ai.mjs --<vendor> --version
pnpm --filter @vibecook/puppeteer-imposter typecheck
pnpm --filter @vibecook/puppeteer-imposter test
pnpm surface:replay --vendor <vendor> --ground-truth packages/surface/vendors/<vendor>/groundtruth.json
pnpm agent-devkit
```

In the devkit, verify that the left side shows the Surface native graph, exact raw names and payloads, correct channels, scenario-driver intent as a secondary view, and usable runflows. At this stage the normalized side may still report `unsupported`; that is honest.

### Emulation exit gate

The stage is complete when:

- `ai --<vendor> --version` answers from `detection.json`;
- the persona loads against the exact candidate ASM;
- every normal scenario is on-model and every intentional unknown is explicit;
- server requests and results use their real direction;
- native session identity survives resume and attach;
- exact capture replay passes, including carrier and result validation;
- native devkit controls do not depend on an adapter or Core reducer.

---

## 7. Stage 4 — implement the adapter and normalization

### 7.1 Package layout

Create a real flat workspace package:

```text
packages/adapter-<vendor>/
  package.json
  tsconfig.json
  tsconfig.build.json
  src/
    index.ts
    detection.ts
    driver.ts
    normalization/
      index.ts
      adapter.ts       # native input dispatch and correlation
      <category>.ts    # one Core event category per file
      monitor.ts       # correction-aware monitor evidence
      pipeline.ts
      types.ts
    services/          # one upper-level capability per file
    generated/        # evidence-derived runtime projections, when needed
    launch/           # native launch/attach preparation
      native-invocation.ts # vendor argv/env normalization + continuation codec
    observation/      # hooks, logs, transcripts, usage
    transport/        # protocol/socket/process clients
    test-support/     # synthetic builders, never real captured truth
    conformance.test.ts
    *.live.test.ts
```

Use only the directories the adapter actually needs. Tests stay beside the responsibility they exercise.

The manifest must match the repository’s public-package contract: lockstep root version, repository directory, Node engine, source and published exports, `clean`, `build`, `prepack`, `typecheck`, and `test` scripts. Every adapter depends on Core. Surface may be a development dependency for generators/tests but must not be a production dependency; runtime code consumes checked generated projections, not model files.

### 7.2 Generate detection and launch facts from Surface

When runtime code needs executable names, version patterns, flags, hook registries, settings entries, or similar stable facts, generate adapter-local TypeScript from the selected Surface model. Follow `packages/adapter-claude/scripts/generate-registry.mjs` and `src/generated/` as the reference.

The active Surface selection intentionally prefers `candidateVersion` over `currentVersion` during review and always resolves the stable vendor-root `groundTruth` path. Use `scripts/agent-model-selection.mjs`; do not hard-code a candidate version in multiple tools.

Commit generated projections and test them against the selected ground truth. Do not import captures or the model from production adapter code.

### 7.3 Implement a stateful, evidence-traceable normalizer

For each native input, make the mapping decision explicit:

```text
native record
  -> validate/parse the native envelope
  -> recover native correlation identifiers
  -> update bounded adapter correlation state
  -> emit zero, one, or many AdapterEventCandidate values
  -> Runtime validates and stamps immutable AgentEventEnvelope values
  -> Runtime-owned Agent projects state, conversation, and monitor views
```

Rules:

- Use the category contracts in `packages/core/src/events/`; do not create ad hoc portable names inside an adapter.
- Every mapping must cite a native fact and a product-relevant semantic reason.
- Preserve distinct identifiers. Do not collapse prompt, assistant-cycle, thread, turn, item, tool, and approval IDs unless evidence proves they are identical.
- Treat correlation as part of the design. State exactly which keys join records and what happens when a key is absent.
- Keep per-session buffers bounded. When evicting pending state, resolve or retain it honestly so reducer state cannot leak forever.
- Handle duplicate, reordered, late, and re-entrant events deterministically.
- Unknown or unsupported native events become `adapter:native-event`, with the full original record retained on the candidate's `nativeEvent` field.
- An intentionally filtered event, a buffered event, and an unknown retained event are three different outcomes.
- Never infer semantic state from terminal text.
- Never infer completion from a “pre” hook or a similarly suggestive name.
- If a server request needs request IDs, client decisions, or response correlation, normalize it in the driver where that context exists; do not fake it in a pure notification normalizer.

If the existing Core vocabulary cannot represent a genuinely cross-vendor, product-relevant fact, propose the Core event and reducer change separately. Prove it against at least two native shapes or explain why it is a universal contract. Do not add a portable event merely to avoid retaining one vendor detail.

Surface confidence and normalized-envelope confidence answer different questions. `verified-headless`/`verified-interactive`/`unverified` describe the evidence behind a native ASM claim. `authoritative`/`derived`/`inferred` describe how a particular portable event was obtained. Choose the latter deliberately:

- `authoritative` when the trusted native rail establishes the portable fact, including lossless assembly of that rail’s streamed representation;
- `derived` when the fact itself is computed from several observations or runtime context rather than stated by the native rail;
- `inferred` only for a weaker heuristic, with terminal inference used as the lowest observation source.

Likewise, `ObservationLevel` describes the best current live observation path for the session, not the vendor’s marketing or the theoretical richness of its protocol.

### 7.4 Implement the driver behind `AgentAdapterBinding`

The driver owns the complete live composition:

- exact binary detection and version reporting;
- launch or attach through vendor-native flags;
- any app server, leader, socket, hook bridge, transcript/native-log observer, or state-file observer;
- native session creation and resume/load;
- one normalized candidate stream containing honest `source`, `confidence`, `promptId`, `turnId`, `replay`, and `nativeEvent` fields;
- category normalization delegated to `normalization/<category>.ts`, not embedded in the driver;
- named `services/<capability>.ts` for prompt, approval, artifact, and other commands;
- native control and approval decisions;
- programmatic prompt submission with a truthful `confirmed`, `rejected`, or `uncertain` receipt;
- idempotent disposal of observation/control resources;
- an honest `ObservationLevel`.

Adapters access terminals only through `AgentHost`. They may build their own native protocols and observers, but they do not own the application’s PTY implementation. Process lifecycle remains with the host; `dispose()` tears down adapter-owned observation/control.

Never launch a second shadow agent for a native TUI session. If the vendor has a controller and a viewer, both must attach to the same native session. Launch environments may contain bearer tokens and must never be logged or persisted.

### 7.5 Test normalization before full composition

Add focused tests for:

- every evidence-backed mapping and every retained native branch;
- missing optional fields and malformed-but-tolerable native records;
- correlation joins and correlation misses;
- stream accumulation and final boundaries;
- allow, deny, dismiss, and unknown approval outcomes;
- tool success/failure and stable tombstones for duplicates;
- duplicate, out-of-order, re-entrant, and late-after-exit input;
- resume replay vs live input;
- bounded buffers and cleanup;
- transport framing, request/result direction, and disconnects;
- launch flags, generated settings, and detection/version behavior;
- prompt confirmation and uncertain outcomes;
- idempotent disposal and ignored events after disposal.

Use synthetic builders in the adapter’s `test-support/`; load real captured truth only from Surface-owned fixtures in tests that are explicitly validating the projection.

---

## 8. Use the normalization devkit as the design loop

The devkit is where developers compare independent native evidence with the actual adapter interpretation:

```text
Native evidence -> Folding ledger -> Normalized events -> Core state facets
```

Start it with:

```sh
pnpm agent-devkit
```

### 8.1 Wire a new vendor into the app

For native viewing:

- add the vendor to `SpawnablePersona` in `apps/imposter-control/src/main/spawner.ts`;
- register a labeled spawner in `apps/imposter-control/src/main/main.ts`;
- add any isolated home/environment handling the vendor requires;
- extend `spawner.test.ts` with native channels, behavior nodes, and runflow assertions.

For pure normalization replay, when the adapter exposes a suitable normalizer:

- add the adapter as a dependency of `apps/imposter-control`;
- add a vendor case to `createNormalizer` in `apps/imposter-control/src/main/normalization-lab.ts`;
- provide the correct native envelope, event source, correlation IDs, and raw `nativeEvent`;
- classify driver-owned requests explicitly;
- add focused normalization-lab tests for mapping, gaps, deduplication, and replay.

If correct normalization requires multiple native rails or live driver context, leave the projection `unsupported` or mark individual records `driver-owned`. Do not write a convenient partial normalizer and present it as full coverage. Grok currently demonstrates this honest limit.

### 8.2 Understand every ledger disposition

| Disposition       | Meaning                                                                                   | Required developer action                                             |
| ----------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `mapped`          | one or more portable events were emitted                                                  | verify the evidence, correlation, source/confidence, and state change |
| `retained-native` | no portable interpretation; native identity was preserved                                 | confirm retention is intentional and inspectable                      |
| `buffered`        | the normalizer consumed correlation evidence and waits for a later record                 | verify the release condition, bound, and missing-boundary behavior    |
| `no-output`       | intentionally no portable output                                                          | explain why it is neither buffering nor accidental loss               |
| `driver-owned`    | complete normalization requires request/runtime context absent from emitted-record replay | cover it in driver and E2E tests                                      |
| `unsupported`     | no faithful pure normalizer is wired                                                      | retain this label until a correct seam exists                         |
| `blocked`         | a native sequence gap prevents safe reduction                                             | repair through authoritative backfill; never reduce around the gap    |
| `error`           | the normalizer rejected the record                                                        | fix the model, scenario, adapter, or projection; do not hide it       |

### 8.3 Review one semantic area at a time

For lifecycle, turns, tools, approvals, messages, reasoning, usage, context, tasks, and subagents:

1. Pick evidence-backed native paths and a curated runflow that covers normal, optional, repeated, and adversarial ordering.
2. Run it once continuously, then step through it to inspect each fold.
3. Account for every native record in the ledger.
4. Inspect correlation joins and the behavior when a key is missing.
5. Compare native sequence boundaries with normalized envelope sequence and state diffs.
6. Compare the same runflow `intent` across agents. Shared portable facets need shared invariants, not identical native routes.
7. Convert the accepted trace into adapter and conformance fixtures.
8. Re-run duplicate, out-of-order, late-after-exit, unknown-event, channel-drop, and resume cases before moving on.

Keep a review table in the adapter PR or findings while decisions are changing:

| Native event + selector | Evidence claim | Correlation key                       | Portable output/disposition                                | Core state effect      | Missing/duplicate/late policy    |
| ----------------------- | -------------- | ------------------------------------- | ---------------------------------------------------------- | ---------------------- | -------------------------------- |
| exact vendor fact       | claim ID       | native identifier or explicit absence | event type, buffered, retained, driver-owned, or no-output | affected facet or none | deterministic edge-case behavior |

Useful review questions:

- Which exact native claim justifies this portable event?
- Is the mapping one-to-one, many-to-one, one-to-many, buffered, driver-owned, or deliberately absent?
- Which identifier proves correlation?
- What closes pending state if the expected later record never arrives?
- Does the Core state change add portable product value or merely rename a vendor detail?
- Does a new variant remain visible before semantics are assigned?
- Would the mapping still be honest if another vendor reached the same facet through a different route?

The pure-normalizer devkit does not currently mirror every transcript/statusline observation and cannot reconstruct all server-request context. Treat the app’s limitations list as part of the result. Full driver conformance remains mandatory.

---

## 9. Stage 5 — conform and integrate

### 9.1 Run the shared `AgentAdapterBinding` contract locally

Create `packages/adapter-<vendor>/src/conformance.test.ts` and register:

```ts
runAgentAdapterConformance('<vendor>', createHarness);
```

The harness must create a fresh session, drive a complete turn, expose the expected reply, resume the same native session, and assert that all adapter-owned resources are gone after disposal.

The shared suite verifies:

- non-empty native and runtime session identities;
- a valid, honest observation level;
- `running` during a turn and `ready` afterward;
- no active turn, reasoning, tool, permission, subagent, or task after completion;
- final assistant text in `lastAssistantMessage`;
- strictly increasing envelope sequences;
- resume of the same native ID and a usable next turn, plus observable history continuity when the native surface exposes replayable conversation facts;
- idempotent disposal and no orphaned resources.

Adapter-specific contracts—approval policy, launch topology, transcript behavior, request routing, account usage, and prompt certainty—need separate tests.

### 9.2 Add a real adapter-against-Imposter lane

Add `packages/imposter/src/conformance.<vendor>.test.ts`. Spawn `packages/imposter/bin/ai.mjs` as a real subprocess and point the real adapter transport/launch recipe at it. Do not call the normalizer directly in this lane.

Exercise:

- detection and launch arguments;
- native channel setup;
- one full turn through the shared conformance suite;
- resume with durable history, or an evidence-backed `identity-only` declaration when the native observation surface exposes identity but no replay payload;
- approval requests and client decisions;
- terminal/controller/leader coexistence if applicable;
- cleanup of processes, sockets, generated settings, and temporary stores.

This lane protects Puppeteer from its own regressions without a vendor binary, credentials, or network. It does not prove the upstream artifact still behaves the same; pinned-real testing does that.

Add the new adapter as an Imposter **development** dependency when the E2E test imports it. It must never become an Imposter production dependency.

### 9.3 Register the built-in runtime provider

Update:

- `packages/builtin-providers/package.json` production dependencies;
- `packages/builtin-providers/src/types.ts`:
  - `BuiltinAgentKind`;
  - `BuiltinExecutableAgentKind` when appropriate;
  - `<Vendor>AgentOptions`;
  - `BuiltinCreateAgentSessionOptions` discriminated variant;
- `packages/builtin-providers/src/providers.ts`:
  - executable resolution from `PUPPETEER_<VENDOR>_BIN`;
  - one `AgentProvider` entry with a strict `{ id, label }` descriptor;
  - optional adapter-owned `AccountUsageService` composition;
  - `createSession` and optional `prepareSession`;
  - one `launch.provider` descriptor declaring resume, native commands, the safe environment allow-list, and any
    conformant Imposter topology;
  - `launch.normalizeInvocation` delegated to the adapter's `launch/native-invocation.ts`;
  - an opaque, credential-free continuation codec when resume depends on an agent home/configuration root or
    implementation topology. Its JSON payload crosses persistence and therefore uses a strict, versioned Zod schema;
  - provider-level resource disposal;
- `packages/builtin-providers/src/providers.test.ts` mocks, forwarding assertions, preparation behavior, and option typing.

Keep all vendor branching behind `AgentProvider`. Never add provider-specific branches to `packages/runtime/src/runtime.ts`.
The public built-in option facade may expose user intent such as model or permission posture; it must not expose
executables, raw environment maps, app-server wiring, native resume argv, or provider store paths.

### 9.4 Wire product applications that expose built-in agents

Runtime registration makes provider-neutral identity and launch capability available to consumers. Godview discovers
provider ids and display labels through `providers()` and
`launchProviders()`, creates shims from declared commands, forwards only declared environment names, and hands the
intent to `prepareInvocation()`. Its spawn-through host owns authentication, PID-to-terminal matching, adoption,
fallback, and `exec`; it must not parse vendor argv, choose adapter transports, or assemble provider options.

Resume uses the `AgentContinuation` returned on every `AgentSessionInfo`: persist it opaquely and pass it to
`runtime.resume()`. Product snapshots must not split it back into provider id, native session id, and launch
provenance. Runtime preserves the generic `native | imposter` distinction; the adapter alone captures and restores
any credential-free state it needs. Every advertised Imposter path must use a host-owned durable state root so resume
cannot silently switch implementations or lose history after the temporary shim directory is removed.

Product code should change only for optional artwork isolated in the branding map or a product choice that is
independent of provider mechanics. A new provider must work through the generic icon fallback and must not require
editing a Godview label switch, restorable list, shim union, argv parser, environment branch, or Imposter allow-list.

Account usage requires no Godview provider list, renderer bucket mapping, or polling branch. Implement the adapter's
account-usage service in its own service file: publish an `AccountUsageProvider` descriptor, normalize native quota ids
into ordered `AccountUsageMetric` records, and compose that service into `AgentProvider.accountUsage`. Runtime validates
the Zod schema and Godview discovers the capability through `accountUsageProviders()`.

Do not add an Imposter agent to a product’s native-pane allowlist until its real adapter-against-Imposter launch topology has passed conformance. Codex and Grok need more than a persona that can print events: their attach/leader compositions must work end to end.

### 9.5 Wire publication and release policy

For a new public adapter package, update:

- `scripts/public-packages.mjs` in dependency order;
- `release-please-config.json` `extra-files`;
- the root lockfile through normal pnpm install/update behavior;
- `packages/runtime/package.json` and any app/Imposter development dependencies;
- optional adapter `docs/event-map.html`, with metadata pointing to the stable ground-truth path and selected version.

Never hand-bump package versions. All public packages release in lockstep.

`pnpm packages:check` enforces package names, versions, exports, scripts, dependency acyclicity, release-list coverage, Surface ownership, and the rule that adapters do not consume Surface at runtime.

### 9.6 Wire continuous and protected workflows

For a new vendor, update the hard-coded orchestration seams:

- `.github/workflows/agent-adaptation.yml` vendor choices;
- `.github/workflows/agent-surface-promotion.yml` vendor choices and the vendor-specific pinned-real lane/environment;
- `.github/workflows/agent-live.yml` scheduled real-artifact job and enablement variables;
- `packages/surface/package.json` vendor audit script;
- any vendor-specific live-test environment variable documentation.

The scheduled upstream detector discovers `upstream.json` definitions, but workflow dispatch choices and pinned-real commands are deliberately explicit security policy.

### Conformance/integration exit gate

The adapter is integration-complete when:

- adapter-local conformance passes;
- adapter-against-Imposter conformance passes without vendor software;
- runtime provider tests and typed options pass;
- every product app that exposes the agent passes its selector, shim, launch, restore, and presentation tests;
- resume restores native history when the Surface exposes it; an `identity-only` exception names the evidence-backed limitation and leaves history continuity to Runtime recording;
- disposal leaves no processes, sockets, observers, settings, or stores orphaned;
- package layout and tarball checks pass;
- the pinned-real lane exists and is opt-in/credential-isolated.

---

## 10. Stage 6 — reconcile, review, and promote

### 10.1 Add the support-ledger candidate

For the first vendor, add a reviewed entry to `support/agents.json`:

```json
{
  "id": "<vendor>",
  "displayName": "<Display Name>",
  "kind": "vendor",
  "adapterPackage": "@vibecook/puppeteer-adapter-<vendor>",
  "persona": "<vendor>",
  "groundTruth": "packages/surface/vendors/<vendor>/groundtruth.json",
  "candidateVersion": "<version>",
  "status": "baseline-pending"
}
```

Do not add `currentVersion` or `verification` by hand for a first unpromoted candidate. Do not hand-edit the generated README badge block. For a manually added first candidate, render it from the ledger and then validate it:

```sh
pnpm support:write
pnpm support:check
```

For a later version of an existing vendor, stage the candidate and align the persona automatically:

```sh
node scripts/stage-agent-candidate.mjs --vendor <vendor> --ground-truth packages/surface/vendors/<vendor>/groundtruth.json
```

### 10.2 Attach exact artifacts and reconcile locally

Once all reviewed platform artifacts have been acquired:

```sh
pnpm surface:evidence:artifacts --ground-truth <ground-truth> --artifacts <acquisition.json>
pnpm --filter @vibecook/puppeteer-surface surface:evidence:write
pnpm surface:replay --vendor <vendor> --ground-truth <ground-truth>
pnpm surface:reconcile --vendor <vendor> --ground-truth <ground-truth> --artifacts <acquisition.json>
```

Reconciliation classifies model, event/variant confidence, channel, behavior, artifact, detector, and replay drift. Its recommendation is input to review, not permission to promote.

The important outcomes are:

- `no-surface-drift`: still requires exact artifacts and promotion gates;
- `additive-unconsumed`: review unknown-event retention and whether product semantics are affected;
- `adaptation-required`: update the persona/adapter and re-run every relevant gate;
- unsafe, unknown, or republished-artifact outcomes: quarantine the candidate.

### 10.3 Use the candidate workflow for existing vendors

After the vendor seam exists, dispatch `.github/workflows/agent-adaptation.yml` from the branch containing the reviewer-prepared ASM v2 candidate:

```sh
gh workflow run agent-adaptation.yml \
  --ref <branch> \
  -f vendor=<vendor> \
  -f version=<version> \
  -f ground_truth=<ground-truth> \
  -f publish_draft=true
```

The workflow:

1. downloads allowlisted artifacts on every declared platform;
2. probes exact version output in disposable homes;
3. assembles immutable artifact identities;
4. attaches those identities to already-prepared evidence without inventing claims;
5. stages the candidate pointer/persona;
6. audits Surface, adapter, Imposter, packages, and support metadata;
7. performs exact replay and drift classification;
8. confines automated changes to Surface, persona, generated adapter output, findings/event-map, and the candidate pointer;
9. may open a draft PR.

It cannot author vendor-specific census claims or modify hand-written adapter/runtime source. Semantic changes remain ordinary reviewed engineering work.

### 10.4 Run protected promotion

After the candidate PR and all semantic/security review are complete, dispatch the protected workflow:

```sh
gh workflow run agent-surface-promotion.yml \
  --ref <candidate-ref> \
  -f vendor=<vendor> \
  -f version=<version> \
  -f ground_truth=<ground-truth> \
  -f confirm=promote
```

Promotion:

1. reacquires the exact bytes on hosted runners;
2. executes each platform artifact on credential-isolated self-hosted runners;
3. runs the vendor Surface audit and real adapter suite;
4. creates per-platform verification reports;
5. verifies the complete declared platform matrix and repository gates;
6. enters the protected `agent-surface-promotion` environment for human approval;
7. atomically updates artifact evidence, `support/agents.json`, and the generated README badge;
8. records the workflow/run/attempt, candidate commit, canonical ground-truth path and version, evidence/model/replay digests, and artifact hashes.

`pnpm surface:promote` is intentionally inert outside the exact attested GitHub Actions context. Local success is not authority to edit `currentVersion` manually.

### 10.5 Keep the adaptation alive

After promotion:

- the six-hour upstream watcher detects and debounces stable releases but never promotes them;
- the scheduled live workflow runs only on explicitly enabled, credential-isolated runners;
- a new version starts again at Survey, using the promoted model as a diff baseline;
- same-version artifact changes and stable-channel rollbacks are incidents, not normal updates to overwrite in place;
- rollback rebuilds the canonical root from a retained verified authoring model, moves `currentVersion` through a protected transaction, and regenerates badges; it never deletes evidence or candidate history.

---

## 11. Required verification matrix

Run targeted checks while iterating, then the full matrix before review.

| Area                | Command                                                                         | What it proves                                                                                  |
| ------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Detector config     | `pnpm upstream:check`                                                           | every `upstream.json` satisfies policy                                                          |
| Surface types/tests | `pnpm --filter @vibecook/puppeteer-surface typecheck` and `test`                | model/sanitizer runtime and vendor fixtures are sound                                           |
| Vendor audit        | `pnpm --filter @vibecook/puppeteer-surface run surface:audit:<vendor>`          | selected candidate matches evidence and vendor-specific checks                                  |
| All Surface         | `pnpm surface:audit`                                                            | every current/candidate surface remains clean                                                   |
| Exact replay        | `pnpm surface:replay --vendor <vendor> --ground-truth <ground-truth>`           | captures, model, persona, carriers, directions, and results agree pre-normalization             |
| Adapter             | `pnpm --filter @vibecook/puppeteer-adapter-<vendor> typecheck` and `test`       | normalization, driver, transport, and shared conformance pass                                   |
| Imposter            | `pnpm --filter @vibecook/puppeteer-imposter typecheck` and `test`               | persona/scenarios and adapter-against-Imposter pass                                             |
| Runtime             | `pnpm --filter @vibecook/puppeteer-runtime typecheck` and `test`                | provider and typed options are integrated                                                       |
| Devkit              | `pnpm --filter imposter-control typecheck`, `test`, and `bundle`                | spawner, native plane, projection, and browser bundle agree                                     |
| Devkit smoke        | `pnpm agent-devkit:smoke`                                                       | Electron main process starts and shuts down correctly                                           |
| Godview, when wired | `pnpm godview:typecheck`, `godview:test`, `godview:bundle`, and `godview:smoke` | built-in selection, shim/spawn-through, restore, renderer, bundle, and native launch are usable |
| Package policy      | `pnpm packages:check`                                                           | topology, manifests, ownership, release coverage, and dependencies are valid                    |
| Support policy      | `pnpm support:check`                                                            | ledger, persona, canonical ground truth, selected versions, evidence, and badge agree           |
| Full repository     | `pnpm test`                                                                     | all typechecks, script tests, package tests, and app tests pass                                 |
| Published shape     | `pnpm pack:check`                                                               | all public packages build and tarballs contain only allowed files                               |

Run live tests only against an explicitly selected artifact in an isolated environment. Existing examples use `PUPPETEER_REAL_CLAUDE=1`, `CODEX_LIVE=1`, and `GROK_LIVE=1`; define and document the equivalent for a new vendor.

For a local Godview smoke run without a Tailscale login, set `GHOSTTEA_TRUFFLE_ENABLED=false`.

---

## 12. Complete file touch map for a new vendor

This is the review checklist for files commonly missed during a first adaptation.

### Surface and evidence

- [ ] `packages/surface/vendors/<vendor>/upstream.json`
- [ ] `packages/surface/vendors/<vendor>/findings.md`
- [ ] census/probe harnesses and optional model generator
- [ ] paired sanitizer and privacy detector tests
- [ ] sanitized captures under the versioned capture directory
- [ ] ASM v2 manifest, evidence, detection, channels, events, and behavior
- [ ] generated vendor-root `groundtruth.json` and `groundtruth.html`, with none inside `model/`
- [ ] vendor `audit.mjs` and focused model/capture tests
- [ ] `surface:audit:<vendor>` script in `packages/surface/package.json`

### Imposter and native devkit

- [ ] `packages/imposter/personas/<vendor>/persona.json`
- [ ] `ops.json`, optional `serve.json`, behavior packs, scenarios, and runflows
- [ ] persona/scenario tests and adapter-against-Imposter conformance
- [ ] Imposter dev dependency on the adapter when required by E2E tests
- [ ] new channel/serve/leader implementation only if the native shape requires it
- [ ] `SpawnablePersona`, spawner registration, vendor environment isolation, and spawner tests in `apps/imposter-control`

### Adapter and normalization devkit

- [ ] public adapter package with source/publish exports and standard scripts
- [ ] generated detection/registry projection where needed
- [ ] normalizer, driver, launch, observation, control, and transport responsibilities
- [ ] unit, integration, conformance, and opt-in live tests
- [ ] adapter dependency and pure-normalizer seam in the devkit, or an explicit honest `unsupported` limit
- [ ] normalization-lab tests for mappings, driver-owned records, gaps, and replay

### Runtime, packaging, and support

- [ ] runtime dependency, provider entry, built-in kind/options, and provider tests
- [ ] `scripts/public-packages.mjs`
- [ ] `release-please-config.json`
- [ ] lockfile update
- [ ] `support/agents.json` candidate entry
- [ ] generated README support block left to `support:write`/promotion
- [ ] optional adapter event map tied to the selected Surface ground truth

### Product applications

- [ ] launch descriptor, native-invocation normalizer, continuation codec, and adjacent adapter tests
- [ ] Godview product branding only; no provider mechanics in shim, spawn-through, or restore
- [ ] product-app typecheck, tests, bundle, and smoke for every app changed

### Automation

- [ ] adaptation workflow vendor choice
- [ ] promotion workflow vendor choice and pinned-real job
- [ ] scheduled live workflow job/variables
- [ ] complete platform artifact policy and runner availability

---

## 13. Definition of done

### Native truth

- [ ] The exact artifact/version/platform identity is recorded.
- [ ] Raw evidence is protected and tracked fixtures are sanitized and shape-faithful.
- [ ] Every relied-on channel and every captured event/method is modeled.
- [ ] Requests, results, complete carriers, directions, variants, and multi-rail events are represented.
- [ ] Every ASM v2 claim resolves to admissible evidence.
- [ ] Native behavior is a partial order with exact names, not normalized states.
- [ ] Known unknowns remain explicit and unverified.

### Imposter

- [ ] The persona points at Surface and contains no copied vendor truth.
- [ ] Detection output, argv, channels, native store, and serving roles match the model.
- [ ] Normal and adversarial scenarios are executable and schema-valid.
- [ ] Runflows cover the important developer journeys without becoming a second scenario language.
- [ ] Exact replay passes and intentional unknown events remain the only off-model payloads.
- [ ] The native devkit pane works without adapter normalization.

### Adapter and normalization

- [ ] Detection/registry facts are generated from Surface where applicable.
- [ ] Every mapping is evidence-traceable and correlation is explicit.
- [ ] Unknown native events and raw records are retained.
- [ ] Buffers are bounded and terminal/missing-boundary behavior is tested.
- [ ] Prompt receipts and observation level are honest.
- [ ] No semantics are derived from terminal text.
- [ ] Devkit ledger dispositions and Core state changes have been reviewed across representative runflows.
- [ ] Driver-owned and unsupported coverage is labeled rather than simulated away.

### Integration and support

- [ ] Adapter-local shared conformance is green.
- [ ] Real adapter-against-Imposter conformance is green with no vendor dependency.
- [ ] Pinned-real conformance is green on every required platform.
- [ ] Resume restores observable history, or has an evidence-backed `identity-only` declaration; disposal leaves no orphans.
- [ ] Runtime provider and typed options are registered without branching in `runtime.ts`.
- [ ] Package, support, upstream, full test, build, and pack gates pass.
- [ ] The protected promotion records the complete attestation and generates the support badge.
- [ ] Ongoing detector and live reconciliation lanes are enabled or their absence is documented.

An adaptation is finished only when every applicable box is checked or an honest limitation is recorded in the candidate and support status.

---

## 14. Common failure modes

### “The persona emits events, but the adapter sees nothing”

Check native identity first: session/thread ID, resume adoption, current working directory, and controller/viewer role. Then check event direction, channel, protocol carrier, and whether the adapter filters another thread. A server that mints a new ID during resume can look healthy while every notification is silently irrelevant to the observer.

### “The payload schema validates, but replay fails”

Replay validates more than `params`: direction, request/result pairing, full carriers, record channel, persona/model version agreement, canonical JSONL bytes, and variant confidence. Fix the missing evidence or model dimension; do not weaken replay to payload-only validation.

### “A runflow is disabled in the devkit”

The loader derives `requiresClient` when a scenario performs a server request. A detached Imposter cannot complete that flow because no real protocol client exists to answer it. Run it through an attached adapter/client or use a notification-only flow for pure native inspection.

### “A native record produces no normalized event”

Use the ledger disposition. `buffered`, `no-output`, `driver-owned`, `retained-native`, and `unsupported` mean different things. Only `error` or an unexplained `no-output` is automatically a bug.

### “`support:check` says the persona and ground truth disagree”

The canonical document, candidate/current version state, and `persona.json` ASM path must select the same agent. Use `stage-agent-candidate.mjs` for an existing vendor; do not update only one side.

### “The candidate workflow rejects my new agent”

That workflow is confined to existing vendor candidates. A first vendor entry, adapter source, runtime registration, and workflow policy need an ordinary reviewed bootstrap candidate PR.

### “The vendor audit says drift is skipped”

Hermetic CI may not have the vendor binary. Capture/model/privacy checks must still run. Exact binary/schema comparison belongs in the pinned-real or explicitly provisioned live lane and must be reported as skipped when unavailable, never silently treated as passed.

### “`packages:check` rejects the new adapter”

Verify the package name, root lockstep version, repository directory, Node engine, source/publish export parity, standard scripts, `scripts/public-packages.mjs`, release-please coverage, dependency direction, and that Surface is not a production dependency.

---

## 15. Suggested PR description

Use this structure so reviewers can verify the adaptation without reconstructing the process:

```md
## Artifact

- Vendor/version:
- Platforms and SHA-256:
- Source/schema relationship:

## Native surface

- Channels:
- New/changed events and variants:
- Ordering/resume/control findings:
- Unverified paths:

## Imposter

- Persona/serve changes:
- Scenarios and runflows:
- Exact replay result:

## Normalization

- Mapping changes:
- Correlation rules:
- Retained/driver-owned/unsupported records:
- Core state effects reviewed in devkit:

## Integration

- Runtime/provider/package/workflow changes:
- Hermetic conformance:
- Pinned-real/platform results:

## Risks and limitations

- Approval/sandbox/filesystem/network implications:
- Known gaps:
- Promotion status:
```

This workflow intentionally makes native evidence, authored simulation, normalized semantics, and support promotion separate reviewable decisions. That separation is what lets Puppeteer add new agents without slowly turning one vendor’s behavior into the universal contract.
