# RFC-001: Evidence-Backed Runtime Observation and the Three-State Monitor

- **Status:** Accepted; implementation in progress (Stage C)
- **Created:** 2026-08-16
- **Last updated:** 2026-08-24
- **Owners:** Puppeteer runtime and adapter maintainers
- **Target:** Puppeteer runtime v2 observation architecture
- **Related:** [`001-implementation-plan.md`](./001-implementation-plan.md); [`docs/archive/MONITOR.md`](../../docs/archive/MONITOR.md); Spaghetti RFC 012A, 012C, and 012D
- **Supersedes:** [`docs/archive/MONITOR.md`](../../docs/archive/MONITOR.md) and the observation, runtime identity, reducer, and Spaghetti-integration portions of [`draft/DESIGN.md`](../../draft/DESIGN.md)

## 1. Abstract

Puppeteer needs to expose a substantially richer view of a running coding agent while preserving the agent's original terminal UI. Consumers such as Godview need to observe token usage and burn rate, context-window pressure, model and effort changes, provider modes, plans, tasks, questions, subagents, teams, workflows, and workspace outcomes. VibeField additionally needs durable runtime and workspace provenance that can be joined with transcript evidence and Git facts to produce contribution claims.

The existing architecture reduces a single ordered `AgentEvent` stream into one mutable `SessionRuntimeState`. That is appropriate for simple lifecycle and hook events, but it cannot correctly represent independently owned evidence, replaceable transcript observations, corrections, retractions, observer resynchronization, resumed native sessions, or confidence-qualified workspace attribution.

This RFC introduces three evidence planes and one derived projection:

1. **Runtime signal plane**, owned by Puppeteer, for process, PTY, prompt, hook, and immediate provider-side signals.
2. **Semantic observation plane**, owned by Spaghetti, for transcript-backed actors, usage, model and effort observations, plans, tasks, tools, questions, teams, workflows, and bounded artifacts.
3. **Workspace provenance plane**, owned by Puppeteer and Git observations, for allocation, isolation, repository baselines, finalization, and interference evidence.
4. **Monitor projection**, assembled by Puppeteer into one small, JSON-plain `AgentMonitorState` for Godview and other live consumers.

The evidence machinery is deliberately private. It exists to make corrections, deduplication, resynchronization, and attribution honest; it is not a second product-facing semantic state machine. The only headline states exposed to fleet applications are `idle`, `working`, and `blocked`, with staleness and process liveness modeled orthogonally. Detailed source evidence remains available to the devkit, recorder, and downstream evidence consumers without becoming Godview's application contract.

The design is progressively adoptable. Puppeteer can introduce the new identities, private reducers, monitor projection, and Claude side-channel coverage before Spaghetti's RFC 012D observer is released. The current transcript watcher remains available behind a compatibility provider until a shadow migration proves parity.

## 2. Decision summary

This RFC proposes the following decisions:

1. Preserve the native-TUI architecture: one managed interactive process per runtime run, no shadow structured agent, and no terminal-screen parsing as semantic truth.
2. Distinguish a durable native conversation from a managed process invocation. One native session may span multiple runtime runs.
3. Replace the single-source `SessionRuntimeState` model with independently reduced runtime, semantic-observation, and workspace slices kept behind a private monitor accumulator.
4. Preserve source-owned identity, revisions, epochs, corrections, coverage, and evidence. A local sequence number must never erase upstream provenance.
5. Publish one `AgentMonitorState` whose headline status is exactly `idle | working | blocked`. Apps render it and do not reclassify lifecycle, tool, task, or permission state.
6. Publish notification-worthy transitions separately from current monitor state.
7. Treat real-time burn rate as a derived, freshness-qualified projection over usage observations, not as durable source truth.
8. Treat provider permission mode, provider session mode, and Puppeteer execution mode as separate concepts.
9. Model questions, plans, tasks, tools, actors, affiliations, and artifacts with enough private revision semantics to project the monitor correctly; do not expose the full semantic machinery as the fleet-board contract.
10. Make workspace baseline and finalization durable runtime-owned evidence. Keep contribution percentages and project attribution in VibeField.
11. Adopt Spaghetti's scoped observer only after version negotiation, epoch/replacement handling, and shadow comparison are available.

## 3. Context

### 3.1 What remains unchanged

The following decisions from [`draft/DESIGN.md`](../../draft/DESIGN.md) remain in force:

- The agent owns its terminal UI.
- Puppeteer owns the PTY, process, environment, lifecycle, and guarded input around that UI.
- PTY bytes are visually authoritative.
- Semantic facts come from side channels, durable native data, process/workspace observation, or explicitly qualified inference.
- Terminal screen content is not an authoritative semantic API.
- The renderer does not own PTYs or secrets.
- Unknown provider events are retained according to the configured recording and privacy policy.
- Native-TUI, structured, and ACP execution remain separate driver modes.

The phrase "one native session has one agent process" is narrowed by this RFC. The actual invariant is:

> A `RuntimeRun` owns at most one primary interactive agent process. Puppeteer never launches a shadow process to mirror that process. A provider-native conversation may be resumed by a later `RuntimeRun`.

### 3.2 Why the existing event model is insufficient

The current event model assumes one monotonic sequence and mostly one-way edges. The required observation surface introduces cases that violate those assumptions:

- A transcript fact may first arrive live and later arrive durably with identical semantic identity.
- A usage value may be corrected downward.
- A task, plan, actor, or affiliation may be retracted or replaced.
- An observer overflow may require complete replacement of its state.
- Hook events can announce a transition before it is committed and can sometimes block it.
- Multiple process runs may resume the same provider-native session.
- Team membership can arrive after an actor's earlier usage.
- A workspace can be shared or externally modified, reducing attribution quality without invalidating process facts.
- Some provider versions expose a fact while others do not.

A single `source` priority and a single `lastSequence` cannot express these conditions honestly.

### 3.3 Related requirements

This RFC incorporates three sets of requirements:

1. The Agent Runtime Observation Checklist in section 4.
2. The three-state product model described in [`docs/archive/MONITOR.md`](../../docs/archive/MONITOR.md).
3. The contribution ownership and claim model described in [`p008/draft/dicussion1.md`](../../../p008/draft/dicussion1.md).
4. The cross-topology identity, resync, provenance, finalization, and completeness requirements described in [`p008/draft/dicussion2.md`](../../../p008/draft/dicussion2.md).

It consumes the semantic contracts proposed by:

- Spaghetti RFC 012A: evidence and compatibility foundation.
- Spaghetti RFC 012C: runtime semantics and usage v2.
- Spaghetti RFC 012D: session-scoped live observation.

### 3.4 Reconciliation with `docs/archive/MONITOR.md`

This RFC adopts `docs/archive/MONITOR.md`'s product boundary: Puppeteer is a live monitor, the native TUI remains the full interaction surface, and the published monitor has only three headline states. It refines four implementation details in that draft:

1. Corrected cumulative usage may move downward. The displayed burn rate remains non-negative, but consumers cannot assume the current cumulative estimate is monotonic.
2. One global freshness timestamp is insufficient when hooks remain healthy but usage or plan observation has failed. The public monitor therefore adds compact per-family readiness and `asOf` timestamps, not per-facet state machines.
3. Multiple blockers can coexist. The monitor retains all permission, question, and failure blockers while projecting one `blocked` status.
4. Spaghetti resync and correction semantics require a private evidence accumulator and atomic family batches. This machinery stays behind the adapter/core boundary and does not expand the product state.

These refinements preserve the small monitor surface while preventing it from reporting a confident but stale or double-counted answer.

## 4. Requirements

### 4.1 Runtime observation checklist

| ID      | Requirement                  | Required behavior                                                                                                                                                                                       |
| ------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OBS-001 | Token usage and burn rate    | Show root usage and response/sample-boundary burn rates. Attribute usage to child actors and team members when evidence permits. Never imply per-token streaming when only boundary observations exist. |
| OBS-002 | Context window               | Show current root context usage and percentage. Show child context usage where supported. Preserve whether percentage is provider-supplied or derived.                                                  |
| OBS-003 | Model                        | Show stable provider model ID and display name. Detect mid-session changes at the first observable evidence boundary.                                                                                   |
| OBS-004 | Effort                       | Show configured intent and observed effective effort separately. Detect changes at the first observable evidence boundary.                                                                              |
| OBS-005 | Plan                         | Expose plan creation and revision in near real time, with actor attribution and evidence.                                                                                                               |
| OBS-006 | Session and permission modes | Expose provider session mode, provider permission mode, and Puppeteer execution mode independently. Preserve raw provider values.                                                                      |
| OBS-007 | Tasks                        | Expose task creation, updates, completion, failure, cancellation, and removal. Distinguish provisional transition signals from confirmed state.                                                         |
| OBS-008 | Subagents                    | Expose child actor creation, lifecycle, current activity, model, effort, context, usage, tasks, and parentage as available.                                                                             |
| OBS-009 | Agent teams                  | Expose team identity, membership revisions, member activity, and team aggregates without duplicating actor usage.                                                                                       |
| OBS-010 | Workflows                    | Expose workflow runs and actor affiliations, provide bounded workflow artifact retrieval, and include workflow-created actors in the same actor graph.                                                  |
| OBS-011 | Structured user input        | Detect when the agent asks the user a question, including choice and multi-choice options, and track pending, resolved, failed, cancelled, and superseded states.                                       |

