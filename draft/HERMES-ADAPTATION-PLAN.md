# Hermes Agent Adaptation Plan

| Field             | Value                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Status            | Stage 0–5 in progress: census, ASM, Imposter, adapter, runtime provider. Not a support claim.    |
| Target            | Official Hermes Agent native TUI (`hermes --tui`)                                                |
| Initial candidate | `0.20.0`, GitHub tag `v2026.8.3`, commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb` (2026-08-03) |
| Canonical process | [adapting-an-agent.md](../docs/guides/adapting-an-agent.md)                                                   |

This document specializes the repository's first-vendor adaptation process for
Hermes Agent. It is a plan, not a Surface model and not a promotion record.
Every preliminary fact below must be recaptured as claim-addressable Surface
evidence before it can support an adapter mapping or a support-ledger change.

The invariant is:

> Surface records native evidence. Adapters normalize it. Imposter simulates
> it. Conformance cross-checks both. Promotion alone declares support.

Hermes is absent from `support/agents.json`. The generic candidate workflow
cannot bootstrap a new vendor. The first change is an ordinary reviewed PR
that may later receive a `baseline-pending` ledger entry. `currentVersion`,
verification, and public support remain outputs of the protected promotion
transaction only.

## 1. Outcome and primary decision

Adapt Hermes Agent as a first-class native-TUI provider. Host the modern TUI
(`hermes --tui`) through `AgentHost` and observe/control it through the same
process tree's structured rails. Do not derive semantics from terminal text.

```text
AgentHost PTY ──► one `hermes --tui` process tree
                    ├─ Node Ink UI          (visible native terminal)
                    ├─ Python tui_gateway   (JSON-RPC; primary candidate rail)
                    ├─ plugin hooks / outbound webhooks
                    └─ ~/.hermes/state.db   (durable resume / replay only)
                              │
                              ▼
                        Hermes rail arbiter
                              │
                              ▼
                      Hermes category normalizers
                              │
                              ▼
                      AdapterEventCandidate
                              │
                              ▼
                    Runtime validation/event bus
