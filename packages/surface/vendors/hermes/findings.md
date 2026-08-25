# Hermes Agent 0.20.0 Surface findings

Status: Stage 0–2. Gate 0, hermetic turn census, and an ASM v2 candidate on
`darwin-arm64`. This is not an adapter, support entry, or promotion claim.

Candidate pin:

- product version `0.20.0`
- GitHub tag `v2026.8.3` (annotated tag object `7de39e700d2c329e15d32eb0b96e2f7cdd9fbdb2`)
- source revision `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`
- `pyproject.toml` SHA-256 `64d1085ee1c23caf0ae0d9e65c73e280f466362ed43fdda1531f18f3af1d9869`
- `uv.lock` SHA-256 `aab3c83f71b683507a590b6315b23bdc0abd6b63b76b2349eae15bf00dfbaf2b`

Identity probes used a disposable `HERMES_HOME` and an editable install of
that exact checkout, with no provider traffic. Turn captures used a second
set of disposable homes, a loopback OpenAI-compatible provider, and never
read the operator's `~/.hermes`.

## Acquisition decision

Hermes is a Python source checkout plus `uv`, not four platform binaries.
`upstream.json` therefore uses `source-revision`: one GitHub source archive
URL templated on `${tag}`, with the usual Chopsticks platforms listed as
**execution environments** for that same archive. Per-platform artifact
maps are forbidden for this vendor.

`hermes` and `hermes-acp` on PATH are setuptools console scripts (~330
bytes). Product identity is the pinned commit and lockfile, not those
wrapper hashes.

Protected promotion still cannot treat this vendor as four reacquired
binaries. Download/acquire tooling understands the URL template, but the
pinned-real lane remains blocked until a source-revision execution recipe
is reviewed.

## Identity probes (`darwin-arm64`)

Observed:

- `hermes --version` prints `Hermes Agent v0.20.0 (2026.8.3)` plus install
  directory, Python, and OpenAI SDK lines;
- `hermes acp --version` and `hermes-acp --version` print `0.20.0`;
- `hermes acp --check` prints `Hermes ACP check OK` and exits 0;
- unknown option `--definitely-not-a-hermes-option` exits 2 and names the
  option;
- `--help` includes `--tui`, `--cli`, `--resume`, `--continue`, `--in` is
  **not** in the top-level help excerpt captured here (directory scoping
  remains a docs lead), `--worktree`, `--yolo`, `--ignore-user-config`,
  `--ignore-rules`, `--safe-mode`, and subcommands `chat`, `acp`,
  `sessions`, `dashboard`.

`--version` install-directory text is redacted in the committed probe.

## Gate 0 — native control seam

### Default `hermes --tui` process tree

Live PTY launch of `hermes --tui` (isolated home, prebuilt
`HERMES_TUI_DIR`) produced:

```text
python hermes --tui
  └─ node --expose-gc ui-tui/dist/entry.js
       └─ python -m tui_gateway.entry
```

The JSON-RPC stdio pipe is owned by the Node TUI and its
`tui_gateway.entry` child. An adapter cannot sit on that pipe without
replacing the visible TUI.

`python -m tui_gateway.entry` on stdio emits
`{"method":"event","params":{"type":"gateway.ready",...}}` within seconds
with no inbound request. That is a live, headless `gateway.ready`.

### Same-session attach

A loopback FastAPI host mounting `tui_gateway.ws.handle_ws` on
`/api/ws` emitted `gateway.ready` to a WebSocket client. Launching
`hermes --tui` with `HERMES_TUI_GATEWAY_URL=ws://127.0.0.1:<port>/api/ws`
attached the Node TUI to that host and **did not** spawn
`python -m tui_gateway.entry`.

This is the dashboard's documented internal seam, not a public CLI flag.
It is stable enough to model: the TUI client reads `HERMES_TUI_GATEWAY_URL`
in `ui-tui/src/gatewayClient.ts`, and `handle_ws` is the same dispatcher
as stdio. Chopsticks may own a tiny loopback host of `handle_ws`; the TUI
is then a viewer of that process's `AIAgent`.

Two WebSocket clients can share the module-global session table. Approvals
must stay native-TUI unless a single-controller lease is proven. Do not
let the adapter and the TUI both answer `approval.respond`.

### ACP isolation

`hermes acp` / `hermes-acp` is a separate stdio ACP server. It was not
observed joining the live `--tui` tree. Source and docs treat ACP
list/load/resume as process-scoped. Running ACP beside the TUI would be a
second `AIAgent`. Forbidden as the native-TUI control plane.

### Gate 0 verdict

| Question                      | Result                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| Default process tree          | Proven: wrapper → Node TUI → `tui_gateway.entry`                   |
| Who owns stdio JSON-RPC       | Node TUI ↔ `tui_gateway.entry`                                     |
| Same-session attach           | Proven via Chopsticks-owned `handle_ws` + `HERMES_TUI_GATEWAY_URL` |
| Official public attach API    | No. Dashboard/Desktop internal only                                |
| Second client races approvals | Yes, if both call `approval.respond`                               |
| Does ACP join the TUI session | No evidence it does; treat as a separate host                      |

**First adapter rail:** structured observation/control through a
Chopsticks-owned loopback `handle_ws` host, with `hermes --tui` attached as
the native viewer. Prompt submission may use `prompt.submit` on that host.
Approvals stay native-TUI for the first slice.

Plugin hooks / outbound webhooks remain a fallback observer if the WS host
is not used. `state.db` is resume/replay only.

