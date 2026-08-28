# Puppeteer contributor guide

Puppeteer hosts coding agents' native terminal interfaces and adds a provider-neutral runtime for lifecycle, observation, guarded control, workspace isolation, and operational monitoring. The agent owns its terminal UI; Puppeteer owns the process environment around it. Semantic state comes from native hooks, protocols, logs, and explicit workspace/process evidence—never from terminal text.

The current architecture is [`docs/rfcs/004-layered-agent-runtime.md`](docs/rfcs/004-layered-agent-runtime.md). Event and service ownership is defined by [`docs/rfcs/002-modular-agent-events-and-services.md`](docs/rfcs/002-modular-agent-events-and-services.md), and native observation ownership by [`docs/rfcs/003-native-observation-sources.md`](docs/rfcs/003-native-observation-sources.md). Historical designs live only under `docs/archive/`.

## Architecture

Puppeteer has two independent foundations and one directional runtime stack:

```text
Surface ground truth ──► Imposter
        │
        └── development/conformance ──► adapters

Core contracts ──► adapters ──► Runtime ingress/event bus ──► Agent ──► monitor/React ──► products
```

The numbered product layers are:

0. `packages/surface`: versioned provider evidence folded into one canonical `groundtruth.json` per provider agent.
1. `packages/imposter`: native-compatible synthetic behavior derived from Surface, with no Core or adapter dependency.
2. `packages/adapter-*`: tolerant wire decoding, one category normalizer per file, and one capability service per file.
3. `packages/runtime`: provider-neutral ingress, identity/deduplication, private per-Agent event bus, and projections.
4. `Agent`: one runtime-owned object per process run, exposing control, state, monitor, and typed subscriptions.
5. `packages/monitor`, `packages/react`, and product views: transport-neutral state delivery and presentation contracts.

`packages/core` is the provider-neutral contract foundation used by layers 2–5. `packages/builtin-providers` is the optional composition root that imports Runtime plus the official adapters.

## Non-negotiable invariants

- Never derive semantics from terminal text. Use native hooks/protocols, native logs, workspace/process observation, or explicitly qualified inference.
- One `RuntimeRun` owns at most one primary interactive agent process. Never launch a shadow print/exec process to mirror a TUI session.
- `core` and `surface` are zero-I/O production foundations and do not depend on each other.
- Adapters reach terminals only through `AgentHost`; provider-specific sockets, logs, and helper processes remain adapter-owned.
- Adapter production code does not import Surface. A reviewed `groundtruth-map.json` digest-locks the native surface it implements.
- Imposter imports Surface only. It does not import Core, adapters, Runtime, Monitor, or React.
- Runtime never imports a concrete adapter. Concrete provider assembly belongs in `packages/builtin-providers`.
- Event routes retain the `category:event-name` convention. Runtime validates payloads with Core Zod schemas and uses TypeScript for callback narrowing.
- Commands travel through named services; they are not represented as events or callback-bearing payloads.
- Unknown meaningful native events are retained as `adapter:native-event` instead of silently dropped.
- Launch environments may contain bearer tokens. Never log or persist them.

## Repository layout

```text
packages/
  core/                zero-I/O event schemas, session/host contracts, pure reducers
  surface/             provider evidence, canonical ground truth, validation and drift tools
  imposter/            one `ai` executable, personas, scenarios, native control protocol, TUI
  adapter-*/           provider-native decoding, normalization, observation, services, transport
  runtime/             Agent, ingress, event bus, projection services, lifecycle/workspace orchestration
  builtin-providers/   official provider composition root
  workspaces/          direct, exclusive, worktree, and copy workspace implementations
  record/              append-only runtime-owned action records
  testing/             vendor-neutral adapter conformance and fake-agent support
  monitor/             transport-neutral monitor store
  react/               React hooks and portable monitor view contract
apps/
  godview/             Electron swarm/product view
  imposter-control/    native-surface and normalization development workbench
docs/
  rfcs/                accepted architecture decisions
  guides/              current operational and adaptation guides
  archive/             explicitly historical designs and rollout records
draft/                 unfinished vendor adaptation plans only
scripts/               repository, release, Surface, and support-ledger automation
support/               machine-readable agent support and verification contracts
```

