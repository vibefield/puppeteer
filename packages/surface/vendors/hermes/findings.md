# Hermes Agent 0.21.5 Surface findings

Status: candidate adaptation of the latest stable release through the exact-source
contract survey, an isolated-home identity probe, a type-preserving hermetic turn
census, ASM v3, adapter and Imposter conformance, and one local adapter-through-real-
native-TUI run. The support ledger entry remains `baseline-pending`; none of this is
a promotion claim. The 0.20.0 candidate's authoring model, captures, probes, and
reference stay beside this one as history.

Candidate pin:

- product version `0.21.5`
- GitHub tag `v2026.9.24` (annotated tag object `e3dd27ee2d8b011737a4eea8e3eb3d711ab78690`)
- source revision `f97608f178d1ffeca59860195ab7da295f7c8e5f`
- `pyproject.toml` SHA-256 `6f969b9fdff95e7269ec808361e3ae8be5357036e6257e53a3306878cf8c41dd`
- `uv.lock` SHA-256 `5b3798f326209475abca8ef7cbf7c9406f12e687c28c0b540dfe597466f48590`
- gateway contract `apps/shared/src/gateway-contract.openrpc.json` SHA-256
  `c89a203e853c285c4af204a229d4d804a36847efdcb6d223da8d3d22017f184d`

## Release and version mapping

Hermes publishes date tags. The detector reads the stable tag (`^v(\d{4}\.\d{1,2}\.\d{1,2})$`)
and takes the product version from the release title (`v(\d+\.\d+\.\d+)`). The 0.20.0
candidate followed the same rule: annotated tag `v2026.8.3` has the subject
`Hermes Agent v0.20.0 (2026.8.3)`, and its `pyproject.toml` and `hermes_cli.__version__`
say `0.20.0`. Tag `v2026.9.24` has the subject `Hermes Agent v0.21.5 (2026.9.24)`
("Rollup patch: ~460 PRs since v0.21.4"), and at the peeled commit `pyproject.toml`
says `version = "0.21.5"` and `hermes_cli/__init__.py` says `__version__ = "0.21.5"`,
`__release_date__ = "2026.9.24"`. The installed console prints
`Hermes Agent v0.21.5 (2026.9.24)`. So `0.21.5` is the normalized version for this tag.
The census tooling keeps every reviewed pin in `census/harness.mjs` `RELEASES`.

## Acquisition and artifact identity

`upstream.json` is unchanged: a `source-revision` archive, a `python-uv-lock`
installed console, and a `node-npm-lock-bundle` runtime bundle. All six reviewed
root files exist at the new tag. `ui-tui/scripts/build.mjs` is byte-identical to
0.20.0; the other five changed. The project still requires Python `>=3.11,<3.14`; the
root `package.json` engines widened from `node >=22.22.0` to
`^22.22.0 || ^24.11.0 || >=26.0.0`, which still admits the pinned Node `22.22.0`.

Not produced here, and not invented:

- **Source-archive bytes.** `github.com` and `codeload.github.com` are unreachable
  from this environment (HTTP 403), so the archive the policy names was not
  downloaded and no archive digest is recorded. The survey used a `git clone` of the tag.
- **Installed-console manifest.** `surface:materialize` requires the exact Python
  `3.11.9` and uv `0.9.28`; this host has Python `3.11.18` and uv `0.11.32`, and
  python-build-standalone downloads come from GitHub. No `installed-console.json`
  or runtime-bundle digest is recorded.

The evidence artifact is therefore a `source-revision-pin` (`kind`), integrity-bound to
the tagged `pyproject.toml` only. Because it carries a `kind`, acquisition replaces it
with the attested installed-console manifests instead of treating it as reviewed bytes
that a later acquisition would contradict. `agent-adaptation.yml` remains the authority
for archive, manifest, and four-platform identity.

## Identity probes (`linux-x64`, survey environment)

