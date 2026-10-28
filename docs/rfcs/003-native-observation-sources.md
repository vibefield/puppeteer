# RFC 003: Adapter-Owned Native Observation Sources

- **Status:** Accepted and implemented
- **Created:** 2026-08-25
- **Owners:** Core and adapter maintainers
- **Supersedes:** The Spaghetti live-observer, SDK pin, and semantic-plane ownership portions of RFC 001 and the draft design
- **Related:** [`001-evidence-backed-runtime-observation.md`](./001-evidence-backed-runtime-observation.md), [`002-modular-agent-events-and-services.md`](./002-modular-agent-events-and-services.md), [`agent-api.html`](../agent-api.html)

## Decision

Puppeteer adapters own the small live observers required to normalize a provider's native evidence. The live runtime no longer depends on `@vibecook/spaghetti-sdk`.

The stable boundary remains the provider-neutral `AgentEvent` catalog. Each event category owns a strict Core Zod schema and its inferred TypeScript callback type. Adapter wire decoders use tolerant TypeScript guards because provider payloads are versioned external input: they extract only fields a category normalizer understands, then runtime ingress validates the resulting Core event once with Zod.

Public event names remain `category:event-name`.

```text
provider hook / OTLP log / transcript / journal / status
  -> adapter-local wire decoder
  -> one category normalizer
  -> AgentEvent (`category:event-name`)
  -> runtime validation, ordering, reducers, and subscribers
```

## Claude source ownership

| Category     | Primary live source                                   | Durable or degraded source                                |
| ------------ | ----------------------------------------------------- | --------------------------------------------------------- |
| conversation | `MessageDisplay` and `Stop` hooks                     | live assistant transcript changes; no conversation replay |
| interaction  | permission/question hooks; OTLP log `tool_decision`   | transcript is not lifecycle truth                         |
| tool         | tool hooks                                            | none required for lifecycle                               |
| model        | session hooks, status channels and OTLP request model | configured launch intent; no transcript model import      |
| effort       | hooks and status channel                              | configured launch intent                                  |
| mode         | hooks and status channel                              | configured launch intent                                  |
| usage        | authenticated OTLP log `api_request`                  | unavailable without OTLP; no transcript token import      |
| compaction   | native compact hooks                                  | none; transcript history is re-read after invalidation    |
| reasoning    | reasoning hooks and child status                      | provider-specific activity evidence                       |
| delegation   | subagent hooks and child status                       | no file-based workflow membership                         |

These categories do not require a general semantic database. Search, cross-session history, and analytics can remain a separate data product that indexes provider files without being in the live process dependency graph.

Claude's native TUI owns resumed conversation history. The adapter silently baselines existing assistant messages on every transcript attachment, including resume-picker rebinds. It does not publish historical prompts, replies or synthetic turn outcomes. Later assistant changes remain observable while that dependency is audited separately. Hooks never wait for the initial transcript read.

The transcript provider reads only the root transcript and emits only live assistant changes. Unknown transcript metadata is not converted into diagnostic events or replayed on attachment. Native hook diagnostics and observer failures remain observable through their own paths.

Transcript model projection and child transcript discovery, probes and reads were removed on 2026-09-12. `SessionStart` supplies the root model on launch/resume, root status supplies its current ID and display name, child status supplies visible task models, and OTLP supplies observed request models. Configured launch intent remains separate from observed models. Historical models are not imported; missing native evidence leaves the observed model unknown. Exact child attribution still requires matching native identity; OTLP keeps derived actor groups when exact IDs are absent. Model capabilities describe the available hook/status/OTLP sources, including unavailable or unverified OTLP.

No hook fires when a person answers a permission prompt: `PostToolUse` arrives when the approved tool ends, and a rejection fires nothing until a turn boundary. Claude's OTLP log [`tool_decision`](https://code.claude.com/docs/en/monitoring-usage#tool-decision-event) is logged at the decision and carries the hooks' `tool_use_id`, so it closes the pending request it names: `accept` as allowed, `reject` as denied, and a `user_abort` source as dismissed. Only its `tool_use_id`, `decision` and `source` are kept, never its `tool_parameters`. A decision that names no pending request (a rule's, or one exported after a fast tool's hooks) stays native evidence. Without OTLP the hooks settle every request as before.