```

The first adapter must not:

- launch `hermes acp` beside the TUI as a second `AIAgent` for the same
  session;
- launch `hermes -z`, `hermes chat -q`, or any other non-interactive process
  to “observe” a TUI session;
- treat the messaging gateway (`hermes gateway`) as the coding-agent rail;
- poll `state.db` as a live event stream;
- rewrite the user's global `~/.hermes` around a live install;
- claim structured control of the TUI until a same-session attach or
  in-process JSON-RPC seam is proven;
- claim verified support before protected promotion against the pinned
  candidate.

`hermes acp` remains useful in two later roles:

1. a hermetic survey/conformance oracle for overlapping `AIAgent` vocabulary;
2. the already-supported generic ACP execution mode for callers who do not
   need the native Hermes terminal.

It is not the control plane of a concurrent native-TUI process. Hermes ACP
`list/load/resume` is scoped to the ACP server process. Running ACP next to
`--tui` is two hosts over the same engine, not Grok's leader/viewer pair.

The classic prompt_toolkit CLI (`hermes --cli`) is a later surface. Pin the
first adapter to `hermes --tui`. Desktop and the web dashboard already embed
that TUI.

## 2. Gate 0 — prove the native control seam before adapter code

This gate precedes Surface modeling and adapter scaffolding. Public docs and
source are leads; the shipped checkout is the authority.

Official docs describe three programmatic protocols:

| Protocol    | Transport                        | Official consumer                  |
| ----------- | -------------------------------- | ---------------------------------- |
| ACP         | JSON-RPC over stdio              | editors (`hermes acp`)             |
| TUI gateway | JSON-RPC over stdio or WebSocket | `hermes --tui`, dashboard, Desktop |
| API server  | HTTP + SSE                       | OpenAI-compatible frontends        |

The TUI gateway (`tui_gateway/server.py`) is the protocol the native TUI
already speaks. Selected methods: `prompt.submit`, `prompt.background`,
`session.create` / `resume` / `interrupt` / `history` / `compress` / `branch`
/ `usage` / `status`, `approval.respond`, `clarify.respond`, `command.dispatch`,
`subagent.interrupt`. Selected events: `message.delta`, `message.complete`,
`tool.start` / `progress` / `complete`, `approval.request`, `gateway.ready`.

`HERMES_TUI_GATEWAY_URL` is documented as a **dashboard-internal** wiring
detail, not a public “point any TUI at any gateway” API. The dashboard does
spawn `hermes --tui` and inject that URL so the child attaches to the
dashboard's in-process gateway. That internal path is a survey lead, not a
product contract.

Stage 1 must answer these with process evidence:

1. What is the exact process tree of `hermes --tui` (parent, Node UI,
   `tui_gateway`, slash-worker)?
2. Who owns the JSON-RPC stdio pipe, and can an adapter sit on it without
   becoming a second controller?
3. Can Puppeteer spawn `tui_gateway` as a controller it owns and attach one
   TUI as a viewer of that same `AIAgent` / session id?
4. If attach works only over the dashboard WebSocket, is that seam stable
   enough to model, or is it an unofficial implementation detail?
5. Does a second attached client race the TUI for `approval.respond`?
6. Does `hermes acp` ever join a live `--tui` session? The expected answer is
   no.

Exit this gate with one of:

| Outcome                                                                              | Adapter consequence                                                                                       |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Same-session JSON-RPC attach or in-tree tap is proven                                | first adapter is structured over `tui_gateway`; observation level may reach `structured`                  |
| Only hooks/webhooks are launch-scoped and non-mutating                               | first adapter is native-TUI + hooks; observation level `native-hooks`; prompt receipts may be `uncertain` |
| Neither rail can be used without mutating the user's home or spawning a second agent | stop; do not ship a fake adapter                                                                          |

Do not write a convenient partial normalizer and present it as full coverage.

## 3. Repository constraints carried into this adapter

- one native session corresponds to one vendor process tree;
- the native TUI remains visible, interactive, and authoritative;
- `AgentHost` owns PTY creation and terminal automation;
- the adapter owns launch recipe, observers, correlation, and cleanup;
- Core remains provider-neutral and performs no I/O;
- every event is stamped once, in ingestion order, before fan-out;
- raw native records survive normalization, including unrecognized records;
- prompt receipts may be `uncertain`; they must never be upgraded from a
  terminal echo or elapsed time;
- semantic turn completion and process exit remain separate facts;
- observation level reflects the strongest rail actually active for that
  session, not the theoretical richness of the protocol;
- Surface, Imposter, adapter, and normalized event graphs remain distinct.

Closest implementation precedents:

- OpenCode / Codex for a structured controller plus a native viewer, **if**
  Gate 0 proves attach;
- Claude for launch-scoped hooks/webhooks, guarded paste, and honest
  `uncertain` receipts if attach fails;
- Grok for ACP composition **only** if a later census finds a shared leader
  that ACP and TUI both attach to (none is documented today);
- the first-vendor bootstrap in [`adapting-an-agent.md`](../docs/guides/adapting-an-agent.md), not the
  already-integrated candidate-refresh workflow.

## 4. Stable identities

| Purpose             | Name                                         |
| ------------------- | -------------------------------------------- |
| Provider/vendor key | `hermes`                                     |
| Display name        | Hermes Agent                                 |
| User-facing command | `hermes`                                     |
| TUI launch          | `hermes --tui`                               |
| Adapter package     | `@vibecook/puppeteer-adapter-hermes`        |
| Adapter directory   | `packages/adapter-hermes`                    |
| Surface directory   | `packages/surface/vendors/hermes`            |
| Imposter persona    | `packages/imposter/personas/hermes`          |
| Binary override     | `PUPPETEER_HERMES_BIN`                      |
| Isolated home       | `HERMES_HOME`                                |
| Live-test opt-in    | `HERMES_LIVE=1`                              |
| Imposter selector   | `ai --hermes` / `AI_PERSONA=hermes`          |
| Imposter shim       | `hermes`                                     |
| Execution mode      | `native-tui`                                 |
| Resume key          | native session id (`YYYYMMDD_HHMMSS_<6hex>`) |

Track separately: vendor artifact version (`0.20.0`), git tag (`v2026.8.3`),
source revision, ASM format version, and Puppeteer package version.

Account/quota reporting is out of scope unless a native, evidence-backed
account surface is found during survey. Nous Portal billing RPCs on the TUI
gateway (`billing.state`, `subscription.*`) are not a first-slice Core
contract.

## 5. Candidate pin and acquisition policy

### 5.1 Proposed first pin

| Concern         | Value                                                      |
| --------------- | ---------------------------------------------------------- |
| Product version | `0.20.0`                                                   |
| Release tag     | `v2026.8.3`                                                |
| Source revision | `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`                 |
| Upstream        | https://github.com/NousResearch/hermes-agent               |
| License         | MIT                                                        |
| Runtime         | Python `>=3.11,<3.14` plus Node ≥ 20 for the TUI           |
| Install shape   | git checkout + `uv` managed venv; not a single-file binary |

`main` moves quickly (thousands of commits between minor tags) and already
contains later session-continuity work described as v0.21 in public docs.
Pin the tag, not `main`. `hermes update` must be disabled or pointed at the
pinned checkout during census and pinned-real tests.

This pin is a research selection. The Surface census must re-read version
output, `pyproject.toml`, and the exact checkout digest after a disposable
install.

### 5.2 Why acquisition is a first-class problem

Existing `upstream.json` acquisition assumes HTTPS platform binaries
(`binary` / `tar.gz` / `zip`) with executable basenames per
`darwin-arm64`, `darwin-x64`, `linux-x64`, and `windows-x64`. Hermes
releases are git tags plus source archives. The installer clones the repo
and builds a venv. Desktop installers and Docker/Nix images exist but are
not the CLI the adapter will spawn.

Promotion as written requires exact reacquired bytes on every declared
platform. A source-only vendor cannot satisfy that matrix without a reviewed
policy exception.

Allowed paths, in preference order:

1. **Extend Surface acquisition** with a reviewed `source-revision` strategy:
   immutable GitHub archive or git-forge tarball, pinned commit SHA,
   `uv.lock` digest, and a hermetic `uv sync` recipe. Declare platforms as
   the environments that execute that recipe, not as four vendor binaries.
2. **Pin an official Desktop/CLI archive** if survey finds immutable,
   allowlisted, per-platform artifacts whose extracted `hermes` launcher is
   the same product as `hermes --tui`.
3. **Keep the vendor `baseline-pending` indefinitely** and document that
   protected promotion cannot run until (1) or (2) exists. Do not invent
   four fake platform binaries from one sdist.

Do not curl the install script as the acquisition strategy. The census may
use a local clone of the exact tag in a disposable home. Promotion must
reacquire the same bytes, not “whatever `hermes update` pulled.”

### 5.3 Preliminary `upstream.json` shape

Until acquisition policy is decided, the detector can still watch GitHub
releases:

- repository `https://github.com/NousResearch/hermes-agent`;
- stable detector: GitHub releases whose tag matches
  `^v(\d{4}\.\d{1,2}\.\d{1,2})$` or product version `0.20.0`;
