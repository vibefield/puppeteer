# Chopsticks Agent Imposter — v0.1

**Status:** Archived implementation rationale; active behavior lives in `packages/imposter` and Surface-owned vendor models
**Created:** 2026-08-07
**Companion:** `docs/archive/EMULATOR.md` (the ASM format and captured-truth pipeline this consumes; its §3–§6 emulator machinery is what this replaces), `draft/ADAPTING-AN-AGENT.md` (the six-step workflow this shortens at steps 3 and 5), `draft/DESIGN.md` (canonical architecture)
**Supersedes:** `packages/emulator` and the per-adapter `surface/emulator/bin.mjs` pattern — the P2/P3 proof of concept, delivered and validated end to end on 2026-08-07, retired per §7

> **Ownership update (2026-08-08):** `draft/SURFACE-ADAPTATION-REFACTOR.md` supersedes this document's adapter-owned ASM decision. Real-vendor evidence and models move to `packages/surface`; Imposter remains a sibling projection and owns only emulation data. The synthetic persona's local model remains the exception.

---

## 0. Charter

> One executable impersonates every agent. `ai --claude`, `ai --codex` — or, through installed shims, plain `claude` and `codex` on PATH. It speaks the vendor's real machine surfaces (hooks, transcripts, statuslines, JSON-RPC), connects itself to the control center over a Unix socket so it is discovered without registration bookkeeping, and adds a new vendor through data rather than a new executable.

---

## 1. What this changes, and what it must not

The proof of concept proved the semantic model works. It did so with **N per-adapter bins**, each reimplementing argv parsing, boot sequencing, channel wiring, and control registration; a stubbed terminal; and discovery through a state file plus two HTTP servers plus polling. This spec keeps the model and replaces the packaging.

| Concern          | PoC                                                            | Imposter                                                                  |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Executables      | one `bin.mjs` per adapter                                      | one `ai` CLI, N personas                                                  |
| Terminal channel | stub (`ADR-003` consequence, accepted)                         | shared cosmetic TUI (§4)                                                  |
| Discovery        | state file → HTTP register → HTTP callback → 1.5 s poll        | one UDS the plane owns; imposters dial in and hold (§5)                   |
| Adding a vendor  | new executable + new behavior pack                             | persona data (§3)                                                         |
| Packages         | `packages/emulator` (ASM runtime + engine + control, one name) | `packages/surface` (ASM) + `packages/imposter`; plane moves app-side (§7) |

### 1.1 The invariant (do not relitigate)

**Chopsticks never derives semantics from terminal text** (ADR-003/-004/-005). Introducing a real TUI is safe _only_ because nothing downstream consumes it: godview renders those bytes for a human, and the reducer's inputs remain hooks, transcript, statusline, and JSON-RPC.

Therefore:

- The imposter's TUI is an **output-only channel**. The imposter's own tests may diff its frames; **no chopsticks package may assert on them**.
- The TUI is explicitly **not** a clone of any vendor's interface (§4). Vendor-interface parity is a stated non-goal, not a deferred phase.
- A test that proves a semantic by reading imposter screen text has crossed the line the emulator exists to defend. Treat it as a build failure, not a style nit.

### 1.2 Truth still flows one way

`EMULATOR.md §1` is unchanged: real artifact → captures → ASM → projections. Surface owns the capture-derived ASM. Adapter and Imposter are sibling projections: the adapter normalizes native input, while Imposter emits native behavior from semantic ops. Everything authored downstream of the model stays outside the truth layer (§3.3).

---

## 2. The single timeline — one truth, two projections

The PoC's `bin.mjs` runs two independent paths: the behavior pack emits hooks and writes the transcript, and separately something writes stdout. They can disagree. With a real TUI they _will_ disagree, constantly — and an imposter whose screen contradicts its hooks is worse than a stub, because it looks trustworthy.

A turn is therefore a sequence of semantic **ops**, each fanning out to both projections:

| op                | claude (hook + transcript) | codex (JSON-RPC app-server)                          | presentation        |
| ----------------- | -------------------------- | ---------------------------------------------------- | ------------------- |
| `turn.start`      | `UserPromptSubmit` hook    | `turn/started` notification                          | prompt echoed       |
| `assistant.delta` | transcript record          | `item/agentMessage/delta`                            | streamed text       |
| `tool.start`      | `PreToolUse` hook          | `item/started`, item type `commandExecution`         | tool line, running  |
| `tool.end`        | `PostToolUse` hook         | `item/completed`                                     | tool line, resolved |
| `permission.ask`  | `PermissionRequest` hook   | a **server request** — method carried in the mapping | pending marker      |
| `turn.end`        | `Stop` hook                | `turn/completed`                                     | idle marker         |
| `usage.refresh`   | statusline invocation      | `thread/tokenUsage/updated`                          | context readout     |

(Codex method names now come from the **vendor's own generated schema**, not from the adapter — see §9.1. That distinction is load-bearing: the adapter's method _names_ all check out, but its item-type and approval-decision vocabularies do not, so citing it as the source would have propagated three confirmed errors. Codex approvals are generic on the adapter side — `driver.ts:137` passes the server-request method straight through as `tool` — so the imposter supplies the method.)

This is `EMULATOR.md §1`'s "two projections, one truth" applied one level down. It buys three things:

1. **The screen cannot structurally contradict the wire.** Not a discipline — a consequence of there being one source.
2. **Scenarios become authorable at the op level.** Raw `emit` stays available for fault, duplicate, out-of-order, and unknown-event cases that must bypass the op layer by definition.
3. **Adding a vendor is a mapping.** Ops → that vendor's channel emissions. That mapping _is_ the schema (§3.2).

The op vocabulary is deliberately small and semantic. It is not a superset of every vendor's events — anything not expressible as an op is written as a raw emission in a scenario.

### 2.1 Consequence for the mapping format

The two families discriminate differently, and this falls out of the table above: claude gives each op a **distinct event name**, while codex routes several ops through **one method** (`item/started`) and discriminates by item type in the payload. So `ops.json` cannot be a name lookup — each entry is a name _plus a payload template_:

```json
{
  "tool.start": {
    "channel": "jsonrpc",
    "method": "item/started",
    "with": { "item": { "type": "commandExecution", "command": "$op.command" } }
  }
}
```

This is the first thing the codex persona proves that the claude persona alone never would — which is precisely why §8 lands them together.

---

## 3. Personas

### 3.1 Layout

```
packages/surface/                       @vibecook/chopsticks-surface   (ASM runtime — §7.1)
  src/model.ts                          self-contained; erasableSyntaxOnly package-wide

packages/imposter/                      @vibecook/chopsticks-imposter
  bin/ai.mjs                            entry; resolves persona, then delegates
  src/
    cli/argv.ts                         persona from argv0 | --<vendor> | AI_PERSONA
    persona/load.ts                     ASM (Surface) + persona data → Persona
    session/timeline.ts                 the op timeline (§2)
    session/scenario.ts                 raw/adversarial layer beneath the ops
    session/channels/                   hook, transcript, statusline, jsonrpc, paste decoder
    control/{client.ts, protocol.ts}    UDS JSON-RPC client + shared message shapes (§5)
    tui/                                ONE shared Ink app; renderer only (§4.1.1)
  personas/
    claude/{persona.json, ops.json, runflows.json, behavior/, scenarios/}
    codex/{persona.json, ops.json, runflows.json, behavior/, scenarios/}
    synthetic/                          absorbs packages/testing/bin/fake-agent.mjs (§7.4)
```

Two packages, not one: §7.1 explains why the ASM runtime keeps its own compiler boundary.

### 3.2 The persona contract

Most of a persona already exists as ASM. That is the point—the evidence/modeling stage has already done this work without trusting either projection.

