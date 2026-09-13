# RFC 001: Evidence-Backed Runtime Observation and the Three-State Monitor

- **Status:** Accepted and implemented
- **Created:** 2026-08-16
- **Revised:** 2026-09-12
- **Owners:** Core, Runtime, adapter, and monitor maintainers
- **Related:** [`002-modular-agent-events-and-services.md`](./002-modular-agent-events-and-services.md), [`003-native-observation-sources.md`](./003-native-observation-sources.md), [`004-layered-agent-runtime.md`](./004-layered-agent-runtime.md), [`agent-api.html`](../agent-api.html)
- **History:** The [original proposal and rollout design](../archive/RFC-001-EVIDENCE-BACKED-RUNTIME-OBSERVATION.md) is archived.

## Decision

Every Runtime Agent owns one evidence-backed monitor. It combines independently sourced runtime, semantic, and workspace facts into one small, immutable `AgentMonitorState` and a separate stream of `MonitorNotification` transitions.

The only fleet-level headline states are:

```ts
type AgentMonitorStatus = 'idle' | 'working' | 'blocked';
```

Process liveness, detailed session lifecycle, observation freshness, and provider readiness remain orthogonal. A live process can be blocked, and an exited process can retain a blocked failure monitor until the failure is acknowledged.

## Ownership

```text
runtime/process signals ───────────┐
                                   │
adapter monitor:batch evidence ────┼─► private accumulator ─► AgentMonitorState
                                   │                      └─► MonitorNotification
workspace allocation/Git facts ───┘
```

- Runtime owns process liveness, prompt receipts, runtime identity, workspace allocation/finalization, and Git observation.
- Adapters own their bounded provider-native observers and normalize correction-aware evidence into `monitor:batch` events.
- Core owns strict monitor input schemas, the private reducer, and pure public projection.
- Runtime owns one `AgentMonitorService` per run and publishes it through the run's `Agent`.
- Monitor and React packages deliver already-projected state; products do not infer semantic status.

There is no shared semantic-database or external observer dependency in the live runtime. Adapter source ownership is specified by RFC-003.

## Public contract

`AgentMonitorState` is JSON-plain, deeply immutable, bounded, and intentionally lossy. It contains operational facts needed by products:

- status, blockers, and current activity;
- usage and short-window burn rate;
- context, model, effort, and provider modes;
- known child count and each child’s model, effort, token usage, and observed activity;
- compaction, environment, native-session identity, freshness, and liveness.

Source epochs, corrections, replacement ledgers, raw provider records, and privacy-safe workspace provenance remain private. There is no monitor artifact-read capability.

`MonitorNotification` reports notification-worthy transitions. It is not another state store and cannot be replayed to reconstruct the complete monitor.

Monitor schema generation 2 removes plan steps and task collections, their bounded-collection counters, and task/plan notifications. Task management belongs to native agents or an external product; provider plan-mode and agent/subagent execution remain operational observations. See RFC 004 for the boundary and consumer migration.

`AgentMonitorHandle` provides a race-free initial snapshot, ordered state and notification iterables, current state and consumer-local closure. Closing a handle never closes the Agent.

Monitor schema generation 3 removes artifact reads, team/workflow types, memberships and notifications, child context, duplicate session-state child maps, and child lifecycle notifications. `subagentCount` includes completed children before display bounds. Child rows retain usage after completion; `working: false` means no work is observed, not proof of termination. Team/workflow identities alone remain native evidence and never create children.

## Evidence semantics

The private accumulator keeps three independently ordered planes:

1. **Runtime:** process, prompt, lifecycle, and immediate host-owned facts.
2. **Semantic:** adapter-owned batches with producer epoch, sequence, readiness, capabilities, coverage, watermarks, and atomic family updates.
3. **Workspace:** current environment facts plus private allocation, baseline, finalization, cleanup, interference, and Git provenance.

Inputs retain source identity, observed/effective time, quality, completeness, provisional state, and evidence references. Runtime delivery order never replaces upstream semantic identity.