- `sourceRelation.strategy: release-tag` with template
  `v${version}` **or** a source-revision file once that strategy exists;
- debounce at least two polls / 30 minutes — Hermes tags are infrequent,
  but `main` is not.

`pnpm upstream:check` will reject a half-specified acquisition block. Do
not merge a placeholder `upstream.json` that pretends four binaries exist.

## 6. Native rails and ownership

| Rail                    | Planned role                                     | Authority                               | Runtime status            |
| ----------------------- | ------------------------------------------------ | --------------------------------------- | ------------------------- |
| PTY / TUI               | Visible native UI and user control               | Control provenance only; never semantic | Required                  |
| TUI gateway JSON-RPC    | Session, prompt, stream, tools, approvals, usage | Authoritative if Gate 0 passes          | Preferred                 |
| Plugin hooks            | Session/tool/LLM/approval/subagent lifecycle     | Authoritative for fields present        | Fallback / enhancement    |
| Outbound webhooks       | Signed push of the plugin-hook event set         | Same as hooks; notify-only              | Fallback observer         |
| `state.db`              | Resume identity, durable history, lineage        | Replay / join only                      | Required for resume       |
| Agent / TUI logs        | Failure diagnosis                                | Native-log evidence only                | Optional                  |
| Process lifecycle       | PID, exit, crash, child reaping                  | Authoritative process facts             | Required                  |
| ACP stdio               | Separate structured host                         | Survey oracle / later mode              | Forbidden beside the TUI  |
| `hermes -z` / `chat -q` | Non-interactive one-shot                         | Survey only                             | Forbidden as TUI observer |
| Terminal text           | Human-visible UI                                 | Never semantic evidence                 | Never parsed              |

