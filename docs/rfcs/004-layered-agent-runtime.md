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
- `upstream.json` is the declared provider inventory. Workflow, audit, and canonical discovery start from it, so missing work is a failure rather than an invisible provider.
- Every capture-version root declares `capture-fidelity.json`. Type-preserving redaction may support native shape claims; semantic and legacy projections support only the facts they explicitly retain.
- ASM v3 records schema fidelity, exact native names, evidence-bound nested payload refinements, and explicitly selected behavior discriminants. Vendor JSON Schema ingestion retains reachable references and vocabulary instead of collapsing nested contracts.
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

### Workspace mutation boundary

File mutation is represented by two facts rather than one ambiguous “workspace changed” signal:

- `workspace:file-operation` is correlated to a native mutating tool call and carries an evidence-backed lifecycle phase (`proposed`, `in-progress`, `applied`, or `failed`). Applied means native-reported success, not independent disk verification. Each change may preserve several complementary details—native unified diff, explicitly bounded diff preview, before/after content, whole-file write, or old/new replacement—and each detail records whether it came from tool input, tool result, or the native file-operation carrier.
- `workspace:file-changed` is a direct filesystem hook or watcher observation. It deliberately has no tool-call id because observation does not prove causality.

Adapters never convert proposal into application, attach watcher activity to a guessed tool, infer edits from terminal prose, manufacture a diff from a path-only signal, or label a rendered preview as an applicable patch. Missing native detail remains missing. The detailed Agent event rail may contain source content or diffs; monitor projections do not retain file identities or content by default.

Every `AgentProvider` declares one strict `AgentProviderDescriptor` (`id`, `label`). Runtime validates it once, requires
launch and account-usage capabilities to repeat the same identity, exposes defensive copies through `providers()`, and
places the descriptor on every `AgentSessionInfo`. Provider ids are open and opaque to products; display copy comes from
the adapter-authored label. A product may keep an isolated optional artwork map, but behavior must never branch on it.

### Launch and continuation boundary

Native launch grammar is another adapter concern. Each built-in provider may expose an `AgentProviderLaunchService` with:

- a Zod-validated `AgentLaunchProvider` descriptor for resume support, intercepted command names, a complete safe
  environment allow-list, and any conformance-gated Imposter topology;
- a pure native-invocation normalizer implemented in that adapter's `launch/native-invocation.ts`;
- an optional continuation codec for credential-free provider state such as an effective configuration, durable
  Imposter root, or data root. The opaque JSON is validated by a strict, versioned adapter-owned Zod schema.

Runtime exposes `spawn()` and `resume({ continuation })` to products. `AgentContinuation` is one opaque persisted value;
products do not reconstruct native argv or `agentOptions`. It exposes only a generic `native | imposter` identity;
provider topology remains opaque. Terminal hosts use the separate `launchProviders()` →
`prepareInvocation()` → `adoptPrepared()` SPI. The host authenticates requests, finds the containing terminal, resolves
trusted executables/state roots, and performs `exec`; the adapter parses argv and chooses hooks, app servers, ACP,
sockets, durable logs, private HTTP/SSE services, or gateway attachment.

Godview therefore contains no built-in provider list, native resume parser, environment branch, transport switch,
Imposter allow-list, or provider label switch. A repository-wide production-source check rejects provider mechanics and
names everywhere under Godview except its isolated optional icon-branding map; built-in composition is confined to the
main-process composition root.

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
