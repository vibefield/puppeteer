# Grok 1.0.0 Surface baseline candidate

Probed on 2026-08-08 using the installed darwin-arm64 artifact reported as `grok 1.0.0 (3cd0d0cbcebe) [stable]`. Its SHA-256 is pinned in the model evidence index. Committed captures are a minimal allowlisted, sanitized projection of the probe; hidden thought text, signatures, paths, host details, and environment-derived content are not retained.

## Observable topology

Grok is not merely “an ACP binary.” The adapter-visible native composition is:

1. `grok agent leader ... --leader-socket <path>` owns a long-lived Unix coordination socket.
2. `grok agent --leader --leader-socket <path> stdio` is a strict JSON-RPC 2.0 ACP controller.
3. `grok --leader --leader-socket <path> --resume <id>` is the native terminal viewer for the same session.
4. `GROK_HOME/sessions/<encoded-cwd>/<session-id>/` contains append-only `updates.jsonl` plus replace-in-place `signals.json` and `summary.json`.

These are separate truth rails in Surface and Imposter. Only `adapter-grok` reconciles them into Core/Godview events.

## Captured lifecycle

The controlled capture includes an ACP protocol-version-1 `initialize` request; supplemental source advertises `session/load`. The sanitized census did not retain the matching result carriers, so the result schemas for `initialize`, `session/new`, `session/load`, and `session/prompt` are source-backed leads and remain `unverified`. A controlled no-tool turn observed standard `session/update` chunks alongside the live xAI extension method `_x.ai/session_notification`. Durable records use both standard `session/update` and the differently spelled `_x.ai/session/update`; treating those methods as interchangeable would lose a real wire distinction.

The observed turn order was user message, user-prompt hook, optional thought chunks, assistant message, response completion, stop hook, and turn completion. The durable update log and state files carry prompt correlation, usage, model/context values, compaction count, turn count, and tool-call count. Imposter resume restores these cumulative fields plus message count and the original creation time; emitting a durable compaction checkpoint advances and persists the counter once.

## Compaction and agent teams

The supplemental public source names `auto_compact_started`, `auto_compact_completed`, `auto_compact_failed`, `auto_compact_cancelled`, the persist-only `compaction_checkpoint`, and `subagent_spawned` / `subagent_progress` / `subagent_finished`. Newer public source also contains workflow and goal updates. They are represented in the native behavior graph, not normalized here.

Those nodes remain `unverified`: the installed artifact was not forced through those paths, and its binary-reported revision is absent from the public mirror. Imposter Control may exercise the raw scenarios, but that is emulation coverage—not evidence promotion.

## Promotion status

This is an executable baseline candidate, not a promoted support baseline. Its
ASM/evidence v2 claims, exact darwin-arm64 digest, and pre-normalization replay
are machine-checked. The adapter-through-real-native-TUI proof also passes
locally against the exact darwin-arm64 1.0.0 artifact in an isolated environment:
one shared leader serves ACP control and the native TUI, normalized events come
from the durable log, the response appears in the TUI, and resume restores both
normalized and TUI history. The deterministic loopback provider distinguishes
the ancillary title and dashboard-summary calls from the one semantic user turn,
so this proof requires neither credentials nor external model access.

The generic adaptation workflow can acquire the four reviewed artifact URLs,
bind them to this already traced candidate, classify drift, and prepare a
confined draft PR. The protected promotion workflow now runs that same
artifact-bound native-TUI proof on each platform and requires its receipt before
it can move the ledger. That four-platform lane is implemented but has not yet
completed successfully on every protected runner.

Promotion is still blocked on darwin-x64, linux-x64, and windows-x64 artifact
and census coverage, on the unresolved source-to-binary relationship (or an
explicit reviewed binary-only evidence policy), and on real captures for any
compact/team path that is to be claimed as verified. `support/agents.json`
therefore correctly remains `baseline-pending`.