The probe ran an editable `uv sync --frozen --no-default-groups` of the exact tag with
Python 3.11.18 in a disposable `HERMES_HOME`; `artifact.json` records that environment
as unattested. Observed:

- `hermes --version` prints `Hermes Agent v0.21.5 (2026.9.24)`, then install directory,
  a new `Install method:` line, Python, and OpenAI SDK lines;
- `hermes acp --version` prints `0.21.5`;
- `hermes acp --check` exits 1: ACP's protocol package is the optional `acp` extra in
  both 0.20.0 and 0.21.5, and the reviewed recipe installs no extras. The 0.20.0
  `darwin-arm64` probe evidently ran with the extra installed. The harness now records
  the check's exit status rather than requiring success. ACP is never run beside the TUI;
- unknown option `--definitely-not-a-hermes-option` exits 2 and names the option;
- `--help` still lists every flag and subcommand the census requires. Root, `chat`, and
  `sessions` help are identical to the adapter's 0.21.4 grammar fixtures apart from the
  isolated home's display path. `hermes_cli/_parser.py`, `main_tui_launch.py`, and
  `stream_json.py` are byte-identical to the hashes in `dispatch-probes.json`;
  `main.py` changed only in profile/s6 supervision paths, not chat dispatch. The 0.21.4
  invocation grammar therefore stands; it was not re-probed.

## Drift from 0.20.0

| Area | 0.20.0 | 0.21.5 | Classification |
| --- | --- | --- | --- |
| Gateway contract | Methods discovered by scanning `@method` in Python | Upstream-generated OpenRPC 1.3.2 contract; registry, handler table, and contract agree (237 methods) | additive authority: exact schemas replace structural guesses |
| Methods | 130 | 237; the dispatcher rejects any undeclared params key with error 4000 | adaptation-required (see `session.resume`) |
| `session.resume` | Ignored an unread `cwd` | Contract has no `cwd`; `{session_id, cwd}` is refused with 4000 (captured in `resume-turn/rejections.jsonl`) | **breaking for the adapter**, fixed |
| Approvals | `approval.request` event, `approval.respond` method | Server→client JSON-RPC request `approval` (`srq-<12 hex>` id, params with `request_id`), answered by a response frame; `approval.respond` remains | **breaking for observation**, fixed |
| Clarify, sudo, secret, ... | `*.request` / `*.expire` events | 13 server→client requests; a timeout or cancel emits `request.cancel {id, method, reason}` | **breaking for observation**, fixed for `clarify` |
| Client capability | none | `client.capabilities {server_requests: true}`; a WebSocket session whose every client never sent it gets server requests failed fast | additive; the native TUI sends it on `gateway.ready` |
| Live session attach | One scalar transport; `session.resume` rebinds it | `FanoutTransport`: a resuming client joins the session's existing clients | additive; the host's 0.20 fan-out shim is now skipped |
| Events | 60 (source scan) | 73; removed `approval.request`, `clarify.*`, `secret.*`, `sudo.*`, `terminal.read.*`, `subagent.text`; added `request.cancel`, `session.usage`, `todo.updated`, `message.reaction`, `session.control.update`, and others | removals adaptation-required (above); additions additive-unconsumed |
| Event carrier | `params {type, session_id, payload}` | adds a per-session monotonic `params.seq` on session-scoped events | additive-unconsumed |
| `gateway.ready` | `skin`, `change_events` | adds required `replay_epoch`, optional `heartbeat` | additive-unconsumed |
| `prompt.submit` result | `{status}` | `{status, user_row_id, ...}`; still no prompt id | additive-unconsumed |
| Hooks | 23 `VALID_HOOKS` | 41 (stream, auxiliary-call, kanban, room, skill, transcription hooks added; none removed) | additive-unconsumed |
| Hook envelopes | shell / outbound fields | both add `profile` | additive-unconsumed |
| Inline diff | `tool.complete.inline_diff` | same bounds (6 files, 80 lines) and tools; preview produced only for a local terminal backend | no drift for the adapter |
| Title request | "Generate a short, descriptive title ..." | "You name chat sessions. ..." | test-support only |
| `state.db` | schema 25 | schema 30 | unconsumed (resume and replay go through the gateway) |
| ACP | `agent-client-protocol==0.9.0` extra | same pin; a few internal server helpers changed | unconsumed (forbidden beside the TUI) |
| CLI | | help unchanged from 0.21.4 | no drift |

