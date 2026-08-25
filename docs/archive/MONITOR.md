# The Runtime Monitor Model

Status: Archived · superseded by [RFC-001](../rfcs/001-evidence-backed-runtime-observation.md) · 2026-08-24

## 1. Positioning

Three things exist; chopsticks should stop trying to be all of them:

- **The native TUI** already gives the user the full original experience. Chopsticks hosts it and
  must not re-narrate it.
- **spaghetti** already ingests everything durable — transcripts, todos, plans, settings. History
  and search live there.
- **chopsticks** is the _live runtime monitor_ (plus the lifecycle it already owns: spawn,
  isolation, guarded control, receipts). Its observation product is exactly the runtime facts a
  user cannot get by glancing at N terminal panes or grepping transcripts after the fact.

The normalized layer therefore serves one product surface: a small, flat, per-session
`AgentMonitorState`, not a general-purpose semantic state machine. Everything below is scoped by
one question — _does a fleet operator need this on the board, live?_

## 2. The product surface

### Three states

```
idle     → assign it new work
working  → how hard? (activity line + burn rate)
blocked  → resolve it NOW (permission / question / failure)
```

- **blocked** = a pending permission request, an open question (elicitation / question-type
  notification), or a failure (turn failed, process died unexpectedly). Sticky until resolved,
  dismissed, or the session leaves the board.
- **working** = a turn is active, or compaction is running.
- **idle** = alive, observed, nothing in flight.

Death is not a fourth state: a cleanly-ended session leaves the board (with a notification).
Staleness is orthogonal (§4): a "working" bubble whose evidence is old renders as stale, never as
a confident lie.

### The metrics

| #   | Metric                                                                   | Why live                                                       |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1   | Activity — one line: what is it doing right now                          | glanceability across the fleet                                 |
| 2   | Token burn — cumulative + burn rate                                      | the #1 runtime cost signal; spot a runaway session immediately |
| 3   | Context window %                                                         | real-time pressure, predicts compaction                        |
| 4   | Model + effort level                                                     | know what each session is running                              |
| 5   | Mode (Plan / Auto / Accept-Edits / Manual…)                              | know how dangerous each session is                             |
| 6   | Plan & tasks — current snapshot + created-notifications                  | know what it _intends_ to do                                   |
| 7   | Subagents & teams — creation notifications, burn rolled into the session | delegation visibility                                          |
| 8   | Compaction started / finished                                            | explains stalls and context resets                             |
| 9   | CwdChanged                                                               | where is it operating                                          |
| 10  | WorktreeCreate / WorktreeRemove                                          | workspace topology changes                                     |

## 3. `AgentMonitorState`

Flat, JSON-plain, IPC-safe as-is. This _is_ the published reducer output; the current
`SessionRuntimeState` internals that survive (tool map, permission map, tombstones) become private
bookkeeping behind it, still visible to the devkit but not part of the app contract.

```ts
interface AgentMonitorState {
  status: 'idle' | 'working' | 'blocked';
  blocked?: { kind: 'permission' | 'question' | 'failure'; detail?: string; since: string };
  activity?: { line: string; since: string }; // "Editing normalizer.ts" · "Thinking" · "Compacting context"

  usage: {
    cumulativeTokens?: number; // monotonic burn, subagent-attributed deltas included
    burnRatePerMin?: number; // sliding-window projection over samples
    contextPercent?: number;
    samples: Array<{ at: string; cumulativeTokens: number }>; // bounded ring
  };

  model?: { id: string; displayName?: string };
  effort?: string; // open set: 'low' … 'xhigh'
  mode?: string; // open set: 'default' | 'plan' | 'acceptEdits' | …

  plan?: { updatedAt: string; steps: Array<{ text: string; status: string }> };
  tasks: Array<{ id: string; description?: string; teamName?: string; teammateName?: string; done: boolean }>;
  subagents: Array<{ id: string; type?: string; active: boolean; tokens?: number }>;
  team?: { name?: string; teammates: Array<{ name: string; idle?: boolean }> };

  compaction: { active: boolean; lastAt?: string; count: number };
  environment: { cwd?: string; git?: AgentGitState | null; worktrees: string[] };
  session: { nativeSessionId?: string; startedAt?: string }; // identity only — rotation-safe
  freshness: { lastEvidenceAt?: string; level: ObservationLevel };
  alive: boolean;
}
```

