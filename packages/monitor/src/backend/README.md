# The monitor backend (MV-1a)

`createMonitorBackend({ runs, host, identity, clock?, scheduler?, sink, ... })` computes every business fact about
this desktop's agents once, beside the runtime, and emits the contract's `MonitorModelSnapshot` / `MonitorModelChange`
(`@vibecook/puppeteer-view-sdk/model`, types only — L3). Node-safe, no DOM, no React, no `node:` import either: the
same code runs in fieldd and in puppeteer Godview's Electron main. Peers' rows are NOT assembled here: each agent is
computed at its home desktop (MV-D22) and the sync plane carries them (L8); the replica merges by id.

## Ports (TypeScript in `ports.ts`)

| Port | Shape | Who implements |
|---|---|---|
| `runs` | `AgentMonitorSource` (store.ts): `listStates()` · `onState` · `onNotification` · `onRemoved({runtimeRunId, runtimeEpoch\|null})`, subscribe-before-list | `runtimeRunSource(runtime)` over the runtime's push bus; the runtime gains `monitorStates()` (the all-runs snapshot it lacked) and passes the run's epoch to `onMonitorRemoved` (both additive) |
| `host` | `{ getFacts(): MonitorHostFacts; subscribe(cb) }` — `device` (this desktop, `self: true`), `runs[]` (per-run host facts), `terminals[]` (bare PTYs), `profileSets \| null` (null = still reading), `spawnPeers?` (other desktops, passed through) | fieldd's fold + roster + profile feed; Godview main's session records + workspace + profiles |
| `identity` | `ProjectIdentityStore`: `seq(key)`, `deal(key)` — sync; never reuses a sequence | fieldd's state store; Godview's project registry (L4); `createMemoryProjectIdentityStore()` for tests |
| `clock` | `{ now(), schedule(ms, fn) → cancel }` | default `Date.now` + `setTimeout`; tests pass a manual clock |
| `scheduler` | `(fn) → cancel`: one emission per tick | default one macrotask (`setTimeout 0`); the host may pass a frame |
| `sink` | `select(resolved)` · `create(resolved)` | fieldd's doors; the Ghosttea workspace |

