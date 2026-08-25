# Surface ownership, package structure, and continuous adaptation refactor

**Status:** R0–R7 implemented through the guarded candidate/promotion boundary on 2026-08-09; R8 auto-promotion remains intentionally disabled, and legacy baselines still require platform-complete evidence

**Date:** 2026-08-08

**Scope:** the complete `packages/` topology, `packages/surface`, vendor evidence and models, adapter and imposter boundaries, upstream release reconciliation, support metadata, and README agent-version badges

**Companions:** `docs/archive/EMULATOR.md`, `docs/archive/IMPOSTER.md`, `draft/ADAPTING-AN-AGENT.md`, `draft/NORMALIZATION-DEVKIT.md`, `draft/DESIGN.md`

This spec starts the next refactoring round. Where the companion drafts say that captures or the Agent Surface Model (ASM) are adapter-owned, this document supersedes them. Their implementation history remains useful; their ownership rule does not.

> **Decision:** vendor evidence and the ASM are integration-neutral assets owned by Surface. Imposter reproduces that native surface, and the native Control plane exposes the model plus raw emissions without normalizing them. The Agent Normalization Devkit may compose adapters and Core strictly downstream as an inspectable projection over those immutable records. Adapters alone reconcile native control and observations into the unified runtime interface Godview consumes. Neither projection defines vendor truth. Every direct child of `packages/` is one intentional published package; generated output, historical package residue, and vendor evidence in the wrong package are removed.

Implementation has completed the ownership move and clean-house refactor. The repository now has eleven intentional flat packages, Surface-owned vendor evidence and native behavior graphs, backward-compatible ASM v1 plus claim-addressable ASM v2, adapter-local generated projections, a vendor-neutral Testing package, an independently pre-normalization Control plane composed into an Agent Normalization Devkit, exact replay and reconciliation, reviewed artifact acquisition, confined draft-candidate automation, protected pinned-real promotion, package/publication policy checks, a guarded support ledger, generated README badges, and a scheduled read-only upstream watcher. Remaining work is evidence work plus normalization design, not an unguarded automation shortcut: upgrade the historical Claude model to ASM v2, acquire and verify the complete four-platform matrix for the legacy/current baselines, prepare vendor-specific census/model changes for each newly detected surface, strengthen portable mappings with the devkit, and decide only after an observed reliability period whether no-drift auto-merge should ever be enabled.

## 1. Why refactor again

The repository has already separated the ASM runtime into `@vibecook/puppeteer-surface`, but the data still reflects the older architecture:

- Claude and Codex captures, census tools, audits, and models live in their adapter packages.
- Imposter resolves a real persona's ASM through that adapter's package manifest.
- The adaptation playbook describes truth-checking, normalization, emulation, and conformance as four kinds of work owned by an adapter package.
- The root `surface:audit` command checks Claude only even though Codex has its own audit.
- Supported upstream versions are repeated in paths and scripts, and are not reported from one support ledger.
- There is no standing workflow that detects a new stable agent release, analyzes it, and prepares an adaptation.
- `packages/node` remains on disk even though the tracked package was retired when terminal ownership moved to Ghosttea; it now contains only ignored `dist` and `node_modules` residue.
- Real Claude captures are duplicated as a second, published fixture set under `packages/testing`, making two packages appear to own the same vendor evidence.
- Package and client versions are repeated manually: the repository is `0.1.8`, while the README and one Codex client still identify Puppeteer as `0.1.3`.

That layout conflates an **integration workflow** with an **adapter component**. The adapter is a projection: it accepts human or product control requests, translates them to a vendor's native control surface, and normalizes native observations into Puppeteer' unified `AgentEvent` contract. Evidence about the native surface exists before that projection and is also consumed by Imposter. It therefore cannot belong to either consumer.

Moving the truth layer into Imposter would repeat the same error in the other direction. It would let the test double own the oracle against which it validates itself, pull private capture machinery into an emulation package, and make Survey and Model depend on Emulate even though the workflow runs in the opposite order.

The existing `packages/surface` boundary is the correct neutral home. This refactor completes that extraction.

## 2. Target architecture

```text
 release metadata     shipped artifacts     exact source/schema     official docs
         \                    |                     /                    /
          +---------------- acquire / probe / capture -----------------+
                                      |
                                      v
                           Surface evidence ledger
                                      |
                                      v
                    Agent Surface Model (native truth)
                         /                         \
                        v                           v
       real artifact / Imposter native wire    Imposter Control
                        |                       model + raw log
                        v                       (no reducer)
                 adapter projection
             native <-> unified interface
                        |
                        v
                     Godview
```

The dependency rules are strict:

1. Surface depends on neither adapters nor Imposter.
2. An adapter may consume Surface models and evidence-derived fixtures, but never an Imposter persona.
3. Imposter may consume Surface models, but never adapter implementation or normalized event maps.
4. Conformance may compose the two projections, but cannot promote an upstream version using only adapter-against-Imposter tests.
5. Godview consumes the unified runtime contract. It does not infer semantics from Surface data or terminal pixels.

### 2.1 Ownership

| Owner              | Owns                                                                                                                                                                                                  | Must not own                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Surface**        | upstream detector configuration, artifact/source provenance, census harnesses, sanitizers, sanitized captures, private raw-capture locations, findings, audits, ASM documents, native replay fixtures | `AgentEvent` normalization, launch policy, scripted agent behavior                        |
| **Adapter**        | detection integration, launch/attach policy, native observation, native control, native-to-`AgentEvent` normalization, human-input reconciliation                                                     | real-vendor captures or ASM copies, Imposter scenarios, claims inferred from adapter code |
| **Imposter**       | persona boot, op-to-native bindings, deterministic behavior, fault injection, authored scenarios, shared cosmetic TUI                                                                                 | real-vendor evidence or model copies, native-to-`AgentEvent` normalization                |
| **Testing**        | cross-projection conformance, product-contract expectations, hermetic and real-artifact lanes                                                                                                         | a second copy of vendor truth                                                             |
| **Support ledger** | which exact Surface baseline Puppeteer currently promotes for each agent                                                                                                                             | upstream-latest values that have not passed promotion                                     |

The synthetic persona remains the sole exception: its model stays local to Imposter because it describes an invented test protocol, not a real vendor.

### 2.2 Runtime boundary: native before normalized

The runtime path has two deliberately different views:

| Layer                | What it may say                                                                                                                              | What it must not say                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Surface**          | exact native event/method names, payload schemas, channels, evidence confidence, and evidence-backed partial ordering for one vendor version | `ready`, `thinking`, `compacting`, `team idle`, or any other cross-vendor interpretation |
| **Imposter**         | which exact native messages it emitted and which channels carried them                                                                       | that a portable scenario-driver phase is vendor state                                    |
| **Native Control plane** | the versioned Surface graph, raw native payload log, channel liveness, explicit test controls, and generic projection transport                       | adapter semantics, reducer ownership, or mutation of native records                      |
| **Normalization projection** | an explicit record-by-record folding ledger, adapter events, Core state facets, correlation, diffs, and replay limitations                         | claims that its downstream state is vendor truth or a production Godview state endpoint |
| **Adapter**          | unified lifecycle, tools, approvals, compaction, delegation/team state, usage, and unknown-native retention                                  | claims that are not traceable to native observations and explicit normalization policy   |
| **Godview**          | the unified adapter contract                                                                                                                 | direct interpretation of vendor hooks or protocol messages                               |