| Persona needs                                           | Source                                          |
| ------------------------------------------------------- | ----------------------------------------------- |
| binary names, `--version` / `--help` output, flag names | `detection.json` — **existing ASM**             |
| which channels to bring up                              | `channels.json` — **existing ASM**              |
| event names + payload schemas                           | `events/*.json` — **existing ASM**              |
| op → channel emission mapping                           | `ops.json` — **new**, per persona               |
| boot op sequence                                        | `persona.json` — **new**, per persona           |
| stimulus → response, fault timelines                    | `behavior/`, `scenarios/` — existing, relocated |
| curated devkit entry points                             | `runflows.json` → references `scenarios/`        |

A new agent therefore costs: the ASM the adapter needs anyway, plus an ops map and a boot sequence. There is **no chrome file** — see §4.

`persona.json` names its own Surface ASM source:

```json
{
  "vendor": "claude",
  "asm": { "package": "@vibecook/chopsticks-surface", "path": "vendors/claude/model/claude@2.1.207" },
  "shimNames": ["claude"],
  "boot": ["session.start", "instructions.loaded", "statusline.refresh"]
}
```

Surface publishes `files: ["dist", "vendors/*/model"]`, so a published Imposter can resolve a promoted ASM. The loader resolves `@vibecook/chopsticks-surface/package.json` and joins the declared model path; it does not deep-import JSON through package exports.

### 3.3 Ownership split

**Decided.** Real-vendor evidence, ASM, provenance, and audit tools live in `packages/surface/vendors/<vendor>/`. Everything Imposter authors—ops, boot, behavior, scenarios, faults, and presentation—centralizes here and never becomes evidence. The synthetic persona's local invented model is the sole exception because no real vendor exists to observe. Adapter mappings and Imposter behavior are reconciled independently against the same Surface model.

---

## 4. The TUI — cosmetic, shared, deliberately not a clone

**One chrome for every persona.** It conveys which agent is being impostered and enough operational readout to debug by. It is not themed per vendor and there is no fidelity ladder.

This is a goal, not a compromise. Cloning vendor interfaces would burn effort on the one surface chopsticks is forbidden to read, and would produce a screen convincing enough to invite exactly the mistake §1.1 prohibits. A screen that plainly announces itself as an imposter is the safer artifact _and_ the cheaper one.

Content:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  ╭───╮  IMPOSTER impersonating claude 2.1.207                                │
│  │· ·│  session 5f0253c2  scenario ready                                     │
│  ╰~~~╯  argv · hook · transcript · statusline · terminal                     │
│ ──────────────────────────────────────────────────────────────────────────── │
│ 18:34:24.577  session.start                                                  │
│ 18:34:25.651  turn.start  "summarise the repo"                               │
│ 18:34:25.652  turn.end  "imposter: ok"                                       │
╰──────────────────────────────────────────────────────────────────────────────╯
 ›