### 4.2 Contribution and provenance requirements

Puppeteer must provide enough runtime-owned evidence for VibeField to make contribution claims without making those claims itself:

- Stable runtime-run and native-session correlation.
- Stable actor correlation where the provider supplies actor lineage.
- Machine-joinable caller and project references without imposing project policy.
- Normative workspace identity, allocation, isolation, baseline, and finalization.
- Explicit completeness and failure state for finalization.
- Durable, idempotent records of Puppeteer-owned actions.
- No default persistence of secrets, full prompts, transcript bodies, or raw diffs.
- Honest qualification when concurrent writers or external interference prevent exact attribution.

### 4.3 Bottom-line deployment constraint

All required observation must work with Godview hosting the provider's native TUI and Puppeteer observing from the side. The design must not require:

- Replacing Claude's interface with a generic chat interface.
- Running Claude in `--print` or structured mode alongside the interactive process.
- Injecting a second model conversation.
- Parsing visible terminal text as semantic truth.
- Modifying the Claude executable.
- Giving the renderer direct access to transcript files, hook secrets, or repositories.

### 4.4 Monitor product constraint

The published live product state has exactly three headline values:

```text
idle     -> assign it new work
working  -> inspect current activity and burn
blocked  -> resolve permission, question, or failure now
```

Detailed activity, metrics, actors, tasks, affiliations, liveness, and freshness explain those states; they do not create additional headline states. Cleanly ended sessions leave the board. Unexpected termination is a failure blocker until dismissed or removed. Staleness never changes the last evidence-backed state; it changes how confidently that state is rendered.

## 5. Non-goals

This RFC does not require Puppeteer to:

- Guarantee equal observation coverage across providers or provider versions.
- Provide exact per-token streaming when the native surface only updates at response or sample boundaries.
- Infer unavailable facts from terminal presentation.
- Own transcript parsing, historical search, or durable semantic indexing.
- Determine who authored a Git commit from a process event alone.
- Compute contribution percentages or decide project membership.
- Preserve every temporary commit in v1 workspace provenance.
- Expose arbitrary workflow, team, or provider files by path.
- Merge two provider processes into one runtime run.
- Turn provider hooks into lifecycle truth when the hook occurs before a blockable transition.
- Publish a general-purpose transcript, workflow, or semantic query model through `AgentMonitorState`.
- Expose process phases such as preparing, ready, interrupting, exited, or failed as additional user-facing monitor states.

## 6. Terminology and identity

### 6.1 Runtime run

A `RuntimeRun` is one Puppeteer-managed provider invocation. Its identity is allocated before workspace preparation and process spawn so failed starts are still recordable.

```ts
type RuntimeRunId = string;

interface ExternalRef {
  namespace: string;
  id: string;
  kind: 'project' | 'contributor' | 'workflow' | 'caller' | 'other';
}

interface RuntimeRunRef {
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  providerId: string;
  executionMode: AgentExecutionMode;
  terminalSessionId?: string;
  nativeSession?: NativeSessionRef;
  externalRefs: ExternalRef[];
}
```

`runtimeEpoch` is a Puppeteer-owned continuity generation. It increments when Puppeteer can no longer guarantee continuity of its own runtime signal stream for the same managed run, such as host recovery or explicit runtime-state reconstruction. A newly created runtime run starts at epoch 1.

Creation accepts a caller-scoped `creationRequestId` plus optional opaque `externalRefs`. Repeating a request ID with a compatible payload returns the same allocated run. Reusing it with a conflicting payload fails explicitly. Puppeteer persists and transports external references but does not interpret project or contributor policy from them.

### 6.2 Native session

A `NativeSessionRef` identifies the provider-native conversation or durable session. It may become known after spawn, may be corrected, and may be shared by multiple runtime runs through provider resume behavior.

```ts
interface NativeSessionRef {
  namespace: string;
  id: string;
  basis: 'configured' | 'observed' | 'inferred';
  quality: EvidenceQuality;
}
```

For Claude, the namespace is provider-scoped and stable, and the ID normally corresponds to Claude's session ID. Contract or source-format versioning is carried separately rather than changing the identity namespace. Puppeteer must not overwrite a runtime-run identity when the native-session identity becomes known.

### 6.3 Terminal session

`terminalSessionId` is a host/UI routing identity. It is not a provider-native session ID and is not a contribution identity. The current `runtimeSessionId` name should migrate to `terminalSessionId`, retaining a deprecated alias during compatibility support.

### 6.4 Actor run

An actor is a semantic participant in a native session: root agent, subagent, teammate, or workflow-created actor. Actor identity and lineage are owned by the semantic observation source.

```ts
interface ActorRunRef {
  rootSessionKey: string;
  runKey: string;
  role: 'root' | 'child';
  parentRunKey?: string;
  nativeSessionId?: string;
  nativeAgentId?: string;
  nativeAgentType?: string;
}
```

This shape mirrors Spaghetti's actor-run contract. `runKey` identifies an evidence-backed native actor lineage; it is not a Puppeteer `runtimeRunId` or an operating-system process ID. Team and workflow membership are affiliations over an actor, not new copies of the actor.

### 6.5 Observation attachment

An observation attachment connects one runtime run to one scoped semantic observer.

```ts
interface ObservationAttachmentRef {
  attachmentId: string;
  runtimeRunId: RuntimeRunId;
  observerContract: string;
  observerScopeEpoch: string;
}
```

The Spaghetti scope epoch is not the Puppeteer runtime epoch. Both must be retained.

### 6.6 Workspace instance

A `WorkspaceInstanceId` identifies one allocated working area and its lifecycle evidence. A path is an attribute, not the identity. A workspace may be reused only through an explicit new lifecycle or continuation record.

## 7. Evidence ownership

No source is globally highest priority. Authority is defined per fact family.

| Fact family                                         | Primary owner                                                                | Fast or corroborating sources                           | Explicitly not authoritative  |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| Process and PTY lifecycle                           | Puppeteer runtime                                                           | OS process observation                                  | Transcript inference          |
| Runtime execution mode and configured launch intent | Puppeteer runtime                                                           | Provider launch acknowledgement                         | Assistant response metadata   |
| Provider permission/session state                   | Native hooks or native transition evidence                                   | Statusline-triggered poll, transcript response evidence | Puppeteer execution mode     |
| Messages and response usage                         | Spaghetti semantic observer                                                  | Provider status samples                                 | PTY text                      |
| Model, effort, and context                          | Provider statusline for low latency; Spaghetti for durable response evidence | Launch intent                                           | Display text in the TUI       |
| Plans, tasks, tools, questions                      | Spaghetti semantic observer                                                  | Native hooks as provisional low-latency signals         | Terminal-screen inference     |
| Actor lineage and affiliations                      | Spaghetti semantic observer                                                  | Provider task status samples                            | OS process tree alone         |
| Workflow/team artifacts                             | Spaghetti bounded artifact API                                               | Provider configuration references                       | Arbitrary renderer file reads |
| Workspace allocation and isolation                  | Puppeteer workspace manager                                                 | OS/filesystem checks                                    | Transcript Git commands       |
| Commits, refs, trees, and diffs                     | Git/workspace facts                                                          | Transcript commands as supporting evidence              | Model statements              |
| Contribution claims and percentages                 | VibeField `ContributionService`                                              | Runtime, semantic, and Git evidence                     | Puppeteer or Spaghetti alone |

Conflicts are resolved inside the reducer for the affected fact family. A conflict must never be hidden by assigning one blanket priority to hooks, transcripts, or status lines.

## 8. Architecture