This distinction is load-bearing for hooks whose names resemble states. Claude's `PreCompact` means “the pre-compaction interception point fired”; it may still block compaction. `PostCompact` is completion evidence. `TeammateIdle` is a pre-idle interception point, not proof that a teammate has committed to an idle state. Codex, by contrast, exposes `item/started` and `item/completed` with `item.type = contextCompaction`, which can support a different normalization. Control shows those exact facts. The adapter decides whether and how they become the unified `compaction.phase` or team status Godview sees.

The old `starting → booting → ready → thinking/tool/approval` graph still has value as the Imposter's **portable scenario driver**. It constrains and debugs authored semantic ops; it is not a vendor lifecycle, does not advance when a raw event is fired, and is always presented as a secondary authoring view. Its public control name is `scenarioDriver`, its graph endpoint is `/api/scenario-driver`, and its source is `session/scenario-driver.ts`.

Each promoted model therefore includes `behavior.json`, a vendor-native **partial-order graph**, not an exclusive state machine:

- every node references an exact name from `events/` and carries confidence for the event-plus-selector claim, so a verified generic method cannot make an unobserved payload branch look verified;
- optional `match` selectors discriminate repeated native methods using scalar payload facts such as `item.type = contextCompaction`;
- lanes and `order` are layout metadata only;
- relations declare `sequence`, `conditional`, `loop`, `resume`, `async`, or `concurrent`, with their own confidence;
- optional, concurrent, re-entrant, and asynchronous behavior is not flattened into one synthetic current state.

`session.hello` carries `nativeBehavior`, `nativeEvents`, `ops`, and `scenarioDriver`. The plane stores and streams those pre-normalized values and raw `session.emitted` records. The Control spawner launches Imposter directly; the generic plane has no adapter/Core dependency and exposes no adapter `sessionState` subscription or `/session-state` route. The containing devkit app may register a downstream projection whose endpoint and SSE event are explicitly named as projections. Adapter-against-Imposter conformance remains a separate test lane, where normalization is exactly what is under test.

## 3. What “truth” means

“Captured behavior is truth” is a useful guardrail against wishful implementations, but it is too absolute. A capture establishes only what one pinned artifact did under one stimulus, environment, account state, and platform. A source repository establishes only what its checked-out revision says, and only when that revision is demonstrably connected to the shipped artifact. Documentation may lag both.

Surface is therefore not a claim of metaphysical truth. It is the repository's **best-supported, provenance-carrying contract for a pinned vendor artifact**.

### 3.1 Authority is per claim

| Claim                                                           | Primary evidence                                                       | Useful corroboration                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| A release/version exists                                        | vendor release channel or release record plus acquired artifact digest | changelog, repository release/tag                              |
| A flag is accepted, rejected, or has a particular exit behavior | the shipped binary on that platform                                    | exact source CLI parser and tests                              |
| A protocol method or payload shape is possible                  | schema generated by the exact binary                                   | exact tagged source types/schema, controlled capture           |
| An event actually occurs and what triggers it                   | controlled runtime capture against the exact binary                    | exact source tests/control flow                                |
| Ordering, duplication, timeout, and failure behavior            | repeated controlled observations                                       | exact source implementation and tests                          |
| A platform behaves the same                                     | the platform-specific shipped artifact                                 | source guarded by the same build configuration                 |
| A rare branch exists but cannot yet be induced                  | exact corresponding source, marked source-derived                      | docs as a lead; later capture promotes confidence              |
| A native fact means a particular `AgentEvent`                   | adapter design plus product conformance                                | never an ASM fact; this is intentionally a projection decision |

When evidence disagrees:

1. The shipped artifact wins for runtime behavior.
2. A schema emitted by that exact artifact wins for protocol shape, but does not prove that every declared branch occurs.
3. Exact corresponding source explains behavior and covers hard-to-trigger branches, but does not override an observed binary divergence.
4. Unmatched repository `main` is a lead, not evidence for a released artifact.
5. Official docs are leads until tied to an artifact or observation.
6. Adapter and Imposter implementations are never admissible evidence about the vendor.

Any disagreement is recorded as a finding; it is not silently resolved by choosing the most convenient source.

### 3.2 Published repositories are evidence, not universal replacements

The initial source-reference policy is:

| Agent       | Repository                                  | Role in Surface                                                                                                                                                                             |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `https://github.com/openai/codex`           | High-value implementation, schema, and test evidence when the release tag/revision matches the acquired binary. The exact binary's generated app-server schema remains the shape authority. |
| Claude Code | `https://github.com/anthropics/claude-code` | Release metadata, changelog, examples, and issue evidence. Do not assume it contains the implementation of the shipped CLI; runtime behavior still requires the released artifact.          |
| Grok Build  | `https://github.com/xai-org/grok-build`     | Source-snapshot evidence. Record both the public commit and its declared `SOURCE_REV`; treat correspondence as declared-sync unless an artifact can be matched more strongly.               |

Every source reference records one of:

- `exact-release`: an upstream tag or commit is explicitly the source of the artifact;
- `declared-sync`: the vendor declares the public snapshot's internal source revision;
- `nearest-known`: useful explanatory source with no exact artifact correspondence;
- `unmatched`: a lead only, prohibited from supporting a promoted claim by itself.

We store references, revisions, licenses, and hashes—not vendored upstream repositories.

### 3.3 Evidence is multi-dimensional

The current `confidence` scalar (`verified-headless`, `verified-interactive`, `unverified`) mixes derivation and execution context. It cannot express “shape came from an exact generated schema, presence was observed headlessly, ordering was not verified.”

The target ASM replaces that scalar with evidence references per claim:

```json
{
  "event": "item/commandExecution/requestApproval",
  "evidence": {
    "existence": ["codex-schema-app-server-experimental"],
    "shape": ["codex-schema-app-server-experimental", "codex-capture-approval"],
    "trigger": ["codex-capture-approval"],
    "ordering": ["codex-capture-approval"]
  }
}
```

An evidence record independently states its kind (`runtime-capture`, `binary-probe`, `generated-schema`, `exact-source`, `official-doc`, or `inference`), artifact identity, platform, harness, timestamp, digest, and sanitized output location. Verification status is computed from those records instead of being hand-authored as a single adjective.

ASM v1 remains readable during migration. Requiring the new evidence map is the point at which a model becomes ASM v2; a path move alone does not justify a format bump.

## 4. Version identities

The system tracks four distinct identities:

| Identity                       | Example                                                               | Owner and purpose                                                                          |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Vendor artifact version**    | Claude Code `2.1.207`, Codex `0.147.0`                                | Upstream; names the released artifact being modeled                                        |
| **Artifact/protocol identity** | platform SHA-256, generated-schema digest, optional protocol revision | Surface evidence; detects republishing and protocol changes hidden behind a version string |
| **ASM format version**         | `asmVersion: 1` or `2`                                                | Surface runtime; versions the model document contract                                      |
| **Puppeteer version**         | `0.1.8`                                                               | This monorepo's lockstep npm release containing adapters, Imposter, and Surface            |

There is deliberately no independent adapter-version counter. The **adapted version** shown to users is the `vendorVersion` in that agent's currently promoted Surface manifest. If Puppeteer changes its adapter for the same vendor artifact, the Puppeteer release version identifies that implementation change.

The support ledger may record `introducedInPuppeteer` so a consumer can answer both questions:

- “Which upstream artifact was verified?”
- “Which Puppeteer release first shipped that verification?”

