# C0 — Codex Surface Findings

> **Current projection (2026-10-24):** the candidate model is Codex CLI **0.164.0** (C8), captured from the release
> package with its `codex-code-mode-host` companion, while promoted support remains the grandfathered 0.147.0
> baseline. Only darwin-arm64 is acquired and probed. The paragraphs below describe the 0.150.0 candidate it
> replaces.

> **Previous projection (2026-08-27):** the candidate model is Codex CLI
> **0.150.0**, ASM v3/evidence v2, while promoted support remains the grandfathered
> 0.147.0 baseline. The generated model includes request parameters, responses,
> server-request results, and durable record carriers; fresh hermetic captures
> replay exactly. The exact local 0.150.0 binary now also passes the complete
> adapter composition: one private app-server, structured observation, prompt
> input through the real native TUI in a PTY, response rendering in that TUI,
> and native resume against the same durable thread. The deterministic loopback
> Responses endpoint needs no account credentials or external model access.
> Protected promotion runs that artifact-bound proof on all four platforms and
> requires its receipt, but those independent platform runs have not yet all
> completed. The sections below retain the earlier C0/C1 survey history where
> it explains design decisions.

> **Adapter and Imposter completion:** the Codex persona includes late,
> duplicate, and out-of-order scenarios driven through the real
> normalizer/reducer. Its durable Imposter history is replayed on
> `thread/resume`; the adapter runs shared history-continuity and
> observation-only no-orphan conformance directly against
> `ai --codex app-server`; and prompt confirmation requires the exact echoed
> `clientUserMessageId`. The exact native proof additionally verifies the
> production `resume <thread> --remote <endpoint>` TUI composition and resumed
> history. Protected multi-platform promotion remains a separate attestation
> requirement.

**Probed:** 2026-07-13, Codex CLI **0.144.2** (`codex-cli`), macOS (darwin), Node 24.14.1
**Method:** `codex --help` + subcommand help; `~/.codex` on-disk inspection; newest rollout record shapes; `codex app-server generate-json-schema --out` (structured protocol dump). Read-only — no live Codex session was spawned (interactive/live confirmations deferred, §6).
**Plan reference:** `IMPLEMENTATION-PLAN.md` §14 (M5). Companion to `HOOK-SURFACE-FINDINGS.md` (Claude Phase 0).

---

## 0. Headline

Codex is **not** a degraded, transcript-only agent. It has the **richest control surface of any agent we've surveyed**: a full JSON-RPC 2.0 **`app-server` protocol** (v2 schema, **516 definitions**) with structured turn control, streaming semantic events, and approvals as first-class request/response. The right puppeteer adapter for Codex is a **structured driver over the app-server**, not a PTY+transcript clone of the Claude adapter.

**Consequence:** M5 (second adapter) and M6 (structured/ACP driver) **collapse into one** for Codex, because Codex's _native_ surface already is a structured protocol. Building it delivers the structured-driver architecture that Gemini/ACP later slot into.

The one thing Codex _lacks_ that Claude has — a dictated `--session-id` — only bites the PTY path (Strategy A). Under the structured driver (Strategy B) identity comes back clean from `ThreadStartResponse`.

---

## 1. Verdicts

| Question                                                    | Verdict                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dictated session id at spawn (`--session-id` equivalent)    | **NO** — Codex mints its own UUIDv7, embedded in the rollout filename and `session_meta.payload.session_id`. The PTY-path join must be **discovered**, not dictated.                                                                                                                                                                                    |
| Structured control protocol exists                          | **YES** — `codex app-server` speaks JSON-RPC 2.0 over `stdio://` \| `unix://` \| `ws://IP:PORT` (`--listen`). `generate-ts` / `generate-json-schema` emit versioned bindings → puppeteer can **codegen a typed client**.                                                                                                                                |
| Clean session identity via protocol                         | **YES** — `ThreadStartResponse.thread` is the thread id; `TurnStartParams` requires `{ input, threadId }`. No discovered-join race under Strategy B.                                                                                                                                                                                                    |
| Structured (authoritative) streaming observation            | **YES** — `ServerNotification` union (188 defs): `ItemStarted/CompletedNotification`, `AgentMessageDeltaNotification`, `TurnStarted/CompletedNotification`, `CommandExecOutputDeltaNotification`, `ProcessExitedNotification`, `FileChangePatchUpdatedNotification`, `ReasoningTextDeltaNotification`, `ContextCompactedNotification`, …                |
| Structured prompt injection (no bracketed-paste guessing)   | **YES** — `TurnStartParams.input` + `clientUserMessageId` → deterministic confirmation when the same id is echoed on the user-message item. Also `ThreadInjectItemsParams`, `TurnSteerParams`. Missing echoes return `uncertain`; request acceptance alone is not proof of observation.                                                                 |
| Structured approvals (observe AND respond)                  | **YES** — approvals are JSON-RPC **ServerRequests** the client answers: `ExecCommandApprovalParams`, `ApplyPatchApprovalParams`, `FileChangeRequestApprovalParams`, `PermissionsRequestApprovalParams`, `CommandExecutionRequestApprovalParams`, `ToolRequestUserInputParams`. Real request-ids — strictly better than Claude's absence-pattern denial. |
| Native TUI + structured control on one session              | **CONFIRMED** — the exact 0.150.0 TUI renders and drives the controller-owned thread through `--remote`; normalized structured events, terminal response rendering, and durable resume agree. POSIX uses UDS; Windows selects an ephemeral `127.0.0.1` WebSocket, whose exact composition also passes locally when forced on macOS.                     |
| Structured resume / fork                                    | **YES** — `ThreadResumeParams` / `ThreadForkParams` (protocol); `codex resume [SESSION_ID] [PROMPT]` / `--last` / `codex fork` (CLI). Resume by UUID, same as Claude.                                                                                                                                                                                   |
| Command-hook / notify callback (Claude-command-hook analog) | **YES** — `notify = ["<program>", "turn-ended"]` in `config.toml`: Codex invokes a program on events. Also a first-class **hooks** system (`--dangerously-bypass-hook-trust`; `HookStarted/CompletedNotification`, `HookEventName` in the protocol) and **MCP** (`codex mcp-server`, `[mcp_servers]`).                                                  |
| Durable native record is independently readable             | **YES** — rollout JSONL lives under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; `session_meta.payload.session_id` is the join key. The adapter does not depend on Spaghetti: app-server notifications are authoritative live observation, while the rollout is durable history/provenance.                                                |

**Go/no-go on the structured driver: GO (recommended primary path).** The PTY+transcript path stays as a degraded fallback / native-TUI-only mode.

---

## 2. On-disk shape (durable native record)

```
~/.codex/sessions/2026/07/13/rollout-2026-07-13T10-06-31-019f5c71-…-fabf6.jsonl
```

Rollout record types (in order): `session_meta` → `event_msg` → `response_item`* …

`session_meta.payload` (the join + provenance):

```
session_id   019f5c71-d2ce-74c1-8041-771f7fcabfa6   (UUIDv7, == filename uuid)
cwd          /Users/.../infinite-canvas-engine
originator   codex-tui
cli_version  0.144.2
git          { commit_hash, branch, repository_url }
base_instructions { text }        # full system prompt inline
context_window { window_id }
```

`cwd` + `git.commit_hash` + `timestamp` are exactly the correlation keys a **discovered-join** would use under Strategy A. Under Strategy B we don't need them — `ThreadStart` hands us the thread id directly.

---

## 3. The two adapter strategies (the M5 fork)

### Strategy A — PTY + transcript + discovered join (Claude-parallel)

Spawn `codex` in a PTY; observe semantics via the rollout file (spaghetti reads it); discover the session id by watching for the new rollout after spawn (correlate `cwd`+`git`+time); inject via bracketed paste confirmed by the rollout's recorded user message.

- **Pro:** reuses the M1 PTY spine and the Claude adapter's exact shape; a genuine "maximally different agent, same adapter shape" abstraction test.
- **Con:** **deliberately throws away Codex's best surface.** Observation is poll-latency and lossy vs the structured stream; injection is back to `uncertain` receipts; permission prompts have no positive signal; discovered-join has a race if two sessions start in one cwd near-simultaneously.
- **Verdict:** keep only as the degraded fallback / native-TUI-only mode.

### Strategy B — app-server structured driver (RECOMMENDED)

Run one private `codex app-server`; `initialize` → `ThreadStart` → drive `TurnStart` / observe `ServerNotification` stream / answer approval `ServerRequests`. Attach the **native TUI** to the same server with `codex --remote <endpoint>`. The adapter selects `unix://<sock>` on POSIX and an ephemeral `ws://127.0.0.1:<port>` endpoint on Windows.