Reducers support idempotent replay, corrections, retractions, complete-family replacement, producer resynchronization, and bounded collections. A malformed or unavailable native observer degrades only its evidence rail; it cannot synthesize process death.

Private-only evidence does not trigger a public state publication. In particular, workspace provenance advances the private workspace plane but not public `lastEvidenceAt` unless a projection-relevant environment fact also changes.

## Status projection

Status is projected in one place:

- any currently working child produces `working`;
- otherwise any unresolved blocker produces `blocked`;
- otherwise current activity produces `working`;
- otherwise the Agent is `idle`.

Blockers include permissions, questions, failures, and other explicitly modeled impediments. Session lifecycle remains a more detailed Runtime projection and is not collapsed into these three states.

Provider-native names and display strings never define headline status. Terminal contents are visually authoritative only; they are not semantic evidence.

## Identity and ordering

The monitor is keyed by `runtimeRunId` and `runtimeEpoch`, not terminal pane ID or provider-native session ID. These identities remain distinct:

- a runtime run is one Puppeteer-managed provider invocation;
- a terminal session identifies the host process/pane binding;
- a native session identifies the provider's resumable conversation;
- actor identities describe root or child participants within native evidence;
- a workspace instance identifies one allocated working area.

Runtime validates monitor candidates before assigning per-Agent delivery order. Projection services consume an accepted envelope before public event subscribers, so callbacks observe state that already includes their event.

## Lifecycle and retention

The monitor exists from run allocation, including provider lookup or preparation failure. On process exit Runtime:

1. publishes authoritative host exit evidence;
2. publishes the resulting state and notifications;
3. detaches and disposes provider resources;
4. finalizes workspace evidence and durable records;
5. removes a clean/cancelled monitor, or freezes an unexpected-failure monitor.

A frozen failure monitor retains only its bounded public projection. Acknowledging its failure blocker is idempotent and removes the retained monitor when no blocker remains. Runtime bounds both retained failure monitors and terminal run summaries.

## Privacy and failure isolation

- Raw prompts, artifact bodies, local paths, credentials, and raw diffs are excluded from monitor state and default action records.
- Workspace file identities use keyed fingerprints when durable correlation is authorized.
- Recorder, observer, listener, and projection failures are diagnostic; they do not reject prompts or kill a live process.
- Listener faults do not interrupt ingestion or other listeners.

## Implementation map

| Responsibility                             | Location                                           |
| ------------------------------------------ | -------------------------------------------------- |
| Public monitor types and pure projection   | `packages/core/src/monitor/`                       |
| Version-locked accumulator SPI             | `packages/core/src/monitor-spi.ts`                 |
| Adapter evidence schema/event              | `packages/core/src/events/monitor.ts`              |
| Runtime monitor orchestration              | `packages/runtime/src/services/monitor-service.ts` |
| Race-free handle and scheduling primitives | `packages/runtime/src/monitor/`                    |
| Transport-neutral external store           | `packages/monitor/`                                |
| React hooks and view contract              | `packages/react/`                                  |
| Product-specific IPC and rendering         | `apps/godview/`                                    |

## Completed migration

The rollback window is closed. The legacy serialized-state bridge, dual monitor projection, shadow comparison provider, rollout flags, and app-local status classifier have been removed. Godview consumes canonical `AgentMonitorState` revisions and `MonitorNotification` transitions only.

The original proposal's external semantic-observer design is historical. RFC-003 replaced it with adapter-owned observers, and RFC-004 defines the implemented repository layers and dependency graph.

## Required invariants

- The public headline state has exactly three values.
- Detailed lifecycle and `alive` remain separate from headline status.
- Monitor state revisions are immutable and advance only for public changes.
- Corrected usage may move totals up or down without double counting.
- Root and child actor evidence cannot overwrite one another.
- Semantic replacement is atomic; an incomplete resync never erases the last committed slice.
- Observation failure cannot produce `process:exited` or `session:exited`.
- Private provenance and raw provider data never leak into renderer state.
- A real host exit is published before resource cleanup and monitor removal.
- Clean monitors are removed; unexpected failures remain bounded and acknowledgeable.
