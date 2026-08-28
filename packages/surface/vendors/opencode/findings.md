# OpenCode Surface Findings

> Candidate status: **ASM v3 modeled; adapter/Imposter/runtime candidate
> complete; pinned darwin-arm64 survey complete**, pinned to OpenCode
> **1.18.16**.
> These findings are evidence for an adapter candidate; they do not declare
> runtime support. The protected real-native-TUI matrix is implemented, but
> promotion remains gated on successful immutable-artifact runs on all four
> required platforms.

## 1. Candidate identity

| Field                    | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| Vendor                   | `opencode`                                                         |
| Display name             | OpenCode                                                           |
| Candidate version        | `1.18.16`                                                          |
| Official repository      | <https://github.com/anomalyco/opencode>                            |
| Exact source tag         | `v1.18.16`                                                         |
| Exact source revision    | `a3647eb025c7615159d417dcc49fc39fdaeba65b`                         |
| Probed platform          | `darwin-arm64`                                                     |
| Extracted binary SHA-256 | `a41776bf64c75786d6baf531b840ffb873c090d7c44793ae2dd4b1896de56a1f` |
| Binary format/signature  | Mach-O arm64; ad-hoc linker-signed                                 |
| Generated `/doc` size    | 1,104,963 bytes                                                    |
| Generated `/doc` SHA-256 | `b593ff30487920943ce01c5fd08b9d54bed656752afbe1a5ff4c504e2c42e338` |
| Census transport         | loopback HTTP REST + SSE                                           |
| Model traffic            | fake local OpenAI-compatible provider; no account or token use     |

Acquisition used the governed Surface downloader and the official platform
package tarball. The recorded binary probes are under
`probes/opencode@1.18.16`; verbatim census output remains gitignored under
`captures-raw`, and the committed JSONL carriers pass both the shared privacy
detector and OpenCode-specific rules.

## 2. Verdict

OpenCode is a structured native agent, not a terminal-scraping adaptation.
The primary integration should own one `opencode serve` backend per Puppeteer
session, observe it through `/event`, control it through its REST endpoints,
and launch the real terminal through:

```text
opencode attach <backend-url> --dir <cwd> --session <native-session-id>
```

This preserves the native TUI and gives Puppeteer a correlated structured
rail for session identity, prompts, messages, reasoning, tools, permissions,
questions, status, durable history, and abort.

OpenCode also exposes ACP, but ACP is not the preferred primary rail here. An
ACP client would become a second approval/question controller beside the
native TUI and would discard OpenCode-specific HTTP events that the TUI itself
uses. The generic ACP adapter remains useful as a separate compatibility path;
it should not replace the native OpenCode adapter.

## 3. Confirmed launch and security surface

The candidate binary confirms:

- `opencode serve` starts a headless server.
- `--hostname` defaults to `127.0.0.1`; `--port` defaults to `0`.
- mDNS is off by default and CORS has no additional origins by default.
- startup prints `opencode server listening on http://<host>:<port>`.
- `opencode attach <url>` accepts `--dir`, `--session`, `--continue`, and
  `--fork`.
- Basic-auth credentials come from `OPENCODE_SERVER_PASSWORD` and
  `OPENCODE_SERVER_USERNAME`; the default username is `opencode`.

The adapter recipe should therefore generate a random password per backend,
pass it only through child-process environment, bind loopback on port `0`, and
leave mDNS/CORS disabled. Passwords must never enter argv, logs, fixtures, or
session metadata.

The adapter's opt-in promotion test now executes that complete recipe rather
than substituting a fake terminal host. Against the exact darwin-arm64
1.18.16 artifact it created the private backend and exact session, attached
the real TUI through a PTY, submitted through the normalized prompt service,
observed completion over HTTP/SSE, and confirmed that the TUI rendered the
same controlled response. The resulting promotion receipt is bound to the
executable digest. This local proof validates the lane; it is not a substitute
for the four required protected workflow results.

## 4. Confirmed HTTP/SSE carrier

