# The monitor backend (MV-1a)

`createMonitorBackend({ runs, host, identity, clock?, scheduler?, sink, ... })` computes every business fact about
this desktop's agents once, beside the runtime, and emits the contract's `MonitorModelSnapshot` / `MonitorModelChange`
(`@vibecook/puppeteer-view-sdk/model`, types only — L3). Node-safe, no DOM, no React, no `node:` import either: the
same code runs in fieldd and in puppeteer Godview's Electron main. Peers' rows are NOT assembled here: each agent is
computed at its home desktop (MV-D22) and the sync plane carries them (L8); the replica merges by id.

## Ports (TypeScript in `ports.ts`)

| Port | Shape | Who implements |
|---|---|---|
| `runs` | `MonitorRunSource` = the store's `AgentMonitorSource` (`listStates()` · `onState` · `onNotification` · `onRemoved({runtimeRunId, runtimeEpoch\|null})`, subscribe-before-list) + optional `acknowledgeFailure(runtimeRunId, blockerId)` (M3) | `runtimeRunSource(runtime)` over the runtime's push bus; the runtime gains `monitorStates()` (the all-runs snapshot it lacked) and passes the run's epoch to `onMonitorRemoved` (both additive); `acknowledgeFailureBlocker` passed through when the runtime has it |
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
| `observed` | a state has arrived and `pending` is unset (M10) | true |
| `pending` | host `pending !== undefined` | — |
| `detail` | pending → `unobserved · resumes when idle`; no state → `starting`; else core's `presentAgentMonitorHeadline(state).detail` | `cwd ?? 'Unassigned terminal'` |
| `activity` | core's `{ kind, line (bounded), since }` (M2) | `{ kind }`: the host's session activity kind, no line |
| `project.name` | `folderName(state.environment.cwd \|\| workspace.sourcePath \|\| workspace.root \|\| host.cwd, provider.label)` — both hosts' chain | `folderName(cwd, title \|\| 'terminal')` |
| `project.branch` | observation first (vf): `git !== undefined ? git?.branch ?? null : workspace.branch` | — |
| `project.seq` | `identity.deal(projectKey ?? state.environment.cwd)` in row order; absent with no key | absent (the ramp) |
| `provider` | host `provider` | — |
| `model` | `state.model.displayName \|\| state.model.id` | — |
| `effort` | `{ value: state.effort.value, intent? }` (M2) | — |
| `account` | host `account` (pu: profile label from the registry; vf: fieldd's) | — |
| `context` | `{ usedPercent }` when `state.context.usedPercent` is a number | — |
| `wait` | first blocker, parts kept apart (M2): `{ kind, since, count?, tool: permission.tool, code: failure.code, header: questions[0].header, question: questions[0].prompt, detail: blocker.detail }`, text bounded like the reply; `count` = `blockers.length + omitted.blockers`, absent when one (M10) | — |
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
reports it shown". `reportShown(screenId, ids)` replaces that screen's set; the first report opens the screen, an empty
one too (its pane shows nothing), and `forgetScreen(screenId)` closes it. One screen reporting its active pane's row is
exactly today's fold — the parity tests prove it against the ported function. Terminals never earn the mark.

**Lifetime (M20).** Today the ledger lives only while Godview is open, so a turn that finished while it was closed is
never marked. The backend keeps that: while no screen is open nothing accrues and the ledger is empty, the first screen to
open stamps first sight for every row, and forgetting the last screen drops every mark. The ledger is memory only
(runtime only). Marking turns that finished while nobody looked would be a design event for James, not MV's.

## Cost

`usage-ledger.ts` ports `reconcileUsage`'s semantics per run id: runs keyed `${runtimeRunId}:${epoch}` under one entry,
a session continuity rule (same provider + native session accumulates across epochs; a different conversation resets),
`total`/`coverage`/20 × 30 s `steps` from core's `costHistory` buckets — which is what refills the ten-minute window after
a daemon restart (L11; seed/export persistence is NOT ported). Histories are recomputed per run on its state change and
for every run at the 30 s boundary (the series' `lastStepAt` moves then, so a priced row emits once per step).

**Across a resumed conversation (M15)** the reading is a host option, `cost: { acrossEpochs }`: `accumulate` (puppeteer
Godview's seam — the run is `${runtimeRunId}:${epoch}`, the conversation the provider + native session, so a resumed
epoch adds up and a new conversation resets; the default) or `current` (VibeField's seam — the run alone, so a new epoch
replaces the total). OPEN: if core replays priced history into a resumed epoch, `accumulate` double counts — the exposure
puppeteer's Godview has today; look before unifying the two.

## Identity (L4)

`ProjectIdentityStore.deal(key)`: a known key keeps its sequence; an unknown one takes the next, dealt in row order, from
0, never reused. Compared (`identity.test.ts` replays both dealers from their sources): VibeField's `dealProjectSeqs`
(counter `next`, never rewinds) and puppeteer's `nextProjectSequence` (max + 1) deal the same numbers fresh and after a
reload of the same record; they part only when VibeField's cache has dropped its oldest keys (`MAX_PROJECT_KEYS` 256),
where its persisted `next` keeps the dropped sequences retired and a max + 1 reader would not. The memory impl follows
VibeField's: `createMemoryProjectIdentityStore(entries, { next })`, the larger of the floor and the dealt sequences
(`loadProjectLedger`). The other divergence is the KEY, a host choice: puppeteer folds to realpath + git toplevel in
main; VibeField uses `workspace.root || sourcePath || monitor.cwd`; the backend takes the host's key and falls back to the
observed directory.

## Spawn menu

Self device: `{ id: device.id, label: device.name, self, state: profileSets === null ? 'reading' : 'ready', profiles }`,
each profile `{ id, label, glyph, kind, isDefault, blocked (some agent row under it is blocked), signedIn }` with
`signedIn` as vf's `signedInLabels` (managed: every persona; native: logged-in only; deduped). Peers are appended as the
host passes them (SB-6 later). Emitted on the change only (deep compare).

## Emission

`revision` from 0; each tick that changed something emits one `MonitorModelChange { since, revision, upserts (rows whose
object changed), removed, spawn? }`; idle emits nothing; `getSnapshot()` is one frozen object until a change. Urgent
facts flush synchronously inside the push: a state whose `alive`, `blockers` or `status` differ from the last, and every
removal; everything else coalesces to the scheduler's tick. A flush asked for while the listeners hear a change (a
listener that reports shown, pushes, removes or runs a tick at once) is held until every listener has heard it, so each
hears revision n before n + 1. Rows are frozen (`freezeTree`). Commands: `select(id)`
resolves the row → `sink.select({ id, kind, runtimeRunId?, terminalSessionId? })`; `create(at?, target?)` resolves the
device (self ready/reading, a peer only ready) and the profile against the menu → `sink.create({ at?, device, profileSet? })`;
`acknowledge(id)` (M3, Godview's keep-until-acknowledged flow from `monitor-ipc.ts`) takes a dead agent row with a
failure blocker and asks the run source's `acknowledgeFailure(runtimeRunId, blockerId)` — the runtime removes the run,
and the row goes through the ordinary removal; an unresolvable command returns false and routes nothing.

## Recorded divergences (ruled in build-mv §7)

- **M3** pu keeps a crashed run's row (alive false, failure blocker) until acknowledged; vf drops `alive === false` at
  its seam. The model carries the row with `alive: false`, as the desk row already does; visibility is the replica's host
  policy (`setLocal({ visible })`, vf passes `row => row.alive`); pu's flow is the `acknowledge` command above.
- **M4** pu's detail appends `+N blockers` and `~$x estimated API cost · $y/min`; vf's prefers the reply line and
  `kind · tool`. The row's `detail` is the headline; `reply`, `wait` (with `count`), `cost` carry the rest; the legacy
  shim composes each host's line (`detail: 'reply-first' | 'headline-cost'`), ported views use vf's reply-first rule.
- vf's floor rows say `agent PTY · in no pane` — "in no pane" is a window fact; here they are terminals with no cwd.
- Notifications stay in the store (bounded); the model carries none (not in the contract).

## Bench (step 11)

`MONITOR_BENCH=1 pnpm exec vitest run src/backend/backend.bench.test.ts` (in `packages/monitor`; skipped without the
variable). A tick is k state pushes then one flush, through the manual clock and scheduler, states built outside the
timed region; medians of 200 ticks after 20 warm-up; it waits for the load average to fall below 60 first (L17) and
prints the load beside the numbers. Reference, never a bound (L14). Recorded 2026-10-03 on James's Mac with the other
MV lanes running (load average 40.0 before, 37.1 after):

| n | tick | k changed | median tick | per changed row | upserts/tick |
|---|---|---|---|---|---|
| 10 | 1 row | 1 | 37 µs | 37.0 µs | 1.0 |
| 10 | 10 % | 1 | 28 µs | 27.7 µs | 1.0 |
| 10 | all | 10 | 147 µs | 14.7 µs | 10.0 |
| 10 | all, nothing drawn moved | 10 | 147 µs | 14.7 µs | 0 emitted |
| 10 | idle recompute, nothing changed | 0 | 11.8 µs | — | 0 |
| 20 | 1 row | 1 | 34 µs | 34.3 µs | 1.0 |
| 20 | 10 % | 2 | 45 µs | 22.4 µs | 2.0 |
| 20 | all | 20 | 289 µs | 14.4 µs | 20.0 |
| 20 | all, nothing drawn moved | 20 | 293 µs | 14.7 µs | 0 emitted |
| 20 | idle recompute, nothing changed | 0 | 14.6 µs | — | 0 |
| 60 | 1 row | 1 | 62 µs | 62.5 µs | 1.0 |
| 60 | 10 % | 6 | 130 µs | 21.7 µs | 6.0 |
| 60 | all | 60 | 824 µs | 13.7 µs | 60.0 |
| 60 | all, nothing drawn moved | 60 | 860 µs | 14.3 µs | 0 emitted |
| 60 | idle recompute, nothing changed | 0 | 45.5 µs | — | 0 |
| 200 | 1 row | 1 | 177 µs | 177.0 µs | 1.0 |
| 200 | 10 % | 20 | 427 µs | 21.4 µs | 20.0 |
| 200 | all | 200 | 2825 µs | 14.1 µs | 200.0 |
| 200 | all, nothing drawn moved | 200 | 3022 µs | 15.1 µs | 0 emitted |
| 200 | idle recompute, nothing changed | 0 | 140.7 µs | — | 0 |

Reading: a tick costs a scan floor of about 0.7 µs per row of the board (the idle row: host facts shallow-compared,
recency re-read, the unread fold, the spawn menu rebuilt and compared) plus about 14–35 µs per row whose state object
moved (the store's accept and freeze, derive, deep-compare, freeze, the sort and the emission). The cost follows what
changed: at n = 200 one changed row is 177 µs against 2825 µs for all two hundred. A new state object whose drawn facts
did not move costs the same derive and compare and emits nothing — the dirty check is by state identity, which is what
the store hands out; comparing the drawn fields before deriving would be the next cut if the floor ever matters.