```

Identity, portable scenario intent, channel liveness, the live op stream, and a prompt line that accepts paste. Nothing else. In practice this doubles as a local authoring mirror of the control center, which is useful when debugging a session that has no console attached.

**Violet and blue, and a ghost.** The palette is a safety property, not decoration: Claude Code is orange and Codex is green, so an imposter that borrowed either would invite the confusion §1.1 exists to prevent. The chrome has to say _stand-in_ from across the room, in a pane you did not launch yourself. The ghost's eyes follow the scenario-driver phase, which is the one piece of personality this screen gets.

**The scenario phase on screen is not vendor truth.** It is the same `ScenarioDriverSnapshot` used by the secondary authoring view in Control (§11). It says which portable ops the Imposter is composing; it does not claim what the real vendor calls its state. Ops the persona binds to no channel are shown too, marked `(unbound)`: they happened in the authored scenario and said nothing on the native wire.

### 4.1 Stack: Ink 7

**Decided: Ink `7.1.1`.** Verified against the registry: `engines.node >= 22`, peer `react >= 19.2.0` / `@types/react >= 19.2.17`. The repo already pins `react ^19.2.7` and `@types/react ^19.2.17` — it drops in with no version negotiation and no new paradigm.

Ink is chosen for the **pinned layout**: header and prompt held in place while the event log scrolls between them. That is genuinely what a re-rendering framework is for, and hand-rolling it means alt-screen management, cursor positioning, and redraw-on-resize.

Note the rationale that does **not** apply: "Claude Code is built on Ink, so it looks closer." True, and irrelevant — §4 rules out parity.

### 4.1.1 Ink renders; it does not own input

Ink 7 ships a `usePaste` hook that enables bracketed-paste mode and delivers a paste as one string. **Do not use it.** The pipe path (§4.2) needs `createPasteDecoder` regardless, and adopting `usePaste` would mean two independent implementations of the one input path the adapter depends on — exactly the drift §2 exists to prevent, in the most load-bearing place.

Instead: take raw stdin through `useStdin` + `setRawMode` and feed the bytes to the **same decoder** both modes use; let its callbacks drive React state. Ink is then purely a renderer. This works because Ink enables bracketed-paste only while `usePaste` is mounted — without it, raw `\x1b[200~…\x1b[201~` arrives as ordinary data, which is precisely what the decoder expects. `useInput` is likewise unused, since it would otherwise interpret those bytes as keystrokes.

One paste path, pinned layout, no divergence between TTY and pipe.

### 4.1.2 Alternatives, and what accepting Ink costs

| Option                    | Why not                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain stdout, append-only | Cheapest and would collapse §4.2's four modes to two — but gives up the pinned header and prompt.                                           |
| OpenTUI                   | Requires Bun — a second runtime in a Node 22 pnpm monorepo. Its advantage is frame rate, meaningless for scripted output.                   |
| Rust / ratatui            | What Codex actually uses, so highest parity for that persona — but parity is a non-goal, and a second toolchain cannot share the ASM types. |

Accepted costs, tracked rather than hidden: a dependency tree the repo did not previously carry; the four-mode matrix stays four (§4.2) because Ink cannot run without a TTY; and per-process memory rises.

**Measured 2026-08-08** (node 26.5, macOS arm64, RSS after module load):

|                      | RSS    |
| -------------------- | ------ |
| bare node            | 47 MB  |
| imposter, headless   | 77 MB  |
| imposter, Ink loaded | 117 MB |

So Ink costs **~40 MB per process**. One imposter does not care; the swarm demo at N=20 is ~800 MB of chrome, since godview runs each imposter under a ghosttea PTY and every one of them therefore has a TTY.

Two things follow, both implemented:

1. **Ink is a dynamic import**, reached only after the TTY check, so a piped run — CI, and the control centre's own spawner — never loads React at all. A resolve-hook test asserts this rather than trusting it.
2. **`CHOPSTICKS_IMPOSTER_TUI=off`** forces the append-only sink even on a TTY. That is the contained retreat this section reserved, available without a code change.

`react-devtools-core` turns out to be an _optional_ peer of Ink, so its 15 MB is not paid. Ink itself is 557 KB unpacked.

### 4.2 Four modes, all first-class

Only ghosttea gives the imposter a real TTY. Both `conformance.emulator.test.ts` (`stdio: ['pipe','pipe','inherit']`) and the control center's spawner (`stdio: ['pipe','ignore','inherit']`) use pipes, and Ink's raw mode requires `stdin.isTTY`.

| stdout | control socket | TUI  | Control    | Exercised by                             |
| ------ | -------------- | ---- | ---------- | ---------------------------------------- |
| TTY    | present        | Ink  | connected  | godview + control center — the §6.4 flow |
| TTY    | absent         | Ink  | standalone | `ai --claude` by hand in a terminal      |
| pipe   | present        | none | connected  | control-center spawner                   |
| pipe   | absent         | none | standalone | **CI / conformance**                     |

Headless is not a fallback — **CI runs it**. Treat it with the same discipline the PoC already applies to standalone mode: a first-class path with its own tests, or it breaks continuously.

---

## 5. Transport — invert the direction

**The plane owns one UDS; imposters dial in and hold the connection.** Node's `net` covers Unix domain sockets on POSIX and named pipes on Windows through one API.

This deletes the state file, the imposter's own HTTP server, the second bearer token, `prune()`, and the console's 1.5 s poll. Liveness becomes socket close — instant and correct rather than inferred from a failed round trip. The connection is bidirectional, so the plane can **push**: the console streams the emitted log instead of polling it.

### 5.1 Protocol

JSON-RPC 2.0, newline-delimited, either side may originate.

| Direction        | Method                    | Notes                                                                                                   |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| imposter → plane | `session.hello`           | vendor, version, sessionId, pid, cwd, channels, `nativeBehavior`, `nativeEvents`, ops, runflows, `scenarioDriver` |
| imposter → plane | `session.emitted`         | pushed per emission; supersedes `/log` polling                                                          |
| imposter → plane | `session.channels`        | on change, e.g. after `channel-drop`                                                                    |
| imposter → plane | `session.scenario-driver` | secondary portable authoring intent; never a native observation                                         |
| imposter → plane | `session.scenario-run`    | run id/status/step and native sequence bounds; control metadata, never native evidence                  |
| imposter → plane | `session.goodbye`         | clean exit; request/reply permits final projection reconciliation before socket close                   |
| plane → imposter | `trigger`                 | ASM-validated, as today                                                                                 |
| plane → imposter | `scenario.run`            | name or inline script, optional runflow id, speed, stimulus                                             |
| plane → imposter | `scenario.control`        | `pause` / `step` / `resume`                                                                             |
| plane → imposter | `fault`                   | crash, exit, hang, flood, channel-drop                                                                  |
| plane → imposter | `state`, `log`            | scenario-driver/channel counts and authoritative rolling native log; no adapter reducer                 |

`scenario.control` is the pause/step that `EMULATOR.md §10` lists as outstanding for P3. A held connection makes it straightforward — the runner awaits a gate between prepared steps.

`runflows.json` does not duplicate a scenario's events or expected normalized output. The loader derives executable facts from the referenced scenario, and the devkit computes normalization results from the records that actually occurred. Only one scenario can own the session gate at a time; a second start is refused instead of orphaning the first run's controls.

### 5.1.1 Realistic runflows versus protocol probes

The developer-facing runflow catalog models complete agent work, not three-event demos. Claude and Codex curated runflows must contain 20–30 actions and demonstrate all of the following:

- at least four native tool families, with successful outputs and a failure or approval boundary where the task calls for one;
- explicit delegation through subagent or team events, including task assignment and worker completion/waiting;
- context usage at or above 90%, followed by the vendor's native compaction lifecycle;
- a post-compaction tool call that verifies the retained task state before the final answer;
- a native terminal boundary (`Stop` for Claude, `turn/completed` for Codex).

Short raw scenarios remain intentional. `late-after-exit`, `duplicate-out-of-order`, `unknown-event`, crash, flood, and permission probes isolate one protocol property and should not be padded to satisfy the runflow contract. The Control UI exposes these as “raw scenarios & faults,” separately from realistic runflows. `scenarios.claude.test.ts` and `scenarios.codex.test.ts` execute every scenario against the promoted ASM and enforce the long-form contract only for catalog entries.

The first paired catalog covers three reusable shapes:

| Intent                     | Agent arc                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| deep research              | plan → parallel primary/local research → web/MCP/files/shell → reconcile → compact → source verification → recommendation     |
| cross-layer implementation | trace → parallel implementation/tests → failing baseline → edit/approval → verify → compact → diff check → handoff            |
| incident investigation     | competing hypotheses → logs/reproduction/status/metrics → reject weak hypothesis → compact → configuration check → mitigation |

The Claude mapping follows the current [hooks](https://code.claude.com/docs/en/hooks), [subagents](https://code.claude.com/docs/en/agents), and [agent teams](https://code.claude.com/docs/en/agent-teams) surfaces: `Task*`, `Subagent*`, `TeammateIdle`, `PreCompact`, and `PostCompact`. The Codex mapping follows the promoted `codex@0.147.0` Surface model and generated event map: tools and collaboration are `item/*` lifecycles (`collabToolCall`, `commandExecution`, `fileChange`, `mcpToolCall`, and `webSearch`), while compaction is an `item/started` → `item/completed` lifecycle with `item.type = contextCompaction`. The legacy `thread/compacted` notification remains a compatibility input, but new scenarios use the current item lifecycle. This structure is also consistent with [OpenAI's guidance for tool-heavy and multi-agent workflows](https://developers.openai.com/api/docs/guides/latest-model).

The browser console keeps HTTP; it has to. The plane translates. Browser ⇄ HTTP ⇄ plane ⇄ UDS ⇄ imposter.

### 5.2 Two constraints worth writing down

- **Path length.** `sun_path` is ~103 bytes on macOS, ~107 on Linux. The socket must live at a short fixed path (`~/.chopsticks/imposter.sock`), never a nested per-session one.
- **Windows auth.** A 0700 directory gives POSIX a filesystem capability that named pipes do not expose through Node. **Keep a bearer token anyway** so both platforms behave identically; the token costs ~10 lines and the real win is that the endpoint was never network-reachable to begin with.

**Where the token lives (settled at I3).** Deleting the state file removed the only place a shared secret was published, so the plane writes one at `~/.chopsticks/imposter.token`, mode 0600, in the same 0700 directory as the socket. This is not the state file returning: it carries no URL, no pid, and nothing to infer liveness from, so there is no discovery parse surface and no ownership contention. The socket path is fixed, and socket close is liveness. The plane keeps a **second, separate** token for the browser console — two doors, two secrets, and the one on disk never reaches a URL.

**Stale sockets.** A socket file outlives an ungraceful exit, so existence is not ownership. The plane dials its own path first: something answers → another plane owns it, refuse to start; nothing answers → unlink and bind. This replaces `livePlaneInStateFile`.

---

## 6. CLI surface

Persona resolution, in order: **argv0** → `--<vendor>` flag → `AI_PERSONA` env. Everything after persona selection is handed to the persona's argv parser, so the adapter's real launch recipe (`--session-id`, `--settings`, `--permission-mode`, …) is consumed exactly as the vendor would.

**`ai` has no subcommands.** That is a property worth defending: everything after the persona selector belongs to the vendor, so there is nothing of ours for a vendor's own argv to collide with.

Getting `ai` onto PATH is the package manager's job — `pnpm add --global ./packages/imposter` from a checkout, or an ordinary global install once published, both working off the `bin` field the package declares. Wanting a VENDOR name to reach the imposter is one line:

```sh
ln -s "$PWD/packages/imposter/bin/ai.mjs" ~/somewhere-on-PATH/claude
```

argv0 dispatch does the rest (`process.argv[1]` through a symlink is the symlink path), and it is POSIX-only: Windows needs a `.cmd` wrapper passing `--<vendor>` explicitly.

Link `bin/ai.mjs` itself, **not** `$(command -v ai)`. A package manager's global `ai` is a wrapper that resolves its payload relative to its own location, so symlinking the wrapper somewhere else makes it look for the package under the new directory and fail with `MODULE_NOT_FOUND` (verified 2026-08-08, two minutes after this paragraph first claimed otherwise).

Two install commands existed for these and both were deleted on 2026-08-08 (§11.1). `ai link` reimplemented the package manager. `ai shims install` wrote the symlink above into a managed directory, with conflict detection, idempotency, a Windows wrapper, `--force`, and a `list` subcommand — a hundred lines and its own test file to save one `ln -s`, in service of a "product apps need no changes" claim that §11.2 retired: an app that wants an imposted session now passes `executable` per session, which is finer-grained, needs no PATH manipulation at all, and cannot leak into a shell the user did not intend.

**Naming.** `ai` collides with the npm package `ai` and is a common shell alias. Publish as `@vibecook/chopsticks-imposter` with `bin: { "ai": …, "imposter": … }`, and let anyone who dislikes the name alias it themselves.

---

## 7. Retiring `packages/emulator`

**Decided: the PoC package is retired.** Its problem was never the code — it was bundling three unrelated things under one name. Retiring it means splitting it correctly.

### 7.1 Why the ASM runtime does not move into the imposter

`model.ts` has consumers that are not the imposter: Surface audits and model tooling use it directly, while adapter projection generators import its types and validator. Claude and Codex carry `@vibecook/chopsticks-surface` only as a **devDependency**; their published runtimes do not depend on the evidence package.

It must also stay **self-contained** — no relative imports, erasable syntax only — because `.mjs` Surface scripts import it under Node type stripping. `packages/surface/tsconfig.json` enforces that constraint. An imposter package containing Ink and JSX cannot set that flag, so moving the model runtime there would degrade a compiler-enforced boundary into convention.

**A package boundary is how this constraint is enforced.** So the ASM runtime keeps its own home and its own compiler flag.

### 7.2 Disposition

| From `packages/emulator`                                                              | Goes to                                                 | Notes                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `model.ts` (whole file)                                                               | **`packages/surface`** — `@vibecook/chopsticks-surface` | Renamed package, same contents, same `erasableSyntaxOnly`. Adapters devDepend on it; the imposter depends on it. |
| `engine.ts` → paste decoder, hook emitter, transcript writer, statusline invoker      | `packages/imposter/src/session/channels/`               | May now import each other normally — the `validate`-injection existed only to keep the file self-contained.      |
| `engine.ts` → scenario runner                                                         | `packages/imposter/src/session/scenario.ts`             | Becomes the raw/adversarial layer beneath the op layer (§2, §2.1).                                               |
| `control.ts` → `createControlPlane`                                                   | `apps/imposter-control/src/main/plane.ts`               | Sole consumer; not published API.                                                                                |
| `control.ts` → message shapes (native Surface, fault, scenario request, session view) | `packages/imposter/src/control/protocol.ts`             | Shared by the imposter's client and the app's plane.                                                             |
| `control.ts` → `EmulatorSpawner`                                                      | stays in `apps/imposter-control`                        | The center's own spawn capability.                                                                               |
| `ui/control.html`                                                                     | `apps/imposter-control/ui/control.html`                 | Fix the two rendering defects found on 2026-08-07 (§7.4).                                                        |

**Deleted outright**, superseded by the UDS inversion (§5): `createEmulatorControlServer` (the bin-side HTTP server — imposters dial out and serve nothing), `defaultControlStateFile` / `parseStateFile` / `livePlaneInStateFile` (no state file), `registrationChannels` / `prune` (liveness is socket close), and the imposter-side bearer dance (the plane keeps a token for the browser).

`packages/emulator` is listed in `scripts/public-packages.mjs` at `0.1.8`, but it has **never been published**: it is new on the unmerged `feat/agent-emulator` branch, and `@vibecook/chopsticks-emulator` returns 404 from the registry (verified 2026-08-07). Retiring it is therefore free — no deprecation, no successor notice, no breaking change for any consumer.

The same holds for every rearrangement in this document. **Nothing described here has shipped**, so the usual constraints on moving published API do not apply, and the sequencing in §8 is chosen purely for bisectability rather than for compatibility.

### 7.3 Hard-won behavior that must survive the rewrite

These are the non-obvious parts of the PoC. They are cheap to lose in a rewrite and expensive to rediscover.

1. **Registration completes before stdin listeners attach.** Under `ELECTRON_RUN_AS_NODE`, a flowing stdin wedges later async I/O initiation and the register fetch never resolves (probed 2026-08-07). Ordering is load-bearing, not stylistic.
2. **Scenarios validate completely before the first side effect**, so a typo late in an inline script cannot leave a half-applied scenario behind.
3. **Off-model payloads are refused.** The imposter will not emit what its own ASM disallows — verified live returning `422 field "message" is number, expected string`. This is the property that keeps the imposter from teaching the adapter a lie.
4. **The curl-forwarder shape shortcut** (`FORWARDER_SHAPE`): the repo's own generated forwarder is recognized and delivered as a direct POST with identical headers and body — byte-identical at the bridge, independent of `sh`, which is what keeps command-transport events working on Windows.
5. **Transcript root isolation** — never `~/.claude`, so emulated sessions stay out of the user's real spaghetti index.
6. **Hook delivery fails soft.** A hook the bridge rejects, or a forwarder that cannot spawn, must not kill the process — real vendors fail the same way.
7. **The emission log is bounded** by both entry count and total bytes, with oversized entries truncated in place.

### 7.4 The other two stand-ins

| Artifact                                           | Disposition                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/adapter-claude/surface/emulator/bin.mjs` | **deleted 2026-08-08**, with `conformance.emulator.test.ts` and `packages/emulator`; the model subsequently moved to neutral Surface ownership |
| `packages/testing/bin/fake-agent.mjs` (183 lines)  | **kept.** See below — the `synthetic` persona was built, the absorption was not.                                                               |

**Revised at I4 (2026-08-08).** The `synthetic` persona exists and earns its keep; folding `fake-agent.mjs` into it does not.

Two reasons. `fakeAgentBin` is exported API of `@vibecook/chopsticks-testing@0.1.8`, which **is** published — removing it is a breaking change for no gain. And the two do different jobs: the fake agent exercises the **terminal spine** (alt-screen, bad UTF-8, byte floods, ignored SIGINT, child process trees) for the PTY layer, while the imposter's TUI is cosmetic by §4 and deliberately does none of that. Merging them would conflate a terminal fixture with a machine-surface stand-in.

What §7.4 actually wanted — a not-a-real-vendor check on the persona contract — is delivered by `personas/synthetic/` alone, and it paid for itself immediately. Writing a second persona found three places the contract had quietly become claude-shaped:

- the envelope (`session_id`/`transcript_path`/…) was **hard-coded in the session**; it is now persona-declared (§3.2), as is the field the event name is written into;
- the ASM was assumed to live in an adapter package; a persona-local model is now legal, because a vendor that does not exist has no adapter to own its captures;
- channel drops were keyed by the imposter's internal delivery kind (`hook`) rather than the vendor's own channel name, so a `channel-drop` fault against a vendor that calls it something else **silently did nothing**.

The third was a live bug, not a design wart. That is the argument for keeping a synthetic persona permanently.

The old console exposed adapter reducer state as though it were part of native Control and serialized its Map-valued collections (`tools`, `permissions`, `subagents`, `tasks`) incorrectly. The native-boundary refactor removed that state from the plane entirely rather than patching the confused ownership. The later Agent Normalization Devkit composes a clearly downstream projection, serializes and executes it behind the native hot path, reconciles missed pushes against the authoritative rolling log, and labels its revisioned, gap-aware state as design/conformance data rather than native truth or Godview's production state. The unrelated empty-session placeholder defect was also fixed.

---

## 8. Phasing

Claude and Codex land **together**, before either is polished. A persona contract validated against one vendor comes out shaped like that vendor; claude (hook + transcript) and codex (JSON-RPC app-server + `--remote` attach) are the two families `ADAPTING-AN-AGENT.md §0` already identifies, and they are the test.

### 8.1 Codex has no ASM yet — and needs a different mechanism, not just a census

**Historical discovery, 2026-08-07 during I1.** At that point Claude's adapter-local model was the only ASM in the repository. Codex now has an independently generated model too, and both promoted real-vendor models live under `packages/surface/vendors/<vendor>/model/`.

The codex persona **must not be hand-written from `adapter-codex/src/normalizer.ts`**. `EMULATOR.md §1` names that exact failure: _emulator and normalizer must never be derived from the same unverified source._ That is not hypothetical here — the audit found the adapter answers all ten server-request approvals with `{decision:'approved'|'denied'}` when `'approved'` is valid on 2 of 10 and `'denied'` on **zero**; `normalizer.ts:180` switches on `localShellCall`, which is not one of the 18 real `ThreadItem` types; and `:194`/`:232` read `item.output`/`item.result` where the schema says `aggregatedOutput`/`results`. Building the imposter from the adapter would bake all of that in, and no test could see it.

Two findings changed the plan, both verified against the installed `codex-cli 0.147.0`:

1. **The binary emits its own protocol schema** (§9.1), so shape need not be inferred from captures.
2. **A full turn runs offline** against a fake local model provider, so the census is hermetic and CI-able rather than a live-lane gamble.

The full design is §9. The sequencing that replaces the old "blocked" note is §9.6.

| Phase    | Contents                                                                                                                                                                                                                                                                       | Exit                                                                                                                                                        | Status              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **I0**   | Extract `packages/surface` (ASM runtime) out of `packages/emulator`. Nothing else moves.                                                                                                                                                                                       | `pnpm test` green, `surface:audit` clean, PoC still runs end to end                                                                                         | **done 2026-08-07** |
| **I1**   | Imposter skeleton, channel modules, persona loader, op timeline, headless session, CLI, claude persona. **No control channel yet.**                                                                                                                                            | conformance green against `ai` instead of `bin.mjs`                                                                                                         | **done 2026-08-07** |
| **I1.5** | Codex survey + model (§9). Ordered: capture envelope + sanitizer → committed harness → hermetic capture (approvals and tools FIRST) → `generate-model.mjs` → `surface/model/codex@0.147.0`. **Hermetic, not `CODEX_LIVE`** — a fake local provider drives a full turn offline. | Model validates; approval round-trip captured; harness committed; `diff(vendor schema, model)` clean                                                        | **done 2026-08-08** |
| **I2**   | Claude **and** codex runtimes — hook/transcript/statusline channels, and the app-server JSON-RPC channel                                                                                                                                                                       | Both conform hermetically in CI; ops map cleanly onto both families, or the vocabulary is revised until they do                                             | **done 2026-08-08** |
| **I3**   | Control channel, both sides at once: UDS client in the imposter **and** the plane rewritten at its new home, now named `apps/imposter-control`. Delete state file, bin-side HTTP server, `prune()`, console poll. Push-based log.                                              | §6.4 flow works over one socket; `scenario.control` pause/step lands                                                                                        | **done 2026-08-08** |
| **I4**   | Ink TUI behind `isTTY`; shim installer (since deleted, §6); delete `bin.mjs` and `packages/emulator`; a `synthetic` persona (**not** an absorbed `fake-agent.mjs` — see §7.4); update EMULATOR.md + ADAPTING-AN-AGENT.md                                                       | godview panes show imposter chrome; no doc still describes per-adapter bins                                                                                 | **done 2026-08-08** |
| **I5**   | The lifecycle machine (§11) and the console rebuilt around it; `ai` on PATH + serve mode from argv (§11.1); `ai --claude` in a Godview pane (§11.2); the chrome redrawn — rounded frame, ghost, violet/blue                                                                    | Clicking an op in the console transitions the graph and the reducer sees the traffic; the drawing cannot disagree with the machine                          | **done 2026-08-08** |
| **I6**   | Move vendor-native behavior topology into Surface `behavior.json`; rename the I5 machine to portable `scenarioDriver`; make Control launch Imposter directly, remove its adapter/reducer path, and lead with the versioned native graph and raw payload log                    | Control exposes exact pre-normalized truth (including compact/team hooks) without inventing unified status; adapters remain the sole normalization boundary | **done 2026-08-08** |

I0 is a refactor that can land on its own and de-risks everything after it. I1–I2 are load-bearing. I3 is mostly deletion. I4 is chrome plus paperwork.

The control channel lands **whole** in I3 rather than client-first in I1, because a UDS client has nothing to dial until the plane is rewritten, and standalone is a first-class mode anyway (§4.2) — conformance runs the pipe-and-no-socket path, so I1 needs no control channel to prove itself. Until I3, `bin.mjs` and the frozen `packages/emulator` keep serving the control-center flow unchanged.

Because I0 leaves the PoC working, there is a green baseline to bisect against for the whole sequence — and if I2 reveals the op vocabulary is wrong for codex, only I1's timeline needs rework.

---

## 9. The JSON-RPC family (codex)

Everything here was observed against `codex-cli 0.147.0` on 2026-08-07, or verified against the
schema that binary emits. Sources of each claim are marked.

### 9.1 The vendor emits its own protocol schema

```sh
codex app-server generate-json-schema --out <dir> [--experimental]
```

Exit 0, ~1s, **no auth, no network**. Output is a pure function of `(binary version,
--experimental)` — repeated runs are byte-identical; a fresh `CODEX_HOME` and explicit `--enable`
of feature flags change nothing.

| Union              | stable | `--experimental` |
| ------------------ | ------ | ---------------- |
| ClientRequest      | 95     | 133              |
| ServerRequest      | 10     | 11               |
| ServerNotification | **70** | **70**           |
| ClientNotification | 1      | 1                |
| files              | 285    | 361              |

**Every server notification is stable** — the surface the imposter _emits_ is entirely the stable
half. Churn concentrates in client control methods, which it answers.

Three cautions, all verified:

- **`--experimental` is not purely additive.** 25 of the 285 shared files differ in _content_; it
  adds fields to stable methods (`CommandExecutionRequestApprovalParams` 13 → 15 properties,
  gaining `additionalPermissions` and `availableDecisions`). Commit both variants, or pick one and
  never mix.
- **The schema is not the whole runtime surface.** `getAuthStatus`, `getConversationSummary`, and
  `gitDiffToRemote` are accepted at runtime but absent from it (136 runtime vs 133 documented). An
  audit must never treat schema-absence as proof of invalidity.
- **`v1/`/`v2/` are Rust module names, not negotiated versions.** `initialize` carries no protocol
  version; the only signal is the binary's own, echoed in `userAgent` and `thread.cliVersion`.

Measured churn 0.146.0 → 0.147.0 (9 days): **+6 methods, 0 removed** — additive, despite a
~2-alpha-per-day tag cadence. Field-level churn is unmeasured and plausibly higher.

### 9.2 Shape from the schema, confidence from the census

This is the rule that keeps `EMULATOR.md §1` honest once the model is generated. If model ← schema
and adapter ← model and imposter ← model, everything agrees and nothing can detect a lie.

- **The vendor schema supplies shape** — properties, types, required. It is a _claim_.
- **The census supplies `confidence`, `fixture`, `firstSeen`, `lastVerified`** — evidence the thing
  actually happens, in that order, with those values.

**`generate-model.mjs` must be structurally incapable of writing `confidence`.** That single
constraint is what stops the imposter and the adapter from being wrong together.

Consequence — the drift equation gains a term, and codex ends up better instrumented than claude:

```
drift = diff(vendor schema, model)     ← mechanical, cheap, every codex release   (codex only)
      ∪ diff(real census, model)       ← evidential                               (claude has only this)
      ∪ diff(emulator behavior, model)
```

### 9.3 The op timeline does not cover this family — and should not be stretched

A hook imposter only emits. A JSON-RPC imposter must **serve**. Three properties each independently
break the timeline: it has no inbound path (`run()` returns `Promise<void>`); 95 client-request
methods (`fs/readFile`, `thread/list`, `config/read`) are an RPC service surface, not agent
semantics, and projecting them onto the small op vocabulary is a category error; and `initialize` is
enforced (`-32600 "Not initialized"`), so the server has a state machine the timeline cannot hold.

The split is clean, because all 70 notifications are stable:

| Duty                               | Volume                     | Mechanism                                         |
| ---------------------------------- | -------------------------- | ------------------------------------------------- |
| emit notifications                 | 70                         | **op timeline, unchanged** — one new channel sink |
| serve client requests              | **~8 that matter**, not 95 | **new: serve table + dispatcher**                 |
| issue server requests, await reply | 10                         | **one flag** on `OpBinding` + id correlation      |

"~8 not 95" is what makes this tractable: the imposter need only be a codex app-server good enough
for _our_ adapter. `driver.ts` calls `initialize`, `initialized`, `model/list`, `thread/start`,
`thread/resume`, `turn/start`; `observer.ts` adds `thread/list`, `thread/read`.

**The fork is the trigger, not the timeline.** For claude the trigger is stdin bytes
(`cli/main.ts`); for codex it is inbound RPC. The timeline runs downstream of the trigger in both
cases and is genuinely shared.

```
                       trigger                          projection
claude:  paste decoder ────┐
                           ├──► behavior ──► OP TIMELINE ──► sinks
codex:   RPC dispatcher ───┘                   (shared)
             │
             └──► synchronous reply, validated against resultSchema
```

`serve.json` carries the serve table and the state machine as data, per persona:

```jsonc
{
  "$server": { "gate": { "until": "initialize", "error": { "code": -32600, "message": "Not initialized" } } },
  "initialize": { "result": { "userAgent": "$vendorVersion", "codexHome": "$imposterHome" } },
  "thread/start": {
    "result": { "thread": { "id": "$uuid:thread", "status": { "type": "idle" } } },
    "then": [{ "op": "session.start", "with": { "threadId": "$uuid:thread" } }],
  },
  "turn/start": { "result": {}, "then": "$behavior" },
}
```

Server-initiated requests need no timeline surgery — `run()` is already async and `runAll` already
awaits sequentially, so an `"await": true` flag on the binding sends it as a server request and
binds the client's reply as `$response`:

```jsonc
"permission.ask": [
  { "channel": "appServer", "event": "item/commandExecution/requestApproval", "await": true,
    "with": { "threadId": "$threadId", "itemId": "$uuid:item", "command": "$op.command" } }
]
```

Three non-negotiables:

1. **Replies validate against `resultSchema` before they go out** — §7.3 item 3 applied to the
   reply direction. The `driver.ts:147` bug is the proof: an imposter doing this would have failed
   the first scripted approval.
2. **Inbound `params` validate against `payloadSchema`; a violation returns a JSON-RPC error, not a
   crash.** This makes the imposter a conformance test _of the adapter's client_ — a capability the
   claude imposter structurally cannot have, and the strongest argument for doing codex properly.
3. **`then` schedules ops; it never writes the wire.** §2's "the screen cannot contradict the wire"
   survives only under that constraint.

### 9.4 `validatePayload` stays as it is

**803 of 812 top-level `v2` properties (98.9%) collapse into the existing flat subset**, 9
untyped/free-form, **zero** non-collapsing unions. Nesting is real (1,274 `$ref`s, 239 `oneOf`s,
depth to 11) but lives _below_ the level `validatePayload` was ever meant to check.

So: **pre-flatten at generation time.** Extending the validator would mean draft-07 support, i.e.
a real JSON-Schema dependency, which breaks the dependency-free `erasableSyntaxOnly` constraint
that justifies `packages/surface` existing at all (§7.1). Two validators would split the drift
equation in half. Each generated event records `sourceSchema: {file, sha256}` so `audit.mjs` can
detect "the vendor changed something the flattening discarded" without storing a megabyte.

### 9.5 ASM delta — additive, zero migration for claude

| Field                                                                                              | Status                             |
| -------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `kind: 'event' \| 'notification' \| 'client-notification' \| 'client-request' \| 'server-request'` | add, defaults to `'event'`         |
| `resultSchema?: PayloadSchema`                                                                     | add                                |
| `envelope?: { payloadPath?, discriminator? }`                                                      | add — `ThreadItem` has 18 variants |
| `sourceSchema?: { file, sha256 }`                                                                  | add                                |
| `validatePayload`, `channels.json` format, `diffModelVsReport`                                     | **unchanged**                      |

`confidence: 'unverified'` already suppresses `unobserved-verified`, so 95 generated-but-unexercised
client methods produce zero drift and get promoted as the census reaches them.

Method names contain `/`, which `loadModel`'s filename check rejects — needs a reversible slug
(`/` → `__`), with `loadModel` asserting reversibility and uniqueness.

### 9.6 Sequencing — two constraints that cannot be retrofitted

1. **Fix the capture envelope before capturing.** `buildReport` derives an event name from
   `hook_event_name` falling back to the filename (`model.ts:447-450`) — a claude accident, because
   hooks are self-describing. JSON-RPC messages are not: a response names nothing. **Only the
   process that watched the stream can pair a response to its method**, so the census must write
   `{"asmCapture":1,"event":…,"kind":…,"payload":…}`. One branch in `buildReport`; claude captures
   keep working byte-for-byte. Id pairing cannot be recovered afterwards from raw wire bytes.
2. **Write the sanitizer before the first capture.** Pseudonyms are `sha256(value)`, so widening
   the id-key set later rewrites every id in every fixture at once. `idKey` currently misses
   `threadId`, `itemId`, `callId` — and codex ids are **UUIDv7, which encode wall-clock capture
   time**, so they need regenerating as v4 (or v7 at a fixed epoch), not merely aliasing.

Then: committed harness → hermetic capture (approvals and tools first — they are the entire reason
to prefer codex over claude's absence-pattern) → `generate-model.mjs` → persona.

**The harness has been lost twice** — the C1 script was never committed, and claude's
`interactive-census.mjs` survives only inside `git show 1eea6db^:…`. Both times the output survived
and the tool that made it did not. Committing the harness is an exit criterion.

### 9.7 Observed at last (2026-08-08)

The **approval round-trip is captured**, hermetically: `captures/codex@0.147.0/approval-{accept,decline}.jsonl`. It had been schema-and-README-only since 2026-07-13.

What unblocked it was not a credentialed turn but `RUST_LOG`. Codex rejects a tool call in its **tool router** and reports that only to its log, never on the app-server protocol. Two sessions had concluded the item was failing to parse and ruled out eight hypotheses on that basis — all of them the wrong layer. See CODEX-SURFACE-FINDINGS C1d.

Three things the census settled, none of them guessable from the schema:

- `exec` is a **custom** tool taking raw JavaScript, and `exec_command`s `cmd` is a **string**, not an argv array.
- Trusted commands auto-approve even under `approvalPolicy: untrusted`; an approval needs a non-allowlisted command under a `read-only` sandbox.
- `cancel` and `decline` are both accepted but differ — `cancel` ends the turn, `decline` lets the agent continue. The adapters `decline` is therefore right, now on evidence rather than inference.

`codex exec --json` and `codex mcp-server` were both evaluated as alternative capture surfaces and rejected: different naming schemes, fewer events, and no schema generator.

**Still unobserved:** `item/fileChange/requestApproval` (the patch-approval path), MCP tool calls, and subagent activity. 70 of the 81 modelled methods are `unverified`, and say so.
---

## 10. Non-goals

- **Vendor TUI parity.** Stated in §4 and repeated here because it is the requirement most likely to drift back in.
- **Emulating model quality.** Unchanged from `EMULATOR.md §8`.
- **A shadow process beside a live session.** ADR-002 stands; the imposter _replaces_ a vendor binary and never accompanies one.
- **Removing the nightly reconciliation lane.** The imposter is a projection of captured truth. Only the real binary can detect drift.

---

## 11. Native behavior and the portable scenario driver

**Corrected 2026-08-08 (I6).** I5 wrote the ops in §2 as a state machine because a turn cannot end before it starts, a tool cannot finish before it runs, and an approval suspends whatever asked for it. That remains useful—but it describes how Imposter authors semantic ops, not what a vendor actually exposes. Calling it “the lifecycle” collapsed the exact boundary this project is meant to test.

There are now two separate graphs:

1. Surface's required `behavior.json` is the versioned vendor-native truth view. Every node names an exact event/method from the same model, repeated methods may be distinguished by native scalar payload selectors, and relations have evidence confidence. It is a partial order because native hooks and notifications may be optional, asynchronous, concurrent, re-entrant, or blocked.
2. `packages/imposter/src/session/scenario-driver.ts` is the portable op authoring machine. It helps Imposter compose a plausible test scenario and reports off-model op ordering. It has no standing to define vendor state or unified adapter state.

The portable driver currently has this shape:

```
starting ──session.initialize──↺
    └────session.start────▶ booting ──session.ready──▶ ready ──turn.start──▶ ┌ turn ─────────────────────┐
                                │                        ▲                   │ thinking ⇄ tool           │
                                └────turn.start──────────┘◀──turn.end────────│      ↘  ↙                 │
                                    (vendors with no                         │     approval              │
                                     readiness signal)                       └───────────────────────────┘
```

`session.initialize` is the starting-state self-loop for protocol negotiation
and ambient bootstrap that occurs before a vendor session exists. Grok requires
the distinction: its xAI extension census arrives after ACP `initialize` and
before `session/new`; neither `session.start` nor `session.ready` truthfully
describes that traffic.

`session.end` (→ `ended`) and `usage.refresh` (a heartbeat that moves nothing) are handled at the root, so they are legal everywhere and are drawn as globals rather than as fourteen edges.

Four properties carry the corrected design:

1. **Native truth leads.** The Imposter sends `persona.model.behavior` and exact native event descriptors in `session.hello`; Control paints nodes only when matching raw `session.emitted` records arrive. Claude `PreCompact`, `PostCompact`, `TaskCreated`, `TaskCompleted`, and `TeammateIdle` therefore appear under their native names. Control never promotes them to “compacting” or “team idle.” Codex compaction remains `item/started` / `item/completed` selected by `item.type = contextCompaction`. The adapter owns any unified interpretation.

2. **The scenario driver reports; it does not gate.** An op the current driver phase does not handle leaves the phase alone and is counted off-model—it is not refused. Adversarial scenarios exist precisely to send traffic no organic route would produce (`duplicate-out-of-order`, `late-after-exit`). Refusal stays at the ASM payload boundary (§7.3 item 3), which judges native names and payloads, not portable order.

3. **The driver advances on an op, not on the wire.** An op a persona leaves unbound still occurred in the authored scenario: Codex binds no `session.ready`, yet the driver can enter its ready phase. That phase says nothing about a native Codex status message. The raw emission log remains the only record of what Imposter actually told the client.

4. **`booting --turn.start--> turn` is an authoring edge, not a vendor claim.** It lets a persona without a `session.ready` binding compose a turn without producing a false off-model warning. The edge does not assert how Codex proves readiness; that normalization is independently tested in the adapter.

**Raw events do not advance the scenario driver.** They do paint the native graph because they are native observations. This is the honest split: Control leads with the native graph, exact event controls, and raw payload log; scenario ops, the portable graph, authored scenarios, and faults sit in a secondary disclosure.

**Two pictures, neither copied.** Each session carries its Surface-native graph. The secondary `describeScenarioDriver()` returns the driver's nodes, edges, globals, and hand-authored layout; the plane serves it at `GET /api/scenario-driver`. Tests validate Surface graph references and walk every driver phase against every op in both directions. The UI labels one “vendor-native behavior” and the other “scenario driver,” so observation and authoring cannot silently trade names.

**The Control boundary is structural.** Its spawner launches `ai` directly. The generic plane in `apps/imposter-control/src/main/plane.ts` has no runtime adapter or Core dependency, no reducer subscription, and no `/session-state` endpoint. The containing Agent Normalization Devkit may register a removable downstream projection with explicitly named projection HTTP/SSE routes; that composition cannot alter native traffic and is not a production state feed. Adapter-against-Imposter conformance still exists in separate suites; there the adapter is intentionally the subject under test. Godview remains the place that consumes the runtime-normalized result.

**Cost.** xstate v5 imports in 6 ms for 5.6 MB RSS (node 26.5, measured 2026-08-08) — an eighth of Ink's 40 MB, and unlike Ink it is wanted in every mode, so it is a static import rather than a dynamic one.

### 11.1 CLI: getting `ai` on PATH, and serve mode from argv

Two changes make `ai` a command you can actually run.

**`ai` reaches PATH through the package manager, not through us.** `pnpm add --global ./packages/imposter` from a checkout — it resolves the `workspace:*` dependencies because the global install symlinks back into the repo, so edits stay live — or an ordinary global install once published. Both work off the `bin` field the package already declares.

An `ai link` command lived here for a few hours and was deleted. It wrote symlinks into `~/.chopsticks/bin`, reasoning that a directory of our own shadows nothing — correct constraint, wrong conclusion, since `ai` and `imposter` shadow nothing _wherever_ they live. The shadowing `~/.chopsticks/shims` exists to contain is a property of the VENDOR names. So the isolation bought nothing and cost the only thing that mattered: `ai: command not found` immediately followed a successful link (reported 2026-08-08). Rewriting it to guess a directory already on PATH only made it worse — it squatted in pnpm's global bin behind pnpm's back. The lesson is narrow and worth keeping: **do not reimplement the package manager**; a `bin` field and one install command already solve this.

`ai shims install` went the same way an hour later, for the same reason applied one level up: it existed to put VENDOR names on PATH so an unmodified app would launch the imposter, and §11.2's per-session `executable` override does that better — per session rather than per shell, with no PATH manipulation to leak. What remains of the capability is argv0 dispatch and one `ln -s` (§6).

### 11.2 Godview panes

`ai --claude` typed in a Godview pane now produces a session Godview recognises as claude, rendering the imposter's own chrome. The pieces:

- Godview's shim directory gains an `ai` entry. The shim reads its own name, takes the vendor from `--<vendor>`, strips that flag, and marks the request `imposter: true`.
- `ClaudeAgentOptions.executable` overrides the binary **for one session**, so every other pane still launches the user's real Claude Code. `CHOPSTICKS_CLAUDE_BIN` is the same capability applied to the whole process, which is exactly what makes it unusable here.
- The gateway resolves the imposter itself (PATH, or `CHOPSTICKS_IMPOSTER_BIN`) and merges `AI_PERSONA` into the launch env. A request can choose emulation; it can never choose what gets executed.

**Only claude, and for a specific reason.** The codex adapter's TUI recipe spawns `codex app-server --listen unix://…` and attaches a second process over a WebSocket on that socket, while the codex persona serves NDJSON on stdio. Until the persona speaks that listen/attach pair, `ai --codex` in a pane is refused with a message saying so — an honest refusal beats a session bound to nothing, which would look like it worked.

### 11.3 Two input bugs, found by running it

Neither showed up in any suite, because both live in the gap between a pipe and a real terminal — and the conformance tests, correctly, use a pipe.

**The imposter never enabled bracketed paste.** A terminal emits `ESC[200~` markers only for an application that has turned DECSET 2004 on. Real TUIs do; the imposter did not, so a pane pasted bare bytes and the decoder — built entirely around those markers — never saw a paste. The pane's prompt did nothing at all, and the adapter's reducer sat at seven events. `ai` now enables the mode on an interactive TTY and restores it on exit.

**Enter that arrives late fell on the floor.** The decoder holds a completed paste for 15 ms and then releases it as staged; terminal automation commonly writes the paste and the newline separately, so the newline arrived after the hold expired and was discarded. The prompt line now keeps staged text across operations, and a bare Enter submits it — which is what every prompt does. The decoder itself stays a pure byte splitter.

While fixing the second, the prompt line gained the minimum a real terminal needs: typed characters accumulate and backspace deletes. That is a prompt line, **not** a line editor — anything more is the vendor parity §4 rules out — but a screen in front of a person where typing does nothing is not a screen.

**Verified in a pane:** `ai --claude` → adopted as claude → prompt → `lastAssistantMessage: "imposter: ok"`, lifecycle back to `ready`, eleven native events observed by the real adapter.

**Known gap.** An imposted claude session projects the USER half of a turn and not the assistant half: `conversationSnapshot().items` holds the prompt, `state.lastAssistantMessage` is correct, and no assistant item ever appears. The transcript records the imposter writes are correctly claude-shaped and the adapter watches the path the hook envelope gives it, so the cause is further in than this work reached. Pre-existing, and unrelated to §11's three changes.

§11.5 narrows it considerably: the same projector produces assistant items for an imposted CODEX session in the same pane, so the projector and the reducer are both fine. Whatever is missing is on the claude side of the seam — the assistant event it emits, or the `displayOnly` flag on it — and not in the shared path.

### 11.4 Known gap: the control channel is unverified on Windows

`apps/imposter-control`'s two spawn-based suites are skipped on Windows, and this records why rather than leaving a bare `skipIf` for someone to find.

A spawned `ai` never dials into the plane there. The wait expired identically at 5 s and at 15 s across four CI rounds, so it is not slowness — the join does not happen at all. The plane takes a **named pipe** on Windows instead of a socket path (`control/protocol.ts` `defaultSocketPath`), and that path has never been observed working; it was written from the platform's documentation and shipped green because only POSIX ever ran it.

What is still covered on Windows: `plane.test.ts`, which exercises the plane's HTTP surface and its socket server in-process, over a named pipe. What is not: a separately spawned imposter finding that pipe and completing `session.hello`. So the untested seam is narrow and named — dialing, not serving.

The alternative was deleting the Windows job, which would have taken godview's and workbench's Windows coverage with it to hide one app's gap. Skipping two suites states the limitation; deleting the job would have concealed it.

**To close it**, the first thing to check is whether the imposter's `connectControl` reaches `createConnection({ path })` with the pipe name intact — `CHOPSTICKS_IMPOSTER_SOCKET` crosses a process boundary as an environment variable, and a `\\.\pipe\…` value survives that differently than a filesystem path does.

### 11.5 The codex pane: a transport, and a second role

`ai --codex` reported two symptoms on 2026-08-09 — it sat on `starting` forever, and no agent appeared in Godview. They were four separate faults wearing one face.

**The lifecycle never began.** `personas/codex/persona.json` shipped `"boot": []`. Claude and synthetic both boot with `session.start` + `session.ready`; codex had neither, so no op reached the machine and the graph never moved. Nothing caught it because every codex suite drove the SERVE fork, where the lifecycle legitimately starts at the client's `thread/start` — the interactive fork was the one path no test entered. `src/session/boot.test.ts` now walks every persona, and is written over `availablePersonas()` so the guard extends to the next one without anyone remembering.

Boot is also now **interactive-only**. A server has no session until a client asks for one; booting one would push `thread/started` at a client that never asked, teaching the adapter a lie about when threads come into existence.

**Templates reached the wire unsubstituted.** With boot restored, `session.start` emitted `thread/started` whose id was the literal string `"$threadId"` — codex mints its ids from `thread/start`, and interactively nothing had. The ASM cannot catch this: `"$threadId"` is a perfectly good string. Personas may now declare `bindings` they mint at session start (`{"$threadId": "$uuid:thread", "$threadCwd": "$cwd"}`), which is also the truthful model — a real `codex` TUI owns a thread from launch. The boot suite asserts no payload leaves with a whole value still matching `/^\$[A-Za-z]/`.

**The transport was the wrong one.** The persona spoke NDJSON on stdio, which is the path almost nothing takes: `adapter-codex` runs `codex app-server --listen unix://<sock>` and speaks **WebSocket** to it for every session it owns (CODEX-SURFACE-FINDINGS §8). Coverage was inverted — thorough on the rare transport, absent on the load-bearing one.

The fix is a transport seam under the channel, not a second channel. `createAppServerChannel` already took `{input, output}`; `session/channels/ws-unix.ts` hands each accepted connection back as that same NDJSON pair, so one serve table and one op timeline sit behind stdio and sockets alike. Which one is chosen comes from the persona's `$server.listen`, because the flag's spelling is vendor vocabulary — the same reason the envelope and the flag aliases are persona-owned. An address the imposter cannot honour is refused loudly; falling back to stdio would leave the adapter waiting on a socket file that never appears, and _hung_ is far worse to debug than _refused_.

A socket server also has **many** clients where stdio has exactly one. Notifications fan out; server-initiated requests do not, and go to the first client to speak — always the controller, which owns the thread, connects before the TUI it then launches, and is the only side with an approval policy.

**And the pane was a second, unwatched session.** `codex resume <id> --remote unix://…` is not a session at all: the vendor's own TUI is a CLIENT of its app-server. The imposter now has that second role — attach, which owns no session, no timeline, and no machine, and sends the same `turn/start` the adapter's driver sends. Before this, the pane started its own lifecycle and drew it while the adapter watched a different thread: the screen contradicting the wire, which is the one thing §2 exists to prevent.

Two things fell out of building it. The prompt line moved to `cli/prompt-line.ts` — two invocations own a screen now, and a second copy would have been a second set of paste bugs. And `spawnAppServer` gained an `env`: that child is private to the recipe, carries no launch spec, and is the only process an app cannot otherwise reach — which is exactly why `AI_PERSONA` could not get to it.

**The bug that hid behind all of them.** With everything above working, the pane still went quiet — no error anywhere. `thread/resume` was declared with `"bind": {"$threadId": "$uuid:thread"}`, so the imposter **renamed the thread** when the TUI joined it. Every notification the pane's turn produced then named a thread the observer was not watching, and the adapter filtered it all out. A resume adopts the id it is handed. Guarded now against the _shipped_ serve table rather than a fixture, because a fixture would have copied the mistake.

**Verified in a pane:** `ai --codex` → adopted as codex → typed prompt → `turn/start` over the socket → the adapter observes a completed turn. `IMPOSTER_AGENTS` now includes `claude`, `codex`, and `grok`. Grok earned the executable gate through a separate composition suite covering leader socket + strict ACP + attached terminal + persisted native log; this does not promote its upstream support baseline. The predicate remains a persona plus a green transport-accurate conformance suite, and the list only records what has passed.

**Still POSIX-only.** Unix sockets, and `ai` spawned as a script by absolute path. The Windows story is §11.4's, unchanged.

### 11.6 Grok leader composition and durable resume

Grok's terminal is also a client, but the topology is not Codex's WebSocket
app-server. The public Grok source defines a Unix leader protocol with a
four-byte big-endian frame length followed by JSON. Registration, ping, and ACP
payload envelopes use that protocol; ACP itself remains strict JSON-RPC 2.0.

The Imposter leader implements that framing and assigns client ids. A
materialized session has exactly one registered controller. Viewer request ids
are rewritten as `<client-id>|<JSON id>`, forwarded to that controller, and
restored on the response. Controller notifications fan out only to viewers of
the same session. Approval requests remain on the direct controller channel,
so a terminal can never answer the same decision a second time. Session ids are
part of the Imposter registration identity so several sessions cannot cross
talk inside one long-lived test leader; that identity convention is an
implementation extension carried inside the upstream protocol's opaque
`client_type` string, not a claimed vendor field.

The controller remains the one session/timeline owner. The `--leader --resume`
invocation owns only presentation and prompt input: it initializes, calls
`session/load`, draws native notifications, and sends `session/prompt`. Durable
resume reads the rebound native directory, restores `signals.json`, and replays
`updates.jsonl` without appending the replay. A direct ACP load targets its
requesting connection. Across the leader, notifications retain the upstream
same-session fan-out described above, so attached viewers can share replay but
clients registered to another session cannot receive it. The Grok conformance
lane types into the spawned terminal and then injects through the adapter,
proving both paths converge on one store and one native session start.
