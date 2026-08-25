# Chopsticks Agent Emulator & Surface Model — v0.1

**Status:** Archived historical design; active ownership lives in `packages/surface`, `packages/imposter`, and `draft/SURFACE-ADAPTATION-REFACTOR.md`
**Created:** 2026-08-07
**Companion:** `draft/DESIGN.md` (canonical architecture; this extends §26 Testing Strategy), `draft/ADAPTING-AN-AGENT.md` (the per-adapter workflow this spec enables)
**Historical basis:** the former root probe tree was the spike this pipeline graduated into

> **Ownership update (2026-08-08):** `draft/SURFACE-ADAPTATION-REFACTOR.md` supersedes this document wherever it assigns real-vendor captures, models, or reconciliation tooling to adapter packages. The evidence-to-ASM rule remains; its neutral owner is now `packages/surface`.

> ### Superseded in part by `docs/archive/IMPOSTER.md` (I4, 2026-08-08)
>
> **§1 (the one rule), §2 (the ASM), and §7 (reconciliation) remain useful rationale.** The active contract is implemented and documented by Surface and the adaptation workflow.
>
> Everything about _how_ the stand-in is built and driven has moved:
>
> | This document says                                         | Now                                                                                                                                |
> | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
> | §4 — each adapter owns `surface/emulator/bin.mjs`          | One executable, `ai`, driven by a persona per vendor (IMPOSTER §3). The per-adapter bins are deleted.                              |
> | §5 — scenarios live beside the bin                         | `packages/imposter/personas/<vendor>/scenarios/`                                                                                   |
> | §6.1–§6.2 — a state file and a control server per emulator | One UDS the plane owns; imposters dial in and hold it (IMPOSTER §5). No state file, no per-imposter server, no `prune()`, no poll. |
> | §8 — `packages/emulator` ships the engine                  | Deleted. The ASM runtime is `@vibecook/chopsticks-surface`; the engine is `@vibecook/chopsticks-imposter`.                         |
>
> §6.3 and §6.4 still describe the shape of the thing; only the spawned process changed.

---

## 0. Charter

> Fact-checking chopsticks today requires running real agent CLIs: slow, nondeterministic, token-burning, and incapable of eliciting most failure paths on demand. Make the **captured surface** of each vendor a first-class, versioned artifact, project it into a **scriptable emulator** of that vendor, and run the entire product — conformance suite, apps, manual QA — against emulators, with a nightly reconciliation lane that re-verifies the emulators against the real binaries.

---

## 1. The one rule that keeps this honest

**The emulator is a reconciled projection of captured truth, never the source of truth.**

```
real vendor artifact ──census/capture──▶ packages/surface/vendors/<vendor>/
                                                     │
                                      one truth, two sibling projections
                                      ├─ adapter: native → AgentEvent → Godview
                                      └─ Imposter: semantic op → native → Control
scheduled: detect candidate → acquire exact artifact → reconcile both projections;
           promote only by moving the support-ledger pointer
```

Corollaries (do not relitigate):

| Rule                                                                                   | Why                                                                                                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Truth flows real artifact → captures → model → projections, never the reverse          | A hand-written projection embodies _beliefs_; when the vendor drifts, every test passes confidently on a wrong model         |
| The nightly live-reconciliation lane is not optional                                   | It is the price of trusting the emulator everywhere else. Skip it and the edifice rots silently within a few vendor releases |
| Emulator and normalizer must never be derived from the same unverified source          | Otherwise they are wrong together in the same way and no test can see it. Both derive from — and diff against — captures     |
| The emulator is a _replacement_ binary for dev/test, never a sidecar to a live session | ADR-002 (one native session = one agent process) is unaffected                                                               |

---

## 2. Agent Surface Model (ASM) — the formal contract

The ASM is the canonical, machine-readable description of everything a vendor exposes that an adapter depends on. It lives in the neutral `@vibecook/chopsticks-surface` package, is **JSON canonical** (diffable, tool-consumable, no build step), and is **versioned per vendor version**.

### 2.1 Layout