- **Pro:** authoritative low-latency observation; deterministic structured injection (`clientUserMessageId`); structured approvals with real request-ids; clean session identity; structured resume/fork; **and** the native terminal experience on the same session. Codegen'd typed client from `generate-ts`.
- **Pro (strategic):** delivers the DESIGN §M6 structured/ACP driver architecture _inside M5_. Gemini/ACP later reuse the `StructuredDriver` seam.
- **Con:** experimental protocol (versioned v1/v2, churns); needs the app-server lifecycle managed (spawn/daemon/pair/token); more moving parts than a PTY.
- **Verdict:** **primary path.**

---

## 4. What this does to the core abstraction

The core event union + reducer were shaped by Claude's **hook + transcript** model. Codex's **structured JSON-RPC** model is a second, structurally different driver behind the same intended `AgentSession` contract. Lifting the abstraction against _both_ is the real generalization test (n=2, the right time). Concretely:

- `ObservationLevel` gains a tier **above** `native-hooks`: `structured` (authoritative streaming + structured approvals).
- The event union likely gains item/turn granularity it didn't need for Claude (`item.started/completed`, reasoning deltas) — that's the union earning its keep, not Claude-shape leaking.
- The **injector** abstraction gains a `structured` implementation (TurnStart/InjectItems, deterministic confirmation) beside Claude's `guarded-paste` one.
- The **join** becomes pluggable: dictated (Claude) / structured-response (Codex-B) / discovered (Codex-A).

---

## 5. Key CLI / config surface (reference)

```
codex [PROMPT]                       interactive TUI (native)
  -C/--cd <DIR>                      working root
  -s/--sandbox read-only|workspace-write|danger-full-access
  -a/--ask-for-approval untrusted|on-request|never
  --dangerously-bypass-approvals-and-sandbox
  --add-dir <DIR>                    extra writable roots
  --no-alt-screen                    inline mode (scrollback preserved)
  -c key=value                       TOML config override (dotted paths)
  --remote <ws://|unix://> --remote-auth-token-env <ENV>   attach TUI to app-server
codex exec [PROMPT]                  non-interactive (DO NOT use for native hosting — analog of claude --print)
codex resume [SESSION_ID] [PROMPT] | --last | --all
codex fork | archive | delete | unarchive
codex app-server --listen stdio://|unix://[PATH]|ws://IP:PORT
  app-server generate-ts --out <DIR> | generate-json-schema --out <DIR>
codex remote-control start|stop|pair [--json]
codex mcp-server                     Codex as an MCP server (stdio)
config.toml: notify=[program, "turn-ended"], [mcp_servers], approvals_reviewer
```

Regenerate the protocol contract any time:

```
codex app-server generate-json-schema --out <dir>   # v1 + v2 JSON Schema
codex app-server generate-ts --out <dir>            # typed bindings for the client
```

---

## 6. Original live-probe questions (historical)

These were the questions opened by the initial read-only survey. Sections 7–8
resolve #1–4; the later hermetic census resolves #6. `notify` remains optional
because app-server is the authoritative observation path.

1. **Identity join:** confirm `ThreadStartResponse.thread` (or its id) **equals** the rollout `session_meta.session_id` → preserves the spaghetti join contract (puppeteer knows the id ⇒ spaghetti indexes the rollout under it).
2. **`initialize` handshake:** exact params/capabilities; auth for `remote-control` (`pair` code vs bearer env); whether `unix://` needs a pre-created socket path.
3. **Native TUI + control coexistence:** `codex --remote unix://<sock>` attaches to the app-server daemon _and_ renders the native TUI, with `TurnStart` driven from the protocol side — no double-drive / lease conflict.
4. **Notification stream capture:** one real `ThreadStart`→`TurnStart` turn → capture the `ServerNotification` sequence verbatim as fixtures (normalizer tests, conformance).
5. **`notify` contract:** exact event names + payload the `notify` program receives (the command-forwarder fallback shape).
6. **Sandbox/approval for write-capable runs:** `-s workspace-write -a on-request` behavior through the protocol (`ThreadStartParams.approvalPolicy`/`sandbox`).

Raw v1+v2 JSON Schema was dumped during this probe (regenerable via §5); not committed (471 KB v2, version-churning) — C1 codegens from a pinned regen instead.

---

## 7. C1 live spike — CONFIRMED (2026-07-13)

Drove `codex app-server` (stdio JSON-RPC) end-to-end against live Codex, read-only sandbox: `initialize` → `initialized` → `thread/start` → `turn/start("reply pong")` → `turn/completed`. **2.8 s, model replied `pong`, zero approval requests.** Capture + distilled shapes: `packages/surface/vendors/codex/captures/codex@0.144.2/c1-appserver-capture.jsonl`, `packages/surface/vendors/codex/captures/codex@0.144.2/c1-notification-shapes.json`.