## Turn census (stdio `tui_gateway`)

The census drove `tui_gateway` over stdio with a fake provider. That is the
same dispatcher as the attach WebSocket (`handle_ws`), not a second agent.
It is not a live `hermes --tui` PTY capture.

Sanitized fixtures live under `captures/hermes@0.20.0/`.

### Identities

`session.create` returns two ids:

- live `session_id`: 8 hex (`272654f4` in the raw basic-turn);
- durable `stored_session_id`: `YYYYMMDD_HHMMSS_` plus 6 hex.

Events carry the live id. `session.resume` takes the stored id and returns a
**new** live id. The resume result uses `resumed` / `session_key` for the
stored id, not `stored_session_id`. `session.info` then repeats
`stored_session_id`. Resume of the basic-turn stored id came back with
`message_count: 2` and `status: "idle"`.

`prompt.submit` returns `{ status: "streaming" }` immediately. There is no
caller-supplied prompt id and no native receipt id. Confirmation is only the
later `message.start` on that live session. Prompt receipts must stay
`uncertain` if that pairing is lost.

### Observed JSON-RPC events

| Scenario          | Distinct event types observed                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| basic-turn        | `gateway.ready`, `session.info`, `message.start`, `thinking.delta`, `sessions.changed`, `message.delta`, `reasoning.available`, `message.complete` |
| tool-success      | plus `tool.generating`, `tool.start`, `tool.complete`                                                                 |
| permission-deny   | plus `approval.request`                                                                                               |
| interrupt         | `session.interrupt` result `interrupted`; `message.complete` status `interrupted`                                     |
| resume-turn       | `session.resume` then the basic-turn stream set                                                                       |

`thinking.delta` is a UI spinner string (`(⊙_⊙) pondering...`), not model
reasoning. `reasoning.available` echoed the assistant text in these runs.

`tool.start` / `tool.complete` share `tool_id` (the model `call_…` id) and
`name`. `tool.complete.result` for a successful terminal call has `output`,
`exit_code: 0`. A denied call has `exit_code: -1`, `status: "blocked"`, and
an error telling the model not to retry.

`approval.request` choices were `once | session | always | deny`.
`approval.respond` with `choice: "deny"` returned `{ resolved: 1 }`. The
TUI overlay was not in this stdio census; a live `--tui` attach would still
race this method if both answered.

`session.interrupt` after the first `message.delta` produced
`message.complete` with `status: "interrupted"` and the partial text. The
RPC write is not itself the stop: the later `message.complete` is.

After a successful user turn the fake provider saw two extra non-streaming
`/v1/chat/completions` calls with no tools. Their system prompt asked for a
3–7 word conversation title. Those are not user turns.

### Hooks and outbound webhooks

Default `python -m tui_gateway.entry` does **not** register
`hooks.outbound` or load user plugins. The first unwrapped basic-turn wrote
an empty `webhooks.jsonl`. The CLI entry does register them.

The census sidecar (`census/tui-gateway-census.py`) calls
`register_from_config` and `discover_plugins` before the real entry. With
that injection, the same turns produced both:

- plugin-hook dumps (`plugin-hooks.jsonl`);
- outbound webhook POSTs (`X-Hermes-Event`, signed-capable body).

New sessions fire `on_session_start`. Resume does not. Every gateway
shutdown fired `on_session_end` twice in the plugin dump (once from the
turn/lifecycle path, once from finalize) and `on_session_finalize` once.
Interrupt had `pre_llm_call` / `pre_api_request` but no `post_llm_call`.

`pre_approval_request` / `post_approval_response` fire on the gateway
surface (`surface: "gateway"`). Outbound webhook top-level `session_id` was
empty for those two events; the stored id is `extra.session_key`.
`post_approval_response.choice` was `deny`.

Hooks remain a fallback observer. They are not live on an unmodified
`--tui` tree unless Chopsticks registers them in the owned gateway process
or enables a user plugin in the isolated home.

## Isolated home side effects

The first `tui_gateway.entry` start in an empty `HERMES_HOME` created
`SOUL.md`, `logs/agent.log`, `logs/errors.log`,
`logs/tui_gateway_crash.log`, and `.update_check`. Census homes must stay
disposable. The adapter must not create these in the user's real home as a
side effect of detection.

## Unverified / next census

- the same turns through the attached `HERMES_TUI_GATEWAY_URL` WebSocket
  (stdio and WS share `handle_ws`; still unproven as a live TUI attach);
- `approval.respond` while a real Node TUI is also attached;
- allow once / session / always, smart auto-allow/deny, approval timeout;
- `--resume` on `hermes --tui` itself (RPC resume is proven);
- compression lineage and `session.compress`;
- `state.db` snapshot vs live events (replay only);
- nonzero tool exit, parallel tools, late `tool.complete`;
- other execution platforms;
- whether `--in <dir>` appears on this exact CLI.

The stdio event map is modeled in `model/hermes@0.20.0/` (28 events).
`@vibecook/chopsticks-adapter-hermes` now owns a TUI-gateway client, a
stateful normalizer, and an attach recipe (`hermes --tui` +
`HERMES_TUI_GATEWAY_URL`). Approvals stay `native-tui`. Prompt receipts
confirm only a following `message.start` on that live session; otherwise
they stay `uncertain`. Imposter `ai --hermes` is the interactive preview;
`ai --hermes tui-gateway` is the stdio double of the owned gateway, not a
native Hermes CLI subcommand. This is still not a support or promotion
claim.