Inside every adapter:

- `normalization/<category>.ts` adapts one provider-native category to Core events; `normalization/monitor.ts` adapts correction-aware monitor evidence.
- `services/<capability>.ts` implements one explicit capability or observation service.
- `transport/` owns protocol framing and clients.
- `observation/` owns provider-native durable/live observation sources.
- `launch/` owns executable preparation.
- `test-support/` contains unpublished fakes only.
- `driver.ts` composes those pieces into one `AgentAdapterBinding`; it does not contain category logic.

Inside Runtime, `events/` owns the private Layer 3 bus, `identity/` owns run/allocation identity, `host/` owns launch policy, `observation/` owns runtime-native evidence such as Git, `monitor/` owns delivery primitives, and `services/` owns Agent projections. The root contains only `Agent`, Runtime composition, public types, and exports.

Do not add top-level compatibility barrels such as `normalizer.ts`, duplicate service shims, or rollout-only bridges. Public package `index.ts` files export the canonical modules directly.

## Ground truth and adaptation

One agent has one stable runtime authority across releases:

```text
packages/surface/vendors/<vendor>/groundtruth.json
```

Versioned manifests, detection records, channels, evidence, behavior, events, and captures under the vendor root are authoring inputs. The canonical document's embedded manifest identifies the active version, and Git history records its evolution. After changing authoring inputs, run `pnpm surface:groundtruth:write`; CI runs `pnpm surface:groundtruth:check`. `support/agents.json` is the sole promotion ledger, and README badges are generated from it.

Use `docs/guides/adapting-an-agent.md` for the end-to-end workflow, `docs/guides/surface-adaptation.md` for evidence/promotion ownership, and `docs/guides/normalization-devkit.md` for the normalization workbench.

## Commands

```sh
pnpm test                         # typecheck, structural gates, scripts, all package/app suites
pnpm build                        # build every package and app
pnpm format                       # format package/app TypeScript and repository scripts
pnpm format:check                 # verify formatting in CI
pnpm packages:check               # package topology, dependency layers, exports, retired-path guards
pnpm pack:check                    # build and inspect every public tarball
pnpm godview                      # bundle and launch Godview
pnpm godview:smoke                # native Electron/terminal smoke
pnpm agent-devkit                 # launch the adaptation/normalization workbench
pnpm surface:audit                # audit selected provider models
pnpm surface:groundtruth:check    # verify canonical JSON/HTML artifacts are current
pnpm groundtruth:mapping:check    # verify adapter mappings match ground-truth digests
pnpm support:check                # validate support ledger and generated README badges
pnpm upstream:detect              # read-only upstream release discovery
```

Live adapter proofs are opt-in and skipped by default: `CLAUDE_NATIVE_TUI_LIVE=1`, `CODEX_NATIVE_TUI_LIVE=1`, `GROK_LIVE=1`, `HERMES_LIVE=1`, `KIMI_LIVE=1`, and `OPENCODE_LIVE=1`.

## TypeScript and package conventions

- ESM throughout; relative TypeScript imports end in `.js` (Imposter is the documented `.ts` exception for Node type stripping).
- `verbatimModuleSyntax` is enabled; use `import type` for types.
- In-repo exports target `src`; `publishConfig` remaps them to `dist`.
- Expected operational failures return typed result objects. Throw only for programmer errors or failed invariants.
- Comments explain ownership, protocol quirks, security boundaries, or rationale—not a restatement of the code.
- Prettier uses single quotes, trailing commas, width 120, and two spaces.
- Preserve unrelated user changes in a dirty worktree.

## Applications and releases

Ghosttea owns PTYs. Applications consume its exact pinned npm packages and supply `AgentHost`; no sibling checkout is required. Never import `@vibecook/ghosttead` from Electron main code—it is ESM-only. The Godview build stages its binary, and app changes should be checked with `pnpm godview:smoke` when native behavior is affected.

Release Please owns versions and tags. Never hand-bump package versions. Public packages release in lockstep, and publishing uses npm trusted publishing through `.github/workflows/release.yml`.
