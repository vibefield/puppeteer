# The monitor backend (MV-1a)

`createMonitorBackend({ runs, host, identity, clock?, scheduler?, sink, ... })` computes every business fact about
this desktop's agents once, beside the runtime, and emits the contract's `MonitorModelSnapshot` / `MonitorModelChange`
(`@vibefield/puppeteer-view-sdk/model`, types only — L3). Node-safe, no DOM, no React, no `node:` import either: the
same code runs in fieldd and in puppeteer Godview's Electron main. Peers' rows are NOT assembled here: each agent is
computed at its home desktop (MV-D22) and the sync plane carries them (L8); the replica merges by id.

## Ports (TypeScript in `ports.ts`)

| Port | Shape | Who implements |
|---|---|---|
| `runs` | `MonitorRunSource` = the store's `AgentMonitorSource` (`listStates()` · `onState` · `onNotification` · `onRemoved({runtimeRunId, runtimeEpoch\|null})`, subscribe-before-list) + optional `acknowledgeFailure(runtimeRunId, blockerId)` (M3) | `runtimeRunSource(runtime)` over the runtime's push bus; the runtime gains `monitorStates()` (the all-runs snapshot it lacked) and passes the run's epoch to `onMonitorRemoved` (both additive); `acknowledgeFailureBlocker` passed through when the runtime has it |
| `host` | `{ getFacts(): MonitorHostFacts; subscribe(cb) }` — `device` (this desktop, `self: true`), `runs[]` (per-run host facts), `terminals[]` (bare PTYs), `profileSets \| null` (null = still reading), `spawnPeers?` (other desktops, passed through) | fieldd's fold + roster + profile feed; Godview main's session records + workspace + profiles |
| `identity` | `ProjectIdentityStore`: `seq(key)`, `deal(key)` — sync; never reuses a sequence | fieldd's state store; Godview's project registry (L4); `createMemoryProjectIdentityStore()` for tests |
| `clock` | `{ now(), schedule(ms, fn) → cancel }` | default `Date.now` + `setTimeout`; tests pass a manual clock |
| `scheduler` | `(fn) → cancel`: one emission per tick; it may run the tick before it returns | default one macrotask (`setTimeout 0`); the host may pass a frame |
| `sink` | `select(resolved)` · `create(resolved)` | fieldd's doors; the Ghosttea workspace |
| `history?` | `MonitorHistoryPort`: `read({sinceMs, untilMs}, {silenceMs, signal?})` → `MonitorRecordedActivity` (`fidelity: turns \| bounds`, `partial`, `detail?`, `sessions[]`: provider, native id, first/last activity, project key, title, turns with their silences; `runs[]`: the host's own runs, provider, native id, run id, birth, profile set, project key, title). Asked at each `readPast`, never polled; a throw is the host's words for `unavailable` | fieldd over rosettad (`index.activity`'s reader) and its session records; absent in puppeteer Godview, so its views are lent no past |

`MonitorHostRun`: `runtimeRunId` · `createdAt` · `provider {id,label}` · `terminalSessionId?` · `replacedTerminalSessionId?`
(AR-4) · `terminalIdentity?` · `projectKey?` (the canonical root the host folds to) · `workspace? {root, sourcePath,
branch}` · `fallbackBranch?` (M26) · `cwd?` · `profileId?` · `profileSet?` · `account?` · `tier?` · `pending?` · `alive?` · `nativeSessionId?`.
`MonitorHostTerminal`: `sessionId` · `identity?` · `createdAt` (0 = unknown, VibeField's floor rows) · `cwd?` · `title?` ·
`activity? {kind}` · `profileSet?` · `workloadClass?` · `exited?`.

## The host contract

What a host owes the backend. Each rule keeps a row's body or the revision chain whole; the backend cannot repair a
host that breaks one.

1. **Keep a PTY listed in `terminals` until its run is named in `runs`.** While both are listed, the dedupe shows one
   row (the agent speaks for its PTY) and the run takes the shell row's id, so a promoted shell keeps its body. The
   backend remembers the previous assembly's terminals for ONE tick only: a shell that leaves the list a tick before its
   run is named (any tick between — the 10 s recency clock, the 30 s step, an unrelated push) reads as the shell
   removed and a different row added under the run's id. Drop the terminal after the run is named, or in the same
   update.
2. **Drop a run only for good.** A removed run stays hidden while its seal is within the store's cap (the newest 4096
   removals, M25), even if the host names it again. Past the cap the removal is forgotten, and a run named again then
   reads as "starting" until the runtime speaks.
3. **Open and close screens (M20).** A screen opens with its first `reportShown(screenId, ids)`, an empty list too
   (its active pane shows nothing), and closes with `forgetScreen(screenId)` when it goes away: fieldd when the
   screen's door subscription closes, puppeteer's Godview when the window closes. A screen never forgotten keeps marks
   accruing as if someone were looking.
4. **One ordered channel (M23).** Deliver a snapshot and the changes after it on ONE ordered channel wherever the
   transport allows (puppeteer's Godview: the snapshot as a message on the change channel, not a separate invoke). The
   replica holds the changes it hears during a gap and replays those after the healing snapshot's revision
   (`gapBuffer`, default 256), but that is the backstop, not the design.
5. **Ask for a run's row by `idOf(runtimeRunId)`**, never by assuming its id is the `runtimeRunId`: a promoted shell's
   run carries the shell's id.

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
| `activity` | core's `{ kind, line (trimmed), since }` (M2) | `{ kind }`: the host's session activity kind, no line |
| `project.name` | `folderName(state.environment.cwd \|\| workspace.sourcePath \|\| workspace.root \|\| host.cwd, provider.label)` — both hosts' chain | `folderName(cwd, title \|\| 'terminal')` |
| `project.branch` | the observed branch when the observation names one; else the host's `fallbackBranch` (M26: pu supplies its workspace's, as its seam read `git?.branch ?? workspace.branch`; vf supplies none); else vf's rule: `git !== undefined ? null : workspace.branch` | — |
| `project.seq` | `identity.deal(projectKey ?? state.environment.cwd)` in row order; absent with no key, and while the host's key is `null` (it is still folding the project: no fallback) | absent (the ramp) |
| `provider` | host `provider` | — |
| `model` | `state.model.displayName \|\| state.model.id` | — |
| `effort` | `{ value: state.effort.value, intent? }` (M2) | — |
| `account` | host `account` (pu: profile label from the registry; vf: fieldd's) | — |
| `context` | `{ usedPercent }` when `state.context.usedPercent` is a number | — |
| `wait` | first blocker, parts kept apart (M2): `{ kind, since, count?, tool: permission.tool, code: failure.code, header: questions[0].header, question: questions[0].prompt, detail: blocker.detail }`, text trimmed like the reply; `count` = `blockers.length + omitted.blockers`, absent when one (M10) | — |
| `reply` | `lastAssistantMessage` → `{ text (trimmed), at, final }`; no bound of the backend's own (M21: core bounds the message; a host may pass `replyMaxLength`, which bounds the reply, the wait's texts and the activity line by code points) | — |
| `cost` | the usage ledger (below): `{ usd, coverage, burnPerHour: costRatePerMin × 60, series }`; absent when nothing is priced | — |
| `tokens` | `{ total: usage.cumulativeTokens, perMinute: usage.burnRatePerMin }` | — |
| `unread` | the unread ledger (L5) | false |
| `device` | host `device` | host `device` |
| `tier` | host `tier` | — |
| `profileSet` | host `profileSet` ?? the set whose persona is `profileId` ?? `native` (vf `agentProfileSet`) | host `profileSet` (the shell's) |
| `attachable` | `terminalSessionId !== undefined` (a PTY here) | true |
| `writable` | M41: the home desktop's policy for a pane on ANOTHER desktop typing into the run, computed once; today `attachable`'s rule (a view reads it only for a row from another desktop) | true |

## Assembly

1. **Join**: every host run → the store's state for its `runtimeRunId` (`AgentMonitorStore`: epochs, revisions, sealed
   removals). A run the store has REMOVED makes no row while the host still names it, until a newer epoch revives it; a
   run the host names but the store has never heard of is a "starting" row; a state the host has not named is no row
   (both hosts wait for the host's record today). **One record of removals (M25):** the store's seal, read through
   `store.isSealed(runtimeRunId)`; the backend keeps none of its own. The store keeps the newest
   `DEFAULT_MONITOR_SEAL_CAPACITY` (4096) seals, forgetting the oldest first, so tombstones are bounded: within the cap
   a removed run stays hidden even when the host names it again, and its removed epoch's late state is refused.
2. **Identity carry-forward** (`id`): `idByRun` for the backend's lifetime. A new run takes the id of the bare-terminal
   row its `terminalSessionId` (or `replacedTerminalSessionId`) stood for — a promoted shell keeps its body — else its
   `runtimeRunId`, which already survives epochs and PTY swaps (AR-4). An id is never held by two rows at once.
   `idOf(runtimeRunId)` tells a host which row a run is in the current snapshot (undefined while it has none).
3. **Dedupe**: a terminal whose `sessionId`/`identity` is claimed by an agent row (its terminal, the one it replaced, or
   its id) is not a row: the agent speaks for both (vf "one identity, one row"; pu's launcher-handoff rule).
4. **Order**: `compareMonitorRows` — agents by `createdAt`, then terminals, ties by id.
5. **Dirty tracking**: a row is rebuilt only when its inputs changed (state object identity — the store freezes and
   replaces only on a newer revision —, host facts by shallow compare, seq, unread, stale, its usage history, the step);
   a rebuilt row deep-equal to the previous one keeps the previous frozen object (MV-D21).

## Unread (L5)

`unread.ts` is the window's former `views/monitor/unread.ts` verbatim (`reconcileUnread`; the window's copy was deleted
at MV-8b, so this is the only one), run on every tick with `active =` "some screen
reports it shown". `reportShown(screenId, ids)` replaces that screen's set; the first report opens the screen, an empty
one too (its pane shows nothing), and `forgetScreen(screenId)` closes it. One screen reporting its active pane's row is
exactly today's fold — the parity tests prove it against the ported function. Terminals never earn the mark.

**Lifetime (M20).** Today the ledger lives only while Godview is open, so a turn that finished while it was closed is
never marked. The backend keeps that: while no screen is open nothing accrues and the ledger is empty, the first screen to
open stamps first sight for every row, and forgetting the last screen drops every mark. The ledger is memory only
(runtime only). Marking turns that finished while nobody looked would be a design event for James, not MV's.

## Cost

`usage-ledger.ts` ports `reconcileUsage`'s semantics (the window's former `views/monitor/usage-ledger.ts`, deleted at
MV-8b) per run id: runs keyed `${runtimeRunId}:${epoch}` under one entry,
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
observed directory. A host that folds asynchronously says `projectKey: null` until it has (puppeteer Godview: its
registry folds a workspace to the Git root, and today's rows wear the ramp until then), so nothing is dealt from the
observed directory meanwhile.

## Spawn menu

Self device: `{ id: device.id, label: device.name, self, state: profileSets === null ? 'reading' : 'ready', profiles }`,
each profile `{ id, label, glyph, kind, isDefault, blocked (some live agent row under it is blocked; a crashed row,
`alive: false`, lights nothing), signedIn }` with
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
  `kind · tool`. The row's `detail` is the headline; `reply`, `wait` (with `count`), `cost` carry the rest; every view
  composes vf's reply-first rule through the toolkit (`detailLine`). *Corrected 2026-10-05 (MV-8): the legacy shim that
  composed each host's line (`detail: 'reply-first' | 'headline-cost'`) is deleted; pu's chrome keeps its own
  headline-cost words for Find (`apps/godview/src/renderer/monitor/chrome-rows.ts` `chromeDetail`).*
- **M17** an agent before its first state is a host option, `unobservedAgents: 'row' | 'terminal'`. `row` (the
  default, vf's): the run is a "starting" row (`observed: false`) that speaks for its terminal at once. `terminal`
  (pu's): the run is no row and claims nothing until the runtime reports a state, so its terminal stands in, not
  deduped; at the first state (urgent, so it flushes inside the push) the agent row takes the terminal row's id and the
  shell keeps its body.
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

## The record's past (`readPast`, capability `history`)

`readPast({sinceMs, untilMs})` reads the record through the `history` port and joins it with the model as it is when
the record answers. The window is clamped to a day ending at `untilMs` (`PAST_MAX_WINDOW_MS`). Nothing is kept: each
ask derives afresh (`past.ts`), so the backend still holds live state only. TIMELINE SHAPES v2 (2026-10-09) is the
contract.

- **Only this runtime's runs.** The port answers the record's sessions AND the host's own runs (`runs`: provider,
  native id, run id, birth, profile set, project key, title — VibeField reads them off fieldd's session records). The
  join is the provider id plus the native session id (AR-D3). A model row gets a `MonitorLivePast` up to its
  `statusSince` (`seamAt`). A session that is one of the host's runs and no longer a row is an ENDED lane,
  `past:<provider>:<native id>`, in birth order, carrying the run's title and profile set. A session that is neither —
  an agent started in another terminal app — is no lane at all. An ended lane's colour is READ from the identity store
  by the run's project key and never dealt, so a past writes no identity.
- **The spans** (`spansFromTurns`): `worked` inside a turn, `quiet` between turns, `unrecorded` across a silence inside
  a turn longer than `PAST_SILENCE_MS` (15 min), because a permission wait or a long tool leaves no record. The record
  never says blocked or unseen, so the past never does. A session whose turns were not read (the floor, `fidelity:
  bounds`, or one session of a turns answer) is one flat `bounds` span; a live row's past stays unrecorded then.
- **Honest states:** `partial` when the host says some of the record was not read, `unavailable` with the host's words
  when the port throws — a host answers fast, so a record that is not up is `unavailable` at once. No port: `readPast`
  answers `undefined`, and a host lends its views no past at all. `readPast` never rejects. An ended lane's id is never
  a command's: `command` routes only the model's ids. A host that can open a past session answers the view's optional
  `openEnded` itself (TV-8, `MonitorViewCommands`); that never comes here.
