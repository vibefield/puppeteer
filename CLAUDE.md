# Chopsticks

A provider-neutral TypeScript runtime that **hosts coding agents' own terminal UIs**. Claude Code
looks like Claude Code; Codex looks like Codex. Chopsticks owns the process environment around that
UI — lifecycle, observation, guarded control, workspace isolation, receipts — and derives semantic
state from native side channels, never by reading the screen.

`draft/DESIGN.md` is the canonical architecture (ADRs, §-numbered; comments across the codebase cite
it). `draft/IMPLEMENTATION-PLAN.md` records what was scoped, deferred, and rejected, and why.
`draft/SURFACE-ADAPTATION-REFACTOR.md` is the live ownership, package-structure, and continuous
adaptation spec. `draft/ADAPTING-AN-AGENT.md` is the canonical start-to-finish developer workflow.
`draft/EMULATOR.md` and `draft/IMPOSTER.md` retain historical rationale but are superseded where
they assign truth to adapters. One executable (`ai`)
impersonates every vendor from a persona; there are no per-adapter bins.

## Sibling repos (this is layer 2 of 3)

| Repo                          | Role                                                                      | Boundary                             |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `p008/spaghetti`              | Static agent-data plane: SQLite/FTS index of transcripts, settings, todos | Bytes left on disk                   |
| **chopsticks**                | Live lifecycle: spawn, observe, control, isolate                          | A live handle to an agent process    |
| `project100/electron-ghostty` | Ghosttea terminal stack (the PTY spine) — repo is `vibecook-dev/ghosttea` | Terminal rendering and PTY ownership |

Chopsticks persists **operational state only**. It never grows browse or search features — if its
records become worth searching, spaghetti indexes them as one more file source.

## Invariants — do not break these without revisiting DESIGN

- **Never derive semantics from terminal text.** Priority order: native hooks/protocols → native
  logs/transcripts → workspace/process observation → screen inference (always marked inferred).
  (ADR-003/-004/-005)
- **One native session = one agent process.** Never spawn a shadow `--print`/`exec` process to
  shadow a TUI session. Never pass `-p`, `--print`, or stream-json flags to an interactive launch.
  (ADR-002)
- **`core` is zero-I/O.** No PTY, process, socket, or filesystem access — types, the reducer, and
  pure helpers only. I/O lives in adapters or the app.
- **Adapters reach terminals only through `AgentHost`** (`packages/core/src/host.ts`): `spawnTerminal`
  - `automateTerminal`. Everything else (app-servers, leaders, sockets, transcripts) the adapter
    builds itself. Applications supply the host.
- **Unknown native events are retained verbatim** as `UnknownNativeEvent` rather than dropped.
  (ADR-008)
- **Prompt injection never overstates certainty.** Claude's guarded bracketed paste confirms against
  a matching `UserPromptSubmit`; `PromptReceipt` may legitimately be `uncertain`. Structured drivers
  (Codex) get deterministic confirmation via `clientUserMessageId` — don't unify them by pretending
  the paste path is deterministic.
- **Launch environments can carry session bearer tokens.** Never log or persist them.

## Layout

```
packages/
  core/          AgentEvent union (29 members) + reduceSessionState + AgentHost + ObservationLevel
  runtime/       AgentRuntime — the single app-facing surface; providers, git observer, conversation
  adapter-claude/  hooks bridge, generated settings, transcript observer (spaghetti SDK), statusline usage
  adapter-codex/   app-server JSON-RPC over WS-in-UDS, structured driver, TUI attach via --remote
  adapter-acp/     generic ACP driver;  adapter-grok/ layers on it (--leader coexistence)
  workspaces/    direct | exclusive | worktree | copy isolation + final-diff metadata
  record/        append-only JSONL of runtime-owned actions;  testing/ fake agent + conformance
  surface/       neutral real-vendor evidence: vendors/<vendor>/{upstream.json,findings.md,captures,
                 model,audit.mjs} + the ASM runtime (loadModel, validatePayload, drift) and sanitiser.
                 SELF-CONTAINED and `erasableSyntaxOnly` — surface .mjs scripts import it under node
                 type stripping, which is why it owns a package (draft/IMPOSTER.md §7.1)
  imposter/      `ai` — one executable that impersonates every vendor from its captured ASM.
                 personas/<vendor>/ (ops, boot, behavior, scenarios), session + channels, op timeline,
                 session/scenario-driver.ts (the xstate lifecycle over the op vocabulary — DESCRIPTIVE, it
                 never gates; off-model ops are counted, not refused), scenario runner, control/ (UDS
                 JSON-RPC client + shared protocol), tui/ (one shared Ink chrome, dynamically imported
                 ONLY on a TTY — it costs ~40 MB of RSS, and `CHOPSTICKS_IMPOSTER_TUI=off` forces the
                 append-only sink). Relative imports end in `.ts` here, NOT `.js` — see
                 packages/imposter/src/index.ts for why. `ai` reaches PATH through the package
                 manager (`pnpm ai:link`) and has NO subcommands — two install commands were built
                 and deleted the same day (draft/IMPOSTER.md §6); a vendor name reaching the imposter
                 is one `ln -s`, and an app does it per session via `agentOptions.executable`

Real-vendor truth lives only under `packages/surface/vendors/<vendor>/`: protected raw captures,
sanitized tracked captures, source/release provenance, versioned ASM, findings, and audit/census
tools. Adapters consume generated runtime projections and normalize native input into `AgentEvent`;
they do not publish models. Imposter consumes the same promoted Surface model and owns only ops,
behavior, scenarios, presentation, and synthetic-vendor models. `support/agents.json` is the sole
promotion ledger; README badges are generated from it. Surface `.mjs` scripts need Node ≥22.18
(type stripping) and import only self-contained modules.
apps/
  godview/       current focus — Electron swarm view (matter.js bubbles, panes, usage panel)
  imposter-control/  Agent adaptation devkit (`pnpm agent-devkit`; legacy `pnpm imposter-control`).
                 Owns the native control plane: one UDS at `~/.chopsticks/imposter.sock` that
                 imposters dial into, plus a loopback HTTP+SSE console. Liveness is socket close —
                 there is no discovery file and nothing polls (draft/IMPOSTER.md §5). The generic
                 plane stays adapter/Core-free. The app composes an optional downstream
                 normalization projection and presents native evidence → folding decisions → Core
                 state facets with correlated time travel (draft/NORMALIZATION-DEVKIT.md). The
                 scenario driver remains secondary authoring intent and never becomes vendor state.
```