Truth-rail rule: one owner per portable fact. Duplicate native evidence is
retained for diagnostics and must not produce duplicate Core events.

If both JSON-RPC and hooks fire for the same tool call, JSON-RPC owns the
portable tool lifecycle. Hooks are a check rail. If only hooks are live,
hooks own the portable fact and JSON-RPC is `unsupported`.

`state.db` is WAL SQLite, schema 23 at the time of research. It is not an
append-only journal. Tailing it for live turns is forbidden. Resume may
read a snapshot, mark envelopes `replay: true`, then follow live rails.

## 7. Isolation, credentials, and privacy

Census and runtime sessions use a disposable `HERMES_HOME`, never the
developer's `~/.hermes`.

Launch-scoped isolation knobs already documented by Hermes:

| Knob                   | Use                                                          |
| ---------------------- | ------------------------------------------------------------ |
| `HERMES_HOME`          | Relocates config, `.env`, `state.db`, skills, logs, profiles |
| `--ignore-user-config` | Built-in defaults; `.env` still loads                        |
| `--ignore-rules`       | Skip AGENTS.md / SOUL.md / memory / preloaded skills         |
| `--safe-mode`          | Also disable plugins, shell hooks, and MCP                   |
| `--source tool`        | Hide third-party sessions from user session lists            |
| `hermes -p <profile>`  | Isolated profile home                                        |

Hook/webhook observation requires plugins or `hooks.outbound` in that
isolated home's `config.yaml`. That is allowed. Swapping the user's global
config and restoring it after spawn is not.

Provider traffic during census should hit a loopback fake OpenAI-compatible
endpoint configured only in the isolated home. No Nous Portal login, no
developer API keys, no network except loopback, unless a later live lane is
explicitly opted in with `HERMES_LIVE=1`.

Raw captures stay under the gitignored `captures-raw` tree. Tracked
captures must remove prompts, model output, account identifiers, home
paths, repository contents, bearer tokens, API keys, and raw authenticated
state. Sanitization must preserve types, identifier formats, and
cross-record correlation.

Launch environments may carry provider tokens. Never log or persist them.

## 8. Session, prompt, and disposal algorithms to prove

Session ids observed in docs: `YYYYMMDD_HHMMSS_` plus a 6-char hex suffix
for CLI/TUI. Resume flags: `--resume` / `-r`, `--continue` / `-c`, keyword
`latest`, `--in <dir>`. Compression creates lineage via `parent_session_id`
and numbered titles (`"my project #2"`). CLI and TUI share `state.db`.

These algorithms are hypotheses until Gate 0 and the census rewrite them.

### 8.1 Fresh session (structured attach, if proven)

1. Create a mode-`0700` disposable `HERMES_HOME` (or a reviewed overlay that
   does not mutate the user home).
2. Resolve `PUPPETEER_HERMES_BIN` then `hermes`.
3. Start the owned `tui_gateway` / attach seam and wait for `gateway.ready`.
4. `session.create` in the requested cwd; record the native session id.
5. Ask `AgentHost` for one `hermes --tui --resume <id>` (or the proven
   attach argv/env) bound to that id.
6. Emit derived `session.ready` only after the session is verified and the
   TUI recipe has been handed to the host. Do not invent a native readiness
   event if none exists.

### 8.2 Fresh session (hooks-only fallback)