An exact verified version is not a claim that all later semver-compatible releases work. Runtime detection should report one of `verified`, `unverified-newer`, `unverified-older`, `known-incompatible`, or `unknown`. The default runtime may warn and continue for an unverified version; strict CI may require `verified`. Known-incompatible versions may be blocked explicitly.

## 5. Target repository layout

```text
packages/
  core/                             zero-I/O contracts and reducers
  surface/                          native evidence contract and ASM runtime
    src/                            loader, validator, reporter, differ, sanitizer
    vendors/
      claude/
        upstream.json               release/source detector configuration
        evidence/claude@<version>/  provenance index and durable evidence metadata
        captures/claude@<version>/  sanitized, shape-faithful native fixtures
        captures-raw/               gitignored or external-store pointers only
        census/                      probes, generators, sanitizer rules
        model/claude@<version>/      ASM documents, including native behavior.json
        audit.mjs
        findings.md
      codex/
        ...
      grok/
        ...
  adapter-acp/                      generic protocol integration
  adapter-claude/                   Claude normalization and native control
  adapter-codex/                    Codex normalization and native control
  adapter-grok/                     Grok normalization and ACP composition
  imposter/                         executable and real/synthetic personas
    bin/
    personas/<vendor>/
      persona.json                  exact Surface model reference, boot, envelope
      ops.json                      semantic op -> native emission
      serve.json                    protocol service behavior where applicable
      behavior/
      scenarios/
    src/
  record/                           append-only runtime-owned action records
  workspaces/                       workspace isolation strategies
  testing/                          vendor-neutral terminal fakes and conformance
  runtime/                          public facade composing adapters and capabilities

support/
  agents.json                       canonical promotion pointers and policy
  agents.schema.json

scripts/
  render-agent-support.mjs          README generation/check
  reconcile-agents.mjs              data-driven orchestration

.github/workflows/
  upstream-agents.yml               scheduled detection and candidate analysis
```

### 5.1 Publication boundary

`@vibecook/puppeteer-surface` publishes:

- its compiled runtime;
- promoted real-vendor model directories;
- the minimal model/provenance metadata required to identify them.

It does not publish raw or sanitized captures, census harnesses, audit logs, upstream source, or findings. Raw captures are never committed. Sanitized captures remain repository-only unless a deliberate fixture export is later designed.

Adapters stop publishing `surface/model`. Built-in Imposter personas change from an adapter package reference such as:

```json
{
  "asm": {
    "package": "@vibecook/puppeteer-adapter-claude",
    "path": "surface/model/claude@2.1.207"
  }
}
```

to the neutral owner:

```json
{
  "asm": {
    "package": "@vibecook/puppeteer-surface",
    "path": "vendors/claude/model/claude@2.1.207"
  }
}
```

The path is a reference; the manifest remains authoritative for `vendorVersion`. CI rejects a persona path whose manifest differs from the promoted support ledger.

An adapter may commit a small generated **projection module** from the promoted model—for example Claude's detection constants and hook registry—when its published runtime needs static data. Such a file has a generated header, contains only the fields that adapter consumes, and has a generator `--check` gate. It is not evidence and must not reproduce the ASM directory. Cross-package relative JSON imports are prohibited; direct runtime model use goes through the Surface package API.

One Surface package is sufficient now. Split per-vendor data packages only if package size, licensing, or independent release cadence becomes a measured problem; do not introduce that complexity preemptively.

### 5.2 Capture replay

Exact sanitized native replay fixtures belong to Surface because they are evidence. Imposter may read or replay them in repository tests, but must not copy or relabel them as authored behavior. Imposter's `behavior/` and `scenarios/` are deliberate simulations and adversarial programs; they are not evidence that a real vendor behaved that way.

### 5.3 Package audit and disposition

The tracked package graph has fourteen real packages. Most are small because their boundaries are doing useful work, not because they are abandoned.