```text
┌──────────────────────────────── Native TUI process ────────────────────────────────┐
│                                                                                     │
│  PTY bytes ───────────────────────────────────────────────────────────────▶ terminal │
│                                                                                     │
│  hooks ───────────────┐                                                              │
│  statusLine ──────────┼──▶ adapter-local evidence join/reducer                       │
│  subagentStatusLine ──┘                                                              │
│                                                                                     │
│  transcript/native files ──▶ Spaghetti scoped observer ──▶ semantic revisions ──────┤
└─────────────────────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼
                                  MonitorObservationBatch
                                           │
 runtime lifecycle signals ────────────────┼──▶ private MonitorAccumulatorState
 workspace manager + Git observation ──────┘                │
                                                            ├──▶ projectAgentMonitorState
                                                            │       └──▶ AgentMonitorState
                                                            │              └──▶ Godview
                                                            ├──▶ MonitorNotification stream
                                                            └──▶ devkit evidence view

 durable runtime/workspace records ─────────────────────────────▶ recorder / fieldd
```

### 8.1 Plane A: runtime signals

The runtime signal plane records facts whose lifecycle Puppeteer directly owns or observes immediately:

- Run allocated, preparing, spawned, running, stopping, exited, or failed.
- PTY attached, resized, detached, or terminated.
- Prompt submission intent and receipt.
- Hook receipt and provisional transition signal.
- Configured model, effort, permission, and execution intent.
- Low-latency root and child status samples.
- Observation-provider attach, ready, degraded, resync, and detached state.

Runtime signals use stable identity across replay:

```ts
interface RuntimeSignalEnvelope<TSignal extends RuntimeSignal> {
  schemaVersion: number;
  eventId: string;
  runtimeRunId: RuntimeRunId;
  runtimeEpoch: number;
  sequence: number;
  observedAt: string;
  effectiveAt?: string;
  providerId: string;
  nativeSessionClaim?: NativeSessionRef;
  actorCorrelation?: ActorRunRef;
  source: RuntimeSignalSource;
  evidence: EvidenceRef[];
  signal: TSignal;
}
```

`eventId` is allocated once and retained through persistence and replay. `sequence` orders one runtime epoch but is not a cross-source deduplication key.

### 8.2 Plane B: semantic observations

Spaghetti events remain source-owned records inside the adapter's evidence join. Puppeteer may wrap them for internal transport, but it must preserve at least:

- Contract version.
- Source event ID.
- Semantic revision reference.
- Observer scope epoch.
- Source instance, object, generation, and cursor.
- Root session and actor references.
- Attribution and affiliations.
- Bootstrap, live, or correction phase.
- Evidence and native evidence references.
- Coverage and capability status.

A Puppeteer delivery ID may be added, but it never replaces the upstream identity. Provider-specific Spaghetti record types do not cross the adapter boundary. The adapter publishes provider-neutral monitor-family revisions or an atomic `MonitorObservationBatch`, retaining generic evidence references for diagnostics and durable correlation.

Semantic observation state is reduced by the family semantics negotiated with Spaghetti:

- Revisioned entity.
- Owned-set snapshot.
- Correlated lifecycle.
- Current-generation log.
- Usage contribution.

The adapter-to-core boundary is an internal atomic batch, not a raw Spaghetti record stream:

```ts
interface MonitorObservationBatch {
  schemaVersion: 1;
  batchId: string;
  runtimeRunId: RuntimeRunId;
  producer: { id: string; epoch: string; sequence?: number; contractVersion?: string };
  phase: 'bootstrap' | 'live' | 'correction' | 'resync';
  observedAt: string;
  effectiveAt?: string;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  readiness?: 'loading' | 'ready' | 'degraded';
  updates: MonitorFamilyUpdate[];
  sourceWatermarks: SourceWatermark[];
  evidence: EvidenceRef[];
  capabilities?: ObservationCapability[];
  coverage?: ObservationCoverage[];
}

type MonitorFamilyUpdate =
  | {
      family: MonitorMetricFamily;
      operation: 'upsert';
      key: string;
      value: MonitorFamilyValue;
    }
  | {
      family: MonitorMetricFamily;
      operation: 'retract';
      key: string;
    }
  | {
      family: MonitorMetricFamily;
      operation: 'replace';
      values: Array<{ key: string; value: MonitorFamilyValue }>;
      coverage: EvidenceCompleteness;
    };
```

All updates in one batch become visible atomically. `replace` is the bridge from Spaghetti owned-set/scope-epoch semantics into the private monitor accumulator. This batch is not exported to renderer applications.

### 8.3 Plane C: workspace provenance

Workspace evidence is runtime-owned and independently versioned:

```ts
interface WorkspaceProvenanceState {
  workspaceInstanceId: string;
  runtimeRunId: RuntimeRunId;
  repository?: RepositoryIdentity;
  allocation: WorkspaceAllocationRecord;
  baseline?: WorkspaceBaselineRecord;
  finalization?: WorkspaceFinalizationRecord;
  isolation: ObservedValue<WorkspaceIsolation>;
  interference: WorkspaceInterferenceObservation[];
  completeness: EvidenceCompleteness;
}
```

Workspace finalization is a required lifecycle step. If it cannot complete, the state is `incomplete` with structured failure evidence; absence is not interpreted as a clean, unchanged workspace.

### 8.4 Derived runtime projection

The three evidence planes reduce into a private accumulator. This state contains whatever maps, tombstones, source epochs, revision keys, provisional transitions, coverage, and evidence references are required for correctness:

```ts
interface MonitorAccumulatorState {
  run: RunControlState;
  semantic: SemanticObservationState;
  workspace: WorkspaceProvenanceState;
  notifications: NotificationBookkeepingState;
  watermarks: RuntimeWatermarks;
}
```

`MonitorAccumulatorState` is not a public application contract. It may evolve with provider evidence and Spaghetti contracts. The devkit may expose a diagnostic representation, but applications cannot depend on its shape.

### 8.5 Published `AgentMonitorState`

Godview consumes one provider-neutral, JSON-plain monitor state:

```ts
type AgentMonitorStatus = 'idle' | 'working' | 'blocked';

interface MonitorBlockerBase {
  id: string;
  detail?: string;
  since: string;
  actorRunKey?: string;
}

type MonitorBlocker =
  | (MonitorBlockerBase & {
      kind: 'permission';
      permission?: { requestId: string; tool?: string };
    })
  | (MonitorBlockerBase & {
      kind: 'question';
      questions: Array<{
        id?: string;
        prompt: string;
        options?: Array<{ label: string; description?: string }>;
        allowMultiple?: boolean;
        allowFreeForm?: boolean;
      }>;
    })
  | (MonitorBlockerBase & {
      kind: 'failure';
      failure?: { code?: string; recoverable?: boolean };
    });

type MonitorMetricFamily =
  | 'status'
  | 'usage'
  | 'context'
  | 'model'
  | 'effort'
  | 'mode'
  | 'planning'
  | 'delegation'
  | 'workflow'
  | 'compaction'
  | 'environment';

type MonitorBoundedCollection =
  'blockers' | 'planSteps' | 'tasks' | 'subagents' | 'teammates' | 'workflows' | 'artifactRefs' | 'questionOptions';

interface AgentMonitorState {
  schemaVersion: number;
  runtimeEpoch: number;
  revision: number;
  runtimeRunId: RuntimeRunId;

  status: AgentMonitorStatus;
  statusSince: string;
  blockers: MonitorBlocker[];
  activity?: {
    kind: 'starting' | 'responding' | 'reasoning' | 'tool' | 'delegating' | 'compacting' | 'other';
    line: string;
    since: string;
  };

  usage: {
    cumulativeTokens?: number;
    burnRatePerMin?: number;
    burnRateWindowMs?: number;
    burnRateBoundary?: 'response' | 'sample' | 'mixed';
    samples: Array<{ at: string; cumulativeTokens: number }>;
    asOf?: string;
  };
  context?: {
    usedTokens?: number;
    capacityTokens?: number;
    usedPercent?: number;
    percentageSource: 'provider' | 'derived' | 'unavailable';
    asOf: string;
  };

  model?: { id: string; displayName?: string; asOf?: string };
  effort?: { value: string; configured?: string; asOf?: string };
  modes: {
    execution: AgentExecutionMode;
    providerSession?: { raw: string; normalized?: string };
    providerPermission?: { raw: string; normalized?: string };
    asOf?: string;
  };

  plan?: {
    updatedAt: string;
    actorRunKey?: string;
    steps: Array<{ text: string; status: string }>;
  };
  tasks: Array<{
    id: string;
    actorRunKey?: string;
    description?: string;
    status: string;
    teamName?: string;
    teammateName?: string;
  }>;
  subagents: Array<{
    id: string;
    actorRunKey?: string;
    type?: string;
    active: boolean;
    activity?: string;
    cumulativeTokens?: number;
    burnRatePerMin?: number;
    contextPercent?: number;
    modelId?: string;
    modelIntent?: 'configured' | 'observed';
    effort?: string;
    effortIntent?: 'configured' | 'observed';
  }>;
  team?: {
    id?: string;
    name?: string;
    memberId?: string;
    memberName?: string;
    teammates: Array<{
      id: string;
      name?: string;
      actorRunKey?: string;
      runtimeRunId?: RuntimeRunId;
      idle?: boolean;
      activity?: string;
      cumulativeTokens?: number;
      burnRatePerMin?: number;
      contextPercent?: number;
      modelId?: string;
      modelIntent?: 'configured' | 'observed';
      effort?: string;
      effortIntent?: 'configured' | 'observed';
      activityProvisional?: boolean;
      provisional?: boolean;
    }>;
    provisional?: boolean;
  };
  workflows: Array<{
    id: string;
    name?: string;
    active: boolean;
    actorRunKeys: string[];
    artifactRefs: ArtifactRef[];
  }>;

  /** Number omitted from deterministic bounded public collections. */
  omitted?: Partial<Record<MonitorBoundedCollection, number>>;

  compaction: { active: boolean; lastAt?: string; count: number };
  environment: {
    cwd?: string;
    git?: AgentGitState | null;
    worktrees: string[];
  };
  session: {
    nativeSessionId?: string;
    startedAt?: string;
  };
  freshness: {
    lastEvidenceAt?: string;
    level: ObservationLevel;
    families: Partial<
      Record<
        MonitorMetricFamily,
        {
          support: 'supported' | 'degraded' | 'unsupported';
          asOf?: string;
        }
      >
    >;
  };
  alive: boolean;
}
```