`MonitorHostRun`: `runtimeRunId` · `createdAt` · `provider {id,label}` · `terminalSessionId?` · `replacedTerminalSessionId?`
(AR-4) · `terminalIdentity?` · `projectKey?` (the canonical root the host folds to) · `workspace? {root, sourcePath,
branch}` · `cwd?` · `profileId?` · `profileSet?` · `account?` · `tier?` · `pending?` · `alive?` · `nativeSessionId?`.
`MonitorHostTerminal`: `sessionId` · `identity?` · `createdAt` (0 = unknown, VibeField's floor rows) · `cwd?` · `title?` ·
`activity? {kind}` · `profileSet?` · `workloadClass?` · `exited?`.

## Every `MonitorAgentRow` field, per host

| Field | Agent row (source → rule) | Terminal row |
|---|---|---|
| `id` | the carried identity (below); first choice `runtimeRunId` | `identity ?? sessionId` |
| `kind` | `agent` | `terminal` |
| `createdAt` | host `createdAt` (pu: `session.createdAtMs`; vf: pane summary's, else the fold's `createdAt`) | host `createdAt` |
| `status` | host `alive === false` → keep the runtime's word; `pending` → `idle` (AR-4); no state yet → `working` ("starting", vf's `unknown`); else `state.status` | `classifyTerminalStatus(activity)`: `foreground-job` → working, else idle |
| `statusSince` | `Date.parse(state.statusSince)`; no state → `createdAt` | when the backend saw the status flip (live state), else `createdAt` |
| `stale` | `classifyMonitorRecency(freshness.lastEvidenceAt, now) === 'stale'`, re-read on the 10 s clock | false |
| `alive` | host `alive` when it says false (vf's witnessed exit outranks a lagging mirror), else `state.alive`, else true | true |
| `pending` | host `pending !== undefined` | — |
| `detail` | pending → `unobserved · resumes when idle`; no state → `starting`; else core's `presentAgentMonitorHeadline(state).detail` | `cwd ?? 'Unassigned terminal'` |
| `activity` | — | the host's activity kind |
| `project.name` | `folderName(state.environment.cwd \|\| workspace.sourcePath \|\| workspace.root \|\| host.cwd, provider.label)` — both hosts' chain | `folderName(cwd, title \|\| 'terminal')` |
| `project.branch` | observation first (vf): `git !== undefined ? git?.branch ?? null : workspace.branch` | — |
| `project.seq` | `identity.deal(projectKey ?? state.environment.cwd)` in row order; absent with no key | absent (the ramp) |
| `provider` | host `provider` | — |
| `model` | `state.model.displayName \|\| state.model.id` | — |
| `effort` | `state.effort.value` | — |
| `account` | host `account` (pu: profile label from the registry; vf: fieldd's) | — |
| `context` | `{ usedPercent }` when `state.context.usedPercent` is a number | — |
| `wait` | first blocker: `{ kind, since, tool: permission.tool, question: questions[0].header ?? prompt }`, bounded | — |
| `reply` | `lastAssistantMessage` → `{ text (trimmed, ≤ replyMaxLength, default 280), at, final }` | — |
| `cost` | the usage ledger (below): `{ usd, coverage, burnPerHour: costRatePerMin × 60, series }`; absent when nothing is priced | — |
| `tokens` | `{ total: usage.cumulativeTokens, perMinute: usage.burnRatePerMin }` | — |
| `unread` | the unread ledger (L5) | false |
| `device` | host `device` | host `device` |
| `tier` | host `tier` | — |
| `profileSet` | host `profileSet` ?? the set whose persona is `profileId` ?? `native` (vf `agentProfileSet`) | host `profileSet` (the shell's) |
| `attachable` | `terminalSessionId !== undefined` (a PTY here) | true |

## Assembly

1. **Join**: every host run → the store's state for its `runtimeRunId` (`AgentMonitorStore`: epochs, revisions, sealed
   removals). A run the store has REMOVED makes no row until a newer epoch revives it; a run the host names but the store
   has never heard of is a "starting" row; a state the host has not named is no row (both hosts wait for the host's
   record today).
2. **Identity carry-forward** (`id`): `idByRun` for the backend's lifetime. A new run takes the id of the bare-terminal
   row its `terminalSessionId` (or `replacedTerminalSessionId`) stood for — a promoted shell keeps its body — else its
   `runtimeRunId`, which already survives epochs and PTY swaps (AR-4). An id is never held by two rows at once.
3. **Dedupe**: a terminal whose `sessionId`/`identity` is claimed by an agent row (its terminal, the one it replaced, or
   its id) is not a row: the agent speaks for both (vf "one identity, one row"; pu's launcher-handoff rule).
4. **Order**: `compareMonitorRows` — agents by `createdAt`, then terminals, ties by id.
5. **Dirty tracking**: a row is rebuilt only when its inputs changed (state object identity — the store freezes and
   replaces only on a newer revision —, host facts by shallow compare, seq, unread, stale, its usage history, the step);
   a rebuilt row deep-equal to the previous one keeps the previous frozen object (MV-D21).

## Unread (L5)

`unread.ts` is `views/monitor/unread.ts` verbatim (`reconcileUnread`), run on every tick with `active =` "some screen
reports it shown". `reportShown(screenId, ids)` replaces that screen's set (empty clears it). One screen reporting its
active pane's row is exactly today's fold — the parity tests prove it against the ported function. Terminals never earn
the mark. The ledger lives in memory for the daemon's lifetime (runtime only).

## Cost

`usage-ledger.ts` ports `reconcileUsage`'s semantics per run id: runs keyed `${runtimeRunId}:${epoch}` under one entry,
a session continuity rule (same provider + native session accumulates across epochs; a different conversation resets),
`total`/`coverage`/20 × 30 s `steps` from core's `costHistory` buckets — which is what refills the ten-minute window after
a daemon restart (L11; seed/export persistence is NOT ported). Histories are recomputed per run on its state change and
for every run at the 30 s boundary (the series' `lastStepAt` moves then, so a priced row emits once per step).

## Identity (L4)

`ProjectIdentityStore.deal(key)`: a known key keeps its sequence; an unknown one takes the next, dealt in row order, from
0, never reused. VibeField's `dealProjectSeqs` (counter `next`, never rewinds) and puppeteer's `nextProjectSequence`
(max + 1) deal identically; the memory impl follows VibeField's counter. The one divergence is the KEY, a host choice:
puppeteer folds to realpath + git toplevel in main; VibeField uses `workspace.root || sourcePath || monitor.cwd`.

## Spawn menu

Self device: `{ id: device.id, label: device.name, self, state: profileSets === null ? 'reading' : 'ready', profiles }`,
each profile `{ id, label, glyph, kind, isDefault, blocked (some agent row under it is blocked), signedIn }` with
`signedIn` as vf's `signedInLabels` (managed: every persona; native: logged-in only; deduped). Peers are appended as the
host passes them (SB-6 later). Emitted on the change only (deep compare).

## Emission

`revision` from 0; each tick that changed something emits one `MonitorModelChange { since, revision, upserts (rows whose
object changed), removed, spawn? }`; idle emits nothing; `getSnapshot()` is one frozen object until a change. Urgent
facts flush synchronously inside the push: a state whose `alive`, `blockers` or `status` differ from the last, and every
removal; everything else coalesces to the scheduler's tick. Rows are frozen (`freezeTree`). Commands: `select(id)`
resolves the row → `sink.select({ id, kind, runtimeRunId?, terminalSessionId? })`; `create(at?, target?)` resolves the
device (self ready/reading, a peer only ready) and the profile against the menu → `sink.create({ at?, device, profileSet? })`;
an unresolvable command returns false and routes nothing.

## Recorded divergences (for the shim and MV-3, not decided here)

- pu keeps a crashed run's row (alive false, failure blocker) until acknowledged; vf drops `alive === false` at its
  seam. The model carries the row with `alive: false` — the fact — as the desk row already does; readers filter.
- pu's detail appends `+N blockers` and `~$x estimated API cost · $y/min`; vf's prefers the reply line and `kind · tool`.
  The row's `detail` is the headline; `reply`, `wait`, `cost` carry the rest for the toolkit/shim to compose.
- vf's floor rows say `agent PTY · in no pane` — "in no pane" is a window fact; here they are terminals with no cwd.
- Notifications stay in the store (bounded); the model carries none (not in the contract).

## Bench (step 11)

_(filled in at step 11)_
