# RFC 002: Modular Agent Events and Services

- Status: Accepted for incremental implementation
- Date: 2026-08-25

## Summary

Puppeteer will keep one ordered, provider-neutral event rail per runtime Agent while making event contracts, projection services, and adapter capabilities independently understandable.

Public event names use one canonical `category:event-name` identifier. Examples include `state:turn-started`, `context-window:updated`, and `monitor:batch`. Provider-native names and the older dotted normalized names are not additional public event identities.

The migration is incremental. Every intermediate change must preserve a green build, existing event order, current projection behavior, and adapter conformance.

## Vocabulary and ownership

Three different concepts must remain separate:

1. **Event category** is the stable public namespace used for event selection. The initial categories remain `state`, `context-window`, `conversation`, `usage`, `environment`, `workspace`, `process`, `notification`, `monitor`, and `adapter`.
2. **Projection service** is an Agent-owned consumer of events, such as state, conversation, or monitor. A projection service may consume events from several categories.
3. **Adapter capability service** implements an upper-level port, such as event observation, prompt submission, approval handling, or bounded artifact reading.

Category names do not imply exclusive projection ownership. For example, the conversation projection legitimately consumes tool and reasoning activity published in the `state` category.

## Canonical event contract

The target event shape has one event identity and one payload:

```ts
interface AgentEvent<Type extends AgentEventType, Payload> {
  readonly type: Type;
  readonly payload: Readonly<Payload>;
}

interface AgentEventEnvelope<Event extends AgentEvent> {
  readonly event: Event;
  // ordered delivery, evidence, identity, and correlation metadata
}
```

The event type itself follows `category:event-name`. The envelope must not introduce a competing dotted event name. Compatibility aliases may exist during migration, but new application and adapter code must use the canonical identifier.

## Schemas and callback typing

Canonical event data is schema-first:

- Each event category owns its Zod payload schemas.
- Exported TypeScript payload and event types are inferred from those schemas.
- A typed event catalog composes all category schemas exhaustively.
- The runtime validates a normalized adapter event once at ingress.
- Public listener types are derived from the event catalog; callbacks are TypeScript contracts and are not runtime schemas.
- Provider-native schemas are tolerant and parse only the evidence required by a normalizer. Canonical Core schemas are strict.

Schema metadata is also the source for generated event documentation and JSON Schema artifacts.

## Event flow

```text
provider-native evidence
  -> adapter wire decoder
  -> category normalizers
  -> AdapterEventCandidate
  -> runtime schema validation, identity correlation, and sequence stamping
  -> Agent projection services
  -> public AgentEventBus
```

Adapters do not own runtime delivery sequence, runtime identity, public routing metadata, or completed envelopes. They produce normalized event candidates plus source evidence.

Projection services run before public listeners. Their ordering is explicit in the Agent composition root so a listener always observes snapshots that already include its envelope.

## Core and runtime layout

```text
packages/core/src/
  events/
    contract.ts
    envelope.ts
    catalog.ts
    state/
      session.ts
      turn.ts
      reasoning.ts
      tool.ts
      interaction.ts
      delegation.ts
      planning.ts
      index.ts
    context-window.ts
    conversation.ts
    usage.ts
    environment.ts
    workspace.ts
    process.ts
    notification.ts
    monitor.ts
    adapter.ts
    index.ts
  adapter/
    event-candidate.ts

packages/runtime/src/
  services/
    projection-service.ts
    state-service.ts
    conversation-service.ts
    monitor-service.ts
```

Core owns pure contracts, schemas, and reducers. Mutable Agent-owned projections live in runtime services. A substantial service may use a directory, but it has one public entry module. Private reducer modules divide implementation mechanics, not the public service contract.

## Adapter convention

Every adapter follows the same conceptual layout:

```text
src/
  wire/
  normalization/
    context.ts
    state/
    context-window.ts
    conversation.ts
    usage.ts
    environment.ts
    workspace.ts
    process.ts
    notification.ts
    monitor.ts
    adapter.ts
    pipeline.ts
  services/
    event-source.ts
    prompt.ts
    approvals.ts
    artifacts.ts
  session.ts
```

Only supported categories and capabilities need implementations. An adapter may delegate a capability to another package, as Grok already does with ACP; the convention must not cause copied normalization logic.

One native record may produce events in several categories. A session-scoped normalization context owns shared correlation state, while category modules remain focused on translating their portion of the record.

## Migration plan

1. Split the current Core event declarations into category modules behind compatible exports.
2. Add the schema-backed event catalog and exhaustive catalog tests.
3. Introduce `AdapterEventCandidate` and make runtime ingress the only envelope stamper.
4. Migrate the Agent pipeline to explicit state, conversation, and monitor services.
5. Refactor Codex as the reference structured adapter, followed by ACP/Grok, Hermes/Kimi, and OpenCode/Claude.
6. Generate the Agent API catalog from schema metadata and add a repository consistency check.
7. Remove legacy dotted event identities and compatibility aliases.

## Implementation status

Core declarations and strict Zod schemas now live with their categories, and the exhaustive catalog derives exact event-listener types from 38 canonical `category:event-name` routes. State, conversation, and monitor are explicit Agent-owned projection services; the Agent composition root runs them before public listeners.

Candidate ingress is active across ACP, Claude, Codex (structured and native-TUI observer paths), Grok, Hermes, Kimi, and OpenCode. Runtime validates candidates before projection and is the only owner of delivery sequence. The deprecated completed-envelope method remains as a temporary bridge for direct low-level consumers, not as runtime ingress for these adapters.

Each adapter now has category-focused normalization modules and capability-focused service modules. Their pipelines retain session-scoped correlation and routing, while normalized event construction lives in the corresponding category module. Event-source, prompt, approval, elicitation, control, launch, and observation capabilities are independently named where the provider supports them.

The Agent API reference now documents the candidate boundary, schema decision, and runtime-owned stamping flow. The monitor category currently validates its versioned batch shell while private family-value schemas remain owned by the monitor SPI. Remaining migration work is removal of dotted compatibility discriminators and the deprecated direct-adapter envelope bridge after downstream callers have moved.

## Required invariants

- Exact, category wildcard, and catch-all subscriptions observe the same ordered event.
- Runtime delivery sequence is strictly increasing per Agent.
- Projection services consume an envelope before public application listeners.
- Listener faults never interrupt ingestion or other listeners.
- Unknown provider evidence remains inspectable through the adapter category.
- Invalid canonical adapter output cannot reach reducers or public listeners unchecked.
- Adding an event requires an explicit catalog entry; there is no implicit fallback category.