The monitor is intentionally lossy. It contains what a fleet operator needs live, not every transcript entity or evidence revision. Fine-grained provenance stays private, while compact per-family support and `asOf` metadata prevent a fresh hook rail from making a dead usage rail look healthy.

Every public collection is deterministically bounded. When a limit is exceeded, `omitted` reports the number left out so a compact board never presents a complete-looking partial list. Root/team aggregates are calculated from the complete private actor set before child display rows are bounded.

`usage.cumulativeTokens` is the latest corrected estimate and may decrease after a source correction. Consumers must not assume monotonicity. Burn rate is never rendered as a negative rate.

`freshness.lastEvidenceAt` is the host receipt time of the latest accepted evidence; each family `asOf` describes the latest value for that metric family. Core exports the shared freshness classifier and threshold policy so apps do not invent incompatible stale states. Freshness is a rendering qualifier and never a fourth status.

### 8.6 Status and activity projection

One core function computes `status`, `statusSince`, `blockers`, and `activity`. Apps must not derive an alternate vocabulary.

Status precedence is deterministic:

1. `blocked` when at least one permission, question, or sticky failure blocker exists.
2. `working` while starting, a turn/response/reasoning/tool/child-actor activity is live, or compaction is active.
3. `idle` when the session is alive and observed with no active work or blocker.

An allocated or starting run projects `working` with `activity.kind = 'starting'`; startup is not exposed as a fourth status. Before semantic observation is ready, freshness/coverage shows the unavailable families rather than presenting an unqualified idle session.

Task or plan existence alone does not imply `working`. This avoids the current behavior where a persistent task can keep a session working forever. On providers without reliable turn boundaries, fresh tool, response, reasoning, or child-activity evidence opens a bounded working lease that closes on matching terminal evidence or staleness policy.

Multiple blockers are retained so resolving a permission does not hide a still-open question. The core provides deterministic ordering and the app may emphasize the first without dropping the rest.

Failure blockers persist until a new turn proves recovery, the user dismisses them, or the session leaves the board. A cleanly ended session is removed after its final notification. Unexpected process death remains `blocked` with `alive: false` until acknowledged or removed. Observation-rail failure does not create a process failure; it makes the affected family stale.

A provider turn failure or unexpected process death can open a failure blocker. An individual `tool.failed` event does not block the session unless provider evidence says the turn failed or user action is required.

Activity is a single line selected from current evidence, with provider-supplied tool presentation preferred over generic wording. Responding, reasoning, tool execution, delegation, and compaction are activity flavors, not additional states.

### 8.7 Notifications are not state

Creation and transition notices use a separate idempotent stream:

```ts
interface MonitorNotification {
  notificationId: string;
  runtimeRunId: RuntimeRunId;
  at: string;
  type:
    | 'blocked.entered'
    | 'plan.created'
    | 'plan.updated'
    | 'task.created'
    | 'task.completed'
    | 'subagent.started'
    | 'subagent.stopped'
    | 'team.observed'
    | 'team.member-added'
    | 'team.member-removed'
    | 'team.member-idle'
    | 'workflow.started'
    | 'workflow.completed'
    | 'compaction.started'
    | 'compaction.completed'
    | 'cwd.changed'
    | 'worktree.created'
    | 'worktree.removed'
    | 'session.ended';
  summary?: string;
}
```

Notifications may be toasted, fed, or recorded. Replaying a notification never mutates current state twice, and current state can always be rebuilt without replaying presentation side effects.

Bootstrap and full-replacement batches update current state but do not emit historical creation toasts. Notification emission begins after the readiness barrier and is keyed by accepted live transition identity. Corrections can amend state without replaying the original notification.

## 9. Common evidence model

### 9.1 Observed values

```ts
type EvidenceQuality = 'exact' | 'strong' | 'derived' | 'estimated' | 'inferred' | 'unknown';
type EvidenceCompleteness = 'complete' | 'partial' | 'unavailable';

interface ObservationProvenance {
  observedAt: string;
  effectiveAt?: string;
  source: EvidenceSource;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  evidence: EvidenceRef[];
}

type ObservedValue<T> =
  | (ObservationProvenance & {
      availability: 'available';
      value: T;
    })
  | (ObservationProvenance & {
      availability: 'unavailable';
      reason: string;
    });
```

`observedAt` answers when Puppeteer learned the value. `effectiveAt` answers when the source says it became effective. They must not be collapsed. These types belong to the private evidence and diagnostic contracts; the public monitor projects only the compact value, `asOf`, and family readiness needed by the operator.

### 9.2 Capability and coverage

Unsupported and temporarily unavailable are different states:

```ts
interface ObservationCapability {
  family: ObservationFamily;
  support: 'supported' | 'degraded' | 'unsupported';
  actorScope: 'root' | 'current-actors' | 'session';
  latency: 'hook' | 'sample' | 'response' | 'file-flush' | 'historical';
  source: string;
  contractVersion?: string;
  limitations: string[];
}

interface ObservationCoverage {
  family: ObservationFamily;
  completeness: EvidenceCompleteness;
  asOf: string;
  actor?: ActorRunRef;
  reason?: string;
}
```

The adapter and monitor projector map these details into `AgentMonitorState.freshness.families`. The devkit may show the full capability and coverage records. Product UIs use the compact projection to show `unsupported`, `unavailable`, `partial`, or `stale` rather than silently omitting a panel or showing zero.

### 9.3 Corrections and replacement

Corrections are ordinary source-owned revisions. They may reduce numeric values, change affiliation, or remove an entity.

For a Spaghetti scope-epoch replacement, the adapter must:

1. Continue draining the observer event and control channels before awaiting readiness.
2. Build replacement state in a staging semantic slice.
3. Reject old-epoch observations after the replacement barrier.
4. Atomically swap the complete adapter-owned semantic slice at `resync_complete`.
5. Remove observer-owned entities absent from the replacement.
6. Publish one atomic provider-neutral monitor batch after the swap.
7. Preserve runtime and workspace slices in the core accumulator.

Merging a replacement snapshot into old semantic state is prohibited.

## 10. Observation-family semantics

### 10.1 Usage and burn rate

Canonical usage is keyed by response and actor. The four qualified token buckets are retained independently when the provider supplies them:

- Input.
- Output.
- Cache read.
- Cache creation.

Unknown buckets remain unknown. They are not coerced to zero.

Burn rate is an ephemeral projection over live post-readiness usage contributions and/or explicitly compatible status samples:

```ts
interface UsageRateProjection {
  actor?: ActorRunRef;
  affiliation?: AffiliationRef;
  windowMs: number;
  inputTokensPerMinute?: number;
  outputTokensPerMinute?: number;
  totalTokensPerMinute?: number;
  sampleCount: number;
  asOf: string;
  quality: EvidenceQuality;
}
```