1. Isolate `HERMES_HOME` and install a launch-scoped no-op/forwarding hook
   or outbound webhook to a loopback collector.
2. Spawn exactly one `hermes --tui` through `AgentHost`.
3. Treat the native id as provisional until `on_session_start` or the first
   `state.db` row for this process binds it.
4. Multiple matching new sessions are `uncertain`; do not pick by mtime.

### 8.3 Prompt submission

Structured path, if `prompt.submit` is on the same session:

1. Mint a caller-owned prompt/correlation id if the native method accepts
   one; otherwise record the submit request id.
2. Call `prompt.submit` (not terminal paste).
3. Confirm only when the native user-message / turn echo carries that id.
4. `uncertain` on timeout or disconnect after acceptance.
5. `rejected` for native validation errors before acceptance.

Hooks-only path:

1. Guarded PTY paste through `AgentHost`.
2. Confirm only an exact native user-message record attributable to that
   submission (`pre_llm_call` / durable row).
3. Terminal echo, elapsed time, or a later assistant message are not
   confirmation.

Never unify the two paths by pretending paste is deterministic.

### 8.4 Resume

1. Require an explicit native session id. Do not use `--continue` as the
   runtime resume API; it is a “latest” lookup and is workspace-scoped.
2. Launch/attach with `--resume <id>` (and `--in <dir>` when the session is
   workspace-bound).
3. Require the first identity-bearing record to match the requested id.
4. Replay durable `state.db` history as `replay: true`, then apply live
   events without duplicating across the boundary.
5. A compression-lineage child is a new native id. Resume the id the caller
   asked for; do not silently retarget `#2`.

### 8.5 Interrupt and disposal

- Structured interrupt is `session.interrupt` if that method is on the
  live rail. A successful RPC write is not proof the turn stopped.
- Hooks-only interrupt is the host's native terminal interrupt. Same rule.
- `dispose()` tears down adapter-owned gateway clients, hook collectors,
  webhook listeners, and temporary `HERMES_HOME` overlays. It does not
  kill a host-owned PTY or synthesize semantic completion.
- Reap the documented child set: Node TUI, Python gateway, slash-worker
  subprocess. A leftover slash-worker is an orphan.

## 9. Approvals and control ownership

Documented approval surfaces:

| Surface                   | Options                                                | Default policy                          |
| ------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Classic CLI / TUI overlay | once / session / always / deny                         | `approvals.mode: smart` (auxiliary LLM) |
| TUI gateway               | `approval.request` / `approval.respond`                | same engine                             |
| ACP                       | `allow_once` / `allow_session` / `allow_always` / deny | host-dependent                          |

`--yolo` / `HERMES_YOLO_MODE` bypasses prompts except the hardline
blocklist. Smart mode can auto-allow or auto-deny without a human.

First adapter default: **native TUI owns the decision**. The adapter
observes and normalizes. A future `onApproval` host-controller option may
answer `approval.respond` only after:

- Gate 0 proves a single-controller lease;
- presentation switches to `host-ui`;
- the TUI is not also answering the same request.

Do not race the overlay.

## 10. Surface census

### 10.1 Offline / identity census

Per pinned checkout:

- tag, commit, `pyproject.toml` version, `uv.lock` digest;
- `hermes --version`, `--help`, rejected option, exit codes;
- `hermes --tui --help` / equivalent, `hermes acp --version` / `--check`;
- executable resolution (`hermes`, `hermes-acp`, package scripts);
- isolated-home layout (`state.db`, `config.yaml`, `.env`, `logs/`);
- TUI Node requirement and `ui-tui` bundle location;
- proof that `hermes update` can be prevented from moving the pin.

### 10.2 Process-topology census (Gate 0)

Capture argv, env, pid tree, sockets, and stdio owners for:

- `hermes --tui` cold start;
- `hermes --tui --resume <id>`;
- dashboard-spawned TUI with `HERMES_TUI_GATEWAY_URL` if that path is
  reachable hermetically;
- `hermes acp` in a separate process, to prove it does not join.

### 10.3 Runtime census