The server publishes workspace-scoped SSE at `GET /event`. The adapter can
select an instance with the `directory` query parameter (or the
`x-opencode-directory` header). On connection the stream emits
`server.connected`, then envelopes of the form:

```json
{
  "id": "evt_…",
  "type": "message.part.updated",
  "properties": {}
}
```

OpenCode-generated event IDs are present in 1.18.16 and are unique in every
captured stream. They provide a live-connection deduplication key. The server
does not expose a proven replay cursor, so a reconnect must rehydrate durable
messages/status and reconcile buffered live events rather than claim a
gap-free resume.

Endpoints exercised by the census:

| Purpose              | Endpoint                           | Confirmed result                      |
| -------------------- | ---------------------------------- | ------------------------------------- |
| Create session       | `POST /session`                    | session object with native `ses_…` ID |
| Verify exact session | `GET /session/:id`                 | same persisted session object         |
| Submit prompt        | `POST /session/:id/prompt_async`   | `204`                                 |
| Durable history      | `GET /session/:id/message`         | user/assistant messages plus parts    |
| Child sessions       | `GET /session/:id/children`        | children joined by `parentID`         |
| Fork session         | `POST /session/:id/fork`           | independent root with cloned/remapped history |
| Update/archive       | `PATCH /session/:id`               | session plus `session.updated`        |
| Delete session       | `DELETE /session/:id`              | `200 true` plus `session.deleted`     |
| Project session list | `GET /session`                     | active and archived sessions          |
| Global session list  | `GET /experimental/session`        | archived excluded unless requested    |
| Session state        | `GET /session/status`              | status map                            |
| Permission response  | `POST /permission/:id/reply`       | correlated reply                      |
| Question response    | `POST /question/:id/reply`         | correlated reply                      |
| Question dismissal   | `POST /question/:id/reject`        | correlated rejection                  |
| Abort active session | `POST /session/:id/abort`          | `200 true`                            |
| Session turn diff    | `GET /session/:id/diff`            | exact `messageID` returns its change; unscoped is empty |
| Tracked workspace diff | `GET /vcs/diff?mode=git`         | added/modified file patch             |
| Pending blockers     | `GET /permission`, `GET /question` | arrays                                |
| Generated schema     | `GET /doc`                         | OpenAPI document                      |

The prompt request accepts a caller-supplied `messageID` beginning with `msg`.
The same ID is emitted on the user `message.updated` event and persisted in
history. This is the deterministic prompt-confirmation channel: HTTP `204`
alone proves request acceptance; the exact native user-message ID proves this
session observed the submitted prompt.

## 5. Observed native turn lifecycle

The controlled baseline turn produced this semantic subsequence (ambient
catalog/plugin/reference events omitted):

```text
session.created
message.updated (role=user, exact supplied message ID)
message.part.updated (user text)
session.status {type:busy}
message.updated (role=assistant)
message.part.updated (step-start)
message.part.updated/delta/updated (reasoning)
message.part.updated/delta/updated (text)
message.part.updated (step-finish, reason/tokens/cost)
message.updated (assistant completed/finish)
session.status {type:idle}
session.idle
```

Several updates repeat the same message/status. Normalization therefore needs
entity/state deduplication; it must not emit a second normalized turn merely
because OpenCode re-published a durable message record.

Confirmed part families in this census:

- `text`: empty start, `message.part.delta`, completed full text.
- `reasoning`: empty start, delta, completed summary text.
- `tool`: `pending` → `running` → `completed` or `error`.
- `step-start` and `step-finish`, with per-step token and cost fields.

Runtime evidence below also verifies file, compaction, direct subtask, agent,
and patch parts, plus snapshot hashes on `step-start` and `step-finish`.
Source/schema inspection identifies dedicated snapshot and retry part types,
but those standalone message-part families remain unverified.

### 5.1 Observed file mutation and diff behavior

A controlled write to a new file produced:

```text
write tool pending → running
→ file.edited → file.watcher.updated {event:add}
→ write tool completed → next model step → session idle
```

A controlled edit first read the tracked file, then produced:

```text
read tool pending → running → completed
→ edit tool pending → running
→ file.edited → file.watcher.updated {event:change}
→ edit running update with filediff metadata → completed
→ next model step → session idle
```

A controlled delete used the native `apply_patch` tool with a GPT-family test
model (the pinned tool registry exposes `apply_patch` instead of write/edit for
that model family):

```text
apply_patch pending → running
→ file.watcher.updated {event:unlink}
→ apply_patch completed → step-finish → patch part
→ next model step → session idle
```

The edit metadata retained structural `filediff` fields (`file`, `patch`,
`additions`, `deletions`) while committed fixtures redact the path, patch, tool
input/output, and file content. The write, edit, and delete scenarios used
clean, Git-backed temporary workspaces.

Exact-release source inspection closes two semantic gaps that the redacted
captures and generated OpenAPI cannot answer. First, `edit`, `write`, and
`apply_patch` build their displayed patches with
`trimDiff(createTwoFilesPatch(...))`. `trimDiff` removes common indentation
from hunk content lines. Those strings are therefore complete native
**presentation previews**, but they are not guaranteed to be directly
applicable unified diffs or byte-exact reconstructions. An edit also recomputes
the preview after formatter changes, so completed metadata can legitimately
differ from the original replacement intent.

Second, the generic tool wrapper adds `metadata.truncated` only after applying
output truncation to the model-facing `output` string. That boolean does not
describe `filediff.patch`, `files[].patch`, or `metadata.diff`. Treating it as
patch completeness silently invents a relationship the native source does not
contain. The digest-pinned contract in
`references/opencode@1.18.16/source/workspace-tools.json` now records the exact
tool inputs, completed metadata fields, preview production, truncation meaning,
and watcher variants; the runtime file scenarios independently establish that
those source paths occur in 1.18.16.

Every mutating assistant step carried a pre-mutation snapshot hash on
`step-start`, a different post-mutation hash on `step-finish`, and a subsequent
`patch` part. The patch hash equaled the pre-mutation snapshot and its file list
identified the changed path.

The diff rails are related but not interchangeable. Live `session.diff` events
are empty invalidations, and `GET /session/:id/diff` without a `messageID`
returned an empty array. Calling the same endpoint with the exact submitted
message ID returned the snapshot-derived per-message change: `added`,
`modified`, or `deleted`, with matching addition/deletion counts. In the same
sessions, `GET /vcs/diff?mode=git` returned the current tracked workspace view
with the same status/counts but a VCS-native patch format. The adapter must
retain the message-scoped and current-workspace meanings separately.

### 5.2 Observed prompt attachment behavior

A controlled `text/plain` data-URL attachment submitted through
`prompt_async` produced this durable user-message part sequence:

```text
ordinary user text
→ synthetic text describing the read call
→ synthetic text containing the decoded attachment
→ file {mime:text/plain}
→ session busy
```

The same `file` part appeared on live `message.part.updated`, and the turn made
one provider request. The committed fixture redacts the URL, filename-sensitive
content, and all prose while preserving the four-part shape and joins. An
adapter should retain the native file part as the attachment carrier and treat
the synthetic text parts as durable OpenCode expansions, not separate user
turns.

The generated schema also declares a standalone `SnapshotPart`. Exact-release
source inspection found no runtime insertion path for that part: 1.18.16 puts
snapshot hashes on `step-start` and `step-finish` and emits `patch` separately.
The ASM therefore keeps `part.type=snapshot` unverified rather than fabricating
a capture for a schema-only branch.

## 6. Permission behavior

An asked Bash permission carries:

- native permission request ID;
- session ID;
- permission kind (`bash`);
- concrete patterns and `always` suggestions;
- metadata;
- correlated tool `{messageID, callID}`.

The reply event carries the same request ID and one of `once`, `always`, or
`reject`.

Observed acceptance:

```text
tool pending → tool running → permission.asked
→ permission.replied {reply:once}
→ tool running → tool completed
→ next model step → session idle
```

The native `attach --session <id>` TUI was also connected to the exact session
while the census observed the shared backend. Choosing **Allow always** and
confirming it in the TUI produced:

```text
tool pending → tool running → permission.asked
→ native TUI confirmation → permission.replied {reply:always}
→ tool running → tool completed
→ next model step → session idle
```

The harness made no `POST /permission/:id/reply` request in this scenario. The
reply came from the attached native client, retained the original request ID,
and left no pending permission. This proves shared-backend control through the
real terminal rather than an HTTP-only approximation.

Observed rejection:

```text
tool pending → tool running → permission.asked
→ permission.replied {reply:reject}
→ tool error → step-finish → session idle
```

Rejection made **one** provider request, not two: it terminated the current
tool loop rather than asking the model for a follow-up response. This is native
behavior the Imposter and conformance suite must preserve.

## 7. Question behavior

Questions are first-class OpenCode events, distinct from permission events.
`question.asked` carries a request ID, session ID, question/options payload,
and correlated tool IDs. Reply and rejection use that request ID.

Observed reply:

```text
question tool pending → question.asked → tool running
→ question.replied → tool completed
→ next model step → session idle
```

Observed dismissal:

```text
question tool pending → question.asked → tool running
→ question.rejected → tool error → step-finish → session idle
```

Like permission rejection, dismissal made no second provider request. Core has
no provider-neutral question event today. The first adapter should retain the
native question events and represent the surrounding question tool lifecycle,
not falsely normalize a question as a permission.

## 8. Abort behavior

`POST /session/:id/abort` returned `200 true` for both controlled abort
scenarios. Each scenario made exactly one provider request, so abort did not
start a follow-up model step.

Aborting an active streamed text response produced:

```text
text delta → abort response → session.error {MessageAbortedError}
→ session idle → completed text-part update containing only the partial text
→ duplicate idle
```

Aborting a running Bash tool produced a more surprising carrier sequence:

```text
tool pending → tool running → abort response
→ session.error {MessageAbortedError} → session idle
→ tool running update → tool completed with a native user-aborted marker
→ duplicate idle
```

The completed Bash carrier does not make the turn successful: the correlated
`session.error` is authoritative for the turn outcome. A normalizer must keep
that failed terminal state when late part/status updates arrive.

## 9. Provider retry and terminal-error behavior

A controlled HTTP `429` caused OpenCode to emit
`session.status {type:retry, attempt:1, message, next}`. It then issued a
second provider request, returned to `busy`, completed the response, and
settled idle without `session.error`. The `next` field is an absolute retry
clock and is pinned by the fixture sanitizer.

A controlled HTTP `400` made one provider request and emitted
`session.error {APIError}` with `statusCode:400` and `isRetryable:false`, then
idle. Durable history retained an assistant message with the same error and no
parts. Provider response headers, body, URL, and prose are redacted from the
committed carrier while their public shape and status fields remain.

Retry status is therefore not a new turn and not a terminal error. It should
keep the active turn open. Non-retryable `session.error` fails the active turn;
subsequent idle duplicates must not also complete it.

## 10. Reconnect, rehydration, and exact resume

The controlled reconnect scenario closed the SSE observer after a text delta,
then released the provider to finish while no observer was connected. Durable
status reached idle and `GET /session/:id/message` returned the completed user
and assistant records. A replacement `/event` stream emitted exactly one
`server.connected` event and no session history.

This confirms the absence of an SSE replay cursor in the exercised carrier.
Reconnect alone cannot close an observation gap: the adapter must open a fresh
stream, buffer any new live events, fetch durable messages/status/blockers,
and reconcile them by native entity state.

The exact-resume scenario completed a turn, stopped the private `serve`
backend, and started a new backend against the same isolated storage and
directory. `GET /session/:id` returned the exact original ID, history before
and after restart was identical, and a second caller-supplied prompt ID was
echoed on the same session. The combined evidence contains two
`server.connected` events, one `session.created`, two provider requests, and
four durable messages.