Rules:

1. Bootstrap establishes a baseline and produces no burn spike.
2. A response correction replaces the earlier response contribution.
3. A downward correction does not render as negative burn.
4. A low-latency cumulative sample series must not be added to canonical response usage.
5. Late actor or team affiliation reprojects grouping; it does not add tokens again.
6. Team totals aggregate distinct actor contributions once.
7. The UI displays the sampling boundary and age.

`AgentMonitorState.usage` is the rollup for one native session and includes attributable in-session child/subagent usage. Entries in `subagents` are breakdowns of that total and must not be added again. A teammate that runs as a separate managed session has its own `AgentMonitorState`; a team view sums each member session once through a shared aggregation helper.

Default windows will be selected by the Godview design, not persisted as semantic facts.

### 10.2 Context window

```ts
interface ContextWindowObservation {
  usedTokens?: number;
  capacityTokens?: number;
  usedPercentage?: number;
  percentageSource: 'provider' | 'derived' | 'unavailable';
}
```

Provider-supplied percentage is preferred when available. A derived percentage requires both compatible numerator and denominator evidence. Context usage is not assumed to equal billed usage or lifetime actor token count.

### 10.3 Model and effort

Model state preserves both a stable provider ID and user-facing display value:

```ts
interface ModelObservation {
  providerModelId: string;
  displayName?: string;
}
```

Configured launch intent and observed effective state are separate facts. Response metadata proves what applied to that response, not necessarily the exact instant a UI setting changed. A transition is reported at the earliest supported observation boundary with an honest `effectiveAt` and quality.

The same configured-versus-observed rule applies to effort.

### 10.4 Execution, session, and permission modes

The generic name `sessionMode` must not conflate three state machines:

- `executionMode`: Puppeteer driver mode such as `native-tui`, `structured`, or `acp`.
- `providerSessionMode`: provider-native high-level operating state when exposed.
- `providerPermissionMode`: provider-native permission policy.

Provider mode observations preserve:

```ts
interface ProviderModeObservation {
  raw: string;
  normalized?: string;
}
```

Unknown future provider values are retained rather than rejected. Labels such as Plan, Auto, Manual, and Accept Edits are UI mappings over provider state, not the storage contract.

### 10.5 Plans and tasks

Plans are revisioned entities. A new plan, modification, replacement, and removal are observable independently.

Tasks are revisioned entities plus lifecycle state. Required normalized states are:

- Proposed or provisional.
- Pending.
- In progress.
- Completed.
- Failed.
- Cancelled.
- Removed.
- Unknown provider state.

Provider hooks that run before a blockable transition create a provisional observation. Confirmation comes from a post-transition event, a durable semantic revision, or a complete owned-set replacement. A timeout can make a provisional signal stale; it cannot promote it to confirmed.

### 10.6 Structured user interactions

Questions and permissions are separate interaction families.

```ts
interface StructuredUserInteraction {
  interactionId: string;
  actor: ActorRunRef;
  kind: 'choice' | 'multi-choice' | 'free-form' | 'mixed';
  questions: StructuredQuestion[];
  state: 'pending' | 'resolved' | 'failed' | 'cancelled' | 'superseded';
  answerEvidence?: EvidenceRef[];
}
```

For Claude, `PreToolUse` for `AskUserQuestion` creates a low-latency provisional pending interaction containing the typed question and options. Spaghetti's structured interaction revision provides canonical identity and state. Matching tool-result or semantic evidence resolves it.

Godview's `blocked` state is derived from at least:

- Pending permission interaction.
- Pending structured user interaction.

The projected blocker retains its kind and, for questions, the typed options needed to answer. The UI must distinguish blocker kinds so the user knows whether to approve an operation, answer a question, or inspect a failure.

### 10.7 Actors, subagents, teams, and workflows

All semantic participants use the actor graph. `actor.kind` may describe root, child, or teammate behavior, but team and workflow relationships are affiliations:

```ts
interface ActorAffiliationRevision {
  actor: ActorRunRef;
  affiliation: AffiliationRef;
  role?: string;
  effectiveAt?: string;
  operation: 'upsert' | 'retract';
}
```

Actor activity is assembled from lifecycle, current tool/task, status samples, recent response activity, and provider state. Lack of recent transcript bytes is not itself proof that an actor stopped.

Team and workflow aggregates are views over distinct actors. The same actor appearing in a workflow and team remains one usage contributor.

Team projection reconciles durable canonical affiliation identities with explicit provider-native aliases from low-latency hooks. Display names are never identity keys. Membership presence and member activity are independent claims: a provisional idle hook may update activity without replacing a durable actor join, and a durable removal still wins over stale activity. Joined actor usage, burn rate, context, observed model, observed effort, and current activity are projected directly onto the teammate row. Membership and activity provisionality remain separately visible.

Full configured-roster coverage remains fail-closed until the semantic observer exposes a policy-safe, revisioned team-definition surface. The minimum upstream payload is canonical and native team/member identity, lead identity, member name/type, configured model/backend when present, membership operation/completeness, and an effective boundary. It must not copy team prompts, cwd values, terminal pane IDs, inbox text, or other native configuration bodies into monitor state. A bounded artifact API alone is sufficient for drill-down only if a typed revision/invalidation event still tells the live observer when to reread it. Puppeteer does not bypass this contract by tailing Claude's team files directly.

Team and workflow definitions are themselves revisioned affiliation entities. Their first supported observation establishes `firstObservedAt`; it is not presented as an exact creation time unless native evidence supplies one. Absence from partial coverage is not deletion. Absence from a complete owned-set replacement is.

### 10.8 Workflow artifacts

Workflow definitions, journals, and team configurations are exposed through bounded artifact references:

```ts
interface ArtifactRef {
  artifactId: string;
  family: 'workflow-definition' | 'workflow-journal' | 'team-config' | 'other';
  mediaType?: string;
  byteLength?: number;
  contentHash?: string;
  availability: 'readable' | 'metadata-only' | 'unavailable';
}

type MonitorArtifactReadResult =
  | {
      status: 'ok';
      artifact: ArtifactRef;
      encoding: 'utf8' | 'base64';
      content: string;
    }
  | {
      status: 'denied' | 'unavailable' | 'too-large';
      artifact?: ArtifactRef;
      message?: string;
    };
```

Content is read only through an explicit bounded `readArtifact` operation using an opaque adapter-issued ID. The operation rejects oversize content instead of returning an ambiguous truncation, and records metadata rather than content in the audit log. Godview must not submit or receive arbitrary native paths, and Puppeteer must not recursively scan provider directories to satisfy this feature.

## 11. Claude adapter design

### 11.1 Observation sources

The Claude native-TUI adapter will combine four side channels:

1. Native hooks for low-latency lifecycle, tool, prompt, task, mode, and question signals.
2. `statusLine` for root model, effort, context, and related status samples.
3. `subagentStatusLine` for visible child task/actor model, effort, context, usage samples, and status where supported.
4. Spaghetti's scoped observer for revisioned transcript-backed semantics and bounded artifacts.

The adapter continues to forward the user's configured statusline and subagent-statusline commands. Puppeteer observes the same payload and delegates without taking ownership of the user's presentation.

### 11.2 Normalization rules

The Claude normalizer must:

- Preserve raw payload and provider version subject to recording policy.
- Preserve `permission_mode`, `effort`, model ID, and native timestamps where supplied.
- Use provider-supplied context percentage instead of recomputing it when available.
- Treat `AskUserQuestion` as structured input, not merely a generic tool call.
- Mark pre-transition task, subagent, and teammate events provisional when they can be blocked.
- Correlate tool lifecycles by native tool-use identity.
- Correlate actors through Spaghetti actor references rather than process IDs.
- Emit an observation poll hint after a relevant hook without waiting for periodic polling.
- Retain unknown hook types without inventing normalized meaning.
- Observe worktree topology through the workspace/Git rail rather than registering a provider hook whose presence changes native worktree behavior.

### 11.3 Fast overlay versus canonical semantics

Statusline and hook observations provide a fast overlay. Spaghetti revisions provide durable/correctable semantic state. Both may coexist in private adapter state with their provenance until they can be safely reconciled. Only their current monitor projection crosses the adapter boundary.

The reducer does not assume that every fast observation will later have a one-to-one transcript record. It also does not double count the two sources.

### 11.4 Current and future Spaghetti providers

Introduce an adapter-internal abstraction:

```ts
interface SemanticObservationProvider {
  capabilities(): Promise<ObservationCapability[]>;
  attach(request: ObservationAttachRequest): Promise<SemanticObservationHandle>;
}
```