## Gate 0 — native control seam (re-checked against 0.21.5 source and one live run)

The process model is unchanged: `hermes --tui` runs the Node Ink TUI, which spawns
`python -m tui_gateway.entry` unless `HERMES_TUI_GATEWAY_URL` points it at a WebSocket
gateway (`ui-tui/src/gatewayClient.ts`). `tui_gateway.ws.handle_ws` is the same
dispatcher. No new 0.21.5 process-tree probe was committed; the attach is proven by the
live adapter run below.

What changed is the shared-session model. `session.resume` of a live session now
attaches the caller beside the clients already streaming
(`methods_session._resume_reuse_live` → `session_lifecycle._rebind_live_transport` →
`session_transports._attach_session_transport`), so the native TUI and the adapter both
receive session events without help. Puppeteer's gateway host keeps its 0.20 event tee
only when `tui_gateway.transport` has no `FanoutTransport`.

Server→client requests travel the same fan-out: every attached client receives the
`approval` request and the first response settles it. The native TUI answers. The
adapter observes and must never reply, because even an error reply would settle the
request in the TUI's place. Approvals therefore stay `native-tui`. Until the TUI has
resumed the session, the adapter's WebSocket is the session's only client and has not
advertised `server_requests`, so Hermes would fail an approval raised in that window;
prompts submitted before the TUI attaches remain a known limitation.

ACP (`hermes acp`) is still a separate stdio host and is forbidden as the native-TUI
control plane.

### Live adapter/native-TUI run (`linux-x64`, survey environment)

`driver.live.test.ts` ran against the survey install and a TUI bundle built from the
tag's `package-lock.json` (`npm ci --workspace ui-tui --ignore-scripts`, then the
reviewed `ui-tui/scripts/build.mjs`, with Node 22.23.4 / npm 10.9.9, not the pinned
22.22.0 / 10.9.4; the bundle digest is not recorded as identity). With a disposable
`HERMES_HOME` and a loopback provider, one prompt was confirmed through `prompt.submit`,
normalized to `turn:completed`, rendered in the real native TUI, and resumed into a
second native TUI with replayed history; the provider saw exactly one model turn. Before
the `session.resume` fix the same run failed at resume with error 4000. It passes with
or without the host's event tee. No attestation receipt was written: this is not the
protected lane.

## Turn census (stdio `tui_gateway`)

Same harness and scenarios as 0.20.0, with two changes: the census client advertises
`client.capabilities {server_requests: true}` on `gateway.ready` (as the native shared
channel does) and answers the `approval` server request with `{choice: "deny"}`. Sanitized
fixtures under `captures/hermes@0.21.5/` are **type-preserving** (schemaVersion 2), unlike
the 0.20.0 legacy projections, so every captured frame is validated against its exact
contract schema by the audit and by `surface:replay`. Replay correlates results through
the census's inline `"direction": "client"` marker, so the method results and the
response to the `approval` server request are validated against their result schemas too
(143 frames + 17 results, 0 unattributed, 0 issues).

### Identities

Unchanged: `session.create` returns an 8-hex live `session_id` and a
`YYYYMMDD_HHMMSS_<6 hex>` `stored_session_id`; `session.resume` takes the stored id and
returns a new live id with `resumed` / `session_key`. `prompt.submit` returns
`{status: "streaming", user_row_id}` with no prompt id, so prompt receipts still confirm
only on the following `message.start` and are otherwise `uncertain`.

### Observed