| Path                                                 | Decision                         | Reason                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`                                      | **keep**                         | Pure, zero-I/O contract boundary used by every adapter, runtime, and testing. Remove the stale comment that still sends I/O to the retired `puppeteer-node`.                       |
| `packages/surface`                                   | **keep and expand**              | Neutral owner selected by this spec; receives real-vendor evidence, models, and reconciliation tooling.                                                                             |
| `packages/adapter-*`                                 | **keep and slim**                | The seven adapters have live production consumers and independent protocol boundaries. Remove Surface-owned data from Claude/Codex; do not merge vendors into runtime.             |
| `packages/imposter`                                  | **keep**                         | Live executable, control protocol, persona engine, and synthetic adversarial system. Its existing `src/{cli,control,persona,session,tui}` structure is healthy.                     |
| `packages/record`                                    | **keep**                         | Independent append-only I/O capability used directly by runtime and Godview. Small is appropriate here.                                                                            |
| `packages/workspaces`                                | **keep**                         | Independent workspace-isolation capability used directly by runtime and Godview.                                                                                                   |
| `packages/testing`                                   | **keep and make vendor-neutral** | The terminal fake and shared conformance suite are valid public utilities; real Claude fixtures and Claude-specific builders are misplaced.                                         |
| `packages/runtime`                                   | **keep**                         | Public composition facade; its broad dependency fan-in is intentional and belongs at the top of the library graph.                                                                  |
| `packages/node`                                      | **remove local residue**         | No manifest or tracked files remain. Git history shows the package retired when terminal ownership moved to Ghosttea; the directory now holds only ignored build/dependency output. |
| `packages/adapter-claude/surface/emulator/scenarios` | **remove local residue**         | Empty remnant of the deleted per-adapter emulator. Real scenarios live under Imposter.                                                                                              |

`dist/`, `node_modules/`, and `node_modules/.vite` inside valid packages are generated installation/build state, not additional packages and must not drive architectural merges. `packages:clean` owns declared build output such as `dist`; pnpm owns dependency directories and their caches.

The live `apps/emulator` is a different thing from the retired `packages/emulator`: it is the Imposter control plane and UI. Rename it mechanically to `apps/imposter-control` after the package move, with the root `emulator` scripts retained as deprecated aliases for one release. It must not be deleted as stale residue. Its later evolution into the Agent Normalization Devkit preserves that native plane as a generic inner component and composes normalization only at the app boundary.

### 5.4 Flat topology is deliberate

Keep publishable packages one level below `packages/`; do not introduce `packages/adapters/*`, `packages/foundation/*`, or `packages/tooling/*` in this round.

The flat layout has useful invariants:

- directory names match npm name suffixes (`adapter-codex` → `@vibecook/puppeteer-adapter-codex`);
- `packages/*` discovers every package without recursive exceptions;
- repository metadata and release paths stay obvious;
- moving a module between responsibilities is visible as a package-boundary change;
- adding a category directory cannot accidentally look like a publishable package.

Fourteen packages do not justify another directory level. Reconsider grouping only after adapter count makes navigation measurably difficult or package families acquire different build/release policies.

Every direct child directory of `packages/` must contain a valid `package.json`; no allowlist of orphan directories is permitted. Conversely, every public package manifest must appear in release-please's lockstep version list, packing, trust, and publishing. `packages:check` enforces both directions.

### 5.5 Package roles and dependency direction

The roles are:

| Role                        | Packages                                                         |
| --------------------------- | ---------------------------------------------------------------- |
| Contract foundations        | `core`, `surface`                                                |
| Side-effect capabilities    | `record`, `workspaces`                                           |
| Native integrations         | `adapter-acp`, `adapter-claude`, `adapter-codex`, `adapter-grok` |
| Simulation and verification | `imposter`, `testing`                                            |
| Composition facade          | `runtime`                                                        |

Production workspace dependencies form one acyclic direction. Arrows point from a consumer to its dependency:

```text
runtime  --> core + record + workspaces
runtime  --> adapter-acp + adapter-claude + adapter-codex + adapter-grok

adapter-acp    --> core
adapter-claude --> core
adapter-codex  --> core
adapter-grok   --> core + adapter-acp

imposter --> surface
testing  --> core
```

Additional rules:

1. `core`, `surface`, `record`, and `workspaces` have no production dependency on another Puppeteer package.
2. Every adapter depends on `core`; a vendor adapter may compose a protocol adapter, as Grok composes ACP.
3. Imposter's only production Puppeteer dependency is Surface. Adapter/testing dependencies are development-only conformance fixtures and may not leak into its tarball.
4. Testing depends on Core and declares its test-runner integration honestly; it never becomes a dependency of production runtime code.
5. Runtime composes adapters and capabilities but does not own their implementations or depend on Imposter.
6. Cycles fail `packages:check`, including cycles that are hidden by a dependency being placed in the wrong manifest section.

### 5.6 Internal folder conventions

Each package root may contain only its manifest/configuration and responsibility-bearing directories such as `src/`, `bin/`, `docs/`, `personas/`, or—only for Surface—`vendors/`. Empty placeholder folders are prohibited.

Small packages stay flat. Create a source subdirectory only when at least two modules share a durable responsibility. Tests remain beside the module they exercise.

The larger adapters converge on this vocabulary where the folders are populated:

```text
src/
  index.ts                 public API only
  driver.ts                session orchestration
  detection.ts             binary/capability integration
  normalizer.ts            native -> AgentEvent
  observation/             hooks, logs, status, transcripts, usage
  control/                 approvals and human-input/control translation
  transport/               protocol/socket/process clients
  launch/                  preparation, settings, prompt and TUI launch
  generated/               checked projections derived from Surface
```

Applied to the current tree:

- Claude groups `hook-bridge`, `transcript-observer`, and `statusline` under `observation/`; `prepare`, `prompt`, and `settings` under `launch/`; and its checked registry/detection projection under `generated/`.
- Codex groups `app-server-client` and `ws-transport` under `transport/`; `observer`, `rollout-context`, and account usage under `observation/`; approvals under `control/`; and TUI session preparation under `launch/`.
- ACP and Grok remain flat until a real second module justifies one of those folders.
- Imposter keeps its current responsibility folders; Surface keeps its self-contained ASM runtime and vendor data tree; Core, Record, Workspaces, and Runtime remain flat while small.

`docs/event-map.html` stays beside each adapter because it documents the **projection**, not native truth. Each map must name its promoted Surface/protocol baseline and `lastVerified` value. A manifest-digest freshness check fails when the adapter is promoted against a newer baseline without reviewing or regenerating its map.

### 5.7 Testing package cleanup

`@vibecook/puppeteer-testing` currently mixes three different things:

1. the provider-neutral terminal-spine fake (`fakeAgentBin`);
2. the provider-neutral `AgentSession` conformance suite;
3. a published copy of real Claude captures plus `fakeClaudeHookPayload`.

Keep the first two. Move the third:

- canonical real captures and their loader/shape tests move to `packages/surface/vendors/claude`;
- Claude's synthetic payload builder and `CapturedHookRecord` type move to an adapter-local test helper;
- adapter tests read real fixtures from Surface and use their local builder for synthetic/off-model cases;
- `packages/testing/fixtures/hooks` and `"fixtures"` in its package `files` list are removed;
- the testing package description becomes vendor-neutral.

The existing fixture loader and Claude-builder exports are public in `0.1.8`. If another `0.1.x` ships before this refactor, mark them deprecated there. Land the structural removal as the declared `0.2.0` break with migration notes, rather than silently changing what their filesystem paths mean. Do not preserve them by making a generated second copy of Surface evidence.

`@vibecook/puppeteer-testing/conformance` imports Vitest. The package must declare the supported Vitest range as a peer dependency (and a development dependency for its own tests), or make the conformance runner framework-neutral. Leaving a runtime import satisfied only by an undeclared dev dependency is not acceptable packaging.

The fake terminal agent remains separate from Imposter for the reasons already established in `docs/archive/IMPOSTER.md §7.4`: one exercises PTY/process failure modes; the other simulates native semantic channels.

### 5.8 Versions, manifests, and release discovery

Lockstep package versions still appear in package manifests because npm and release-please require them, but runtime code gets one generated constant:

```text
packages/core/src/version.ts
  PUPPETEER_VERSION
  PUPPETEER_CORE_VERSION   deprecated compatibility alias
```

Codex driver, observer, and account-usage client metadata import that constant instead of carrying three release-please literals. This removes the current `account-usage.ts` `0.1.3` drift. Package policy checks the README installation text against the root manifest, removing its independent `0.1.3` drift. Vendor versions continue to come only from promoted Surface manifests.

Every public manifest follows one checked contract:

- package name, root-relative directory, repository `directory`, lockstep version, license, module type, and Node engine are consistent;
- the Node engine is at least the repository baseline (`>=22.18.0` for this refactor);
- `files` is an allowlist and packing proves no captures, raw evidence, test cache, or source-only tooling leaks;
- every workspace import is declared in the correct production, peer, or development section;
- source and `publishConfig` export maps describe the same public subpaths;
- package scripts expose the common `clean`, `build`, `prepack`, `typecheck`, and `test` lifecycle unless a documented package role makes one inapplicable.

Build/test tooling may be root-owned when it is used only by repository scripts and test files. Anything imported by emitted public source must be declared by that package as a production or peer dependency. That distinction is why Vitest may stay centralized for ordinary `*.test.ts` files but must be a peer for the exported conformance module.

`scripts/public-packages.mjs` may retain an explicit topological publish order, but `packages:check` compares it and `release-please-config.json` against discovered public manifests. A new, renamed, or removed package cannot be omitted from one release mechanism while remaining in another.

### 5.9 Generated output and orphan hygiene

Add two repository commands:

```sh
pnpm packages:check          # read-only topology, manifest, graph, and release-list validation
pnpm packages:clean         # remove generated output for known workspace packages/apps only
```

`packages:clean` may remove declared `dist` directories and known tool caches. It does not delete `node_modules`, arbitrary direct children, evidence, captures, or unrecognized paths. Dependency-store cleanup remains an explicit package-manager operation.

R1 removes the exact known orphan `packages/node` and empty per-adapter emulator directory after a read-only check confirms they contain no tracked or non-generated files. The layout check then prevents either name from returning. Never use a broad recursive cleanup rooted at `packages/`.

## 6. Machine-readable contracts

### 6.1 `upstream.json`

Each real vendor has one declarative release/source configuration. It names:

- stable and optional preview release detectors;
- required platform acquisition work (R7 supplies executable acquisition methods);
- expected version extraction;
- checksum/signature sources where available;
- source repository and artifact-to-source correspondence rule;
- supported schema generator or census entry points;
- required platform matrix;
- debounce and supersession policy.

Detector implementations are reviewed code. `upstream.json` does not contain shell fragments interpolated from untrusted release metadata.

The first detector matrix is:

| Agent        | Stable release signal                                          | Source signal                                  | Required analysis                                                                              |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Claude Code  | vendor stable pointer, corroborated by GitHub release metadata | public repo release/tag when present           | binary flags/settings probes plus controlled hook/transcript/statusline census                 |
| Codex        | GitHub release/tag and exact release artifact                  | matching `rust-v<version>` source tag          | binary-generated stable and experimental app-server schemas plus hermetic fake-provider census |
| Grok Build   | vendor stable channel and changelog                            | public sync commit plus `SOURCE_REV`           | binary/ACP probes and a new reproducible census before first promotion                         |
| Future agent | explicit detector added as data                                | exact or declared source relation if available | family-appropriate schema generation and/or controlled census                                  |

Seed detector inputs, reviewed when this spec was written, are Claude's `https://downloads.claude.ai/claude-code-releases/stable` and `/latest` pointers plus its GitHub releases, Codex's GitHub releases in `openai/codex`, and Grok's `https://x.ai/cli/stable` / `alpha` pointers plus its changelog and public `SOURCE_REV`. These URLs initialize `upstream.json`; the configuration and its detector tests become authoritative afterward so this prose can age harmlessly.

Preview/latest channels are early-warning inputs. Only a stable candidate can become the README's promoted version unless the ledger explicitly labels an agent preview-only.

### 6.2 Evidence index

Each candidate version has an evidence index containing at least:

```json
{
  "evidenceVersion": 1,
  "vendor": "codex",
  "vendorVersion": "0.147.0",
  "artifacts": [
    {
      "id": "codex-darwin-arm64",
      "platform": "darwin-arm64",
      "channel": "stable",
      "sha256": "sha256:<digest>",
      "acquiredAt": "2026-08-08T00:00:00Z"
    }
  ],
  "sourceReferences": [
    {
      "repository": "https://github.com/openai/codex",
      "revision": "rust-v0.147.0",
      "relation": "exact-release"
    }
  ],
  "records": []
}
```

Every record has a stable id and digest. Local filesystem paths, account ids, prompts, responses, tokens, home directories, and credentials are prohibited. If licenses prevent artifact retention, the record keeps the acquisition URL, immutable digest, and verification metadata without redistributing the binary.

If the same vendor version later resolves to a different artifact digest, that is a `republished-artifact` incident—not a harmless rerun. The old evidence remains immutable and promotion stops for human review.

### 6.3 Support ledger

`support/agents.json` is the single promotion ledger. It references manifests rather than repeating vendor versions:

```json
{
  "schemaVersion": 1,
  "agents": [
    {
      "id": "claude",
      "displayName": "Claude Code",
      "kind": "vendor",
      "adapterPackage": "@vibecook/puppeteer-adapter-claude",
      "persona": "claude",
      "currentManifest": "packages/surface/vendors/claude/model/claude@2.1.207/manifest.json",
      "status": "verified",
      "introducedInPuppeteer": "0.1.8"
    },
    {
      "id": "grok",
      "displayName": "Grok Build",
      "kind": "vendor",
      "adapterPackage": "@vibecook/puppeteer-adapter-grok",
      "status": "baseline-pending"
    }
  ]
}
```

The paths and values above are migration examples, not permission to claim coverage that has not passed the gates in §8. In particular, Grok remains `baseline-pending` until an exact artifact, evidence index, ASM, persona, and real-artifact conformance lane exist.

The ledger can retain previous manifests for rollback and historical compatibility, but exactly one is `current`. A promotion changes that pointer. Detection of an upstream release does not.

ACP-like protocol adapters use `kind: "protocol"` and point at a protocol-conformance baseline rather than pretending there is a single vendor binary. Synthetic personas never appear in the public support ledger.

## 7. Continuous adaptation workflow

The workflow is a state machine, not a nightly script that overwrites files:

```text
detected -> acquired -> analyzed -> adapted -> verified -> promoted
               |           |           |          |
               +--------> quarantined / rejected <-+
```

### 7.1 Detection

`.github/workflows/upstream-agents.yml` runs on a six-hour schedule and `workflow_dispatch`. It discovers vendor definitions from `upstream.json`; adding an agent does not require editing the workflow matrix.

For every release signal it:

1. normalizes the vendor version and channel;
2. records all detected stable versions, even when rapid releases are later superseded;
3. debounces a new stable pointer until it is seen consistently, by default in two polls or for 30 minutes;
4. keys detected work by `(vendor, version, platform, release-signal digest)` with an explicit pending artifact digest; isolated acquisition replaces that pending identity with `(vendor, version, platform, artifact digest)` in R7 so retries are idempotent;
5. alerts on stable-channel rollback, detector disagreement, missing artifacts, or same-version republishing;
6. processes the newest stable candidate first when several upstream patches arrive before adaptation, while retaining an explicit skipped/superseded record for the others.

The detector state is append-only across versions and distinct same-version
signals. A compressed copy lives in the standing GitHub tracking issue and is
restored before each scheduled run; workflow artifacts provide the detailed
per-run report. A cache is only an acceleration path, not the historical source
of record.

Puppeteer does not promise to promote every upstream patch. It promises to notice each release and make the decision auditable.

### 7.2 Acquisition and analysis

Candidate artifacts execute only in ephemeral, unprivileged jobs with:

- no publish, repository-write, cloud, or user credentials;
- a disposable home and workspace;
- a fake local model provider where the agent family permits it;
- network denied after acquisition unless a specific probe requires a reviewed endpoint;
- bounded time, output, process, and filesystem quotas;
- raw output sanitized before any upload or PR creation.

The generic job starts only after a vendor-specific census has produced a
reviewer-prepared, claim-addressable ASM v2 candidate on the selected ref. It
downloads each artifact from reviewed HTTPS templates, probes only its bounded
version output in a disposable home, records immutable digests and source URLs,
attaches those identities without inventing claims, validates the model and both
projections, performs exact replay, and compares the candidate with the current
support model. Schema generation and family census remain explicit
vendor-specific work because treating unobserved generated shapes as runtime
truth would violate the evidence model.

It classifies the candidate:

| Class                  | Meaning                                                                                                       | Default action                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `no-surface-drift`     | modeled shape and observed behavior are unchanged                                                             | draft promotion PR after real-artifact smoke and platform gates |
| `additive-unconsumed`  | new native events/fields do not change an existing normalized path                                            | draft model/persona PR; human confirms unknown-event behavior   |
| `adaptation-required`  | removed/changed shapes, ordering, approvals, control, or normalized semantics                                 | draft report and issue; human updates adapter and persona       |
| `unsafe-or-unknown`    | artifact mismatch, sanitizer failure, unexplained silence, detector conflict, or incomplete platform evidence | quarantine; never update support metadata                       |
| `republished-artifact` | a known version now has a different digest                                                                    | high-priority quarantine and human investigation                |

### 7.3 Candidate PR

Automation may prepare a draft PR containing:

- the candidate evidence index and sanitized captures;
- generated ASM changes;
- a structural and behavioral diff report;
- generated persona additions that are mechanical and schema-valid;
- coverage gaps for adapter mappings, Imposter bindings, scenarios, and platforms;
- a recommendation, never an automatic claim of compatibility.

The publisher receives only a path-allowlisted Git patch and JSON reports, not
the acquired executables or credentials. It cannot modify promoted ledger
fields, README badges, raw captures, runtime adapter source, or unrelated files.

The support ledger and README badges remain unchanged while the PR is a candidate. A reviewer promotes with one command after all gates pass; that command updates the ledger and regenerates documentation in the same diff.

### 7.4 Promotion and rollback

Promotion is manual. The protected workflow reacquires the exact bytes on hosted
runners, then runs each artifact on a credential-isolated self-hosted runner for
its platform. Only the final job has repository-write permission, only that job
enters the `agent-surface-promotion` protected environment, and the promotion
command checks that the report belongs to the same repository, commit, workflow
ref, run, and attempt. Human review is always required when a release changes:

- approval or permission semantics;
- command execution, filesystem, network, or sandbox behavior;
- human-input/control behavior;
- event ordering or lifecycle meaning;
- normalized `AgentEvent` mappings;
- artifact provenance or platform coverage.

After the workflow has a measured history, `no-surface-drift` PRs may become eligible for auto-merge, but only with exact artifact integrity, all required platforms, real-artifact conformance, privacy checks, and branch protection green. Additive or semantic changes remain reviewed.

Rollback changes the ledger pointer back to a retained verified manifest and regenerates the badges. Evidence and candidate history are immutable; rollback never deletes them.

## 8. Verification gates

A version is `promoted` only when all applicable gates pass:

1. **Identity:** stable release metadata, exact version output, platform artifact digests, and source relationship are recorded.
2. **Privacy:** committed fixtures pass vendor-specific sanitization; raw captures remain ignored or access-controlled.
3. **Model:** the ASM validates, every claim has admissible evidence, and every sanitized native event is modeled.
4. **Adapter fixture lane:** the adapter normalizes Surface captures into the expected core contract, retaining unknown native events honestly.
5. **Imposter lane:** persona boot, ops, service table, behavior, and scenarios validate against the same ASM; off-model emission is refused.
6. **Replay-diff:** native emissions replayed or generated through Imposter match the modeled channel contract without treating authored scenarios as observations.
7. **Hermetic end to end:** adapter-against-Imposter conformance passes with no vendor binary, credentials, or network.
8. **Pinned real artifact:** the same conformance intent passes against the acquired upstream binary; this is mandatory because Imposter cannot detect vendor drift.
9. **Platform:** every platform declared required by `upstream.json` has a verified artifact SHA-256 and passes; removing an unsupported platform is an explicit policy change, not a passing verification result.
10. **Packaging:** published Surface includes the promoted models and excludes evidence/captures; adapters contain no model copies.
11. **Documentation:** ledger, generated README badges, findings, and compatibility status agree.
12. **Promotion attestation:** the all-gates report names the exact model-tree
    digest and checked-out commit, and promotion runs inside the matching
    GitHub Actions repository, exact workflow ref, run, and attempt.

The three principal test flows remain independent:

```text
Surface capture ----------> ASM audit
       |                         |
       +----> adapter ----------+----> AgentEvent expectations

semantic op ----> Imposter ----> native channel ----> adapter ----> conformance

pinned/latest real artifact ------------------------> adapter ----> reconciliation
```

The hermetic lane protects Puppeteer from its own regressions. The pinned real-artifact lane proves the adaptation. The latest lane detects upstream drift. None can replace the other two.

## 9. README support badges

The root README gains a generated block:

```md
<!-- agent-support:start -->

[![Claude Code verified: 2.1.207](https://img.shields.io/badge/Claude_Code_verified-2.1.207-blue)](packages/surface/vendors/claude/model/claude@2.1.207/manifest.json)
[![Codex verified: 0.147.0](https://img.shields.io/badge/Codex_verified-0.147.0-blue)](packages/surface/vendors/codex/model/codex@0.147.0/manifest.json)
[![Grok Build: baseline pending](https://img.shields.io/badge/Grok_Build-baseline_pending-lightgrey)](support/agents.json)
<!-- agent-support:end -->
```

Those are seed values from the current repository, subject to the promotion gates. The generator:

1. reads `support/agents.json`;
2. loads each referenced manifest and derives the displayed vendor version;
3. verifies the adapter package exists and every verified vendor has a persona;
4. verifies built-in personas reference the same promoted Surface model;
5. renders the marked README block deterministically;
6. offers `--write` and `--check` modes.

CI runs `node scripts/render-agent-support.mjs --check`. A hand-edited or stale badge fails. Badges show the exact **promoted** version, not a live upstream-latest value and not an optimistic semver range. They link to the evidence-bearing manifest so “verified” is inspectable.

The upstream watcher reports newer candidates through workflow summaries, issues, and candidate PRs. It does not mutate a green support badge merely because a vendor published something.

While adding generated README metadata, fix the existing manually stale install example (`0.1.3` while the repository is `0.1.8`) or derive that snippet from the root package version. Vendor support and Puppeteer package versions remain visually distinct.

## 10. Refactoring sequence

Each phase is independently reviewable. R1 is intentionally a filesystem/ownership move and R2 a package-contract cleanup before the evidence format changes, so failures have one cause at a time.

| Phase                                             | Work                                                                                                                                                                                                                                                                                                                                                                    | Exit                                                                                                                                                                                        | Implementation status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0 — freeze and inventory**                     | Record current model/package digests, inventory Surface paths, package directories, exports, release lists, version literals, and imports; make root `surface:audit` run every existing vendor audit; keep tests and packs green.                                                                                                                                       | The old layout is reproducible; Codex cannot be skipped; every later deletion has an explicit owner/consumer report.                                                                        | **Delivered 2026-08-08.** Baselines were audited before the move and root audit now discovers all vendor audits.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **R1 — physical cleanup and ownership move**      | Verify and remove the exact orphan `packages/node` and empty emulator remnant; move real-vendor Surface trees/findings under `packages/surface/vendors/`; update paths, package files, personas, privacy/ignore rules, and publication without changing behavior.                                                                                                       | Every `packages/*` directory is a real package; no real-vendor capture/model remains under an adapter or Imposter; model content is unchanged.                                              | **Delivered 2026-08-08.** The orphan and empty remnants were removed recoverably; Claude/Codex truth has one physical owner.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **R2 — package contracts and internal structure** | Add `packages:check`/`packages:clean`; migrate and remove vendor-specific Testing exports as the `0.2.0` break; group the populated Claude/Codex source responsibilities; centralize Puppeteer runtime version metadata; normalize manifests, dependency sections, docs freshness, pack checks, and release-list coverage; rename the live app to `imposter-control`.  | The flat graph is intentional and acyclic, Testing is vendor-neutral, generated/version drift fails CI, and every published tarball matches its role.                                       | **Delivered 2026-08-08.** The Testing migration is documented in `packages/testing/MIGRATION.md`; legacy root `emulator` commands remain temporary aliases.                                                                                                                                                                                                                                                                                                                                                                                               |
| **R3 — provenance and ASM v2**                    | Add `upstream.json`, evidence indexes, artifact/source identities, per-claim evidence maps, backward-compatible ASM v1 loading, and v2 validation/generation.                                                                                                                                                                                                           | Every promoted native claim traces to an artifact and admissible evidence; no free-form `source` string is the sole provenance.                                                             | **Promotion contract delivered 2026-08-09.** The loader remains compatible with ASM/evidence v1; Codex and Grok are claim-addressable ASM/evidence v2 with artifact identities, event/variant/behavior evidence, and deterministic tree digests. Claude remains a grandfathered ASM v1 baseline. Unqualified `verified` now requires ASM/evidence v2 plus an immutable digest for every declared platform; incomplete current baselines are labeled `legacy-verified`, never silently upgraded.                                                           |
| **R4 — independent projections**                  | Update adapter fixture tests, Imposter validation, exact replay ownership, replay-diff, import-boundary tests, and the pre-normalization Control boundary. Add a vendor-native behavior graph to each Surface; transmit it with raw native event metadata; demote the portable op machine to an explicitly named scenario driver; remove adapter reducers from the native plane. | Adapter and Imposter consume one Surface model without importing or deriving from each other; the native plane cannot assign normalized meaning; Godview receives production normalization only through adapters. | **Delivered 2026-08-09.** Generated adapter projections, Surface fixtures, persona pointers, dependency rules, native behavior graphs, direct Imposter spawning, conformance tests, and a vendor-neutral exact replay runner are in place. Replay validates request params, results, durable carriers, channel attribution, and raw sanitized bytes before normalization. The later devkit composes an explicitly downstream, non-production normalization projection without changing these boundaries. |
| **R5 — support ledger and badges**                | Add schemas, promotion/check commands, README generated block, runtime compatibility classification, and packaging checks.                                                                                                                                                                                                                                              | One pointer determines each public adapted version; manual duplicates fail CI.                                                                                                              | **Delivered 2026-08-09.** `support/agents.json` is authoritative; promotion requires a machine-readable all-gates-passed report, exact artifact/model digest, matching Git commit, and the actual GitHub Actions workflow/run attempt. It updates badges transactionally. Rich drift classification belongs to R7 analysis.                                                                                                                                                                                                                               |
| **R6 — release watcher**                          | Add data-driven scheduled detection, immutable candidate identity, alerts, workflow summaries, and narrowly scoped issue creation. Keep detection read-only and isolate the issue publisher's permission.                                                                                                                                                               | Every upstream stable release is noticed and recorded without executing it in a privileged context.                                                                                         | **Delivered 2026-08-09.** The six-hour workflow debounces authoritative detectors, retains every version and distinct signal in a durable tracking-issue ledger, reports rollback/disagreement/republish incidents, and hands concrete reviewed per-platform acquisition URLs to R7. It cannot execute artifacts or promote.                                                                                                                                                                                                                              |
| **R7 — adaptation bot**                           | Add isolated acquisition, schema/census analysis, classification, and draft candidate PRs; keep promotion manual.                                                                                                                                                                                                                                                       | A routine no-drift release arrives as a reviewable PR with evidence and all mechanical work complete.                                                                                       | **Guarded framework delivered 2026-08-09.** Hosted jobs acquire/hash the full platform matrix; a separate version probe uses a disposable home; analysis attaches artifacts only to a pre-traced ASM v2 candidate, stages the persona pointer, audits, replays, classifies, confines the patch, and can open a draft PR. Protected promotion reacquires artifacts and requires credential-isolated pinned-real reports from all platforms. Vendor-specific census/model generation remains a reviewed prerequisite rather than fabricated generic output. |
| **R8 — controlled automation**                    | After an observed reliability period, permit guarded auto-merge for `no-surface-drift` only; update companion drafts to describe the delivered architecture.                                                                                                                                                                                                            | Automation cannot promote semantic or security-relevant drift, and no active doc or public compatibility shim preserves the superseded ownership model.                                     | **Pending by design.** No release is auto-promoted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 10.1 Migration constraints

- Preserve the current model content byte-for-byte during R1 except for paths that must change.
- Do not combine the ownership move with adapter behavior fixes.
- Before retiring a manifest-backed package, inventory tracked files, workspace/external consumers, and any public registry compatibility obligation. Before deleting a manifest-less local orphan, prove it contains no tracked or non-generated files. The second rule applies to the current `packages/node` residue; the first protects real small packages.
- Keep the package directories flat and npm names unchanged; internal Claude/Codex source moves happen only in R2 after R1 is green.
- Do not create compatibility copies under adapters; one physical model is the invariant. The old non-exported package path is retired in release notes.
- Announce/deprecate the public Testing fixture APIs before their `0.2.0` removal when release timing permits; in every case provide migration notes and never silently redirect them to a different evidence set.
- Replace hard-coded current versions in census/audit scripts with an explicit candidate argument or a support-ledger lookup.
- Keep `packages/surface/src/model.ts` self-contained and `erasableSyntaxOnly`; moving data beside it does not weaken that compiler boundary.
- Keep raw capture paths gitignored before the first automated census runs.
- Preserve unknown native messages rather than dropping them while a new release is under analysis.
- Add a structural CI test that rejects `packages/adapter-*/surface/{model,captures,captures-raw}` and real-vendor models under `packages/imposter/personas/`.
- Never make `packages:clean` recursively delete an unrecognized directory merely because it lacks a manifest.

## 11. Command surface

The delivered repository-wide command surface is:

```sh
pnpm packages:check
pnpm packages:clean
pnpm surface:audit
pnpm surface:detect
pnpm surface:download --vendor codex --version <version> --platform <platform> --output <path>
pnpm surface:acquire --vendor codex --version <version> --artifact <platform>=<path> --version-output <platform>=<text>
pnpm surface:evidence:artifacts --manifest <path> --artifacts <acquisition.json>
pnpm surface:replay --vendor codex --manifest <path>
pnpm surface:reconcile --vendor codex --manifest <path> --artifacts <acquisition.json>
pnpm surface:verify --vendor codex --manifest <path> --platform-report <path>
pnpm surface:promote --vendor codex --manifest <path> --verification <path>
pnpm support:check
pnpm support:write
```

`packages:check` is read-only and validates topology, manifests, the dependency DAG, exports, release-list coverage, and packed ownership rules. `packages:clean` removes generated output only from known workspaces. `surface:audit` is hermetic and checks every selected support/candidate baseline. `surface:detect` performs release metadata discovery only. `surface:download` accepts only reviewed HTTPS origins (including every redirect), bounds the response stream before buffering, and validates binary/archive layouts; `surface:acquire` hashes already downloaded bytes, rejects duplicate platform arguments, and detects same-version republishing. `surface:evidence:artifacts` will update only an identity-matching, already claim-addressable ASM v2 evidence index. `surface:replay` is exact and pre-normalization, failing directional orphan results; `surface:reconcile` classifies artifact completeness plus event/variant/behavior confidence, channel, detector, structural, and behavioral drift without promoting. `surface:verify` aggregates repository gates and platform reports. `surface:promote` refuses unless a machine-readable verification report satisfies §8, the candidate carries a verified artifact/model digest for the complete platform matrix, and the report is bound to the checked-out commit plus the active GitHub Actions workflow, run, and attempt. Promotion persists that attestation in the ledger; legacy baselines instead carry frozen manifest/model digests. The support commands only render and validate ledger-derived documentation.

The watcher and generic workflow do not manufacture a vendor-specific census or
ASM. A maintainer or vendor-specific generator prepares those semantic changes;
the general pipeline owns the repeatable acquisition, identity, replay, diff,
classification, confined publication, verification, and promotion transaction.

## 12. Proposal-time R1/R2 touch map

The direct seams found before implementation are preserved below as the migration record. R0 regenerated this inventory before files moved; the target treatment column describes the delivered result rather than a second source of current paths.

| Area                    | Current seam                                                                                                                            | Target treatment                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Root orchestration      | `package.json` routes `surface:audit` to Claude only                                                                                    | discover and run every promoted Surface audit                                                                                                |
| Orphan package          | ignored `packages/node/{dist,node_modules}` survived the tracked package's Ghosttea migration                                           | verify contents, remove the exact directory, and reject future manifest-less `packages/*` children                                           |
| Empty emulator remnant  | `packages/adapter-claude/surface/emulator/scenarios` is empty                                                                           | remove it; Imposter owns scenarios                                                                                                           |
| Surface publication     | `packages/surface/package.json` publishes `dist` only                                                                                   | add promoted `vendors/*/model` and minimal provenance metadata                                                                               |
| Adapter publication     | Claude publishes `surface/model`; Codex does not                                                                                        | remove all adapter model publication                                                                                                         |
| Imposter resolution     | Claude/Codex `persona.json` point at adapter packages; loader errors and tests say adapter-owned                                        | point at `@vibecook/puppeteer-surface`, update loader contract text/tests, and remove adapter dev dependencies used only for ASM resolution |
| Claude runtime          | `src/detection.ts` imports adapter-local `detection.json`; `registry.ts` is generated from the local model                              | generate checked adapter projection modules from the promoted Surface manifest                                                               |
| Claude tooling          | audit, sanitizer, registry generator, tests, and package scripts assume adapter-relative paths and `2.1.207`                            | move tooling and resolve the explicit candidate or support-ledger baseline                                                                   |
| Codex tooling           | census, sanitizer, model generator, audit, and `surface-model.test.ts` share hard-coded `CODEX_VERSION` and adapter-relative paths      | move under Surface and take version/artifact identity from candidate metadata                                                                |
| Privacy gate            | `scripts/check-captures.test.mjs` enumerates adapter capture roots and prints adapter-local sanitizer instructions                      | discover Surface vendor capture roots and route to the owning sanitizer                                                                      |
| Ignore rules            | `.gitignore` ignores `packages/adapter-*/surface/captures-raw/`                                                                         | ignore `packages/surface/vendors/*/captures-raw/` before moving or capturing                                                                 |
| Testing ownership       | `packages/testing/fixtures/hooks`, its loader API, and `fakeClaudeHookPayload` duplicate/vendorize Claude evidence in a general package | move evidence/loaders to Surface, synthetic builder to Claude test support, deprecate then remove public exports                             |
| Testing peer contract   | exported conformance code imports Vitest while Vitest is only a development dependency                                                  | declare Vitest as a peer plus dev dependency, or make the runner framework-neutral                                                           |
| Runtime version         | Codex driver/observer carry release literals and account usage still reports `0.1.3`; Core has a separate literal                       | export one generated `PUPPETEER_VERSION` from Core and make all client metadata consume it                                                  |
| README package catalog  | the public package list omits Surface and Imposter, and its install example is still `0.1.3`                                            | list packages by the roles in §5.5 and generate the install version from the root manifest                                                   |
| Package inventory       | `scripts/public-packages.mjs` and release-please separately enumerate public manifests                                                  | retain required order/config but cross-check both against manifest discovery                                                                 |
| Package manifests       | Node engines, `package.json` exports, dependency sections, and common scripts are inconsistent                                          | enforce the manifest contract in `packages:check` and verify tarball contents                                                                |
| Internal adapter layout | larger Claude/Codex sources are flat while Imposter already has responsibility folders                                                  | mechanically group only populated observation/control/transport/launch/generated areas in R2                                                 |
| Legacy app name         | live `apps/emulator` is easily confused with deleted `packages/emulator`                                                                | rename to `apps/imposter-control`; retain deprecated root command aliases temporarily                                                        |
| Findings/docs           | Claude/Codex findings and the three companion drafts name adapter-owned paths                                                           | move or relink findings and retain the supersession notices until the historical docs are fully reconciled                                   |
| Packaging tests         | Claude's manifest includes the model while pack checks currently verify tarball count, not ownership                                    | assert Surface contains promoted models; adapter/testing tarballs exclude evidence; all files match allowlists                               |

## 13. Definition of done

This refactor is complete when:

- [x] Every direct `packages/*` directory is one intentional manifest-backed package, with no `packages/node`, empty emulator remnants, or category placeholders.
- [x] The eleven retained packages remain a flat, acyclic graph with checked roles, manifests, exports, release coverage, and tarball allowlists.
- [x] `packages/surface` is the only owner of real-vendor evidence and ASM data.
- [x] Adapters own detection, launch, observation, native control, normalization, and generated projections—not real-vendor truth or Imposter scenarios.
- [x] Imposter contains only emulation concerns plus its synthetic model exception.
- [x] Every promoted Surface carries a validated native `behavior.json`; its nodes use exact native names and its graph is a partial order, not a normalized lifecycle.
- [x] The native Control plane launches Imposter directly, leads with native behavior/raw payloads, and has no adapter reducer dependency or normalized session-state route; the containing devkit labels any adapter/Core view as a removable downstream projection.
- [x] Portable op state is named and displayed only as `scenarioDriver`; compaction and team status are not inferred before the adapter boundary.
- [x] `packages/testing` exposes provider-neutral terminal/conformance utilities and no real-vendor evidence; the removed Claude fixture APIs have `0.2.0` migration notes.
- [x] Record and Workspaces remain independent capability packages because their direct consumers and I/O boundaries are documented, not merged merely for being small.
- [x] One release-managed `PUPPETEER_VERSION` supplies runtime client metadata; package policy checks reject disagreement with the root and README install versions.
- [x] Exported test-runner integration declares its peer dependency, and all workspace imports are present in the correct manifest section.
- [x] `packages:check` and safe generated-output cleanup run in CI or its preflight, and broad deletion of unknown package paths is impossible.
- [ ] Every current support model identifies exact vendor artifacts, platform coverage, source correspondence, and claim evidence. Claude is ASM/evidence v1 with no retained binary digest; Codex is ASM/evidence v2 with an exact darwin-arm64 digest but lacks the other three platforms. Both are explicitly `legacy-verified`; future unqualified promotion rejects either gap.
- [x] Exact source and generated schemas are used where available without being treated as universal substitutes for shipped behavior.
- [x] Root CI audits every promoted agent and enforces projection boundaries.
- [x] Hermetic, pinned-real, and latest-reconciliation lanes are visibly distinct: exact replay/reconciliation is general, while credential-isolated platform execution and protected promotion are separate workflows.
- [x] Every detected stable release enters an auditable, debounced candidate state.
- [x] For a reviewer-prepared ASM v2 candidate, routine acquisition, evidence binding, replay, diffing, classification, confined staging, and draft-PR creation are automatic.
- [ ] Vendor-specific census and semantic model generation are automated without treating generated schemas or authored scenarios as observed truth.
- [x] Semantic/security changes and promotion remain human-reviewed until an explicit later policy changes that rule.
- [x] `support/agents.json` is the only promotion ledger; verified entries retain workflow/model/replay/platform attestations, while legacy entries are frozen to explicit manifest/model digests.
- [x] README badges are generated from promoted manifests and cannot drift by hand.
- [x] Grok is labeled baseline-pending until it earns the same evidence chain as Claude and Codex.
- [x] Companion docs no longer claim that adapters or Imposter own real-vendor truth.
- [x] The live Imposter control app is no longer confused by name or documentation with the deleted `packages/emulator` implementation.

The architectural invariant is concise enough to test and remember:

> **Surface records native evidence. Adapters normalize it. Imposter simulates it. Conformance cross-checks both. Promotion alone declares what Puppeteer currently supports.**