Authoritative implementation:

- `SpaghettiScopedObservationProvider`: implements RFC 012D events, readiness,
  resync, polling, provider-neutral monitor projection, and explicit artifact
  unavailability until bounded retrieval is supported.

The former `LegacyClaudeTranscriptProvider` and dual-provider shadow wrappers
were removed on 2026-08-24. A Claude session has one transcript-derived owner;
hooks and status channels remain independent fast evidence rails.

### 11.5 Dependency and failure boundary

The live monitor binds an in-process, headless Spaghetti SDK/N-API frontend. It does not query a separately running history daemon for current status. The daemon may serve history, search, and cross-session analytics, but live operational metrics have one owner: `AgentMonitorState`.

The adapter owns the vendor-specific join among hooks, status samples, and transcript records. A neutral middle package would erase the record types and correlation behavior required to perform that join. Shared provider-neutral reducers and monitor contracts remain in core.

Adapters pin one exact compatible Spaghetti version. An upgrade is an explicit integration event with fixture, epoch/correction, and native-addon validation. If the observer fails, the adapter stops producing evidence for the affected families; the process remains alive and those families become stale. It must not synthesize `process.exited`.

## 12. Runtime observation API

The monitor state is small enough to publish as a full replacement on each coalesced revision. This prevents apps from implementing another partial reducer and keeps reconnection straightforward.

```ts
interface AgentMonitorHandle {
  states: AsyncIterable<AgentMonitorState>;
  notifications: AsyncIterable<MonitorNotification>;
  ready: Promise<AgentMonitorState>;
  current(): AgentMonitorState | undefined;
  readArtifact(artifactId: string, options?: { maxBytes?: number }): Promise<MonitorArtifactReadResult>;
  close(): Promise<void>;
}
```

Runtime control exposes an idempotent `acknowledgeFailureBlocker(runtimeRunId, blockerId)` operation. It may dismiss a sticky failure notice; it cannot dismiss or pretend to resolve a provider-owned permission or question.

Consumer order is normative:

1. Create the monitor handle.
2. Begin draining `states` and `notifications`.
3. Await `ready`.
4. Install the returned state.
5. Install only subsequently received states with a newer `(runtimeEpoch, revision)` tuple for the same `runtimeRunId`.

The runtime may coalesce high-frequency evidence into a bounded publication cadence, but blockers and session termination bypass ordinary metric coalescing. Source watermarks remain private to the accumulator; renderers order full states only by runtime epoch and monitor revision.

Multiple consumers must not cause multiple destructive drains of an underlying source. Runtime observation is fan-out with bounded consumer policies and explicit internal resync/degradation.

## 13. Reducers and projection

The runtime is decomposed into source-specific private reduction, provider-neutral bookkeeping, and one public projection:

```text
AdapterEvidenceReducer
  hooks + status samples + scoped semantic revisions
  -> AdapterMonitorEvidenceState

RunBookkeepingReducer
  runtime signals -> RunControlState

WorkspaceProvenanceReducer
  workspace records -> WorkspaceProvenanceState

MonitorAccumulatorReducer
  adapter batches + run state + workspace state
  -> private MonitorAccumulatorState

projectAgentMonitorState
  private accumulator -> public AgentMonitorState

projectMonitorNotifications
  accepted transitions -> idempotent MonitorNotification[]
```

Required reducer properties:

- Deterministic replay.
- Duplicate tolerance by stable event or semantic revision identity.
- Correct replacement and retraction.
- No numeric monotonicity assumption for corrections.
- Unknown-event preservation.
- Per-family capability and coverage.
- No cross-plane deletion during observer replacement.
- Stable actor aggregation independent of affiliation arrival order.
- Idempotent workspace finalization records.
- Exactly three projected headline states.
- A single deterministic status/activity projection shared by every app.
- No status change caused solely by renderer time or terminal-screen parsing.

The current `AgentEvent` stream remains available for adapters, diagnostics, and compatibility. A small additive event vocabulary may carry monitor inputs such as token samples, plan updates, compaction, and teammate activity, but the union is not expanded into a public semantic database.

The current `SessionRuntimeState` remains as private bookkeeping and a deprecated compatibility accessor while apps migrate. Its maps and tombstones may survive internally; its serialized shape is not the v2 application contract.

## 14. Godview contract

Godview consumes only `AgentMonitorState`, `MonitorNotification`, and runtime control APIs. It does not import provider payload types or Spaghetti reducer types; `SessionRuntimeState` remains isolated to the rollback bridge until cutover.

The board bubble displays exactly:

- `idle` — assign more work.
- `working` — show the one-line activity and burn rate.
- `blocked` — show the highest-priority blocker and the count of any others.

The detail surface may display:

- Run and native-session continuity.
- Compact subagent, team, and workflow summaries.
- Usage totals and freshness-qualified rate windows.
- Context percentage and pressure.
- Current model ID/display name and effort.
- Execution, provider session, and provider permission modes separately.
- Current plan and task snapshot.
- Current root and child activity summaries.
- Pending question versus pending permission.
- Workflow artifact availability.
- Compact per-family readiness and staleness.
- Current cwd and worktree topology.

Godview may aggregate separate teammate session monitor states into a team view using stable affiliation and runtime references. It must not sum the same actor twice, and shared aggregation helpers belong outside renderer components.

Provider-specific rendering may enhance a generic view, but it may not become the only path to the underlying fact. `classifyAgentStatus`, `agentDetail`, `statusTone`, `liveLabel`, duplicate `serializeState` functions, and equivalent app-local projections are removed after migration.

## 15. Workspace provenance and contribution boundary

### 15.1 Workspace baseline

Before the agent can write, Puppeteer records:

- `workspaceInstanceId` and `runtimeRunId`.
- Policy-safe repository identity.
- Canonical worktree and common Git directory identity where safe.
- Allocation and isolation mode.
- Initial HEAD and ref.
- Initial index/worktree dirty-state fingerprints and summaries.
- Known concurrent writers or sharing conditions.
- Observation timestamps and completeness.

### 15.2 Workspace finalization

On normal or abnormal termination, Puppeteer attempts to record:

- Final HEAD and ref.
- Final index/worktree dirty-state fingerprints and summaries.
- Files-touched and short-stat style summaries where policy allows.
- Finalization timestamp.
- External interference and conflict evidence.
- Complete, partial, failed, or unavailable finalization state.

Baseline and final HEAD are sufficient for the v1 question "which commits are reachable at completion?" Continuous ref observation is optional until a consumer requires every temporary commit.

### 15.3 Durable own-action records

At minimum, persist idempotent records for:

- Runtime run allocated.
- Workspace allocated.
- Workspace baseline captured.
- Process spawned.
- Native-session correlation established or corrected.
- Process exited.
- Workspace finalized or finalization failed.

Every record includes:

- Schema version.
- Stable record ID.
- Runtime run ID and epoch.
- Native-session claim when known.
- Workspace instance ID when applicable.
- Observed/effective timestamps.
- Replacement or correction relationship where applicable.
- Quality, completeness, and evidence references.

### 15.4 VibeField ownership

Puppeteer exports evidence; it does not emit contribution percentages.

VibeField's `ContributionService` joins:

- Spaghetti durable semantic evidence.
- Puppeteer run, actor-correlation, and workspace evidence.
- Git facts for commits, refs, trees, diffs, files, and line metrics.
- Application-owned project and contributor identity.

The resulting contribution claim states target, relation, basis, quality, metrics, scope, and evidence references. Commit production, execution of a commit, Git author, and Git committer remain distinct relations.

In v1, exact or strong contribution claims require a managed isolated workspace, successful baseline/finalization, and accepted/reachable commits. Shared or externally modified workspaces lower quality rather than being presented as exact.

## 16. Migration plan

### Phase 0: Ratify contracts and terminology

- Ratify this RFC.
- Amend [`draft/DESIGN.md`](../../draft/DESIGN.md) and `CLAUDE.md` to use runtime-run/native-session terminology.
- Define public `AgentMonitorState`, `MonitorNotification`, and `AgentMonitorHandle` contracts in `packages/core`.
- Mark evidence/accumulator types internal and keep provider-native record types inside adapters.
- Freeze compatibility names and deprecation behavior.
- Add checklist-to-fixture traceability.

### Phase 1: Identity and runtime records

- Allocate `runtimeRunId` before workspace and spawn.
- Add `runtimeEpoch`, stable runtime event IDs, `creationRequestId`, and opaque `externalRefs`.
- Rename `runtimeSessionId` conceptually to `terminalSessionId` with a compatibility alias.
- Stop mutating runtime identity when native session identity becomes known.
- Add durable own-action record schema.

