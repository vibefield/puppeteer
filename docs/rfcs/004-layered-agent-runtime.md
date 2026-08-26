# RFC 004: Layered Agent Runtime

- **Status:** Accepted and implemented
- **Date:** 2026-08-26
- **Owners:** Surface, Core, adapter, runtime, and product maintainers
- **Related:** [`002-modular-agent-events-and-services.md`](./002-modular-agent-events-and-services.md), [`003-native-observation-sources.md`](./003-native-observation-sources.md), [`agent-api.html`](../agent-api.html)

## Decision

Puppeteer has two independent foundations and one directional runtime stack:

```text
provider artifacts and captures                 provider-neutral contracts
              │                                           │
              ▼                                           ▼
       Surface ground truth                           Core contracts
          │          │                                      │
          │          └────────► Imposter                    │
          │                                                 ▼
          └──── development/conformance ─────────────► adapters
                                                            │
                                                            ▼
                                             Runtime ingress + private event bus
                                                            │
                                                            ▼
                                               one Agent per runtime run
                                                            │
                                                            ▼
                                             monitor store → React bindings
                                                            │
                                                            ▼
                                                    product views
```

Ground truth describes provider-native reality; Core describes Puppeteer’s provider-neutral contract. Neither depends on the other. Adapters are the bridge, but production adapters do not import Surface: they ship normalizers for one reviewed ground-truth version and carry a digest-locked `groundtruth-map.json` conformance record.

The numbered product model is therefore:

0. **Ground truth:** versioned evidence folded into one canonical `groundtruth.json` for each provider agent.
1. **Imposter:** native-compatible behavior built only from Surface ground truth.
2. **Adapters:** tolerant native decoders, category normalizers, and explicit capability ports targeting Core.
3. **Runtime ingress and event bus:** validate candidates, correlate runtime identity, assign delivery order, project state, and route immutable envelopes. The bus is private and per Agent.
4. **Agent:** binds one adapter/process run and exposes control, projections, operational status, and typed subscriptions.
5. **Presentation:** a headless monitor store, React hooks/view contracts, and product-specific projections such as Godview’s terminal-aware swarm.

Core contracts are a foundation used by layers 2–5, not a hidden sub-layer of provider ground truth.

## Ground-truth contract

- A provider has one canonical `packages/surface/vendors/<provider>/groundtruth.json`; its embedded manifest identifies the active version.
- Versioned `model/<provider>@<version>/` trees are authoring and evidence inputs only. They never contain another canonical ground-truth file; Git history tracks changes to the root document.
- Imposter depends on Surface and remains provider-native. It does not import Core, adapters, or Runtime.
- Each supported adapter owns `groundtruth-map.json`. The map locks the ground-truth digest and partitions native names into semantic inputs, observed/control inputs, and an explicitly hashed unmapped remainder.
- `pnpm groundtruth:mapping:check` fails when ground truth or adapter implementation references drift without review.

Ground truth is not a normalized event log and does not promise that every provider-native method becomes a public event. Client-to-provider commands may become capability services; transport noise may remain unmapped; meaningful observed facts become normalized candidates.

## Adapter boundary

Every adapter returns exactly one `AgentAdapterBinding`:

```ts
interface AgentAdapterBinding {
  readonly sessionId: string;
  readonly runtimeSessionId: string;
  observationLevel(): ObservationLevel;
  readonly events: AgentAdapterEventSource;
  readonly services: {
    readonly prompt: AgentPromptService;
    readonly artifacts?: AgentArtifactService;
  };
  dispose(): Promise<void>;
}
```

`events.onCandidate(...)` is the only normalized observation rail. Candidates contain a canonical `category:event-name` route and normalized payload, but no runtime sequence, runtime epoch, public category field, callback, or command function. Commands travel through named services. Optional capabilities are represented by optional service ports, not sentinel events.

Strict Zod schemas validate runtime data at the Core boundary. TypeScript defines callback narrowing and internal composition. Provider-native decoding stays tolerant because upstream wire formats are versioned evidence, not trusted Core values.

## Runtime and Agent ownership

Runtime is provider-agnostic. It has no concrete adapter dependencies; `@vibecook/puppeteer-builtin-providers` is the optional composition root that imports official adapters and Runtime.

For each accepted candidate, Runtime performs this order:

```text
candidate metadata validation
  → route lookup and payload validation
  → runtime/native identity correlation and deduplication
  → monotonically increasing sequence assignment
  → Agent projections
  → private per-Agent event-bus publication
```

The public envelope uses `category`, never `service`, while its route remains `category:event-name`. Projection services may consume many categories; category names do not imply service ownership.

Each live `Agent` owns:

- defensive `state` and `conversation` snapshots;
- detailed `lifecycle` and host-owned `alive` state;
- the orthogonal three-state operational machine `status: 'idle' | 'working' | 'blocked'`;
- a deeply immutable `monitor` snapshot and race-free `observeMonitor()` handle;
- typed `on(exact | category:* | *)` subscriptions;
- explicit controls such as `submitPrompt()` and bounded artifact reads.

The eight-state session lifecycle is not collapsed into the three-state operational status. For example, a live process can be operationally blocked while its session lifecycle remains running.

## Presentation boundary

`@vibecook/puppeteer-monitor` owns transport-neutral epoch/revision ordering, removal tombstones, bounded notification retention, and external-store snapshots. `@vibecook/puppeteer-react` supplies `useSyncExternalStore` hooks and the generic `AgentMonitorViewDefinition` contract.

Products may add terminal, pane, layout, and interaction facets, but a view receives projected data and actions only. It never imports adapters, opens provider files, or infers semantics from terminal text.

## Enforced dependency rules

`scripts/check-package-layout.mjs` contains the exact allowed internal production edges. In particular:

- Core and Surface have no internal production dependencies.
- Imposter depends only on Surface.
- adapters depend on Core; Grok may delegate its ACP control capability to the ACP adapter.
- Runtime depends on Core, Record, and Workspaces, never concrete adapters.
- the built-in composition package is the only package that imports all official adapters.
- Monitor depends only on Core; React depends only on Core and Monitor.

Cycles, unregistered packages, and upward/concrete-provider edges fail CI.

## Consequences

Provider fidelity, normalized contracts, runtime ordering, product monitoring, and UI layout can evolve independently. The former dual adapter rail and adapter-stamped envelope compatibility path are removed. Category projectors no longer require a shared “Spaghetti” orchestration dependency: they are ordinary focused consumers composed by Runtime, with dependencies visible through imports and package rules.