Use isolated `HERMES_HOME` and a loopback fake provider. Required scenarios:

| Area           | Cases                                                                   |
| -------------- | ----------------------------------------------------------------------- |
| Startup        | isolated home, missing credentials, invalid config, TUI fallback to CLI |
| Turn           | no-tool reply, streamed deltas, empty/failed provider response          |
| Prompt control | JSON-RPC submit if available; guarded paste; busy interrupt/queue/steer |
| Tools          | success, nonzero, repeated same name, parallel calls, late complete     |
| Permission     | allow once, session, always, deny, smart auto-allow/deny, timeout       |
| Interrupt      | during model work, tool work, approval, idle, immediately after submit  |
| Session        | new id, explicit resume, latest-in-dir, compression lineage             |
| Ordering       | duplicate, reorder, disconnect/reconnect, late after exit               |
| Context        | usage snapshot, `/compress` / `session.compress`, auto-compress         |
| Work graph     | `delegate_task`, `/background`, subagent interrupt                      |
| Hooks          | plugin hook payloads and outbound webhook bodies for the same turns     |
| Shutdown       | clean `/quit`, crash, host kill, observer-first failure                 |

Do not spawn a shadow one-shot to generate “the same” events as the TUI.

### 10.4 Evidence handling

For every scenario retain:

- raw private capture with origin, command, exact checkout, platform,
  timestamp, and scenario inputs;
- sanitized tracked capture;
- sanitization audit result;
- a finding that describes observed facts without proposing normalization;
- claim-to-evidence references precise enough to identify the record and
  field.

The sanitizer must be deterministic, fail closed on unknown secret-shaped
fields, preserve referential identity, and have positive and negative tests.

## 11. Candidate normalization map

This table is a hypothesis backlog. No row becomes adapter behavior until
the Surface model cites evidence for its carrier, identity, ordering, and
variants.

| Native evidence candidate            | Core event / disposition                    | Rule                                                        |
| ------------------------------------ | ------------------------------------------- | ----------------------------------------------------------- |
| First bound native session id        | `session.started`                           | Bind once; reject conflicting ids                           |
| Proven prompt-ready state            | `session.ready` or derived runtime ready    | Never infer from the TUI status line text                   |
| `prompt.submit` accepted + user echo | `turn.started`; may confirm receipt         | Prefer native prompt/request id                             |
| `message.delta` / `message.complete` | `assistant.message`                         | Accumulate by stable message id; preserve finality          |
| Public reasoning stream              | reasoning events                            | Presence or public summary only                             |
| `tool.start`                         | `tool.started`                              | Native tool-call id; FIFO per name if ids collide           |
| `tool.complete` success              | `tool.completed`                            | Correlate by native id                                      |
| `tool.complete` error                | `tool.failed`                               | Preserve native error; late unmatched variants stay visible |
| `approval.request`                   | `permission.requested`                      | Presentation remains `native-tui` unless a lease exists     |
| `approval.respond` / hook decision   | `permission.resolved`                       | Never infer outcome from later tool success                 |
| `session.interrupt` settled          | `turn.cancelled` / failed per native reason | RPC write ≠ stopped                                         |
| `session.usage`                      | `context-window.updated`                    | Keep cumulative and per-turn distinct                       |
| `session.compress` / lineage child   | `context-window.invalidated`                | Never infer from a token-bar drop                           |
| `subagent.*` / `delegate_task`       | subagent events                             | Keep parent, child, and tool ids independent                |
| `/background` task                   | task events                                 | Separate session id (`bg_…` in docs) is not the parent turn |
| Process spawn/exit                   | process events                              | Separate from session/turn completion                       |
| Unmapped native record               | `adapter.native-event`                      | Retain raw payload and native type                          |

Observation level:

- `structured` only while the TUI-gateway rail is connected and producing
  valid events for that session;
- `native-hooks` when only hooks/webhooks are live;
- `native-log` if only durable `state.db` replay is available (resume
  hydration), then upgrade when a live rail connects;
- never `structured` merely because `hermes acp` exists on PATH.