### Phase 2: Private accumulator and monitor projection

- Add adapter, run-bookkeeping, and workspace reducers behind `MonitorAccumulatorState`.
- Add the one core status/activity projector and notification projector.
- Introduce the race-free `AgentMonitorHandle` with full-state revisions.
- Preserve source identity and coverage privately while projecting compact family readiness.
- Retain `SessionRuntimeState` as private bookkeeping and a deprecated compatibility accessor.
- Add monitor-state and notification IPC without removing existing IPC.

### Phase 3: Monitor metric coverage

- Extend root statusline normalization for model, provider context percentage, and effort.
- Add user-preserving `subagentStatusLine` multiplexing.
- Capture provider modes and configured intent separately.
- Add structured `AskUserQuestion` state.
- Qualify blockable task/subagent/team hooks as provisional.
- Map plan, task, compaction, teammate, cwd, and worktree observations without treating those concepts as headline statuses.
- Add observation poll hints.
- Preserve permission absence-closure at a trustworthy turn boundary and emit a diagnostic when a permission outlives that boundary.
- Make fallback tool-call identity collision-safe for repeated same-tool calls in one prompt.
- Rebind native-session identity after legitimate provider rotation such as Claude `/clear` without terminating the runtime run.
- Remove adapter-generated `process.exited` events that actually mean an observation or control channel died.
- Map equivalent usage and compaction sources in Codex, Grok, Kimi, OpenCode, Hermes, and ACP as their verified surfaces permit.

This phase does not depend on the unreleased Spaghetti RFC 012D observer.

### Phase 4: Workspace provenance

- Add stable workspace identity and repository identity.
- Capture normative baseline and finalization.
- Record isolation, concurrency, interference, and completeness.
- Export idempotent own-action records for VibeField joins.

### Phase 5: Spaghetti scoped observer

- Implement contract negotiation before source access.
- Attach the RFC 012D provider behind a feature flag.
- Implement event draining, readiness barrier, scope epochs, staging, and atomic replacement.
- Preserve semantic revision and native evidence references end to end.
- Publish only an atomic provider-neutral monitor batch after a semantic replacement.
- Shadow legacy and new providers and compare family-level digests.
- Exercise overflow and resync under slow consumers.

Cutover requires released SDK support and all gates in section 17.

### Phase 6: Godview v2

- Move Godview to full `AgentMonitorState` revisions and `MonitorNotification`.
- Render only `idle`, `working`, and `blocked` as headline states.
- Add compact subagent/team/workflow and checklist detail views.
- Add family staleness and unsupported rendering without inventing new statuses.
- Delete the legacy state serializer, classifier, and detail derivation after the rollback window.
- Keep the v1 serialized-state bridge available for rollback.

### Phase 7: VibeField contribution integration

- Publish the runtime/workspace evidence contract consumed by `fieldd`.
- Validate joins across runtime run, native session, actor, workspace, project, and Git target.
- Start with managed isolated completed runs.
- Expand to uncommitted and historical attribution only after v1 quality gates hold.

### Package-level change map