Workflow journal observation was removed on 2026-09-11. The adapter does not discover or read workflow journals, reconstruct membership, or infer completion from idle time. The public workflow and team models were also removed on 2026-09-12. OTLP workflow IDs/names and name-only teammate hints remain native evidence; proven child identities contribute only unified child metrics and activity.

## Usage rules learned from the burn-rate probe

The shared live-only usage boundary and USD accounting path are specified in
[RFC 008](008-live-usage-cost.md). Rosetta's historical transcript accounting is
independent; it never feeds Puppeteer's live totals or rates.

Claude OTLP logs are the sole settled-request usage source. Metrics and traces duplicate the same token facts and are not ingested. `api_request` arrives at request completion; there is no sanctioned intra-response output-token stream. Transcript token extraction and mixed-source usage reconciliation were removed on 2026-09-11; [the cleanup tracker](../../draft/CLAUDE-TRANSCRIPT-DEPENDENCIES.md) records the remaining work.

For each request the adapter retains separate values:

- `totalTokens`: fresh input + output + cache read + cache creation;
- `meterTokens`: fresh input + output, used by the short operational burn meter;
- token buckets and `costUsd`: preserved independently for UI and analytics.

Every request is counted, including workflow/subagent requests. Actor attribution is added only when Claude emits an exact native agent id; derived actor lanes use `actorKey` and `actorRole` without pretending they are exact native identities.

OTLP is enabled only in the spawned process environment. The adapter does not mutate user configuration, does not use the console exporter, and does not overwrite an existing OTLP route. Known versions older than the locally proven Claude `2.1.245` do not provide settled request usage; unknown versions are safely probed. Disabled or conflicting exporters also leave settled request usage unavailable. The collector accepts logs on a loopback-only bearer-authenticated endpoint and drops all attributes outside an explicit operational allow-list, including email and account identifiers.

OTLP requests use `claude-request:<request_id>`. A bounded fingerprint cache suppresses duplicate telemetry and permits corrections from the same source. Transcript records cannot contribute token amounts, historical totals or actor corrections to this stream. Request totals cover completions observed since attachment; full historical accounting is a separate follow-up.

Child status `tokenCount` and `tokenSamples` describe context occupancy, not consumption; they do not enter usage or burn calculations. Child status supplies model, effort and activity only after exact identity joins. OTLP child request usage is counted once in the run total and attributed to child rows where the native ID is present.

## Package layout

```text
packages/adapter-claude/src/observation/
  otel/
    wire.ts             # OTLP JSON + PII allow-list
    actor.ts            # exact and derived actor attribution
    usage.ts            # usage:tokens-used
    model.ts            # model:updated
    capability.ts       # supported-version gate
  transcript/
    wire.ts             # tolerant transcript rows
    conversation.ts     # live conversation:assistant-message changes
    provider.ts         # polling service
    services/
      jsonl-reader.ts   # append-aware, reset-aware, bounded reader
  hook-bridge.ts        # authenticated loopback transport service
```

Independent native-source queues are isolated: a stalled or malformed source cannot block another observer. Readers retain bounded state and return snapshots rather than exposing mutable internal buffers.

## Consequences

- Core schemas and route names stay provider-neutral and exhaustive.
- Each adapter file answers one question: which native source is normalized for which upper-level category or service?
- Hooks remain lifecycle truth; transcript failure cannot end a live process.
- The dependency graph and runtime failure surface are smaller.
- Provider schema drift is now our responsibility, so each wire decoder requires fixtures, tolerant unknown-field behavior, version/capability reporting, and bounded input handling.

## Stable ingress (2026-09-12)