`packages/node` is **gone** (commit `1eea6db`) — the PTY spine moved to electron-ghostty.
`pnpm packages:check` rejects manifest-less package children so retired husks cannot return.

## Commands

```sh
pnpm test           # typecheck + script tests + every package and app suite
pnpm godview        # bundle + launch the Electron swarm app
pnpm format         # prettier --write over packages/*/src (CI runs format:check FIRST)
pnpm pack:check     # build + pack every public package into tarballs
pnpm ai:link        # pnpm add --global ./packages/imposter — then `ai --claude` anywhere
pnpm surface:audit  # audit every captured vendor model from packages/surface
pnpm surface:download # download one reviewed, allowlisted upstream artifact without executing it
pnpm surface:acquire # hash/version-bind a complete set of already downloaded platform artifacts
pnpm surface:replay # exact pre-normalization replay of sanitized captures through the persona contract
pnpm surface:reconcile # classify an ASM v2 candidate; never promotes support
pnpm surface:verify # aggregate hermetic and pinned-real promotion gates
pnpm surface:promote # guarded ledger + README transaction; accepted only in its attested CI run
pnpm packages:check # package manifests, versions, exports, release coverage, dependency boundaries
pnpm support:check  # support ledger, personas, promoted manifests, generated README badges
pnpm upstream:detect # read-only release discovery; never promotes support
```

The adaptation and promotion workflows keep artifact execution separate from repository-write
credentials. Candidate analysis starts from a reviewer-prepared, claim-addressable ASM v2 model;
generic automation may attach immutable platform artifacts, replay, classify, stage a candidate,
and open a draft PR, but it does not invent vendor-specific census claims. Only the protected
promotion workflow can move the support pointer, after all four declared platforms pass against
the reacquired bytes. `legacy-verified` means an existing support baseline predates those gates;
it remains readable and supported, but cannot be promoted again as unqualified `verified`.

Live adapter probes are opt-in and skipped by default: `CODEX_LIVE=1`, `GROK_LIVE=1`,
`CHOPSTICKS_REAL_CLAUDE=1`. Agent binaries resolve from PATH or `CHOPSTICKS_{CLAUDE,CODEX,GROK}_BIN`.

**CI covers `packages/**` and `apps/**` in separate jobs.** The apps consume everything Ghosttea
from npm at an exact pinned version, including the two native artifacts that used to require the
sibling checkout: the daemon prebuilt through `@vibecook/ghosttead` (override with `GHOSTTEAD_BIN`
to run one built from source) and the tab-ordering addon through `@vibecook/ghosttea-native-tabs`.
No sibling checkout or Rust toolchain is needed anymore.

**Never import `@vibecook/ghosttead` from app `main`.** It is ESM-only, and Electron's bundled Node
cannot `require` it from a CJS bundle — bundled _or_ external. `build.mjs` calls `ghostteadPath()`
at build time and stages the binary into `dist/bin/`, the same shape as the native tabs addon;
where no prebuild exists the staging is skipped and `GHOSTTEAD_BIN` is required. This fails only at
launch, so **verify app changes with `pnpm godview:smoke`, not just the suite.** Pass
`GHOSTTEA_TRUFFLE_ENABLED=false` to smoke without a Tailscale login.

## Conventions

- ESM throughout: relative imports end in `.js` even in TypeScript. `verbatimModuleSyntax` is on, so
  type-only imports need `import type`.
- In-repo `exports` point at `./src/index.ts`; `publishConfig` remaps to `dist` at pack time. Cross-package
  changes need no build step during development.
- Expected failures return typed result objects (`{ error: { code, message } }`) rather than throwing;
  codes are unions like `PreparationErrorCode`. Throwing is for programmer error.
- Comments explain **why** — a rationale, a protocol quirk, a DESIGN reference. Match that register;
  don't add comments that restate the code.
- Prettier: single quotes, trailing commas, width 120.
- Providers stay behind the `AgentProvider` seam in `packages/runtime/src/providers.ts`. Adding an
  agent means a new adapter + provider entry + a variant in `BuiltinCreateAgentSessionOptions` —
  never provider-specific branching inside `runtime.ts`.

## Releases

release-please owns versions and tags; **never hand-bump a version**. All public packages release in
lockstep from the root manifest, including the single `// x-release-please-version` marker in
`packages/core/src/version.ts`. Publishing goes through tokenless npm
trusted publishing in `.github/workflows/release.yml`. To retry a partial publish:
`gh workflow run release.yml --ref main -f tag=vX.Y.Z`.

Applications should pin `@vibecook/chopsticks-runtime` exactly and treat upgrades as deliberate
integration events. Node.js 22.18+.