```
packages/surface/vendors/<vendor>/
  upstream.json                    # release and source detectors
  findings.md                      # observations and provenance
  model/
    <vendor>@<version>/           # e.g. claude@2.1.207
      manifest.json               # asmVersion, vendor, vendorVersion, generated-at, tool versions
      detection.json              # binary names, --version shape, capability probes, min/max supported
      channels.json               # channel ids → transport, addressing, lifecycle (§2.3)
      behavior.json               # native partial-order graph; exact event names, not normalized state
      events/<Event>.json         # one file per native event/method/notification (§2.2)
  captures/
    <vendor>@<version>/           # sanitized, shape-faithful census fixtures (tracked)
      <Event>.jsonl
  captures-raw/
    <vendor>@<version>/           # verbatim census output (gitignored or private artifact store)
  audit.mjs                       # census → surface-report.json → diff against model/ (§7)

packages/imposter/personas/<vendor>/
  persona.json                    # model pointer, envelope, boot
  ops.json                        # semantic ops → native emissions
  behavior/*.json
  scenarios/*.json
```

`asmVersion` versions the _format_; the directory name versions the _vendor_. Multiple vendor versions may coexist side by side — `git diff` between two version directories **is** the vendor API changelog, mechanically derived.

Raw captures are evidence, but they routinely contain prompts, responses, tool arguments, account identifiers, and absolute workstation paths. They must not be committed. Surface owns the shared sanitizer mechanism, vendor extensions, and privacy checks; only shape-faithful sanitized evidence enters `captures/` and the model audit. Exact raw evidence stays gitignored locally or in an access-controlled artifact store long enough to reproduce the model.

### 2.2 Event file

```json
{
  "surface": "claude",
  "surfaceVersion": "2.1.207",
  "event": "UserPromptSubmit",
  "channel": "hook",
  "channels": ["hook"],
  "transport": "http",
  "trigger": "user submits a prompt in the TUI",
  "payloadSchema": {
    "type": "object",
    "required": ["session_id", "transcript_path", "cwd", "hook_event_name", "prompt", "prompt_id"],
    "properties": { "prompt": { "type": "string" }, "prompt_id": { "type": "string", "format": "uuid" } }
  },
  "confidence": "verified-headless",
  "timeoutSec": 5,
  "firstSeen": "2.1.207",
  "lastVerified": "2.1.207",
  "fixture": "captures/claude@2.1.207/UserPromptSubmit.jsonl",
  "notes": "prompt is verbatim — §17.2 exact-match confirmation"
}
```

- `channel` is the primary/default rail retained by ASM v1; `channels` is every
  native rail on which the same exact event is observable. A multi-rail event
  such as Grok `session/update` may declare both `acp` and `session-log`.
  Persona bindings and raw Control triggers must choose one of those declared
  rails; they may not silently route by event name alone.
- `payloadSchema` is a **recursive JSON-Schema subset** (object/required/properties, primitives, arrays/items, enums). Nested protocol discriminants such as `update.sessionUpdate` are validated, not merely the top-level carrier object. The engine ships a minimal validator; no new runtime dependency.
- `confidence` reuses the registry's existing ladder: `verified-headless` | `verified-interactive` | `unverified`.
- `lastVerified` makes staleness self-reporting: the nightly audit bumps it when the event is observed unchanged, or files a drift issue when it isn't observed / differs.

### 2.2.1 Native behavior graph

`behavior.json` connects exact entries from `events/` into an evidence-qualified partial order. It exists so Imposter and Emulator Control can reproduce and display what one pinned vendor surface actually exposes without borrowing an adapter's normalized lifecycle.

It is deliberately not a finite-state machine. Hooks and protocol notifications may be optional, concurrent, asynchronous, repeated, or re-entrant. Nodes name an exact event/method, confidence for that event-plus-selector claim, a display lane, and layout order; a scalar dotted-path `match` may distinguish repeated protocol methods by native payload facts (for example Codex `item/started` where `item.type` is `contextCompaction`). Relations name their kind and confidence independently. This prevents a captured generic `item/started` from making an unobserved `contextCompaction` branch look verified.

No node may be named `thinking`, `compacting`, `team-idle`, or another unified concept unless the vendor itself emits that exact native name. For example:

- Claude `PreCompact` records a pre-compaction interception point and `PostCompact` records completion; `PreCompact` alone does not prove an ongoing compaction.
- Claude `TeammateIdle` records the vendor's hook point; it is not a committed cross-vendor team status.
- Codex `item/started` / `item/completed` with `item.type = contextCompaction` are preserved as those exact payload-discriminated native observations.