**Verdicts (flips §6 deferrals #1, #4; partial #2):**

| Deferral                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 thread id ↔ rollout `session_id` ↔ spaghetti join | **CONFIRMED on disk.** `thread.sessionId` == `thread.id` == rollout `session_meta.session_id` (`019f5d86-…`). `thread/start` also returns `thread.path` = the rollout file path (handed to us, like Claude's `transcript_path` — no construction). **The puppeteer↔spaghetti join is a field on the ThreadStart response.**                                                                                               |
| #2 `initialize` handshake / auth                     | **Partial.** stdio app-server used James's `~/.codex/auth.json` directly — no extra auth. Handshake = `initialize`(requires `clientInfo{name,version}`) → server result carries `{userAgent, codexHome, platformFamily, platformOs}` → client MUST send the `initialized` notification before `thread/*`. `remote-control`/`pair`/bearer path still untested (only needed for the `--remote` TUI attach, C6).             |
| #4 notification stream fixtures                      | **CAPTURED.** Sequence for one turn: `thread/started` → `turn/started` → `item/started`(userMessage) → `item/completed`(userMessage) → `item/started`(agentMessage) → `item/agentMessage/delta` → `item/completed`(agentMessage) → `thread/tokenUsage/updated` → `turn/completed`. Plus ambient `remoteControl/status/changed`, `mcpServer/startupStatus/updated`, `thread/status/changed`, `account/rateLimits/updated`. |

**Payload → core `AgentEvent` mapping (C2 preview):**

| Codex notification                   | Shape (key fields)                                                                                                             | → core event                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn/started`                       | `{threadId, turn:{id, status:"inProgress", startedAt}}`                                                                        | `turn.started` (turnId = `turn.id`)                                                                                                                                        |
| `item/completed` type `userMessage`  | `{id, clientId, content:[{type:"text",text}]}`                                                                                 | user prompt echo — **`clientId` is the injection-confirmation channel** (set `TurnStartParams.clientUserMessageId`, match it here → deterministic, no `uncertain` receipt) |
| `item/agentMessage/delta`            | `{threadId, turnId, itemId, delta}`                                                                                            | streaming assistant text (structured — carries `itemId`, unlike Claude's `MessageDisplay`)                                                                                 |
| `item/completed` type `agentMessage` | `{id, text, phase:"final_answer", memoryCitation}`                                                                             | `assistant.message` (`phase` = `final_answer` \| commentary → the final/streaming discriminator)                                                                           |
| `turn/completed`                     | `{threadId, turn:{id, status:"completed", durationMs}}`                                                                        | `turn.completed`                                                                                                                                                           |
| `thread/tokenUsage/updated`          | `{tokenUsage:{total,last:{totalTokens,inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens}}, modelContextWindow}` | token accounting — **per-turn tokens the rollout file can't give; spaghetti's Codex source shows `—` tokens, the protocol has them**                                       |

**Protocol facts learned (corrections to §1/§5 assumptions):**

- Client method strings are `thread/start`, `turn/start` (also `turn/steer`, `turn/interrupt`, `thread/inject_items`, `thread/resume`, `thread/fork`). Full list dumped from `ClientRequest.json`.
- `ThreadStartParams.sandbox` is a **`SandboxMode` string** (`"read-only"`), **not** the `SandboxPolicy` object — sending the object errors `-32600 invalid value: map, expected map with a single key`.
- `ThreadStartParams.approvalPolicy` = `AskForApproval` string (`"never"` \| `"on-request"` \| `"untrusted"` \| `{granular:{…}}`).
- `TurnStartParams` = `{ threadId, input:[UserInput] }` where `UserInput` = `{type:"text", text}` (or image). Turn identity (`turn.id`) is returned on `turn/started`, distinct from `thread.id`.

**Status at the end of C1:** #3 native-TUI coexistence moved to C6; #5 `notify` was superseded by the protocol for observation; #6 write-mode approvals moved to the later hermetic census. Those are historical handoffs, not current adapter gaps.

**C1 verdict: GO — the structured driver is real, identity-clean, and spaghetti-joinable.** Proceed to C2 (normalizer over these captures).

---

## 8. C6a — native-TUI coexistence probe (`--remote` over WebSocket)

Resolves §6 deferral #3, live against codex 0.144.2. Versioned method probes are retained under `packages/surface/vendors/codex/probes/codex@0.144.2/`.

**The socket transport is WebSocket, not NDJSON — on BOTH unix and TCP.** `codex app-server --listen` accepts `stdio://` (NDJSON), `unix://<sock>`, and `ws://IP:PORT`. Every _socket_ transport (unix **and** TCP) frames JSON-RPC as **WebSocket**; only `stdio://` is NDJSON. Raw NDJSON/`Content-Length` to a socket gets silence (it's waiting for a WS upgrade). **WebSocket-over-UDS is verified** (`c6-ws-uds` probe: `HTTP/1.1 101 Switching Protocols` over the unix socket, then `initialize`/`thread/start`). **UDS is the preferred C6 transport** — no port allocation/collision, filesystem-permission scoped, not network-exposed. Gotchas: `--listen unix://` needs a **real path** (macOS `/tmp` is a symlink → the app-server's `lstat` rejects it with "not a directory"); the server logs "binds localhost only" and exposes `/readyz` + `/healthz`. **Localhost/UDS needs NO auth token** (the `--remote-auth-token-env` bearer is for remote/pairing access). Client note: Node's **built-in `WebSocket` is TCP-only**, so WS-over-UDS needs either the `ws` package (`ws+unix://`) or a ~70-line hand-rolled WS client (the probe proves it's small).

**Same JSON-RPC over WS.** `initialize → thread/start → notifications` behave exactly as stdio. `thread/list` → `{ data: [...] }`; `thread/read` → `{ thread: {...} }` (incl. the rollout path).

**The native TUI attaches and renders.** `codex --remote ws://127.0.0.1:PORT` under a real PTY (node-pty) renders the native Codex TUI (the `╭─ OpenAI Codex (v0.144.2) ─╮` banner, prompt, model/dir) — no auth, no errors.

**Coexistence CONFIRMED — the C6 model.** With a controller WS client AND the native TUI attached to the _same_ app-server: the user types a prompt in the TUI → a new thread is created (`preview` = the prompt) → the controller observes it (`thread/list` picks it up, `thread/read` returns it, and it receives `thread/started` + `thread/status/changed` notifications). The TUI renders the assistant reply. **Native terminal + structured observation on one server, one thread.**

**C6 observation flow — CONFIRMED.** Broadcast notifications give a controller only thread-level events (`thread/started`, `thread/status/changed`), NOT the turn/item stream for a thread it didn't _initiate_. Subscription is **implicit**: there is no `thread/subscribe`, only `thread/unsubscribe`. `thread/resume {threadId}` returns the thread's history AND **opens the live stream** — verified (`c6-subscribe` probe): after the controller resumed a TUI-created thread, a second prompt typed in the TUI delivered the full stream to the controller (`turn/started → item/started → item/completed → item/agentMessage/delta → thread/tokenUsage/updated → turn/completed`). So the Model-B flow is: observe `thread/started` → `thread/resume` (history + live subscribe) → normalizer. This is a distinct lifecycle from `createCodexSession` (which `thread/start`s its own thread) → the adapter needs a **`createCodexObserver`** entry (shipped C6-2, live-tested).

**Materialization caveat (found building the observer):** a thread has **no rollout until its first user message** — `thread/resume`/`thread/read` right after `thread/started` error with "no rollout found" / "not materialized yet; includeTurns unavailable before first user message". So the observer **retries `thread/resume`** after `thread/started` until the first turn materializes the thread (a moment later), then observes forward. `thread/started` **does** broadcast to other connections (verified), so discovery is fine; only the resume must wait for materialization.

**C6 verdict: GO, now implemented.** `adapter-codex` owns the private app-server process, endpoint selection, controller connection, real TUI launch, and shutdown ordering. POSIX keeps the filesystem-scoped WS-over-UDS path. Windows uses Codex's supported ephemeral loopback listener (`ws://127.0.0.1:0`), parses the bound address from the startup banner, and routes both controller and TUI through it. The resume-picker observation proxy mirrors either endpoint kind. §6 #3 is resolved without leaking a platform choice to consumers.

The 0.150.0 exact-artifact proof adds two lifecycle details absent from the early
C6 probe: disposal waits for the private app-server process to exit before a
same-thread resume, and the hermetic model provider recognizes Codex's optional
strict-schema thread-title request as auxiliary work rather than a second user
turn.

---

# C1b — Re-probe at 0.147.0 (2026-08-07)

**Probed:** 2026-08-07, `codex-cli` **0.147.0**, macOS 26.5.2 arm64. Live app-server sessions this
time (C0 was read-only). Design consequences live in `docs/archive/IMPOSTER.md §9`.

C0 already established the important architecture — `generate-json-schema`/`generate-ts`,
approvals as JSON-RPC ServerRequests with real request-ids, the structured-driver recommendation.
This section records only what is **new or corrected** three minor versions later.

## What changed since C0

|                    | C0 (0.144.2) | now (0.147.0)                        |
| ------------------ | ------------ | ------------------------------------ |
| v2 definitions     | 516          | 557                                  |
| ClientRequest      | —            | **95 stable / 133 `--experimental`** |
| ServerNotification | —            | **70 / 70 — all stable**             |
| ServerRequest      | —            | 10 / 11                              |
| schema files       | —            | 285 stable / 361 experimental        |

Measured churn 0.146.0 → 0.147.0 (9 days): **+6 methods, 0 removed**, matching the release notes.
Additive, despite ~2 alpha tags/day.

## New findings

1. **Generation is deterministic** — a pure function of `(version, --experimental)`. Repeated runs
   byte-identical; fresh `CODEX_HOME` and explicit `--enable` of feature flags change nothing. So
   `docs/archive/EMULATOR.md §2.1`'s `git diff`-as-changelog promise holds for codex.
2. **`--experimental` is NOT purely additive.** 25 of the 285 shared files differ in _content_ — it
   adds fields to stable methods. `CommandExecutionRequestApprovalParams` goes 13 → 15 properties,
   gaining `additionalPermissions` and **`availableDecisions`** (the vendor enumerating which
   decisions are legal, in the request itself). Commit both variants, or pick one and never mix.
3. **The schema is not the whole runtime surface.** `getAuthStatus`, `getConversationSummary`,
   `gitDiffToRemote` are accepted at runtime but absent from it (136 runtime vs 133 documented). An
   audit must not treat schema-absence as invalidity.
4. **`v1/`/`v2/` are Rust module names, not negotiated versions.** `v1/` holds only
   `InitializeParams`/`InitializeResponse`. `initialize` carries no protocol version at all.
5. **The wire is JSON-RPC 2.0-shaped but not conformant.** `jsonrpc` is omitted on server output
   (22/22 in the C1 capture) and tolerated on input (4/4 accepted). Generated `JSONRPCRequest`
   requires only `["id","method"]`. A strict JSON-RPC library will not work unmodified.
6. **The auth wall is exactly the model call.** `initialize`, `model/list`, `account/read`,
   `thread/start` and even `turn/start` all succeed with an empty `CODEX_HOME`; only the upstream
   `wss://api.openai.com/v1/responses` call 401s.
7. **A full turn runs offline** against a fake local model provider (`-c model_provider=fake`,
   `base_url=http://127.0.0.1:8899/v1`, `wire_api=responses`, junk key). Complete arc through
   `turn/completed`. **This makes the census hermetic and CI-able** — it resolves C0's §6 deferral
   without needing a live-credential lane.
8. **`codex exec --json` and `codex mcp-server` are worse capture surfaces** — different naming
   schemes (`thread.started` vs `thread/started`), fewer events, and no schema generator. Stay on
   app-server.

## Corrections to the adapter (all confirmed against the 0.147.0 schema)

C0's protocol reading was sound; the adapter built from it has since drifted.

- **Approval replies are malformed on every method.** `driver.ts:133-150` returns
  `{decision:'approved'|'denied'}` uniformly. `'approved'` is valid on 2 of 10; **`'denied'` on
  zero** (legacy deny is the object `{denied:{rejection}}`; current is `"decline"`); 6 of 10 have
  no `decision` field at all. `driver.ts:147` already carries an `UNVERIFIED` comment.
- **`localShellCall` (`normalizer.ts:180`) is not a real item type.** The 18 real ones are
  userMessage, hookPrompt, agentMessage, plan, reasoning, commandExecution, fileChange, mcpToolCall,
  dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep,
  imageGeneration, enteredReviewMode, exitedReviewMode, contextCompaction.
- **Two field reads can never resolve**: `normalizer.ts:194` reads `item.output` (real:
  `aggregatedOutput`); `:232` reads `item.result` (real: `results`).
- `clientUserMessageId` and `clientId` ARE real, so C0's deterministic-confirmation design is
  sound — but the round-trip was never exercised, and `driver.ts:239` returns `confirmed` on the
  `turn/start` promise alone without reading it.

## Privacy — the legacy C1 app-server capture

That capture is **committed raw to a public repo** (`origin/main` + 4 branches). It contains
`/Users/<user>/.codex`, hostname `<hostname>.local`, `installationId`, the prompt and
reply, and a `userAgent` carrying OS version and terminal emulator. No credentials. At the time,
`.gitignore` covered `packages/surface/vendors/*/captures-raw/` but not the root probe directory.

Worse, the claude sanitizer **passes it clean** while leaving all of the above intact, because
`idKey` misses `threadId`/`itemId`/`callId` and codex has no `sensitiveContainer` equivalent. Two
constraints follow, neither retrofittable: widen the id set BEFORE the first capture (pseudonyms
are `sha256(value)`, so widening later rewrites every id in every fixture), and rewrite timestamps
— **codex ids are UUIDv7 and encode wall-clock capture time**, so aliasing alone does not anonymise
them.

## Still unobserved (C0's §6 item #6, still open)

The **approval round-trip has never been captured** — schema- and README-confirmed only. It is
where every adapter defect above lives, so it is the first scenario the census must produce.

## C1c — Hermetic harness groundwork (2026-08-08)

Probing toward the census harness. Two blockers from the earlier pass are
resolved; one remains.

**SOLVED — a hermetic turn now completes end to end.** The earlier attempt failed
with `stream disconnected before completion: failed to parse ResponseCompleted:
missing field 'total_tokens'`. A fake `responses` provider must send
`usage: {input_tokens, output_tokens, total_tokens}` — `total_tokens` is
required. With it, a turn runs offline through the full arc: `turn/started` →
`item/started`/`item/completed` (userMessage, agentMessage) →
`thread/tokenUsage/updated` → `account/rateLimits/updated` → `turn/completed`.
No account, no network, no tokens spent.

**SOLVED — the tool inventory.** Codex declares tools to the provider nested in
`input[0].tools` as _namespaces_, not a top-level `tools` array:

| namespace       | tools                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `functions`     | `exec`, `wait`, `request_user_input`                                                           |
| `collaboration` | `followup_task`, `interrupt_agent`, `list_agents`, `send_message`, `spawn_agent`, `wait_agent` |

There is no `shell` tool in 0.147.0, which is why the earlier probe got
`unsupported call: shell`. `exec` is **`"type": "custom"`** — it takes a
`custom_tool_call` whose `input` is RAW JavaScript source, not a `function_call`
with JSON arguments. Nested tools reach the real capabilities:
`await tools.exec_command({cmd: [...]})`.

**UNSOLVED — eliciting a tool execution from a fake provider.** Four shapes
tried: `function_call` with JSON arguments; `custom_tool_call` with raw source;
each with and without a preceding `response.output_item.added`; and with the
item echoed into `response.completed.output`. In every case codex accepts the
stream and completes the turn cleanly, but emits only `userMessage` and
`agentMessage` items — the call is silently not executed, with no error.

RULED OUT (each tested against 0.147.0, all producing the same result — turn
completes cleanly, only `userMessage`/`agentMessage` items, no error):

1. Tool type — custom (`exec`) AND plain function (`request_user_input`).
2. Plan mode vs default mode.
3. Preceding `response.output_item.added`, present and absent.
4. The item echoed into `response.completed.output` vs an empty array.
5. `status: completed` on the item.
6. `--disable code_mode_host` — the declared tool list is unchanged, so
   `exec` is unconditional in this version.
7. Namespaced call names — `functions.request_user_input` and
   `functions_request_user_input`.
8. The `response.function_call_arguments.delta`/`.done` sequence the real
   streaming API emits for a function call.

The diagnostic that matters: **message items parse correctly** (the assistant
message from turn 2 always arrives) and codex proceeds to a SECOND provider
request after the tool call, so the stream is accepted rather than rejected. The
call is being silently discarded specifically in non-message item parsing.

**Consequence for the plan:** the hermetic lane can capture a full turn, token
usage and rate limits today, which is most of a behaviour census. Approvals and
tool items — the highest-value scenarios (docs/archive/IMPOSTER.md §9.7) — remain blocked on
the above. Recommended next move, and it is a BOOTSTRAP rather than a fallback: run ONE
credentialed turn that uses a tool, and record the provider's exact SSE bytes.
That yields the ground truth for the fake provider, after which the hermetic
lane replays those bytes forever at zero cost. Reading codex's own response
parser in openai/codex is the alternative, and is determinate rather than
guesswork — but the recorded bytes are useful regardless.

## C1d — The hermetic blocker, solved (2026-08-08)

**C1c was wrong about the layer.** It concluded the tool call was "silently
discarded specifically in non-message item parsing", and ruled out eight
hypotheses on that basis. All eight were probing the wrong thing: the item was
parsing correctly the whole time.

### How it was found

`strings` on the codex binary (210 MB, `@openai/codex-darwin-arm64`) shows the
parser logs `failed to parse ResponseItem from output_item.done` on a parse
failure — and that **`RUST_LOG` is honoured**. Running the existing probe with
`RUST_LOG=codex_core=debug` produced no parse error at all, and instead:

```
ERROR codex_core::tools::router: error=request_user_input is unavailable in Default mode
```

The call reached the **tool router**, which rejected it. The rejection goes to
the log and is never surfaced on the app-server protocol, which is why every
earlier probe saw a clean turn with no error. **A silent failure in the protocol
was a loud one in the log.**

The lesson generalises: probe a vendor with its own diagnostics turned on before
inferring behaviour from what its protocol does not say.

### The actual requirements for a tool call from a fake provider

1. `exec` is `"type": "custom"`, and its declared `format` is a **lark grammar**:
   the `input` is raw JavaScript source, evaluated in a fresh V8 isolate as an
   async module. Nested tools hang off a global `tools` object.
2. **Nested tool arguments are the trap.** `await tools.exec_command({cmd: [...]})`
   fails with `invalid type: sequence, expected a string at line 1 column 7` —
   `cmd` is a **string**, not an argv array. With
   `await tools.exec_command({cmd: "echo hi"})` the turn produces a real
   `commandExecution` item.
3. `namespace` on the item is **not** required (the hypothesis that came out of
   the `ResponseItem` field table was wrong; it parsed fine without it).
4. `request_user_input` is gated: _"unavailable in Default mode"_. There is a
   `tools.experimental_request_user_input` config key.

### The approval round-trip — CAPTURED (C0 §6 #6, open since 2026-07-13)

Trusted commands are auto-approved even under `approvalPolicy: "untrusted"`, so
`echo` never escalates. A **non-allowlisted** command does:
`sandbox: "read-only"` + `curl` produces
`item/commandExecution/requestApproval`.

```json
{
  "threadId": "…",
  "turnId": "…",
  "itemId": "exec-…",
  "startedAtMs": 1786207320888,
  "environmentId": "local",
  "command": "/bin/zsh -lc 'curl -s https://example.com'",
  "cwd": "…",
  "commandActions": [{ "type": "unknown", "command": "curl -s https://example.com" }],
  "proposedExecpolicyAmendment": ["curl", "-s", "https://example.com"],
  "availableDecisions": [
    "accept",
    { "acceptWithExecpolicyAmendment": { "execpolicy_amendment": ["curl", "-s", "https://example.com"] } },
    "cancel"
  ]
}
```

**The runtime sends `availableDecisions`; the stable schema does not declare it.**
An earlier draft of this section said it "ships on the stable surface, not just
under `--experimental` as C1b recorded" — that was wrong, and C1b was right.
Measured directly: stable declares 13 properties on
`CommandExecutionRequestApprovalParams`, `--experimental` declares 15 including
`availableDecisions`, and the wire carries it either way. This is C1b finding #3
again — the runtime surface is wider than the documented one — and it decides
which schema variant the ASM is generated from: **`--experimental`**, because a
model built from stable would omit a field the adapter must read.

The vendor enumerating its own legal decisions in the request is the useful
part: an adapter should read them rather than hard-code a table.

**`cancel` and `decline` are both accepted but are NOT synonyms:**

| reply                    | item status                                           | turn                                 |
| ------------------------ | ----------------------------------------------------- | ------------------------------------ |
| `{"decision":"accept"}`  | `failed`, `exitCode: 6` (sandbox blocked the network) | continues                            |
| `{"decision":"cancel"}`  | `declined`                                            | **ends** — no `agentMessage` follows |
| `{"decision":"decline"}` | `declined`                                            | continues to `agentMessage`          |

`decline` is absent from `availableDecisions` yet accepted, which is C1b finding
#3 again: **the enumerated surface is not the whole accepted surface**, in both
directions. For "deny this command but let the agent keep working" — the useful
default — `decline` is correct and `cancel` is wrong.

The completed item confirms two I3 corrections against real bytes:
`aggregatedOutput` (not `output`) and a real `exitCode`.

### Consequence

The census is now **fully hermetic**: turn, token usage, rate limits, tool
execution, and both approval outcomes, with no account and no tokens spent. The
credentialed bootstrap turn recommended at the end of C1c is **no longer
needed**.

### File-change field semantics require source evidence

The generated protocol schema proves that `FileUpdateChange` always contains
`path`, `kind`, and a string named `diff`; it cannot prove what that string
means for each discriminated kind. Exact `rust-v0.150.0` source does:

- `add`: `diff` is the complete new-file content;
- `delete`: `diff` is the complete deleted-file content;
- `update`: `diff` is a unified diff;
- `update` with `move_path`: the app-server appends
  `\n\nMoved to: <move_path>` after the unified diff;
- the emitted change array is sorted lexicographically by path.

Calling all four values a unified diff was an adapter error made possible by a
Layer 0 workflow that retained structural schema but not field semantics. The
generator now requires the digest-pinned exact-source contract at
`references/codex@0.150.0/source/file-changes.json` and projects its
kind-dependent schemas into `item/started`, `item/completed`, and
`item/fileChange/patchUpdated`. Source proves encoding, not runtime occurrence,
independent disk application, or changes made out of band by shell commands.

### A leak the automated check could not see

Sanitizing the first census output produced a clean report while
`startedAtMs: 1786207526734` sat in the committed fixture. Every value-level
rule in the sanitizer operates on **strings**; a wall-clock timestamp is a
**number**, so it walked past all of them — while the UUIDv7 ids beside it were
being aliased into synthetic v4s specifically to destroy the clock they encode.
The redaction and the leak were the same fact, handled in one place and missed
in the other.

`SanitizerRules` gained `timestampKey`, with both halves — the redactor pins
matching numeric values to `REDACTED_EPOCH_MS` (2026-01-01T00:00:00Z, not 0, so
fixtures stay shape-faithful), and the detector reports an unpinned clock.

Turning the detector on immediately failed the repo's capture gate with **20
real leaks in the legacy C1 app-server capture and
`c1-notification-shapes.json`** — the files C1b flagged as committed raw to a
public repo. Both are now sanitized and the gate is clean. That is twice this
capture has been found leaking by a rule written for something else, which is
the argument for the sanitizer's deliberately broad defaults.

---

# C7 — The typed invocation at 0.157.1 (2026-09-27)

**Probed:** 2026-09-27, `codex-cli` **0.157.1**, macOS arm64: 163 session-free parse probes and 23 hermetic
live sessions (isolated `CODEX_HOME`, loopback model, no account). Record and results:
`probes/codex@0.157.1/`. They classify every option and subcommand of `codex --help` and
`codex resume --help` for a managed launch (`packages/adapter-codex/src/launch/invocation-grammar.ts`), and
decide where each carried argument lands in the recipe `codex resume <thread> --remote <addr>`.

## What changed in the topology since C6

- **A typed `codex` now runs on a shared daemon.** `daemon_auto_start` is a stable, on-by-default feature: a
  bare `codex` installs a copy of itself under `$CODEX_HOME/packages/app-server-daemon/` and starts
  `codex app-server --listen unix:// --managed-daemon` detached, with its control socket at
  `$CODEX_HOME/app-server-control/app-server-control.sock`, and the TUI joins it. `--no-daemon` runs the server
  in the TUI's own process; `--no-daemon` cannot be combined with `--remote`.
- **A TUI on `--remote` does not start what it resumes.** On `resume <id> --remote` it sends `thread/resume`
  with `model`, `sandbox` and `approvalPolicy` null and `config` = its own overrides; the server does not apply
  that config to a thread it already holds (a typed `-c model_reasoning_effort=high` or `--search` given only to
  the TUI never reaches the model). In each `turn/start` the TUI repeats the thread's own approval policy, model
  and effort — it adopts the thread's settings.
- **What the TUI refuses on a remote resume:** `-s`/`-a` ("Permission overrides are not supported when resuming
  a remote task") and `--add-dir` ("not supported with --remote. Configure additional workspace roots on the
  server"). `thread/start.runtimeWorkspaceRoots` requires the `experimentalApi` capability.
- **A bare `--remote` TUI sends no `cwd`** in its `thread/start`: the server works in its own directory.
- **`--search` is `web_search = "live"`**: the TUI's own translation, in the `config` it sends.
- **The prompt and images.** `resume <id> <prompt> --remote` submits the prompt at once, images from `-i` with
  it; `-i` without a prompt is submitted as its own first turn — typed and managed alike.
- **`reasoning.summary`**: a thread on a separate server (the daemon, the managed recipe, a typed `--remote`)
  asks for `summary: auto`; an in-process `--no-daemon` session sends none.

## Consequences for the adapter

The managed recipe carries `-m`/`-s`/`-a` and `--dangerously-bypass-approvals-and-sandbox` as `thread/start`
parameters; `-c`/`--enable`/`--disable` on the private app-server's own command line (codex parses them there)
and the TUI's — except a sandbox or approval setting, which goes to the app-server's line alone; `--search` as
the server's `web_search=live` plus the TUI's flag; the prompt (after `--`), `-i` and `--no-alt-screen` on the
TUI's line. Each was compared with the typed command at the request that reaches the model, and the whole recipe
was run through the production path.

## The person's own permissions (2026-09-27, S24–S35)

The first version of this section (534ed2e) recorded, from reading the observer and without a probe, that every
managed thread started with an explicit `workspace-write` / `on-request`, so a `sandbox_mode` or
`approval_policy` in a person's `config.toml` held typed and not managed. Measured since, with two isolated
homes (A: `read-only` / `never`; B: `danger-full-access` / `on-request`), by digests of the exact permission and
filesystem text codex writes for the model:

- **It was a defect.** Home A typed (S24) is read-only / never; the managed thread with the explicit defaults
  (S26) is workspace-write / on-request, and even the TUI's own `turn/start` then says on-request: **a TUI that
  resumes a thread adopts the thread's approval policy over its own `config.toml`**.
- **`thread/start` without `sandbox` and `approvalPolicy` takes both from the app-server's own configuration**,
  byte for byte what a typed `codex` tells the model: S24 = S25, S27 = S28.
- **Now:** a typed launch leaves out of `thread/start` whichever of the two the person did not type
  (`permissionDefaults: 'configuration'`, decided in one place in `observation/observer.ts`); a host's own spawn,
  `createCodexTuiSession` and the imposter keep the explicit defaults. Verified through the production path:
  bare `codex` S33 = S24; `-a never` with `-c sandbox_mode="read-only"` S34 = S29; `-s workspace-write` with
  `-c approval_policy` and `-c sandbox_workspace_write.*` S35 = S31.
- **The TUI refuses permission overrides on a remote resume**, whatever their spelling: `-s`/`-a` (S7),
  `-c sandbox_mode` ("Permission overrides are not supported when resuming a remote task", S30) and
  `-c sandbox_workspace_write.writable_roots` ("not supported with --remote. Configure additional workspace roots
  on the server", S32). So they reach a managed thread only through the server that starts it.
- **`approval_policy = "untrusted"` is refused by 0.157.1's config loader** ("no longer supported; remove this
  setting"); `on-failure` still loads.
- **Not measured:** an untrusted working directory (every probe ran in a trusted one), a selected `profile`,
  permission profiles (`default_permissions`, `permissions`), `approvals_reviewer` and `sandbox_permissions`;
  a `-c` for any of these stays refused.

---

# C8 — Codex 0.164.0 (2026-10-24)

**Probed:** 2026-10-24, `codex-cli 0.164.0`, darwin-arm64, macOS. Artifact: the release package
`codex-package-aarch64-apple-darwin.tar.gz` from `https://github.com/openai/codex/releases/download/rust-v0.164.0/`
(sha256 `dd99e909…`, equal to the asset digest GitHub publishes; tag `rust-v0.164.0` = commit `6aaac694…`), extracted
into an empty directory: `bin/codex` `d8990e3e…` (byte-identical to what `pnpm surface:download` extracts) and
`bin/codex-code-mode-host` `416721e3…`. Harness: `census/harness.mjs --package-root <extracted package>`. Records:
`captures/codex@0.164.0/`, `probes/codex@0.164.0/` (README there), `references/codex@0.164.0/`. Every run was
isolated: throwaway HOME, CODEX_HOME and TMPDIR, an allowlisted environment, a loopback model, no account. Isolated is
not offline: every run that starts an app-server lets its curated-plugin sync make unauthenticated requests to
github.com and chatgpt.com (Known gaps).

## The exec tool needs the package's code-mode host

`exec` runs its JavaScript isolate in a separate executable, `codex-code-mode-host`, which the release package ships
beside `bin/codex`. With the standalone executable alone (0.150.0 behaves the same) every protocol request is still
answered, but each tool turn degrades to a plain assistant message: the router logs `failed to spawn code-mode host
<dir>/codex-code-mode-host`, and 0.164.0 also sends a `warning` notification ("Code Mode is unavailable because failed
to spawn code-mode host …"). Until this release the harness exited 0 on such a run and the sanitizer would have
promoted it.

Now every scenario declares what it must observe — item types, the exact server requests, notifications, requests
answered with a result — and any other router error or any `warning`/`error` notification fails it. A failed run writes
nothing to `captures-raw/codex@<v>/` (its output goes to `….failed/` for diagnosis) and exits 1. Run against the
standalone binary, `approval-accept` fails five ways at once (missing `commandExecution`, missing server request and
`serverRequest/resolved`, the warning, the router error). The harness also refuses a binary whose `--version` is not
the version being captured, records the executable's and the companion's digests in `census-run.json`, and kills the
app-server's whole process group before removing its home: at startup the app-server syncs its curated plugins over
the network into `CODEX_HOME/.tmp/plugins-clone-*`, and removing the home under that sync was the `ENOTEMPTY` the
critic's 0.150.0 live run hit.

Promotion's own lanes are not affected: `surface:audit:codex` (schema drift) passes with the standalone executable,
and the native-TUI live proof needs no tool (critic, re-run on 0.164.0).

## Census

Six scenarios, all passing their expectations: the four of C1d, whose method, result and item-type sequences are
identical to 0.150.0's but for one race; `file-change` (a nested `tools.apply_patch` that adds one file and updates
another); and `history-hydration` (the observer's controller-owned attach and its history read, then the paginated
replacement). 22 events are now `verified-headless` (15 before): `deprecationNotice`, `thread/inject_items`,
`thread/resume`, `thread/read`, `thread/turns/list`, `turn/diff/updated` and `thread/goal/cleared` joined.

- **One ordering race.** After a declined approval, `item/completed` (`commandExecution`, `declined`) and
  `thread/status/changed` (`active`, no flags) arrive in either order: the survey's 0.164.0 run and 0.150.0 put the
  status first; five runs here put the item first. The behavior graph already models status changes as asynchronous.
- **A declined command** completes as `{status: 'declined', exitCode: null}` (as on 0.150.0); the router logs it as
  `Rejected("rejected by user")`, the one router error the census expects.
- **`emittedAtMs`** is still on every captured server notification and still absent from the generated union.

## Protocol delta

From the generated `--experimental` schema of the exact binary (byte-identical to the survey's and the critic's
regenerations): 272 methods.

- **29 added:** client requests `account/bedrock/checkGovCloudRequirements`, `account/gatewayOAuth/{cancel,login,read}`,
  `feedback/save`, `memory/status`, `plugin/reconcile`, `rollout/compress`, `thread/attachment/{add,list,remove}`,
  `thread/attachmentOwner/list`, `thread/items/read`, `thread/prediction/request`, `thread/readState/update`,
  `thread/sample`, `thread/sample/cancel`, `turn/settings/update`, `userVerification/{cancel,delete,enroll,status,verify}`;
  server notifications `account/gatewayOAuth/changed`, `modelProvider/authRecovery{Started,Completed}`,
  `thread/attachment/updated`, `thread/prediction/updated`, `thread/readState/changed`. All unverified; the adapter
  sends none, and an unclaimed notification reaches consumers as `adapter:native-event`. The 0.164.0 TUI itself sends
  `account/bedrock/checkGovCloudRequirements`.
- **1 removed: `thread/rollback`** (rust-v0.156.0 #44915). 0.150.0 answered it with a `deprecationNotice`; 0.164.0
  rejects it as an unknown variant. Nothing in the repository calls it.
- **43 existing documents changed shape**, none by a newly required field on an existing path (critic flatdiff).
  Optional additions the adapter does not read: `Thread.{model, reasoningEffort, originator, environments[],
daybreakEnabled}`, `Turn.rootTurnId`, `TurnStartParams.{toolOutput, parentTurnId, rootTurnId, turnTrigger, …}`,
  `agentMessage.questions`, `MessagePhase` `partial_answer`, `TurnError.misalignment`, `CodexErrorInfo` as `anyOf` with
  new variants and a catch-all, `RateLimitSnapshot.normalModelSlug`, new `PlanType` values, a params object for
  `account/rateLimits/read` (omitted and `null` still accepted), and `ThreadResumeResponse.collaborationMode`. A new
  `ThreadItem` variant, `functionCallOutput`, has no normalizer case and stays a native event.
- **Result shapes removed outside the ASM.** `ModelProviderCapabilitiesReadResponse.namespaceTools` (was required) and
  `ConfigRequirements.windowsSandboxPrivateDesktop` are gone, and `ConfigRequirements` names
  `WindowsSandboxImplementation` (adds `mxc`) where it named `WindowsSandboxSetupMode`; the
  `windowsSandbox/setupStart` and `setupCompleted` payloads keep `WindowsSandboxSetupMode`. The ASM binds client-request
  results only for the methods the Imposter serves, so neither version models these two results, and the adapter reads
  neither. The vendor audit compares method names, so shape drift like this is visible only to reconciliation.

## Full-history hydration is deprecated; paginated history replaces it

Since rust-v0.158.0 (#47900, local threads default to paginated history), each full-history hydration also sends a
`deprecationNotice` with `details: null` and no `threadId`, ahead of the request's result:

- `thread/resume` without `excludeTurns`: "Full-history hydration is deprecated for paginated threads; use
  `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`."
- `thread/read` with `includeTurns: true`: "…; omit `includeTurns` or set it to `false`, then page with …".

The calls still answer in full. The census reproduces the observer exactly — `thread/start`, the empty
`thread/inject_items`, `thread/resume {threadId}` — so **every managed session's attach on 0.164.0 receives a
notice**, and so does every history read of an existing thread. `thread/resume {excludeTurns: true}` then
`thread/turns/list {itemsView: 'full', sortDirection: 'asc'}` sends none and pages the completed turn's
`[userMessage, agentMessage]` (`nextCursor: null`). The default `itemsView` is `summary`, which the schema calls
"only a display summary" (`TurnItemsView`; `full` is "every ThreadItem available from persisted app-server history").
In the survey's pagination probe (scratch, not committed) it answered `[userMessage, agentMessage]` for a turn whose
`full` items were `[userMessage, fileChange, agentMessage]`; a command or tool item under `summary` was not observed.
Only `full` is a faithful replacement. The 0.164.0 TUI already resumes with
`excludeTurns: true` and pages with `thread/turns/list` and `thread/items/list` (probe record). Each resume is followed
by `thread/goal/cleared`.

The experimental gate on `thread/turns/list`, `thread/items/list` and `thread/resume.excludeTurns` was removed in
rust-v0.151.0 (critic's bisection over the protocol source of 15 tags), so 0.150.x and the promoted 0.147.0 reject them
without `experimentalApi` (`-32600`); `thread/resume.initialTurnsPage` is still experimental. Precedent:
`thread/rollback` went from a deprecation notice to removal in about six releases; no removal of full hydration is
announced through 0.164.0.

The ASM now binds `thread/turns/list`'s result (`v2/ThreadTurnsListResponse.json`) and carries runtime evidence for it;
the behavior graph gains a history lane (attach, the two notices, the paginated replacement).

## Replayed history caps command output

rust-v0.162.0 (#50427) caps persisted command output at 64 KiB. Measured (`probes/codex@0.164.0`
`history-truncation-results.json`): a command printing 100 000 bytes completes live with all of them in
`aggregatedOutput`; read back through `thread/turns/list` (`full`) or `thread/read` (`includeTurns`) — even on the same
connection, the thread still loaded — the same item carries exactly 65 536 bytes: the first and last 32 743 bytes
around `\n... command output truncated for persistence ...\n`. #50458 likewise replaces an oversized MCP tool result in
paginated history with a 64 KiB text preview of its JSON, keeping `is_error` and clearing `structuredContent` and
`_meta` (release notes and pull request; not reproduced: the census has no MCP server). The schema type is unchanged, so
this is a change of meaning: an adapter that replays history (`replay: true` tool events) can report a truncated output
as complete.

## File-change semantics carried forward from exact source

`census/source-contract.mjs --from 0.150.0 --version 0.164.0` fetched both pinned files at both tags, re-checked the
0.150.0 pins byte for byte, and extracted the seven named items (with their attributes and doc comments) from each:
all byte-identical, so the contract is carried forward with new pins only — `item_builders.rs` `1b227632…` (15 495 B)
and `v2/item.rs` `7a1bcd40…` (65 490 B) at `rust-v0.164.0` (`sourceCommit` `6aaac694…`). The runtime agrees
(`file-change-results.json`): `add` carries the whole new file, `update` the unified hunk without file headers, in path
order; `item/started` already carries the changes; `turn/diff/updated` arrives three times; `item/fileChange/patchUpdated`
never does. The sanitized census redacts every `diff`, so it proves where the field occurs, not what it says.

## Transcript (rollout) drift

The adapter reads only rollout `event_msg/token_count` (`observation/rollout-context.ts`), whose payload, the path
scheme and `session_meta` are unchanged (survey). Otherwise: `event_msg/user_message` and `event_msg/agent_message` are
gone, replaced by `event_msg/item_completed`; `token_usage_record` (rust-v0.153.0 #41912),
`event_msg/thread_settings_applied` and `response_item/additional_tools` are new; records gain `ordinal` and messages
`metadata`; `turn_context` loses `current_date`, `personality`, `timezone` and `workspace_roots` (rust-v0.162.0 #51492)
and gains `disabled_plugin_ids` and `root_turn_id`. An external transcript reader keyed on `user_message` or
`agent_message` breaks. Surface does not model this channel (below).

## MCP enterprise-managed auth (`auth = "ema_auth"`)

Servers configured `auth = "ema_auth"` share one enterprise grant per CODEX_HOME (`McpServerAuth::EmaAuth`; the
`ema-idp:` credential namespace, keyed by the canonical CODEX_HOME). `codex mcp login <server>` refuses them ("Enterprise
MCP authorization is managed by Codex account sign-in"), and since rust-v0.161.0 (#49276) `codex mcp logout` on any one
removes the grant for every EMA server of the profile. A user server whose name merely starts with `ema-idp:` is escaped
to `local:ema-idp:…` and is not affected. `codex mcp list --json` does not expose `auth`. (Source read by the critic at
rust-v0.164.0.) Measured without an account (`probes/codex@0.164.0` Method 5): 0.164.0's `config/read` returns
`auth: "ema_auth"` in the merged `mcp_servers`, `mcp list` reports such a server `unsupported` until an enterprise IdP
profile registers it, and `mcp login` refuses it with the message above; 0.150.0 rejects `auth = "ema_auth"` as an
unknown variant. The grant's removal by a signed-in logout is not exercised (it needs an enterprise account).

## The typed invocation

Grammar (probe record): the root help differs from the 0.157.1 fixture by the `migrate-nfs-db` row alone ("[experimental]
Migrate configured SQLite databases to DELETE mode in place"; `-V`/`--version` exit 2); `resume --help` is byte for byte
the 0.157.1 file; `sandbox uninstall` is new; of the 0.157.1 parse and config cases, all answer the same but for version
strings and `write_stdin_approval` now being stable. The clap `Subcommand` source adds only `MigrateNfsDb` (critic), so no
hidden subcommand was missed.

Below the root, from the critic's nested help of 0.150.0 and 0.164.0 (36 paths; scratch, not committed), only
subcommand options moved: `app-server` gains `--startup-sign-out`, `--print-startup-config`, `--startup-client-info`,
`--cloud-skills-snapshot` and `daemon update`; `exec` and `exec resume` gain `--worktree` and
`--cyber-access-program`; `mcp login` gains `--no-browser`; `mcp add` gains `--oauth-client-secret`. `--listen` takes
the same values, and `--ws-auth` is reworded ("Authentication mode for incoming WebSocket connections",
`capability-token|signed-bearer-token`) with loopback still unauthenticated by default. Subcommands are passthrough
rows in the grammar, and the flags `transport/app-server-process.ts` and `launch/tui-session.ts` pass are unchanged.
The model now also sees `functions.request_user_input_async` and `namespace clock:{sleep}`, while `exec` stays the
custom JavaScript tool with nested `tools.exec_command({cmd})` and `tools.apply_patch(input)` (critic provider bodies),
so the census scenarios need no change. `features list` churned: `daemon_auto_start` is listed (stable and on since
0.157.1, so not new to the grammar pin), `code_mode_host` and `write_stdin_approval` are stable,
`apply_patch_streaming_events` is under development, and `transcript_v2`, `personality`, `remote_compaction_v2`,
`shell_zsh_fork` and `worktrees` are gone. `cli_auth_credentials_store = "file"`, which `services/profiles.ts` writes so
a managed profile's credentials stay out of the keychain, is still recognized: the critic's probe rejects a bogus value
on both versions.

Landing (S1–S35 re-run, made replayable): every permission-digest equality the recipe relies on holds. The workspace-write
filesystem block now adds a read-only `.aws` entry per workspace root; the permissions text is unchanged (the critic's
differing permissions digests came from the writable-roots sentence, whose root order depends on where the case root
lives). New: a session's task tools depend on who starts its thread. In-process typed sessions offer
`namespace:mcp__codex_worktrees` plus `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`; the
bare daemon session offers `namespace:mcp__codex_tui` and the same resource tools; a TUI that starts its own thread on a
remote server sends `dynamicTools: [namespace:codex_tui]`. Managed and recipe sessions — threads the controller starts —
get none of these (`codex-rs/tui/src/dynamic_tools_mcp.rs`: the TUI injects them into its own `thread/start`). On
0.157.1 the tool sets were equal. Every request now asks for `reasoning.summary: auto`.

## Transport

`app-server --listen unix://` on 0.164.0 creates sockets at paths longer than `SUN_LEN` (0.150.0 exits "path must be
shorter than SUN_LEN"), though a client still cannot connect to an absolute path over 104 bytes. With a short TMPDIR the
unix-transport native-TUI live proof passes on 0.164.0 (package and standalone) and on 0.150.0; websocket passes too
(survey and critic runs; `transport/app-server-process.ts` is unchanged).

## Privacy

- **`runtimeWorkspaceRoots` and `writableRoots` are path keys** in `codexRules`. Until now only value patterns rewrote
  them, so a census run with TMPDIR outside `/var/folders` and `/Users` committed the path (24 occurrences in the
  survey's scratch output).
- **The shared detector now flags absolute temp-root paths** (`/tmp/…`, `/private/tmp/…`, embedded or bare) and the
  redactor rewrites them, in `packages/surface/src/sanitize.ts` `defaultRules` — the codex model test checks with the
  default rules. Turning it on found a committed leak: `captures/codex@0.144.2/c1-appserver-capture.jsonl` line 6 carried
  a `runtimeWorkspaceRoots` under `/private/tmp/<uid>/` naming the operator's checkout. It is re-redacted (that one value;
  noted in its `capture-fidelity.json`). Across every tracked capture, probe and reference file of every vendor, the only
  other hit is a synthetic `/tmp/codex-extra` argument in the 0.157.1 parse record (erratum there).
- **codex's own detector patterns lost their `g` flag**: under `RegExp.test` a global pattern resumes at `lastIndex` and
  skipped every other matching value (a test now proves all are reported).
- **Signed release URLs.** `download.json` recorded the redirect target, a `release-assets.githubusercontent.com` URL
  carrying `sig=` and a `jwt=` bearer token, which assemble and evidence-update copy into tracked evidence. The downloader
  now records the reviewed pre-redirect URL; the 0.164.0 evidence names
  `https://github.com/openai/codex/releases/download/rust-v0.164.0/codex-package-aarch64-apple-darwin.tar.gz`.
  Acquisition (`scripts/acquire-agent-artifacts.mjs`) now refuses a source URL with a query, a fragment or
  credentials, and the evidence merge (`update-agent-evidence-artifacts.mjs`) re-checks rather than trusts a report
  written before that, so a `download.json` from the old downloader can no longer reach tracked evidence.
- **`file://` temp paths.** The temp-root rule's look-behind kept `https://host/tmp/x` out of scope and with it
  `file:///private/tmp/<uid>/<slug>/…`, whose slug alone was aliased and which then read clean. A local `file://` or
  `file://localhost/` URL's path is now treated as the path it is. No tracked capture of any vendor carried one.
- **Probe records are gated.** No sanitizer writes `probes/codex@<version>/`, and nothing read it: a home path and an
  `sk-` token planted in `live-results.json` passed every codex gate. `checkProbeRecords` (`census/sanitize.mjs`) now runs
  the detector over every JSON record, help capture and README there, from `surface:privacy:codex`, the audit and
  `model.test.ts`, with three pinned exceptions (live case labels under `id`, the `<root>/…` case-root placeholder, and
  the 0.157.1 synthetic `/tmp/codex-extra`); `whitelist-live.mjs` refuses to write a projection it flags.
- **No codex from `PATH`.** The audit's drift check, `generate-model.mjs`, the harness and every probe script used to
  fall back to `codex` on `PATH`, the operator's own (usually signed-in) install, and the 0.144.2 and 0.147.0 probes
  passed it the caller's whole environment. Each now runs only the executable it is named (`--bin`, `--package-root`
  or `PUPPETEER_CODEX_BIN`) in a throwaway HOME and CODEX_HOME with the allowlisted environment, whose `PATH` keeps no
  directory holding another codex. Without one the audit reports drift as skipped; with one that cannot generate its
  schema the audit fails instead of skipping.

## Adapter implications (the adapter stage)

- Migrate `observation/observer.ts` off full-history hydration: `thread/resume {excludeTurns: true}` plus paged
  `thread/turns/list {itemsView: 'full', sortDirection: 'asc'}`, falling back to the current calls on `-32600 … requires
experimentalApi` (0.150.x, 0.147.0). Keep the replay barrier and turn-id dedup; serve `thread/turns/list` and accept
  `excludeTurns` in the Imposter (`serve.json`); the ASM binds its result.
- Expect a `deprecationNotice` on every attach until then (it reaches consumers as `adapter:native-event`).
- Replayed tool outputs may be truncated (above).
- Pre-existing, made visible here: a declined `commandExecution` normalizes to `tool:completed`
  (`normalization/tool.ts`); `ErrorNotification` is `{error: {message}, …}`, not `{message}` (`normalization/notification.ts`).
- `services/extensions.ts`: do not offer `codex mcp login` for `ema_auth` servers; their sign-out reaches every EMA
  server of the profile.
- Grammar: the `migrate-nfs-db` row (utility), `CODEX_GRAMMAR_VERSION = '0.164.0'`, the help fixtures from
  `probes/codex@0.164.0/`.

## Adapter stage (2026-10-24)

- **History.** `observation/thread-history.ts` owns the read: `thread/resume {threadId, excludeTurns: true}`, then
  `thread/turns/list {itemsView: 'full', sortDirection: 'asc'}` paged by `nextCursor` (an empty page or a repeated
  cursor ends the walk). The deprecated full resume and `thread/read {includeTurns: true}` are used only after the
  server answers `-32600 … requires experimentalApi capability` or an unknown method (`-32600 … unknown variant`,
  `-32601`), once per connection. Any other page failure leaves only the oldest turns read: a page the server
  answered with an error gets one `thread/read {includeTurns: true}` (one native deprecation notice on 0.158.0 and
  later); a page it never answered (a timeout, a lost connection) gets no second request; and whatever is still
  missing is replayed as far as it was read and then reported as an `adapter:native-event` with the diagnostic
  `codex-history-incomplete`, rather than passed off as the whole history (fix review). The observer replays each completed turn once (`replay: true`), behind the same barrier and turn-id
  dedup; a thread it just created reads no history. `createCodexSession`'s resume reads only settings, so it sends
  `excludeTurns: true` too. Live: `native-tui.live.test.ts` now asserts that no native deprecation event reaches
  consumers and that the resumed answer is replayed history. It passes on 0.164.0 (package and the standalone
  artifact, unix and websocket) and on 0.150.0 through the fallback (websocket; unix on retry after the known
  plugins-clone cleanup race). With the previous observer the same proof fails on 0.164.0: a `deprecationNotice`
  reaches consumers. The S1–S35 landing re-run with the new observer (`live-cases.json`, 35 sessions, 294 s) projects
  to the committed `live-results.json` session for session — every permissions and filesystem digest equal — except
  that 7 sessions list the TUI's own concurrent startup requests in another order (same requests, same params).
- **Imposter.** `serve.json` serves `thread/turns/list` (empty, like its `thread/read`), on the pinned params and
  result schemas; `thread/resume {excludeTurns: true}` is validated by the same model. The persona still hands a
  resumed client its history by replaying the stored session on `thread/resume` (`restore`), so no Imposter topology
  resumes an observer onto paged turns; the paged replay is proven by the unit suite and the live proof.
- **Normalization.** A `declined` `commandExecution` is `tool:failed` ("command was declined"); `ErrorNotification`
  text comes from `error.message`.
- **Enterprise servers.** `services/extensions.ts` keeps, from `config/read`'s merged config, only the names of
  `auth = "ema_auth"` servers, per profile root from its last inventory. Their sign-in is `in-app` (the Codex
  account's own sign-in); their sign-out stays `codex mcp logout` with `reaches: ['sign-in']` — the shared grant of
  this profile's other enterprise servers, never `every-profile`.
- **Grammar** `0.164.0` (`migrate-nfs-db`, utility); help fixtures re-captured from the exact artifact (stdout,
  digests equal to the probe record). **Mapping lock:** 272 ground-truth events, 26 semantic, 27 observed (+
  `thread/turns/list`), 219 unmapped. **Monitor contract** `codex-app-server@0.164.0`.
- `docs/event-map.html` documents the paged history, the fallback, the declined command and `error.message`; its
  `puppeteer-last-verified` stays `0.147.0`, because `pnpm packages:check` pins it to the ledger's promoted version
  (follow-up below).

## Known gaps / follow-ups

- **Companion-file artifact identity.** The census needs `bin/codex-code-mode-host`, but `upstream.schema.json`
  (`additionalProperties: false`) has no companion concept, and download, acquire and assemble digest `bin/codex` alone.
  The companion digest is recorded in `evidence.json` (`artifacts[0].companions`, which an acquisition merge replaces), in
  `census-run.json` and in `probes/codex@0.164.0/artifact.json`. A reviewed cross-vendor schema change, or
  `app-server --code-mode-host <URL>` against a separately attested host, would close it.
- **Other platforms.** darwin-x64, linux-x64 and windows-x64 packages are not acquired or probed (code-mode host, Unix
  sockets, the Windows websocket banner). The candidate stays incomplete until the protected workflow does.
- **Result-shape drift.** The ASM keeps client-request results only for Imposter-served bindings, and the audit compares
  method names only, so result removals such as `namespaceTools` are invisible to both. Retaining every result would
  remove the guard that a served method needs a reviewed binding; it needs its own field or rule.
- **No rollout channel in Surface.** `channels.json` has argv, appserver and terminal; the census deletes CODEX_HOME, so
  no rollout is retained although the adapter reads `event_msg/token_count`. Needs a retained-home census option and
  sanitizer coverage for rollout records.
- **Managed sessions lack the TUI-owned task tools.** Recovering them conflicts with the controller-owned thread; record
  it as a product limitation or decide the architecture.
- **Truncated replay in Core.** Whether replayed tool outputs should be marked as possibly truncated (command output,
  MCP previews) is a Core question; #50458's MCP preview is not reproduced.
- **Cold resume.** History scenarios run on one connection; resuming from the rollout after an app-server restart is
  not in the census.
- **Network at app-server start.** The curated-plugin sync reaches the network even in the census (unauthenticated);
  disabling it would change the captured surface, so it stays and is documented.
- **Imposter history fidelity.** The codex persona replays a stored session as live notifications on
  `thread/resume`; real Codex returns no history there and pages it through `thread/turns/list`. Serving stored turns
  from `thread/turns/list` needs a shared Imposter op that builds `Turn`s from the native store.
- **Headless resume shows no history.** `createCodexSession({ resume })` (not the product path, which is the
  observer) never replays the resumed thread's turns; it did not before either.
- **Enterprise-server state is per service instance.** Which servers are `ema_auth` is known from the profile's last
  inventory in the same `ExtensionService`; a plan made before any inventory treats the server as any other (and
  `codex mcp login` then refuses it with its own message). Core's `McpServerItem` has no field for it.
- **Event-map `lastVerified` at promotion.** `packages:check` requires `docs/event-map.html`'s
  `puppeteer-last-verified` to equal `support/agents.json`'s `currentVersion`, and `surface:promote` does not rewrite
  it, so promoting 0.164.0 must bump the meta in the same change.
- **An enterprise server's sign-out cannot say what else it ends.** `codex mcp logout` on one `ema_auth` server ends
  the grant every `ema_auth` server of the profile uses (run_logout, rust-v0.161.0+), but the plan reports
  `reaches: ['sign-in']`, which Core defines as "a remote server's stored sign-in goes with it" — the act itself.
  `ExtensionReach` has no value for "the profile's other servers lose theirs", and an available plan has no message
  (`AvailableExtensionActPlanSchema` is strict), so a host cannot warn that the other enterprise servers are signed out
  too. It needs a Core reach value (or a plan message) reviewed across adapters.
- **Incomplete history is a diagnostic, not a state.** A history that cannot be read in full is replayed as far as it
  was read and then reported (`codex-history-incomplete`); Core has no field marking a session's replay as partial, so
  a projection's latest answer can still be an older one until live traffic supersedes it.
- **Signed URLs in old local bundles.** `download.json` files written by the earlier downloader still hold the signed
  redirect URL on the machine that acquired them (outside the repository). Acquisition now refuses them; regenerate
  those bundles with the current downloader before assembling.
- **Unverified branches:** `functionCallOutput`, `agentMessage.questions`, `partial_answer`, `TurnError.misalignment`,
  `modelProvider/authRecovery*`, `thread/readState/changed`, `thread/prediction/updated`, `item/fileChange/patchUpdated`.