Core's current event union is sufficient for the first slice. Do not add
portable events for skills, personalities, pets, messaging platforms, or
Nous billing.

## 12. Surface and model layout

Create:

```text
packages/surface/vendors/hermes/
  upstream.json
  findings.md
  privacy.mjs
  privacy.test.mjs
  sanitize-captures.mjs
  audit.mjs
  census/
    harness.mjs
    generate-model.mjs
  probes/
    hermes@0.20.0/
  captures-raw/          # gitignored
  captures/
    hermes@0.20.0/
  model/
    hermes@0.20.0/
      manifest.json
      evidence.json
      detection.json
      channels.json
      behavior.json
      events/
```

Expected channel kinds, pending census:

- detection / argv / version;
- TUI-gateway JSON-RPC (if Gate 0 passes), including request/result
  direction;
- plugin-hook stdin/callback payloads;
- outbound-webhook HTTP bodies;
- `state.db` snapshot / export (replay carrier, not a live stream);
- process lifecycle;
- ACP survey-oracle frames, stored separately and never mixed into TUI
  evidence.

Slash-delimited JSON-RPC methods should mirror the slash path under
`events/`, as Codex does.

Add `surface:audit:hermes` to `packages/surface/package.json`. The audit
must load the model, require every captured method to have a document,
validate payloads/results/carriers, refuse stronger confidence than
evidence, and keep privacy fail-closed.

## 13. Imposter plan

Create an exact Hermes native persona. It points at Surface and does not
copy the model.

```text
packages/imposter/personas/hermes/
  persona.json
  ops.json
  serve.json            # only if the TUI-gateway is a served protocol
  behavior/
  scenarios/
  runflows.json
```

If Gate 0 proves a served JSON-RPC (stdio and/or loopback WebSocket), add
that transport deliberately. Current Imposter socket serving is `unix`.
Silently falling back to stdio would make the adapter wait for a socket
that never appears. A new `DELIVERY_KIND` / channel implementation is an
implementation task, not a reason to relabel Hermes events as Codex
methods.

`nativeStore` should emulate `state.db` only to the extent resume/replay
requires: session id, source tag, message list, parent lineage. Do not
reimplement FTS5.

Minimum scenarios:

- happy turn;
- tool success and failure;
- permission allow and deny;
- usage refresh;
- resume of a completed session;
- compression lineage if observed;
- duplicate / out-of-order correlation;
- late event after exit;
- unknown-event (intentionally off-model);
- flood, crash-mid-turn, channel-disconnect;
- subagent / background task if observed.

Runflows stay metadata over those scenarios. Shared `intent` values should
match other personas (`turn.basic`, permission allow/deny, resume, unknown).

## 14. Adapter package plan

```text
packages/adapter-hermes/
  package.json
  tsconfig.json
  tsconfig.build.json
  src/
    index.ts
    detection.ts
    driver.ts
    generated/          # detection/launch facts from Surface
    launch/
    normalization/      # one Core event category per file
    services/           # event source and prompt capability
    transport/          # JSON-RPC framing and stdio
    test-support/
    conformance.test.ts
    hermes.live.test.ts
```

Use only the directories the proven rails need. Surface is a development
dependency. Production code consumes generated projections, not model
files.

Detection facts (executable names, version parsing, `--tui` / `--resume`
flags, `HERMES_HOME`, `PUPPETEER_HERMES_BIN`) are generated from
`detection.json`.

Prompt receipts stay honest. Observation level is computed from the rails
that actually connected.

## 15. Runtime, apps, and automation

After adapter-against-Imposter conformance is green:

- register `hermes` behind `AgentProvider` in `packages/runtime` (never
  branch inside `runtime.ts`);
- add Godview selector, shim, and spawn-through entries only
  after the native launch topology works end to end;
- add Imposter Control `SpawnablePersona` and, if a pure normalizer exists,
  a `createNormalizer` case; otherwise leave the projection `unsupported`;
- add `support/agents.json` as `baseline-pending` with the stable `groundTruth` path and `candidateVersion`;
- run `pnpm support:write` rather than hand-editing README badges;
- add workflow vendor choices only after the first-vendor seam exists.

