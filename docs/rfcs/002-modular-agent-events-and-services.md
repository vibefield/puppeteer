# RFC 002: Modular Agent Events and Services

- **Status:** Accepted and implemented
- **Date:** 2026-08-25
- **Owners:** Core, runtime, and adapter maintainers
- **Related:** [`003-native-observation-sources.md`](./003-native-observation-sources.md), [`agent-api.html`](../agent-api.html)

## Decision

Puppeteer has one ordered, provider-neutral event rail per runtime Agent. Public event names have one canonical `category:event-name` identity, shared by the envelope and normalized event:

```ts
envelope.type === envelope.event.type;
```

Provider-native names belong only in retained source evidence. Dotted aliases and a synthetic `state` event namespace are not public identities.

The catalog currently contains 42 routes in 21 categories: `session`, `turn`, `reasoning`, `tool`, `interaction`, `delegation`, `planning`, `compaction`, `context-window`, `conversation`, `usage`, `workflow`, `environment`, `model`, `effort`, `mode`, `workspace`, `process`, `notification`, `monitor`, and `adapter`.

## Vocabulary and ownership

Three concepts remain separate:

1. An **event category** is a stable public namespace and owns the schemas for its events.
2. A **projection service** is an Agent-owned consumer such as state, conversation, or monitor. It may consume several event categories.
3. An **adapter capability service** implements an upper-level port such as event observation, prompt submission, approval handling, or bounded artifact reading.

Category names do not imply exclusive projection ownership. For example, the conversation projection consumes tool and reasoning events, while the state projection consumes session, turn, environment, model, process, and context-window events.

## Schema decision

Canonical Core event contracts use strict Zod schemas with TypeScript types inferred from them. This is the right boundary because adapter output is runtime data, not merely compile-time data. It must be rejected before it reaches reducers or listeners when an adapter drifts.

TypeScript remains the contract for callbacks and internal composition:

- Each category owns its strict Zod event schemas.
- Exported event types are inferred from those schemas.
- The exhaustive catalog binds every route to one category and one schema.
- Runtime ingress validates each `AdapterEventCandidate` once before sequence assignment.
- Listener overloads derive their narrowed TypeScript envelope types from the catalog.
- Provider-native decoders stay tolerant and extract only evidence a normalizer understands; copying strict Core schemas onto unstable provider wire formats would make adapters unnecessarily brittle.

Zod is therefore used where untrusted runtime data crosses into Core. It is not used to model callbacks or every internal function.

## Event contract and flow

Every normalized event extends the unified structural contract:

```ts
interface AgentEventContract<Type extends `${string}:${string}`> {
  readonly type: Type;
}

interface AgentEventEnvelope<Event extends AgentEvent> {
  readonly type: Event['type'];
  readonly category: AgentEventCategoryOf<Event>;
  readonly event: Event;
  // runtime identity, ordering, actor attribution, evidence, and correlation
}
```

The flow is:

```text
provider-native evidence
  -> adapter-local tolerant decoder
  -> category normalizer
  -> AdapterEventCandidate
  -> runtime strict validation, identity correlation, and sequence stamping
  -> Agent projection services
  -> public AgentEventBus
```

Adapters never assign runtime sequence, runtime identity, or public routing metadata. Invalid candidates are rejected without consuming a sequence number. Projection services run before public listeners, so callbacks observe snapshots that already include their event.

## Core and runtime layout

```text
packages/core/src/
  events/
    contract.ts
    envelope.ts
    catalog.ts
    session.ts
    turn.ts
    reasoning.ts
    tool.ts
    interaction.ts
    delegation.ts
    planning.ts
    compaction.ts
    context-window.ts
    conversation.ts
    usage.ts
    workflow.ts
    environment.ts
    model.ts
    effort.ts
    mode.ts
    workspace.ts
    process.ts
    notification.ts
    monitor.ts
    adapter.ts
    index.ts
  adapter/
    binding.ts
    event-candidate.ts
    index.ts
  services/
    account-usage.ts
    event-source.ts
    prompt.ts
    artifacts.ts

packages/runtime/src/
  events/
    event-bus.ts
  host/
    environment.ts
  identity/
    creation-registry.ts
    runtime-identity.ts
  monitor/
    clock.ts
    handle.ts
  observation/
    git.ts
  services/
    state-service.ts
    conversation-service.ts
    monitor-service.ts
    projection-service.ts
  agent.ts
  runtime.ts
```

There is no `events/state/` umbrella. Session lifecycle, turns, reasoning, tools, interactions, delegation, planning, and compaction are peer domains. Environment contains only cwd and Git facts; model, effort, and provider mode have independent events so unrelated evidence does not overwrite one another.

## Adapter convention

Each adapter follows the same conceptual organization:

```text
src/
  normalization/
    session.ts
    turn.ts
    reasoning.ts
    tool.ts
    interaction.ts
    delegation.ts
    planning.ts
    compaction.ts
    context-window.ts
    conversation.ts
    usage.ts
    workflow.ts
    environment.ts
    model.ts
    effort.ts
    mode.ts
    workspace.ts
    process.ts
    notification.ts
    adapter.ts
    pipeline.ts
  services/
    event-source.ts
    prompt.ts
    approvals.ts
    artifacts.ts
```

Only supported categories and capabilities need files. An adapter may delegate a capability instead of copying normalization logic. One native record may produce several candidates; the pipeline owns shared correlation and composes focused category normalizers.

Every adapter returns one `AgentAdapterBinding`. Its `events.onCandidate(...)` source is the only normalized observation rail, while `services.prompt` and optional capabilities such as `services.artifacts` are named command ports. Adapters never publish a stamped `AgentEventEnvelope`; the private per-Agent bus lives in Runtime.

Observation-source code may be organized by native transport when that is the clearest boundary, but normalized event construction still lives in the category module. Artifact readers must be incremental and bounded, and independent evidence rails must fail independently.

## Required invariants

- Exact, category-wildcard, and catch-all subscriptions receive the same immutable envelope.
- Schema-owned nested event data is frozen before publication; opaque tool input/output and retained native evidence remain caller-read-only without recursively freezing provider objects.
- Runtime sequence is strictly increasing per Agent and assigned only to valid candidates.
- Projection services consume an envelope before public application listeners.
- Listener faults never interrupt ingestion or other listeners.
- Agent state and identity getters return defensive snapshots, and published monitor snapshots are deeply immutable.
- Unknown provider evidence remains inspectable as `adapter:native-event` with its native payload retained.
- Root and non-root actor evidence cannot overwrite one another; exact `agentId` is preferred, with `actorKey`/`actorRole` available for derived lanes.
- Independent native evidence rails cannot starve one another when one source is malformed or unavailable.
- Adding an event requires a category-owned schema and explicit catalog entry; there is no implicit fallback category.

## Consequences

Consumers can locate an event contract, its normalizer, and the service it feeds without understanding an adapter monolith. Runtime validation protects reducers from adapter drift while catalog-derived TypeScript keeps callbacks precise. The cost is more small files and explicit catalog entries, which is intentional: category ownership and flow control remain visible in the repository structure.