This verifies headless persistence and exact-ID reuse across a backend restart.
A combined interactive scenario then completed a first turn, restarted the
private backend, verified the same ID/history, and launched a fresh native
`attach --session` against the recovered session. Its resumed prompt requested
a Bash permission. The TUI displayed the recovered history and new turn, the
operator selected **Allow always** and confirmed it, and the shared SSE stream
observed `permission.replied {reply:always}`. The harness made no permission
reply request.

The combined capture contains two `server.connected` events, one
`session.created`, three provider requests, and five durable messages. Its
post-restart stream contains the permission lifecycle but no second
`session.created`. This closes the exact-session native-TUI resume path rather
than inferring it from separate headless and attach probes.

## 11. Manual/automatic compaction and context semantics

After a completed baseline turn, the controlled client called
`POST /session/:id/summarize` with the pinned provider/model and `auto:false`.
The endpoint returned `200 true` and made exactly one additional provider
request. OpenCode persisted a synthetic user message containing a
`compaction {auto:false}` part, then an assistant message with
`mode:compaction` and `summary:true`.

The observed compaction subsequence was:

```text
completed turn / session idle
→ manual summarize request
→ message.part.updated {type:compaction, auto:false}
→ assistant message {mode:compaction, summary:true}
→ session.compacted → session idle
```

This verifies `session.compacted` as the native manual context invalidation
signal and verifies the manual `compaction` message-part branch.

A second scenario enabled automatic compaction, declared a 128-token model
context with 32 output tokens reserved, and returned controlled provider usage
of 110 input plus 10 output tokens. The 120-token reported total crossed the
96-token usable threshold. Without any summarize HTTP request, OpenCode made
three provider calls and persisted six durable messages:

```text
build step-finish {input:110, output:10, total:120}
→ compaction {auto:true, overflow:false}
→ assistant {mode:compaction, summary:true}
→ synthetic user text {metadata.compaction_continue:true}
→ session.compacted → resumed build response → session idle
```

This proves that the pinned binary uses provider-reported step usage together
with native model limits for proactive context pressure and automatically
continues the build loop after a successful compaction. `overflow:false`
distinguishes this threshold path from provider hard-overflow recovery.

A third scenario made the provider reject the initial request with HTTP `413`.
OpenCode parsed it as `ContextOverflowError`, did not retry the request, and
emitted `session.error`. With automatic compaction enabled, that error was a
recoverable transition rather than the terminal outcome:

```text
provider HTTP 413 → session.error {ContextOverflowError}
→ compaction {auto:true, overflow:true}
→ assistant {mode:compaction, summary:true}
→ synthetic user text {metadata.compaction_continue:true}
→ session.compacted → resumed build response → session idle
```

This path made three provider requests and no summarize HTTP call. Durable
history retained an empty initial build assistant followed by the compaction
and resumed-build messages. A normalizer must therefore delay terminal
`turn.failed` for a context-overflow error while the correlated automatic
compaction branch remains active; if compaction or resumption fails, that later
outcome becomes authoritative.

Finally, a model declared with `limit.context:0` reported 1,000,010 total
tokens in one completed step. OpenCode made one provider request, emitted no
compaction part or `session.compacted`, and settled idle normally. In the
pinned implementation, zero is the unknown-capacity sentinel and disables
proactive threshold compaction. The adapter must not invent a capacity or
context-pressure percentage for that model.

## 12. Foreground tasks, direct subtasks, and child sessions

The controlled provider first requested OpenCode's `task` tool with an
`explore` subagent. OpenCode created a second durable session whose
`info.parentID` matched the parent session, added the child ID to the parent
task carrier as `state.metadata.sessionId`, and returned the same child from
`GET /session/:parent/children`. The child history contained its own user and
assistant messages under that child session ID.

The foreground ordering was:

```text
parent task pending
→ child session.created {parentID: parent}
→ parent task running {metadata: parentSessionId, sessionId: child}
→ child user/assistant turn → child session.idle
→ parent task completed → parent build response → parent session idle
```

This scenario made three provider calls: the parent's task request, the child
response, and the parent's response after the child result.