| Area                              | Refactor                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/events.ts`     | Keep the normalized event stream for adapters and diagnostics; add only bounded monitor inputs and notification-worthy facts. Add stable runtime identity/provenance without importing provider record types.                      |
| `packages/core/src/state.ts`      | Turn the surviving maps and tombstones into private bookkeeping. Stop treating its serialized shape as an app API. Add rotation, failure-blocker, question, usage, compaction, and absence-closure behavior needed by the monitor. |
| `packages/core/src/monitor/`      | Add public monitor types, private accumulator contracts, the sole status/activity projector, full-state revision publisher, notification projector, and property tests.                                                            |
| `packages/core/src/session.ts`    | Add `monitor()`/`observeMonitor()` while retaining `state()` as a deprecated compatibility accessor.                                                                                                                               |
| `packages/runtime/src/types.ts`   | Add runtime-run identity, idempotent creation correlation, monitor handle, and monitor-state APIs. Distinguish terminal routing from native session identity.                                                                      |
| `packages/runtime/src/runtime.ts` | Preserve upstream source identities, dispatch real process exits before removal, publish the final monitor revision/notification, and stop restamping away semantic provenance.                                                    |
| `packages/adapter-claude/src/`    | Own the hook + statusline + subagent-statusline + Spaghetti join; project atomic monitor batches; add question, effort, mode, plan/task, compaction, actor, and workflow coverage.                                                 |
| Other adapters                    | Map verified usage, context, model, effort, mode, plan, task, actor, and compaction sources; remove fake process exits caused by observation/control failures.                                                                     |
| `packages/workspaces/`            | Add stable workspace identity, baseline/finalization, isolation, interference, and worktree topology observations.                                                                                                                 |
| `packages/record/`                | Add schema-versioned runtime/workspace own-action records and stable IDs; keep sensitive bodies and raw diffs out by default.                                                                                                      |
| `apps/godview/`                   | Replace serialized `SessionRuntimeState` with `AgentMonitorState`; delete app-local status/detail derivation and drive toasts/feed from `MonitorNotification`.                                                                     |
| Devkit/imposter control           | Retain raw/native evidence and private-ledger inspection as a diagnostic stage, then show the exact public monitor projection as the final stage.                                                                                  |

## 17. Verification and rollout gates

### 17.1 Core reducer tests

- Duplicate runtime event replay is idempotent.
- Duplicate durable/live semantic revisions do not double apply.
- A corrected usage response can move totals up or down.
- Bootstrap usage creates no burn-rate spike.
- Late affiliation changes team grouping without changing global usage.
- An observer replacement removes vanished plans, tasks, actors, and interactions.
- A semantic observer resync does not remove process or workspace state.
- Unknown provider values and events survive normalization.
- Full monitor state at revision N equals projection of evidence through its recorded watermarks.
- The only projected status values are `idle`, `working`, and `blocked`.
- Blocked wins over working, and working wins over idle.
- An open task or plan without live activity does not imply working.
- Concurrent permission and question blockers both survive until independently resolved.
- Staleness changes presentation confidence without changing the last evidence-backed status.
- Clean exit produces one final notification and removal; unexpected exit produces a sticky failure blocker.
- The same evidence projects the same status and activity line for every app.

### 17.2 Claude fixture and integration tests

- Root model, context percentage, and effort parse from supported statusline versions.
- Mid-session model and effort changes produce new observed values.
- `subagentStatusLine` samples correlate to child actors without becoming canonical transcript usage.
- `AskUserQuestion` exposes question text and options and resolves on matching evidence.
- Permission and question blockers render distinctly under the same `blocked` headline state.
- Plan/permission mode changes preserve raw values.
- Blockable task-completion and teammate-idle hooks remain provisional until confirmed.
- Subagent start, activity, stop, and correction preserve actor identity.
- User-owned statusline and subagent-statusline commands still run.
- Losing the observation side channel degrades semantics without terminating the TUI.
- Claude worktree topology is observed without registering the behavior-replacing worktree hook.
- Claude `/clear` rotation rebinds native identity without removing a live terminal from the board.
- A permission omitted at a trustworthy stop boundary closes and cannot leave the monitor permanently blocked.
- Repeated same-tool calls with fallback IDs remain distinct activity lifecycles.

### 17.3 Spaghetti migration tests

- Version negotiation fails closed to degraded coverage before file access.
- Watchers are installed before initial scan.
- Bootstrap, live, and correction phases are preserved.
- Scope overflow forces a new epoch and full replacement.
- Old-epoch events cannot contaminate the installed replacement.
- Legacy and RFC 012D providers match expected family digests where both claim support.
- Bounded artifacts enforce size and family constraints.
- Multiple Godview consumers do not multiply transcript readers or lose events.
- A healthy hook rail cannot make stale usage or plan families appear fresh.

### 17.4 Workspace and contribution tests

- One native session resumed across multiple runtime runs stays joinable without merging runs.
- Spawn failure still has a stable run record.
- Normal exit finalizes the workspace exactly once.
- Crash or forced termination records partial/failed finalization explicitly.
- Baseline-to-final reachable commits are reproducible from Git facts.
- Initial dirty files are not attributed as newly produced work.
- Shared workspace and human edits lower isolation/attribution quality.
- Rebase, squash, detached HEAD, deleted branch, and no-commit cases remain representable.
- Raw diffs and secrets are absent from default own-action records.

### 17.5 Cutover gates

The new projection becomes the default only when:

1. Core property and replay tests pass.
2. Godview renders the core-projected three-state classification without reclassifying it.
3. Claude TUI and user statusline behavior remain unchanged.
4. Spaghetti scope-epoch replacement passes overflow tests.
5. Shadow comparison shows no unexplained duplicate usage or persistent entities.
6. Workspace finalization survives normal, crash, and shared-workspace cases.
7. App-local serializers and status vocabularies have been removed.
8. Rollback to the v1 projection remains available for one release cycle.

Suggested feature flags:

- `agentMonitorStateV2`
- `claudeSubagentStatusObservation`
- `workspaceProvenanceV2`
- `godviewMonitorV2`

## 18. Security, privacy, and boundedness

- Hook secrets, authorization tokens, and generated settings remain in the runtime host.
- Renderer IPC carries `AgentMonitorState`, notifications, and bounded artifact references, not private evidence records, hook secrets, or native paths.
- Raw prompts, transcript bodies, tool arguments, environment values, and diffs are not persisted by default.
- Unknown native payload retention follows the explicit recording policy and is never enabled implicitly by this RFC.
- Artifact reads are explicit, family-scoped, size-bounded, and auditable.
- Observation queues are bounded. Overflow produces degradation or epoch resync, never silent loss presented as complete state.
- Stable external references are opaque strings with namespace and owner; Puppeteer does not interpret application secrets embedded in them.
- Repository identity should be joinable without exposing credentials or unredacted remote URLs.

## 19. Compatibility

### 19.1 Public API compatibility

- Existing session creation remains available while v2 options are additive.
- Existing `sessionId` and `runtimeSessionId` fields remain during a documented deprecation window.
- Existing `AgentEvent` subscriptions remain available for compatibility and diagnostics.
- Existing serialized `SessionRuntimeState` IPC remains available through a temporary bridge while apps move to `AgentMonitorState`.
- Existing Godview IPC remains available until the v2 renderer is default and rollback has soaked for one release.
- Existing Claude transcript observation remains the default until the scoped observer passes cutover gates.

### 19.2 Persistence compatibility

Runtime-owned records are append-only and schema-versioned. Corrections reference replaced record IDs rather than rewriting historical files. Readers ignore unknown fields and reject unsupported major versions explicitly.

No compatibility promise is made for private accumulator snapshots. `AgentMonitorState` is rebuildable and may be cached only with its runtime epoch, revision, runtime identity, and schema version.

## 20. Alternatives considered

### 20.1 Extend the existing `AgentEvent` union

Rejected. It would mix edge signals, revisioned entities, owned-set replacements, cumulative samples, and workspace facts under one ordering and deduplication model. The resulting reducer would be source-specific and unable to resync safely.

### 20.2 Make Spaghetti the whole live runtime state

Rejected. Spaghetti does not own PTYs, process lifecycle, prompt receipts, workspace allocation, isolation, or finalization. It should not learn Puppeteer process semantics merely to simplify one consumer.

### 20.3 Make Puppeteer parse transcripts directly

Rejected. This duplicates Spaghetti's native-data expertise and loses durable/live semantic revision identity.

### 20.4 Use the terminal screen as the universal fallback

Rejected as a semantic source. Terminal presentation is unstable, localized, lossy, and designed for people. Optional screen inference may exist only as explicitly inferred evidence.

### 20.5 Wait for Spaghetti before refactoring

Rejected. Runtime identity, separate state planes, Claude status telemetry, structured questions, workspace provenance, and Godview contracts are useful independently. Waiting would force the eventual observer into the current inadequate reducer.

### 20.6 Compute contribution directly in Puppeteer

Rejected. Puppeteer lacks project policy and Git-history ownership. Combining runtime lifecycle with attribution percentages would make evidence capture policy-dependent and difficult to audit.

### 20.7 Publish the full evidence state to applications

Rejected. This recreates a general semantic state machine, couples every app to source revisions, and invites each renderer to derive a different user status. The private evidence state exists for correctness; `AgentMonitorState` exists for the product.

### 20.8 Keep only the three-state monitor with no private evidence layer

Rejected. A flat monitor alone cannot safely deduplicate durable/live observations, process downward usage corrections, retract vanished tasks, or replace state after observer overflow. Simplicity belongs at the publication boundary, not at the evidence boundary.

## 21. Risks and mitigations

| Risk                                                          | Mitigation                                                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| The v2 contract becomes Claude-shaped                         | Keep source-owned facts and capability families provider-neutral; validate against Codex and another adapter before declaring the public API stable. |
| Fast hook/status observations disagree with durable semantics | Preserve both provenance chains; mark fast signals provisional or sample-based; allow source correction.                                             |
| UI complexity grows with quality metadata                     | Publish only compact per-family readiness; keep full provenance in the devkit and evidence records.                                                  |
| Spaghetti draft contracts change                              | Isolate them behind `SemanticObservationProvider` and negotiate versions before source access.                                                       |
| Actor usage is double counted across teams/workflows          | Aggregate by actor contribution identity first, then project affiliations.                                                                           |
| Resync races lose live events                                 | Watch before scan, drain before readiness, use watermarks, and atomically swap staged epochs.                                                        |
| Workspace evidence overclaims attribution                     | Record isolation and interference explicitly; leave contribution judgment to VibeField.                                                              |
| Durable records leak sensitive content                        | Persist identifiers, summaries, hashes, and evidence references by default; require explicit policy for bodies and raw diffs.                        |
| Three states hide simultaneous blockers                       | Retain a blocker array with typed permission, question, and failure details; status remains a three-value projection.                                |
| Apps recreate divergent activity labels                       | Compute status and activity once in core and delete app-local serializers/classifiers after migration.                                               |

## 22. Questions before ratification

1. Should the public replacement for `runtimeSessionId` be `terminalSessionId`, `hostSessionId`, or another routing-specific name?
2. Which burn-rate windows should Godview ship by default? This does not affect the storage contract.
3. Should runtime-owned action records remain JSONL in v2 or use a small pluggable append-only writer? The record contract is independent of the storage choice.
4. What deterministic priority should Godview use when several blocker kinds are simultaneously open? The full blocker list is retained regardless.

## 23. Acceptance criteria

This RFC is implemented when all of the following are true:

1. A runtime run has a stable identity distinct from the provider-native session and terminal routing identity.
2. Godview receives the epoch-aware `AgentMonitorState` without parsing native payloads, and its headline status is exactly `idle | working | blocked`.
3. Root usage, burn rate, context, model, and effort are visible with freshness and evidence quality.
4. Child actor usage, burn rate, model, effort, context, and activity appear where capability coverage permits.
5. Model, effort, and provider mode changes produce revisioned observed state.
6. Plans, tasks, tools, and structured questions support corrections and removals.
7. Questions with options produce a typed question blocker under the common `blocked` status.
8. Subagents, team members, and workflow-created actors share one privately deduplicated actor graph and compact monitor summaries.
9. Workflow artifacts can be listed and read through bounded references when supported.
10. Observer overflow and resync replace semantic state without damaging runtime or workspace state.
11. Workspace baseline and finalization produce durable completeness-qualified evidence.
12. VibeField can join run, native session, actor, workspace, project, and Git evidence without Puppeteer assigning contribution percentages.
13. All functionality operates beside the original Claude TUI with no shadow model process.
14. Unsupported or unavailable observations are rendered honestly rather than as zero or absence.
15. Apps no longer serialize `SessionRuntimeState` or derive their own status/activity labels.
16. Clean termination removes a session after one notification; unexpected death remains a failure blocker until acknowledged or removed.

## 24. References

- [`RFC-001 implementation plan`](./001-implementation-plan.md)
- [`draft/DESIGN.md`](../../draft/DESIGN.md)
- [`draft/IMPLEMENTATION-PLAN.md`](../../draft/IMPLEMENTATION-PLAN.md)
- [`docs/archive/MONITOR.md`](../../docs/archive/MONITOR.md)
- [`p008/draft/dicussion1.md`](../../../p008/draft/dicussion1.md)
- [`p008/draft/dicussion2.md`](../../../p008/draft/dicussion2.md)
- [Spaghetti RFC 012](../../../p008/spaghetti/docs/rfcs/012-evidence-backed-adapters-and-progressive-readiness.md)
- [Spaghetti RFC 012C](../../../p008/spaghetti/docs/rfcs/012c-runtime-semantics-and-usage-v2.md)
- [Spaghetti RFC 012D](../../../p008/spaghetti/docs/rfcs/012d-session-scoped-observation.md)
- [Claude Code statusline documentation](https://code.claude.com/docs/en/statusline)
- [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