`status` and `activity.line` are computed by **one core function** — the single successor to the
eleven status vocabularies the consumer audit found (godview's `classifyAgentStatus`/`agentDetail`,
workbench's `statusTone`/`liveLabel`, the swarm remap, …). Apps render; they do not re-derive.

## 4. Status and staleness rules

- Blocked wins over working; working over idle. Failure-blocked persists until the next turn
  starts, the user acts, or the session leaves the board.
- "Responding" (streaming deltas), "thinking" (reasoning signal), and tool titles all collapse
  into `activity.line` — they are flavors of working, not states.
- `freshness.lastEvidenceAt` is stamped by every reduced envelope. The app renders stale sessions
  greyed past a threshold. When an observation rail dies (app-server socket, ACP attach, hook
  bridge), the adapter emits **nothing** — the monitor goes stale honestly. This replaces both the
  old fake `process.exited` emissions and the STATE-LAYERS channel facet.

## 5. Sourcing the metrics (per vendor)

Verified facts worth stating plainly: Claude's hook envelope carries `permission_mode` and
`effort` on **every** event and the adapter currently reads neither (grep is empty); the
transcript's per-message `usage` block (input/output/cache tokens, present on sidechain rows too)
is the only session-scoped burn source that includes subagents, and the transcript observer
currently extracts only assistant text; Kimi's journal has `usage.record` explicitly dropped
(`kimi/normalizer.ts:362`).

| Metric     | Claude                                                                                                                                                                   | Codex                             | Grok                      | Kimi                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------- | ------------------------------- |
| activity   | tool events + MessageDisplay deltas + reasoning                                                                                                                          | item lifecycle                    | log chunks                | journal                         |
| burn       | **transcript `message.usage` per record (incl. sidechains)**; statusline cross-check                                                                                     | `thread/tokenUsage/updated`       | `signals.json`            | `usage.record` (unmapped today) |
| context %  | statusline                                                                                                                                                               | tokenUsage                        | signals.json              | —                               |
| model      | statusline / SessionStart                                                                                                                                                | thread settings                   | summary.json              | journal                         |
| effort     | hook envelope `effort` (dropped today)                                                                                                                                   | settings                          | —                         | —                               |
| mode       | hook envelope `permission_mode` (dropped today)                                                                                                                          | approvalPolicy/sandbox            | —                         | —                               |
| plan/tasks | `TodoWrite` PreToolUse input (derived) + TaskCreated/Completed                                                                                                           | `plan` items                      | —                         | task.*                          |
| subagents  | SubagentStart/Stop + envelope `agent_id` on every event                                                                                                                  | collab items (peer `newThreadId`) | subagent_spawned/finished | task.* kind:'agent'             |
| team       | TaskCreated/Completed `team_name`/`teammate_name` + TeammateIdle                                                                                                         | thread-to-thread                  | —                         | —                               |
| compaction | PreCompact / PostCompact                                                                                                                                                 | `contextCompaction` item          | `auto_compact_*` updates  | `full_compaction.complete`      |
| cwd        | CwdChanged (mapped today)                                                                                                                                                | thread settings                   | summary.json              | journal                         |
| worktrees  | **git/workspace observation, NOT the WorktreeCreate hook** — registering that hook _replaces_ Claude's native worktree creation (it is the one hook with a resultSchema) | —                                 | —                         | —                               |

Team burn rollup across sessions (teammates are full sessions) is an application-level sum keyed by
team name; per-session rollup of subagent deltas is core's job via envelope attribution.

## 6. The spaghetti seam

Several metrics (burn, plan snapshots) come from vendor files spaghetti already knows how to parse.
The dependency shape:

- **Code flows down; bytes flow up.** Chopsticks adapters import spaghetti's SDK (layer 2 → layer
  1); spaghetti never imports chopsticks — it ingests chopsticks' record files as one more file
  source. One direction is code, the other is data, so there is no cycle.