## 16. Implementation slices

### A. Bootstrap and acquisition

- [x] Read the adaptation guide and existing vendor plans.
- [x] Select a research pin (`0.20.0` / `v2026.8.3` / `3c27eb6`).
- [x] Install that exact checkout into a disposable `HERMES_HOME`.
- [x] Decide source-revision (one GitHub tag archive; platforms are
      execution environments). Promotion remains blocked on a reviewed
      source-execution recipe.
- [x] Add a reviewed `upstream.json` that `pnpm upstream:check` accepts
      without inventing platform binaries.

### B. Gate 0 and survey

- [x] Capture the `hermes --tui` process tree and JSON-RPC owner.
- [x] Prove same-session attach via Puppeteer-owned `handle_ws` +
      `HERMES_TUI_GATEWAY_URL` (TUI does not spawn a second gateway).
- [x] Prove ACP is a separate process/host and does not join the TUI tree.
- [x] Build an isolated-home identity census harness (loopback fake
      provider still required for turn captures).
- [x] Capture identity probes (`--version`, `--help`, rejected option,
      `acp --check`).
- [x] Capture basic turn, tool, approval, interrupt, resume.
- [x] Capture hook and outbound-webhook payloads for those turns.
- [x] Pair sanitizer, privacy tests, and sanitized identity/Gate 0 probes.
- [x] Write `findings.md` with go/no-go per rail.

### C. Model

- [x] Generate ASM v2 from captures plus exact-source facts whose
      relation to the tag is recorded.
- [x] Model request/result direction, carriers, variants, and partial order.
- [x] Leave unobserved branches `unverified`.
- [x] Add `audit.mjs`, `surface:audit:hermes`, and evidence digests.

### D. Imposter

- [x] Persona pointing at the candidate ASM.
- [x] Serve/channel implementation only for rails the ASM declares.
- [x] Required scenarios and runflows.
- [x] Exact capture replay.
- [x] Native Imposter Control spawn (interactive `ai --hermes`; serve is `tui-gateway`).

### E. Adapter and normalization

- [x] Public adapter package and generated detection projection.
- [x] Driver for the Gate 0 winner (JSON-RPC and/or hooks).
- [x] Stateful normalizer with bounded buffers and ADR-008 retention.
- [x] Honest prompt receipts and observation level.
- [x] Focused unit tests from synthetic builders; Surface fixtures only
      in projection tests.
- [x] Devkit projection through `HermesGatewayNormalizer`.

### F. Conform, integrate, promote

- [x] Shared `AgentAdapterBinding` conformance.
- [x] Real adapter-against-Imposter lane.
- [x] Runtime `AgentProvider` entry (no `runtime.ts` branching).
- [ ] Godview selector and Imposter Control projection.
- [ ] `support/agents.json` candidate (`baseline-pending` only).
- [ ] Opt-in `HERMES_LIVE` / pinned-real lane on the declared platform
      matrix.
- [ ] Protected promotion only; no ordinary PR edits `currentVersion`.

## 17. Stop conditions

Pause implementation rather than guess if any of these occurs:

- the installed checkout does not match `v2026.8.3` / `3c27eb6`;
- `hermes update` or a lazy dependency install mutates the pin mid-census;
- session discovery is ambiguous in a controlled single-process run;
- the only way to observe the TUI is a second `AIAgent`;
- hook/webhook injection requires mutating the user's live `~/.hermes`;
- JSON-RPC attach exists but two clients race the same approval;
- a native fact has no faithful Core representation and is product-relevant
  for more than one vendor (propose a Core change separately);
- sanitization cannot prove removal of prompts, model output, credentials,
  paths, or host-specific data;
- acquisition policy cannot name immutable bytes for promotion.

## 18. Suggested first-vendor PR shape

When implementation starts, use the PR template in
[`adapting-an-agent.md`](../docs/guides/adapting-an-agent.md) §15. The first PR that only lands Surface + findings

- an honest Gate 0 result is acceptable. Adapter source should not land
  until the winning rail is evidenced.

Promotion status for that PR remains: not promoted.