Adapters may normalize those facts into a unified compaction or team model. Surface, Imposter, and Emulator Control may not.

### 2.3 Channels

A channel is one wire the adapter and vendor exchange semantics over. `channels.json` enumerates them; the emulator engine implements one simulator per channel _kind_, configured per vendor:

| Channel kind     | Vendor example                                           | Simulator in engine                                                        |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `argv-env`       | claude `--session-id`, `--settings`, `--permission-mode` | argv/env parser + acceptance behavior (incl. silently-tolerated unknowns)  |
| `hook-http`      | claude `type:"http"` hooks                               | loopback HTTP client POSTing to the adapter's real bridge                  |
| `hook-command`   | claude command hooks                                     | spawn the configured forwarder command                                     |
| `transcript`     | `~/.claude/projects/<slug>/<uuid>.jsonl`                 | JSONL writer emitting real record shapes, incl. partial-flush control      |
| `statusline`     | claude statusline command                                | invokes the configured command with the real stdin JSON                    |
| `jsonrpc-stdio`  | codex `app-server`                                       | JSON-RPC 2.0 endpoint: requests, responses, server requests, notifications |
| `jsonrpc-ws-uds` | codex `--remote` attach                                  | WebSocket-in-UDS listener                                                  |
| `acp`            | grok strict JSON-RPC 2.0                                 | request/notification channel with strict inbound and outbound versioning   |
| `native-log`     | grok `updates.jsonl`                                     | append-only store with incremental replay/tail                             |
| `native-state`   | grok `signals.json`, `summary.json`                      | replace-in-place JSON state files                                          |
| `leader-ipc`     | grok leader socket                                       | four-byte big-endian framed JSON relay with ACP payload strings            |
| `terminal`       | the TUI itself                                           | minimal stub: alt-screen, echo, bracketed-paste accept (§3)                |

Detection (`detection.json`) covers what the adapter's probe relies on: binary resolution, `--version` output shape, and capability flags. The emulator bin must answer the detection surface plausibly (§4).

---

## 3. Fidelity ladder

Three levels; each is validated against the one above.

| Level                        | What                                                                                                    | Status                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **L0 — scripted transports** | In-memory JSON-RPC, scripted ACP connector. Unit-test doubles                                           | **exists** (`adapter-codex` in-memory transport, `adapter-acp/scripted-connector.ts`) |
| **L1 — behavioral emulator** | A real subprocess speaking the vendor's real channels, driven by the behavior pack; scenario-scriptable | this spec                                                                             |
| **L2 — recorded replay**     | Real captured sessions replayed verbatim (hook timings, transcript bytes, notification sequences)       | this spec; scenarios of kind `replay`                                                 |

L1 exists only because chopsticks never parses terminal text (ADR-003/-004/-005): the entire semantic surface to reproduce faithfully is hooks, transcripts, statusline, and JSON-RPC — all file- or socket-based, all scriptable. The terminal channel is a stub by design. **Consequence (accepted):** in emulator mode an app's terminal pane shows the stub TUI, not the vendor's real interface; the implemented semantic paths (state, events, panes, usage) remain testable without terminal scraping.

---

## 4. Historical emulator-bin contract

This section records the retired P2 proof-of-concept contract. The live design uses the shared Imposter executable and Surface-owned real-vendor models; adapters no longer own emulator bins or model data. See `docs/archive/IMPOSTER.md` and `draft/SURFACE-ADAPTATION-REFACTOR.md`.

The retired design gave each adapter a `surface/emulator/bin.mjs` executable that the adapter spawned **in place of the vendor CLI**, resolved through the existing seams: `CHOPSTICKS_{CLAUDE,CODEX,GROK}_BIN` or `BuiltinProviderOptions.executables`. Script recipes used a resolved real Node binary so the same `.mjs` worked on POSIX and Windows without shell or `.cmd` quoting.

The bin MUST:

1. **Branch on argv the way the vendor does.** e.g. codex: `app-server` subcommand → JSON-RPC daemon; bare invocation → TUI stub that attaches via `--remote`. grok: `--leader` backend vs TUI.
2. **Implement the detection surface** from `detection.json` (`--version` shape, probed flags) so adapter detection behaves as against the real binary.
3. **Bring up every channel** declared in `channels.json`, using the engine's simulators, driven by `behavior/`.
4. **Read `~/.chopsticks/emulator-control.json`** (written by the control center, §6); if present and reachable, register and serve the control API; if absent, run standalone on default behavior (still fully usable in CI).
5. **Never require network or vendor credentials.**

The bin SHOULD treat unknown argv/env the way the real vendor does (claude silently tolerates unknown hook names; mirror that) — the ASM is where such quirks live, as data.

**Historical P2/P3 delivery note (Claude bin):** these five behaviors were implemented in the now-deleted per-adapter bin, including standalone mode, authenticated control registration, and the statusline channel. The behavior was subsequently absorbed into Imposter. This paragraph is retained as implementation history, not as a live path or ownership rule.

---

## 5. Behavior packs and scenarios

### 5.1 Behavior rules

Stimulus → response rules over ASM events, evaluated by the engine:

```json
{
  "on": { "channel": "terminal", "stimulus": "paste" },
  "then": [
    { "emit": { "channel": "hook", "event": "UserPromptSubmit", "with": { "prompt": "$stimulus.text" } } },
    { "replay": { "channel": "transcript", "fixture": "assistant-turn.jsonl", "intervalMs": 80 } },
    { "emit": { "channel": "hook", "event": "Stop", "afterMs": 400 } }
  ]
}
```

`$stimulus.*` binds captured input; `afterMs`/`intervalMs` give deterministic timing; payloads are validated against the ASM `payloadSchema` before emission (an emulator that emits off-model payloads fails its own tests).

### 5.2 Scenarios

Named timelines for fault and stress cases the behavior rules don't cover organically:

```json
{
  "name": "crash-mid-turn",
  "steps": [
    { "at": 0, "do": { "emit": { "channel": "hook", "event": "UserPromptSubmit", "with": { "prompt": "refactor" } } } },
    { "at": 300, "do": { "emit": { "channel": "hook", "event": "PreToolUse", "with": { "tool_name": "Bash" } } } },
    {
      "at": 600,
      "do": { "fault": { "kind": "crash", "exitCode": 137, "partialTranscriptLine": "{\"type\":\"assistant\"" } }
    }
  ]
}
```

Required starter set per adapter (extends DESIGN §26.1): happy turn, permission request → allow, permission → deny (absence-pattern for claude, structured request for codex), hook arriving after process exit, duplicate + out-of-order events, an **unknown event** (verifies ADR-008 retention end-to-end), flood, crash mid-turn, channel disconnect (hook bridge loss, app-server socket drop), token/usage refresh.

### 5.3 Curated runflows

`personas/<vendor>/runflows.json` selects the small set of scenarios that should be one-click entry points in the adaptation devkit. Entries add human intent, grouping, defaults, and safety metadata but always reference a scenario from §5.2; they do not copy its steps or prescribe normalized output. The loader derives step/event/channel/request facts and refuses drift such as a missing scenario. Shared intent ids such as `turn.basic` and `turn.tool.permission-allow` make native routes comparable without claiming that vendors share native behavior.

### 5.4 Replay scenarios

Kind `replay`: a real captured session (hooks + transcript + JSON-RPC logs) replayed verbatim with original timings or a speed factor. Regression tests against shapes that actually happened in production.

The first delivered slice is Claude hook replay. Godview can record the active
real Claude pane from the runtime-retained `nativeEvent` stream into a local
scenario JSON file. It removes only the transport-owned `session_id`,
`transcript_path`, `cwd`, and `hook_event_name` fields, so Imposter supplies its
own envelope on replay; event-specific prompt/tool correlation remains intact.
Long wall-clock captures are proportionally compressed to a bounded replay
timeline. Imposter Control imports the file as an inline scenario and runs it
through the same Surface validation and play/pause/step gate as authored
scenarios. These files can contain real prompts, tool inputs, outputs, and paths
and are deliberately saved outside the checked-in persona tree by default.

Transcript bytes, statusline samples, and the JSON-RPC/native-log families are
still required before this slice qualifies as complete cross-vendor L2 replay.

---

## 6. The control center (`apps/imposter-control`)