| Scenario | Distinct native traffic |
| --- | --- |
| basic-turn | `gateway.ready`, `client.capabilities`, `session.create`, `session.info`, `prompt.submit`, `message.start`, `sessions.changed`, `session.title`, `thinking.delta`, `message.delta`, `reasoning.available`, `session.usage`, `message.complete` |
| tool-success | plus `tool.generating`, `tool.start`, `tool.complete` |
| permission-deny | plus server request `approval` and the client's response |
| interrupt | `session.interrupt` → `{status: "interrupted"}`; `message.complete` status `interrupted` with `persisted_turn` |
| resume-turn | refused `session.resume {session_id, cwd}` (kept in `rejections.jsonl`), then `session.resume {session_id}` and the basic stream |

`thinking.delta` is still spinner text, and an empty text now clears it. `message.start`
carries no payload. `sessions.changed` is session-less and carries no `seq`. A denied
terminal call completes with `exit_code: -1`, `status: "blocked"`, and a new
`user_summary`. The approval request params carried `pattern_key` and `pattern_keys`
beyond the declared fields, which the open `ApprovalRequestParams` model admits.
Besides the user turn, the provider again saw two auxiliary requests (one with the new
title prompt) and several model-metadata probes; none are user turns.

### Hooks and outbound webhooks

As in 0.20.0, default `tui_gateway.entry` registers neither plugins nor `hooks.outbound`;
the census sidecar does. The gateway now registers shell hooks itself when it builds an
agent. New sessions fire `on_session_start` (resume does not), and shutdown fires
`on_session_end` twice and `on_session_finalize` once. Every kwargs object now carries
`telemetry_schema_version: "hermes.observer.v1"`, and tool hooks carry `turn_id`,
`api_request_id`, and `middleware_trace`. Hook payload schemas in the ASM are sampled
from the census (`sampled` fidelity); hooks not encountered have none.

## Adapter and Imposter implications

- `session.resume` sends only `session_id`; the resumed session keeps its recorded cwd.
- The normalizer and monitor read server→client requests: `approval` →
  `interaction:permission-requested` (`requestId` = the approval queue's `request_id`,
  `presentation: native-tui`); `clarify` → `interaction:question-requested`, single or
  batch, named by the `srq-` id; `request.cancel` → `permission-resolved` (`dismissed`)
  or `question-resolved` (`cancelled`). The native TUI's answer never reaches the observer,
  so an approval still open when its gated tool's `tool.complete` (the tool in flight when
  it was raised) or the turn's `message.complete` arrives resolves with outcome `unknown`,
  matching the monitor projection. Other server requests stay `adapter:native-event`.
  The 0.20 event spellings remain accepted. Answers stay invisible, as before.
- The gateway host leaves a native fan-out Hermes as shipped.
- Live test support recognizes the 0.21 title prompt.
- The Imposter persona emits `approval` as a server request with `srq-` ids, includes the
  required `replay_epoch` and `session.create`/`session.resume` result fields, and emits
  hook kwargs in their native shape.

## Privacy

Sanitization rules now also redact `arguments` (stringified tool-call arguments),
`context` and `preview` (command previews), and pseudonymize the `X-Hermes-Delivery`
header so it joins its body's `delivery_id`. Probe text has the checkout and environment
roots redacted.

## Unverified / next census

- every platform other than `linux-x64`, and the pinned Python/uv/Node toolchain;
- source-archive bytes and the installed-console manifest (adaptation workflow);
- tool, denial, interrupt, and approval through the attached real TUI (the basic turn
  and resume are proven by the live run);
- allow once / session / always, smart approval, approval timeout and `request.cancel`;
- `clarify`, `sudo`, `secret`, and the other server requests at runtime;
- an approval raised before the native TUI attaches (expected to fail fast);
- compression lineage and `session.compress`, subagent events, `session.usage` and
  `todo.updated` consumption;
- `state.db` schema 30 snapshot vs live events (replay only).

The model is `model/hermes@0.21.5/` (364 events: 237 methods, 13 server requests,
73 events, 41 hooks), generated by `census/generate-model.mjs` from the retained contract,
reference, probes, and captures.