A second scenario submitted a native user `subtask` message part directly to
`prompt_async`. OpenCode did not send that part to the parent model first. It
created an `explore`-mode parent assistant task carrier in `running` state,
created and completed the same kind of child session, completed the task
carrier, and then resumed the parent `build` agent. This path made two provider
calls (child, then resumed parent) and intentionally had no `pending` task-tool
update:

```text
user message.part {type:subtask}
→ parent assistant {mode:explore} / task running
→ child session.created → child turn → child idle
→ task completed → parent assistant {mode:build, finish:stop}
→ parent session idle
```

A third input submitted ordinary user text followed by an `agent` part naming
the `explore` agent. OpenCode persisted that part, appended a synthetic user
text instruction telling the model to generate a prompt and call `task`, and
then followed the same foreground child-session lifecycle. The dedicated
`agent` branch is therefore verified; it is an invocation hint, not itself a
child-session start event.

Child agents deny recursive `task` and `todowrite` permissions in both
captures. Adapter correlation must use native parent/child IDs; event type
alone is insufficient because parent and child emit the same session/message
families. Child creation maps naturally to `subagent.started`, and child
terminal/idle state to `subagent.stopped`, while the surrounding task carrier
continues through the ordinary tool lifecycle.

The pinned binary also exposes background subagents behind
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`. A task launched with
`background:true` created the same child/session join, but completed the parent
task carrier immediately with `metadata.background:true` and `jobId` equal to
the child session ID. The parent produced a response and went idle while the
child provider stream remained deliberately gated. After child idle, OpenCode
injected a synthetic text message into the parent, automatically ran the
parent build agent again, and reached a second parent idle:

```text
task running {background:true, sessionId:child}
→ task carrier completed {jobId:child} → parent response → parent idle
→ child idle → synthetic parent result
→ parent build response → parent idle
```

A separate capture began with an ordinary foreground task, held the child
stream open, and called
`POST /experimental/session/:parent/background`. The endpoint returned
`200 true`; the task metadata transitioned from foreground to
`background:true, jobId:child`, then followed the same two-idle notification
sequence. Each asynchronous scenario made four provider calls.

For normalization, a completed task carrier with `background:true` means only
that the parent received an asynchronous handle; it does not mean the child
stopped. Keep the subagent active until the joined child terminal/idle event,
then treat the synthetic parent result as a new correlated turn rather than a
late update to the already-idle parent turn.

## 13. Session fork, archive, and deletion behavior

The lifecycle capture forked one completed two-message session twice. Passing
the assistant `messageID` cloned only the history strictly before that target,
so the fork contained one user message. Sending no request body cloned the
complete user/assistant history. Both results were independent root sessions
without `parentID`; OpenCode allocated new message and part IDs and remapped
the cloned assistant's `parentID` to its cloned user message.

Archiving the message-scoped fork used:

```text
PATCH /session/:fork {time:{archived:<timestamp>}}
→ session.updated carrying the same archived timestamp
```

The two list rails then diverged. Stable project-scoped `GET /session` retained
all three sessions, including the archived fork. Experimental global
`GET /experimental/session` excluded the archived fork by default, while
`?archived=true` returned active and archived sessions together. The adapter
must not assume the stable list applies an active-only filter.

Finally, `DELETE /session/:fork` returned `200 true`, emitted
`session.deleted` with the last archived session snapshot, and removed the ID
from the next archived-inclusive global list. A fork is therefore a new
top-level session, while archive is visibility metadata and delete is a
terminal removal event.

## 14. ASM v3 and mapping implications

The generated ASM at `model/opencode@1.18.16/` contains 278 native documents:
188 namespaced OpenAPI operations (`http/<operationId>`) and 90 exact SSE event
types. Runtime evidence verifies 21 HTTP operations and 24 SSE types headlessly;
the remaining 233 documents are explicitly unverified. The `always` branch of
`permission.replied` is independently `verified-interactive` even though the
event itself also has stronger headless existence/shape evidence from its
`once` and `reject` branches.

The pinned `/doc` `Event` union declares 89 SSE types. Runtime also emitted
`server.heartbeat`, so the generator retains it as a capture-backed runtime-only
event instead of laundering it through generated-schema evidence. The model
audit validates 2,775 SSE carriers, 209 HTTP requests, 209 correlated HTTP
results, both privacy policies, 29 digest-pinned evidence records, and a fresh
278-document regeneration from `/doc`.

The native ASM is now contract. The first adapter implements the portable
effects below from these captures; question, file, and snapshot
events remain native. Overflow recovery now delays `turn.failed` until idle
and cancels it when `compaction {auto:true}` continues the same turn.

| Native OpenCode observation                          | Proposed normalized effect                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `session.created` / verified resumed session         | `session.started`                                                           |
| fork `session.created` without `parentID`             | a new independent `session.started`, not `subagent.started`                  |
| archived `session.updated`                            | retain native visibility metadata; do not stop the session                   |
| `session.deleted`                                     | terminal removal of that native session identity                             |
| exact user `message.updated`                         | `turn.started`; native message ID is turn/prompt correlation                |
| text part delta/full update                          | accumulated `assistant.message`, final only on completed part/message       |
| reasoning part lifecycle                             | `reasoning.started` / `reasoning.summary` / `reasoning.completed`           |
| tool `pending`                                       | `tool.requested`                                                            |
| tool `running`                                       | `tool.started`                                                              |
| tool `completed` / `error`                           | `tool.completed` / `tool.failed`                                            |
| child `session.created {parentID}`                    | `subagent.started`; use the child session ID as `subagentId`                 |
| child terminal/idle joined through task metadata      | `subagent.stopped`; do not stop the parent turn                              |
| completed task carrier with `background:true`         | async handle returned; keep the joined subagent active                       |
| synthetic result after background child idle          | new correlated parent turn, not a late mutation of the prior idle turn       |
| prompt `file` part plus synthetic text expansions      | retain one native attachment and durable expansion siblings on the same turn |
| `file.edited` / `file.watcher.updated`               | retain native workspace events; correlate by redacted/native file identity  |
| snapshot-bearing step parts plus `patch`              | retain pre/post snapshot identity and changed-file membership                |
| `GET /session/:id/diff?messageID=…`                  | durable snapshot-derived diff for that exact submitted message               |
| `GET /vcs/diff?mode=git`                             | current tracked workspace diff; do not conflate with per-message history     |
| `permission.asked`                                   | `permission.requested` with request and call IDs                            |
| `permission.replied` once/always/reject              | `permission.resolved` allowed/denied                                        |
| `session.status` retry                               | retain native retry state; keep the correlated turn active                  |
| `session.status` idle with an active correlated turn | `turn.completed`                                                            |
| `session.error` with an active turn                  | `turn.failed`; later part/idle updates cannot reverse it                    |
| context-overflow `session.error` followed by auto compaction | keep the turn recoverable until compaction/resume reaches a terminal outcome |
| completed step tokens plus resolved model limit      | `context-window.updated`; use native total (or input/output/cache sum), capacity = context |
| `session.compacted`                                  | `context-window.invalidated` (`compacted`)                                  |
| `question.*`                                         | retain as OpenCode native event; use question tool lifecycle for generic UI |

Only emit `context-window.updated` when the adapter can resolve the active
model's native context limit. Exact-release source uses `tokens.total` when it
is present, otherwise input + output + cache read + cache write; it compares
that value against the usable model limit. The capture proves this threshold
path, but does not justify inventing a capacity for an unknown model.

## 15. Survey scope and deferred platform expansion

The behavioral survey and complete adapter-through-native-TUI proof are
currently scoped to the probed `darwin-arm64` artifact. Support on darwin-x64,
linux-x64, and windows-x64 still requires successful governed acquisition,
immutable hashes, exact launch/turn receipts, and drift review in the protected
matrix; none is inferred from the arm64 run.

The standalone snapshot part is a settled exact-release limitation, not a
missing synthetic probe: it has no runtime producer in 1.18.16 and remains
`unverified`. Other unobserved schema branches likewise remain `unverified`
until a real runtime producer is captured.