An Electron app on the same skeleton as `apps/workbench`/`apps/godview` — the interactive half of the emulator story: spawn any agent in emulator mode and trigger its events by hand while the product app reacts.

The generic control plane is a **pre-normalization native-surface console**. It exposes the versioned ASM, exact event controls, raw payloads, channel liveness, authored scenarios, runflow capabilities, and faults. The containing Agent Normalization Devkit composes a removable adapter/Core projection downstream of that plane; the projection cannot alter the native stream and is not a production state feed.

### 6.1 Plane and registration

- The plane owns one short UDS (`~/.chopsticks/imposter.sock`; a named pipe on Windows) plus a token file. Imposters dial it and hold a bidirectional JSON-RPC connection. If no plane is available, Imposter remains fully standalone.
- `session.hello` carries identity, channels, the versioned `nativeBehavior`, exact `nativeEvents` descriptors, persona op bindings, curated runflows, and a separately named `scenarioDriver` snapshot.
- `session.emitted` pushes each raw native event and payload; `session.channels`, `session.scenario-driver`, and `session.scenario-run` update non-overlapping liveness, intent, and automation views. Socket close is liveness.
- The plane serves a token-protected loopback console and SSE stream. There is no discovery state file, per-Imposter HTTP server, polling, or pruning.

### 6.2 Browser-facing control API

| Endpoint                                    | Effect                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/sessions`                         | native model/event metadata, channels, curated runflows, secondary scenario intent, and latest run metadata |
| `GET /api/events`                           | SSE for sessions, raw emissions, channel changes, `scenario-driver`, and `scenario-run` updates       |
| `GET /api/scenario-driver`                  | portable authoring graph; explicitly not a vendor lifecycle                                           |
| `GET .../log`                               | raw native emissions and payload backfill                                                             |
| `POST .../trigger`                          | emit one exact native event now; Surface-schema validated                                             |
| `POST .../op`                               | apply one portable authoring op and return `scenarioDriver`                                           |
| `POST .../scenario`, `.../scenario-control` | play/pause/step/resume an authored scenario                                                           |
| `POST .../fault`                            | crash, hang, flood, exit, or drop a native channel                                                    |

There is intentionally no generic-plane adapter state subscription and no `/session-state` endpoint. The Control spawner launches `ai` directly. The devkit's explicitly named projection routes are app composition, while adapter-against-Imposter tests remain separate because their purpose is complete runtime normalization.

### 6.3 UI panels

1. **Vendor-native behavior** — the session's versioned `behavior.json`, grouped by native lanes and painted only from raw emissions actually observed. Unverified nodes/relations stay visibly dashed.
2. **Automated runflows, native event surface, and payload log** — curated realistic sessions plus exact vendor names, schema-derived fields, confidence/channel metadata, payload-discriminated controls, and raw JSON backfill. Per-run reports are computed from actual sequence-bounded native and normalization records.
3. **Scenario driver and faults** — a collapsed advanced authoring/debug view. Its `starting/ready/thinking/tool/approval` phases are never labeled vendor state.

Godview owns recording because it already consumes the production runtime and
can identify a real pane without coupling the native Control plane to adapters.
Imposter Control owns import, validation, and replay. This keeps Control
pre-normalization while still closing the real-session hook record/replay loop.

### 6.4 Emulator mode in product apps

```
1. pnpm imposter-control              # Control starts and awaits Imposter connections
2a. click Spawn                       # Control launches Imposter directly; inspect native truth only
2b. or configure Godview's vendor executable as packages/imposter/bin/ai.mjs
3. Godview creates a session as usual
   → adapter spawns Imposter → Imposter joins Control → adapter normalizes the same native wire