- **Pairwise, direct, no middle layer.** Each adapter consumes its own vendor's scoped typed
  observer — Claude uses Spaghetti's `observeSession()` epoch/replacement contract with the rule
  "no second parser: cold-ingest parity is inherited." Per-vendor aggregation _is_ the
  adapter: joining hooks + transcript + statusline is its whole job. Cross-vendor aggregation _is_
  the provider/runtime seam. A middle "observers" package would relocate the pairwise knowledge
  without removing it, and split the adapter's intimate correlation (activity poke, replay dedupe)
  across a package boundary. Host-style inversion is wrong here too: `AgentHost` inverts because
  the application owns the terminal resource; nobody owns vendor files, and a neutral seam would
  erase the vendor record types that are the point of the dependency.
- **One Rust core, two frontends.** With spaghetti's runtime moving to a Rust daemon, the parser +
  tail engine (fs watch, partial-line JSONL, rotation/rewrite detection, cursor replay, per-vendor
  typed records) lives in the Rust crates and is exposed two ways: an **N-API package** (the
  `spaghetti-sdk-native` lineage) that chopsticks adapters link **in-process**, and the **daemon**
  that applications query for history, search, and analytics. Adapters bind the napi frontend,
  never the daemon: a published library must not require a running service, and failure domains
  stay per-session (a daemon restart must not dark every session's transcript rail at once).
  N-API's ABI stability means no Electron rebuild pain, and napi-rs generates the TS types, so the
  record contract stays in lockstep with the parser by construction. This also retires the old
  concern about the TS SDK's UI-heavy root entry — chopsticks stops touching it entirely. The
  Ghosttea precedent marks the line: a daemon is justified where a daemon is _necessary_ (PTY
  ownership surviving renderer reloads); file tailing needs only fs access, so don't buy daemon
  coupling for it. Two read-only tails on one file (daemon indexing live, adapter monitoring live)
  are fine.
- **Live truth vs durable truth — never double-source.** The daemon makes it possible for godview
  to fetch transcript-derived numbers directly, bypassing chopsticks. Don't: **live operational
  metrics (status, activity, burn rate, context %) come only from chopsticks'
  `AgentMonitorState`; the daemon serves history, search, and cross-session analytics** (e.g. burn
  charts over past sessions). One fact, one owner — otherwise the board and the history disagree
  and neither can be trusted.
- **The adapter drives the join and the clock.** The adapter learns file identity from its own
  rails (Claude: `transcript_path` on hook envelopes) and attaches the scoped file-watching
  observer. Hook poll hints remain a provider-neutral latency signal; session discovery stays
  index-side.
- **Version discipline.** Exact pin, one version across all adapters — worth a `packages:check`
  rule. Claude's adapter and both hosts now declare 0.7.0, with the local root override resolving
  that edge to the sibling workspace. Upgrades are deliberate integration events: the Ghosttea
  discipline.
- **Parser follows the index.** Kimi/Grok/Codex log parsers are hand-rolled in their adapters
  today, which is fine while spaghetti does not ingest those formats. The moment it does, the
  parser moves down into a spaghetti source and the adapter consumes the scoped tail — never two
  parsers for one format across the ecosystem.
- **Spaghetti records never cross the adapter boundary.** Normalization happens in-adapter; core,
  runtime, and apps see only provider-neutral events and monitor batches. Observer failure
  never fails the session (§16.8): a dead tail is a dark rail — staleness, not an error state.

## 7. Event vocabulary delta (small, additive)

- New: `tokens.used { cumulativeTokens?, deltaTokens?, breakdown?, agentId? }`,
  `plan.updated { steps }`, `compaction.started { trigger? }`, `compaction.completed { trigger? }`,
  `teammate.idle { teamName?, teammateName }`.
- Extended: `session.environment.updated` gains `mode?` and `effort?`; `TaskCreated`/`TaskCompleted`
  gain `teamName?`/`teammateName?`; the envelope gains `agentId?`/`agentType?` (subagent
  attribution — Claude puts it on every hook event, Kimi on every journal record).
- Distinct facts stay distinct: `tokens.used` is cumulative burn (grows through cache reads,
  survives compaction); `context-window.updated` is pressure (shrinks on compaction).
- Removed lies: the four adapter `process.exited` emissions that actually describe control-channel
  death (codex driver + observer, acp, grok attach-failure-as-crash) are deleted, not remapped.
- Notification-worthy (app toast/feed, tagged by core): blocked-entered, plan.updated,
  task.created, subagent.started, teammate.idle, compaction.started/completed, worktree changes,
  session ended.

## 8. Fixes kept from the state-layers investigation

The pivot deletes the structure, not the bugs. These stand on their own:

| Fix                                                                                                                                                          | Why the monitor needs it                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `/clear` rotation: `session.started` after `session.exited` rebinds identity instead of stranding a terminal `exited` (`claude/normalizer.ts:373` + reducer) | a live agent must never vanish from the board mid-conversation                                        |
| Runtime dispatches process exit into the reducer and publishes the final snapshot _before_ `closeManaged` deletes the session (`runtime.ts:201`)             | sessions must _leave_ the board through one truthful route; today no terminal state is ever published |
| Permission absence-closure at `Stop` (already implemented) + `permission-outlived-turn` diagnostic                                                           | blocked must clear when the user resolves a dialog Claude never reports                               |
| Claude fallback tool-id collision (`tool-${promptId}-${toolName}`, `normalizer.ts:282`) gets a counter suffix                                                | repeated same-tool calls silently swallow activity today                                              |
| One core status/activity projection; `AgentMonitorState` is JSON-plain                                                                                       | deletes both hand-copied `serializeState` implementations and all eleven downstream vocabularies      |

## 9. Explicitly dropped from STATE-LAYERS

Process phase machine (an `alive` boolean + one exit event suffice), observation-channel facet
(staleness timestamp instead), session rotation chain/generation history (spaghetti owns history;
one rebind rule suffices), `describeStateFacets()` machine descriptions, per-facet provenance
stamps (freshness + the existing `environment` provenance cover the monitor), teams-as-machines,
the 12-facet product state. If a future consumer needs deeper semantics, the raw envelope log is
still complete (ADR-008) — nothing is lost, it is just not _modeled_.

## 10. Migration sketch

1. **Core** — `AgentMonitorState` + its reducer (existing tool/permission/turn bookkeeping shrinks
   to private helpers); the status/activity projection; new events. Old `SessionRuntimeState`
   consumers keep working through a compat accessor until apps move.
2. **Adapters** — Claude: read `permission_mode`/`effort` from the envelope, extract transcript
   `message.usage` (incl. sidechains) into `tokens.used`, map PreCompact/PostCompact/TeammateIdle,
   TodoWrite→`plan.updated`, tool-id counter, delete nothing else. Codex: tokenUsage→`tokens.used`,
   plan items, delete the two fake process exits. Grok/ACP: delete the fake exits. Kimi: map
   `usage.record`.
3. **Apps** — godview consumes `AgentMonitorState` directly (bubble = status, tooltip = metrics,
   toast = notification events); both `serializeState` copies and all local classifiers deleted.
   The devkit keeps its native-evidence/ledger stages and shows MonitorState as the third stage.

## 11. Open questions

1. Burn-rate window and sampling density (per statusline tick? per transcript record?) — pick after
   watching real data in godview.
2. Claude subagent burn attribution: sidechain transcript rows vs `agent_id`-tagged hook events —
   verify which is complete under parallel subagents.
3. Mode vocabulary mapping across vendors (Claude permission modes vs Codex approval/sandbox pairs)
   — keep open strings + app-side display table, or normalize?
4. Does the question-type notification (`Notification.notification_type`) enumerate well enough to
   distinguish "asking the user" from ambient notices? Only `permission_prompt` observed so far.
5. Worktree observation route: git observer polling vs FileChanged matchers — never the
   WorktreeCreate hook (behavior-replacing).
6. The napi live-watch frontend: prebuild coverage for the three target platforms, exact-pin
   discipline in adapters, and whether the poke/cursor API surfaces per vendor or as one scoped
   tail with vendor-typed payloads — settled in the spaghetti Rust refactor; chopsticks requires
   only that it is in-process, headless, and shares the daemon's parser.