A host that outlives its own process — a resident daemon that restarts under a running agent — loses every native
source the moment it exits: the hook bridge was bound ephemerally with a token minted for the launch, and the launched
process keeps posting into a closed port. Until now the only recovery was resume-respawn, which is a new process and
a turn boundary the user did not choose. Three additions make the bridge a stable ingress instead:

- **The host may pin and must be able to learn the ingress.** `HostIngress` (core `host.ts`) rides every session
  request (`AgentTuiSessionOptions.ingress`, runtime `createSession`/`spawn`/`resume`): a host pins `port` and
  `token` or lets the adapter mint them, and `onBound` reports what was bound once the listener is up and before the
  process launches — the moment a host that persists `{port, token}` beside its session records has everything it
  needs. Adapters without a loopback ingress ignore the field; `onBound` never fires for them.
- **A provider may bind to a process that is already running.** `AgentProvider.attachSession` takes the native
  session id the process announced, the terminal it lives in, the cwd, the profile and the ingress, and answers an
  `AgentAdapterBinding` exactly as `createSession` would — without launching. The Claude adapter's
  `attachClaudeTuiSession` rebinds the bridge on the pinned port and token (a taken port fails before anything is
  adopted, so the host knows the ingress is lost and resumes instead), locks the allow-list to the session (following
  `/clear` as a spawned session does), locates the transcript by id under the config root and arms the durable rail
  at the first subscription — the existing records are the silent baseline, as on every attachment — and adopts the
  terminal. Observation reads `native-log` from the transcript until the next hook upgrades it. The runtime's
  `attach` wraps it: provider binding → workspace rebuilt at the recorded cwd → `restoreSession` at the next epoch;
  `ATTACH_UNSUPPORTED` names a provider without the path, `ATTACH_FAILED` a binding that could not be made or that
  names another terminal.
- **A host may leave without ending the runs.** `dispose({ detach: true })` releases every managed session — the
  adapter's observation, the monitors, the workspace lease — and marks nothing terminal: the durable creation claim
  stays allocated, no `process:exited` is dispatched or recorded, and the host that comes back re-attaches. A plain
  `dispose` still closes the runs for good; `handleProcessExit` is unchanged.

**Amended 2026-09-13 (PU-1b, after VibeField's AR-4 review).** _A release keeps what the process depends on._ The
detach path disposes each binding with `{ release: true }` (`AdapterDisposeOptions`, core `binding.ts`): the Claude
binding closes its bridge by DRAINING (in-flight posts complete, a bounded moment, then force) and leaves the staged
settings file and hook/status-line forwarders in place — the running process execs them on every hook, and a plain
dispose had been deleting them under it, which is what killed a TUI released within its first seconds and left the
hook rail dead after every re-attach. A released run's staged files are cleaned by the close that eventually ends it;
a run released and never re-attached leaves them behind in the temp dir (a few KB), which is the accepted cost.
_Identity is validated before anything is bound._ `attach` reads the durable claim (`CreationRequestRegistry.lookup`,
new) and refuses a run this runtime already manages, a missing or terminal claim, and a stale epoch — naming the
claim's current epoch — BEFORE `attachSession` takes the live process's port or a workspace is built; a bind that then
fails inside the restore no longer marks the live process's claim terminal (`RestoreAgentSessionOptions.attaching`),
and a workspace the attach merely resumed is never destroyed. _A rotation the host missed is followed._ A `/clear`
typed while no host listened rotates the id unheard; on attach the first authenticated hook under a new id — before
the pinned id has spoken — is taken as that rotation when the new id already has a transcript under the same root,
and the transcript is observed. Configured intent is not published for an attached process (it is a launch fact).

What stays with the host: choosing to pin, persisting what was bound (owner-only, like every other credential the
host keeps), knowing which terminals are still alive after it returns, and the resume fallback for providers with no
attach path. What stays out of this RFC: buffering hooks posted while no host is listening (a native relay would
carry that; it is a different process and a different lifetime), and any vendor's own reconnection story beyond
Claude's — Codex and Grok rebuild their app-server and leader sockets by id and are the next candidates.