4. Control emits a native permission hook, steps a scenario, or crashes the stand-in
5. Control shows exact native traffic; Godview independently shows the adapter's unified interpretation
```

Godview/workbench may grow a `--emulate` convenience flag that sets `executables` itself; the env seam already works today with zero app code.

---

## 7. Reconciliation — the nightly lane

`audit.mjs` per Surface vendor is the productized census (what the retired root probes did by hand):

1. Run the census against the installed vendor binary → `surface-report.json`.
2. Diff against `packages/surface/vendors/<vendor>/model/<vendor>@<version>/`: unobserved model entries, observed-but-unmodeled events, payload-shape changes.
3. Replay the standard scenario pack against **both** the real CLI and the emulator; diff channel outputs.
4. Any diff → candidate issue/report; a clean candidate still requires the promotion gates and ledger update.

Scheduling begins with `.github/workflows/upstream-agents.yml`, which polls every six hours, debounces stable candidates, and persists its compressed append-only release state in a tracking issue without modifying support. Detector reports retain same-version signal changes, rollback alerts, source-relation expectations, and pending per-platform acquisition work. Pinned-real acquisition/reconciliation remains an isolated R7 job; the hermetic Imposter lane remains a separate CI gate.

**Drift equation:** `drift = diff(real census, model) ∪ diff(emulator behavior, model)`. Both halves are mechanical; neither involves reading vendor changelogs (which lag or don't exist — Phase 0's lesson).

---

## 8. Limits and non-goals

- The emulator **cannot detect vendor drift by itself.** Only reconciliation against the real binary can. There is no version of this system where the nightly lane is deleted.
- The terminal channel is a stub (§3). Apps whose own features depend on terminal _pixels_ still need real-vendor manual QA.
- OAuth / account-usage flows are emulated at the HTTP layer (fake usage endpoint). The live `account-usage.live.test.ts` stays in the nightly lane forever.
- Not a goal: emulating vendors' _model quality_. Prompts to an emulator get scripted responses; nothing here evaluates agent intelligence.
- Not a goal: a shadow process beside a live session (ADR-002). The emulator replaces the vendor binary; it never accompanies it.

---

## 9. Package and ownership summary

| Piece                                                                  | Location                    | Public?                                                   |
| ---------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------- |
| ASM runtime, promoted models, sanitized captures, audit and provenance | `packages/surface`          | yes; package tarballs include models but exclude captures |
| Replacement-agent engine and persona behavior                          | `packages/imposter`         | yes                                                       |
| Native control and native → `AgentEvent` normalization                 | `packages/adapter-<vendor>` | yes; no model/capture publication                         |
| Conformance suite and synthetic fake agent                             | `packages/testing`          | yes; vendor-neutral                                       |
| Control center                                                         | `apps/imposter-control`     | private                                                   |

**Consumption constraint (learned in P1):** node type stripping does not remap `./x.js` → `./x.ts`, so `.mjs` Surface scripts cannot import modules that use the repo's `.js`-suffixed relative imports. The ASM runtime therefore remains self-contained in `packages/surface/src/model.ts`; the package enforces `erasableSyntaxOnly`. Scripts require Node ≥22.18.

`core` stays zero-I/O. Surface and Imposter are siblings: neither depends on an adapter, while adapters consume generated Surface projections at development/test time.

---

## 10. Phasing

| Phase  | Contents                                                                                                                                                                | Exit                                                                              | Status                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | ASM format + validator in `packages/emulator`; adapter-claude as reference: distill the initial captures into `surface/model/claude@2.1.207`, migrate captures, `audit.mjs` | `registry.ts` generated from the model; audit diff clean against 2.1.207 captures | **substantially delivered 2026-08-07** (hook model/captures/registry audit complete; capture-backed transcript and statusline schemas remain)                    |
| **P2** | Channel simulators + scenario runner + claude `bin.mjs` (hooks + transcript first — they feed the reducer); conformance suite gains emulator mode                       | `adapter-claude` conformance green hermetically in CI                             | **substantially delivered 2026-08-07** (engine + bin + full starter scenario set + `conformance.emulator.test.ts`; captured-session replay/diff remains P4 work) |
| **P3** | control center (now `apps/imposter-control`) + registration/control channel + godview emulator-mode flow                                                                | the §6.4 five-step flow works by hand                                             | **substantially delivered 2026-08-07** (named/inline play with speed and stimulus; pause/step and a recorded manual §6.4 run remain)                             |
| **P4** | Codex behavior pack (fake app-server promoted from the existing in-memory transport to a real subprocess) + the nightly reconciliation workflow; then grok/acp packs    | nightly lane files (or doesn't) its first drift issue                             |                                                                                                                                                                  |

P1 unblocks P2; P3 is independent of P4. Each phase is shippable and useful on its own.
