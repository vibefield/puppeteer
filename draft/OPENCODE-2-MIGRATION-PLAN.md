# OpenCode 2 Migration Plan

Status: **Ruled (a) on 2026-11-04 (§3); Part A in progress.** Recorded 2026-11-03 while advancing the 1.x candidate
to 1.19.5; refreshed 2026-11-04 with an upstream re-check, a second governed probe, and the A5 probes and A6 drafts
(§2.5, `draft/opencode-2/`).
Current 1.x line: OpenCode **1.19.5**, `verified` in `support/agents.json` (promotion run `41794896986`).
Target line: OpenCode **2.x** (`@opencode/cli`, latest 2.2.5; no newer stable release as of 2026-11-04).

This note says why the ledger stayed on 1.x, what OpenCode 2 changes, the decision the owner has to make, and the work
a 2.x adaptation needs. **None of the 2.x facts below are Surface evidence.** They come from two read-only probes
(linux-x64 on 2026-11-03, darwin-arm64 on 2026-11-04) and from upstream source at tag `v2.2.5`. A 2.x adaptation must
capture them again through the governed census.

### Probe provenance

| Probe | Binary | Isolation |
| --- | --- | --- |
| 2026-11-03, linux-x64 | `@opencode/cli-linux-x64@2.2.5`, tarball sha256 `92690eee07a680d3cb760ca02ba43878de9eab1b4e5d5dfae8795518c53628f4`, `bin/opencode` sha256 `8d060e1d2fbb9bb44cf09ae6ed1f3f6a7cff070b5227e2f90970132b23a92050` | empty home, environment-only password, no model or account |
| 2026-11-04, darwin-arm64 | `@opencode/cli-darwin-arm64@2.2.5`, tarball sha256 `dfd827de3281b4c3ca2b0bfc8f4beb103fa660c419d148a1a515c4344f9e9c02` (sha1/sha512 match npm), `bin/opencode` sha256 `abe4d88594bffb12b364375b8a6732d2d1f7a977195ed1a35c5c76f8e89c9e0e`, signed TeamIdentifier `5NZ4Q7NXJ4`. A seed `opencode-darwin-arm64@1.19.5` (`bin/opencode` sha256 `feaafead…f83596c`, the ledger's darwin-arm64 artifact) built a 1.x store for the in-place test. | `env -i`, private HOME/XDG/TMPDIR, `OPENCODE_DISABLE_AUTOUPDATE=1` and `autoupdate:false`, 127.0.0.1 only, password generated in memory and passed only through the environment. The only provider was a loopback fake shaped like the census harness's, used for one 1.19.5 request. Port 49374 (the 2.x background service default) had no listener before or after, and the real `~/.local/state/opencode` was unchanged. |

| 2026-11-04 (A5), darwin-arm64 | the same `@opencode/cli-darwin-arm64@2.2.5` `bin/opencode`, sha256 `abe4d885…c89e0e` re-checked before use, TeamIdentifier `5NZ4Q7NXJ4` | as above, one fresh root per scenario, `--server` on every server-backed CLI call. Loopback fake provider (OpenAI-compatible SSE) and a stdio MCP server written for the probe; synthetic API keys only, redacted from every saved output. `lsof` on the server found no off-loopback socket at boot, after a turn, or at the end of any scenario. Port 49374 had no listener and the real `~/.local/{state,share}/opencode` files kept their size and mtime. |

The 2026-11-04 outputs (redacted) and the upstream source at `9bbb8ce` were kept in the session scratchpad
(`…/scratchpad/oc2/lane-probe/out/NN-*.json|txt|sse`, cited below as `probe:NN`; the A5 run is `…/scratchpad/oc2/a5/out`,
cited as `a5:<name>`). They are not committed and are not evidence; the binaries and tarballs were deleted.

## 1. Two maintained release lines

Re-checked 2026-11-04 (metadata only). Nothing has been released on either line since the plan was first recorded.

| Signal | OpenCode 1.x | OpenCode 2.x |
| --- | --- | --- |
| npm package | `opencode-ai` (`latest` 1.19.5, 2026-10-28) | `@opencode/cli` (`latest` 2.2.5, 2026-10-30) |
| platform packages | `opencode-<platform>` | `@opencode/cli-<platform>` (12 targets, including `-musl` and `-baseline`) |
| source line | branch `v1` (head `006d837` "sync release versions for v1.19.5", 10-28; the tag commit is not on the branch, compare is ahead 1 / behind 1; no activity since), tag `v1.19.5` = `810c0eb` | branch `dev` (daily) / `production` (`d9184f2`, 11-02), tag `v2.2.5` = `9bbb8ce` |
| cadence | 1.19.0 on 10-11 through 1.19.5 on 10-28; no snapshot since `0.0.0-dev-202610280534` | `v2.0.0` 2026-09-11; 2.1.0 10-20, 2.2.0 10-27, 2.2.1–2.2.5 10-29/30; `dev` snapshots daily (`0.0.0-dev-583` on 11-04) |
| GitHub release | `gh release edit --latest` (`script/publish.ts`) | `gh release create --latest=false`, then `edit --draft=false --latest=false`. Not a prerelease. |
| GitHub "Latest" | v1.19.5 (`releases/latest` 302 → `/releases/tag/v1.19.5`) | never marked Latest |
| default installer | `https://opencode.ai/install` → `refs/heads/v1/install`; refuses major ≥2, points to `/v2/install` or `upgrade --major` | `https://opencode.ai/v2/install`, reading `https://opencode.ai/update/api/latest/cli/npm` (2.2.5, `@opencode/cli`) |
| install target | `$HOME/.opencode/bin/opencode` | **the same** `$HOME/.opencode/bin/opencode`, plus an `opencode2` shim that execs it |
| upgrade path | `opencode upgrade --major` moves a 1.x install to 2 | n/a |
| docs and packages | `/docs`, Homebrew `anomalyco/tap/opencode`, AUR `opencode-bin` | `/v2/docs`, Homebrew `anomalyco/tap/opencode-v2`, AUR `opencode-beta`; mise ≥ 2026.10.9 installs 2 |
| deprecation | npm `deprecated` unset, no EOL notice in the v1 README | npm `deprecated` unset; "Migrate from V1" gives no 1.x end date |

Upstream still treats both lines as stable, but the weight is moving to 2.x: the `dev` README leads with the v2
installer, mise switched to 2, and the v1 installer itself notes "GitHub's Latest release may be OpenCode 2, so it's
never used". Re-check the Latest flag before relying on `releases/latest` anywhere.

**The lines cannot coexist on one machine.** The migration page: "OpenCode 1 and OpenCode 2 both use the opencode
command and are no longer installed side by side by default … the V2 curl installer replaces the V1 binary." Both
read config from the same places and share one data file (§2.2). Whatever the ownership decision, detection must tell
the lines apart from `--version` (`1.19.5` vs `opencode v2.2.5`), never from the path.

**Detector consequence.** `upstream.json`'s `github-stable` detector takes the first non-draft, non-prerelease tag
that matches `^v(\d+\.\d+\.\d+)$` in API order. v2 releases are non-prerelease, so the detector can report a 2.x
version, and the 1.x acquisition URLs (`opencode-<platform>@2.x`) then 404. Detection stays as it is for now so the
2.x line keeps showing as upstream activity. Since the 1.19.5 promotion the ledger row carries no blocker, so this plan
is the only place a reviewer sees why. Whether the pattern is narrowed later depends on the decision in §3.

## 2. Why 2.x is a new integration family

### 2.1 Interface changes

| Puppeteer dependency (1.x, verified) | 2.2.5 observation (probe, not Surface evidence) |
| --- | --- |
| `opencode --version` prints bare `1.19.5` | prints `opencode v2.2.5` (`probe:02`). `OPENCODE_VERSION_PATTERN` and `detection.json` must change. |
| `opencode serve` = instance REST + SSE; ready line `opencode server listening on …` | `serve` = "Start the v2 API and web server", flags `--hostname --port --cors --service --stdio`, no `--pure`. Ready line `server listening on http://127.0.0.1:<port>`, without the `opencode ` prefix. (Side note for the 1.x lane: in one darwin run 1.19.5 bound 4096 despite `--port 0`; one observation, not reproduced.) |
| `opencode attach <url> --dir --session --pure` | no `attach`, `web`, `github`, `pr`, `import`, `export` or `db`. Root flags `--standalone --server --auto --continue/-c --session/-s --prompt` (plus `--wizard`, `--completions`); the directory is positional; `-s` creates a missing session. Root commands: `upgrade/update uninstall acp api debug auth mcp plugin models stats mini run session service reload pair serve` (48 help pages, `probe:04`). The help is not yargs-shaped. |
| Basic auth from `OPENCODE_SERVER_PASSWORD`, optional `OPENCODE_SERVER_USERNAME` | 2.x reads `OPENCODE_PASSWORD`, falling back to `OPENCODE_SERVER_PASSWORD` (`cli/src/env.ts`); `OPENCODE_SERVER_USERNAME` is no longer supported and the user is always `opencode`. `/openapi.json`, `/api/session`, `/api/event` return 401 with `WWW-Authenticate: Basic realm="Secure Area"` and `{_tag:"UnauthorizedError"}`. `/`, `/doc` and `/event` return **200 HTML** (the web app), so a 1.x-style `/event` probe against 2.x gets HTML, not 404 (`probe:12`). Launches must set or scrub both password variables. |
| `GET /doc` OpenAPI (188 operations) | `GET /openapi.json`, OpenAPI 3.1.0, 138 paths, **169 operations**, all under `/api/*` apart from `/auth/connect/{code}`. sha256 `f5c4571bf7e9afc22a440875a746f593f988c4c31bf824f602601c04b20e6c8e`, byte-identical on linux-x64 and darwin-arm64 (`probe:10`, `probe:11`). No `components.schemas.Event`, only `V2EventEncoded` and `Event.SeqEncoded`. No `/experimental/console/orgs`; `/api/integration*`, `/api/credential*`, `/api/plugin`, `/api/mcp`, `/api/skill` instead. |
| `GET /event` `{id,type,properties}` | `GET /api/event`. See §2.3 for the proven grammar. |
| `POST /session/:id/prompt_async` with a caller `messageID` | `POST /api/session/{id}/prompt` with optional `id`, `text`, `files`, `agents`, `skills`, `metadata`, `delivery`. The echo is durable `session.inbox.enqueued {inboxID, item}` keyed by the user message id, then `session.inbox.delivered` (§2.5 ii). |
| `message.updated` / `message.part.updated` / `message.part.delta` | `session.execution.*`, `session.step.*`, `session.text.*`, `session.reasoning.*`, `session.tool.{input.*,called,progress,success,failed}`, `session.compaction.*`, `session.retry.scheduled`, `session.usage.updated`, `session.inbox.*` (96 type names in all) |
| `permission.asked/replied`, `POST /permission/:id/reply {reply}` | `POST /api/session/{id}/permission` returns `{id, effect}`; default ruleset → `allow`, nothing published. With a session ruleset `{action:"*",resource:"*",effect:"ask"}` it emits `permission.asked {id,sessionID,action,resources,save?}`. Reply `POST /api/session/{id}/permission/{requestID}/reply {decision: once\|always\|reject, message?}` → 204 and `permission.replied {sessionID,requestID,reply}`: the event key is `reply` while the request field is `decision`, and a reject `message` is not in the event. The 1.x body `{reply}` → 400 "Missing key decision". A settled or unknown request → **404** `PermissionNotFoundError`. `always` saves a `psv_` rule (`probe:20`). |
| `question.*`, `POST /question/:id/reply\|reject` | no question routes. Form create → `form.created`; reply 204 → `form.replied {id,sessionID,answer}`; DELETE 204 → `form.cancelled`. Invalid answer 400 `FormInvalidAnswerError`; settled **409** `FormAlreadySettledError`; unknown 404 `FormNotFoundError` (`probe:20`). |
| `POST /session/:id/abort` | `POST /api/session/{id}/interrupt` (+ `session.execution.interrupted`). Idle: `200 {interrupted:false}` (also with `?resume=false`); unknown: 404 `SessionNotFoundError`; malformed id: 400 `InvalidRequestError` `kind:"Params"`. |
| `POST /session/:id/summarize` | `POST /api/session/{id}/compact` |
| agent switch | `POST /api/session/{id}/agent` returns 204 even for an unknown agent (no validation) and emits durable `session.agent.selected` (`previous` set when it changes). Entering or leaving `plan` also enqueues a durable synthetic `session.inbox.enqueued` steer reminder ("You are in Plan mode" / "You are NO LONGER in Plan mode"). |
| `@agentclientprotocol/sdk` | the CLI depends on `@agentclientprotocol/sdk` 1.6.0, and `opencode acp` remains |

Model-free routes that work under a private `serve`: session create/get/list (with `directory`)/active/message/context/
inbox/rename/metadata/archive/unarchive/fork/delete, interrupt, and `session.permission.create` / `session.form.create`.
The last two let the census drive permission and form scenarios without a model.

### 2.2 Storage: 2.x shares and migrates the 1.x data file (was "unproven")

Both lines use `$XDG_DATA_HOME/opencode/opencode.db`. In 2.x, `cli/src/database-path.ts` at the tag picks
`opencode.db` for the `latest`/`dev`/`beta`/`next`/`prod` channels (otherwise `opencode-<channel>.db`) and honours an
`OPENCODE_DB` override (unprobed). The probe ran 1.19.5 to seed a store, then opened it with 2.2.5 (`probe:40`,
`probe:41`, `probe:50`):

- 2.2.5 applies 21 more migrations on the same migration-table lineage (38 → 59 rows; first `20260804233008_loose_psylocke`).
  They drop `data_migration`, `session_context_epoch`, `session_input` and add `session_v2`, `session_part`,
  `session_inbox`, `kv`, `blob`, `job`, `schedule` and related tables.
- At startup it copies 1.x sessions once in the background (`v1-migration.bun.ts`), `running` → `completed` within
  250 ms (`GET /api/experimental/migration/v1`), and records `kv` `migration.v1-v2 = {"phase":"completed"}`. That
  one-time copy, not a schema migration, first **deletes every `event` row** (16 → 0).
- The 1.x session survives with its ids: `/api/session/{same ses_ id}` and `/message` return the same message ids,
  agent and model, with token counts folded in.
- The 1.x tables (`session`, `message`, `part`, `permission`) keep their rows and schema; 1.19.5 still starts on the
  store afterwards, lists and reads the session, and creates new ones.
- **The copy runs once.** A session 1.x creates after 2.x has opened the store never reaches 2.x: on reopen 2.x listed
  only the seed session while the legacy `session` table held two.
- `account`, `account_state`, `credential` and `control_account` already exist in the 1.19.5 store (the probe did
  not diff their schemas). The 2.x migration `20260805200742_import_legacy_credentials` imports the data root's
  `auth.json` (`$XDG_DATA_HOME/opencode/auth.json`) into `credential` rows. A fresh 2.x database has no `session` table.

Rule: Puppeteer resume survives a 1→2 upgrade for sessions written before the first 2.x launch, but a home used by both
lines diverges after that launch. A Puppeteer-run 2.x backend on a profile's `XDG_DATA_HOME` migrates that store under
any user who still runs 1.x by hand.

### 2.3 Event stream: no replay cursor (was "unproven")

- Headers `text/event-stream`, `cache-control: no-cache, no-transform`, `x-accel-buffering: no`. Every frame is
  `data: <json>\n\n`; never `id:`, `event:` or `retry:` (upstream `server/src/event-feed.ts`). `: heartbeat` on connect
  and every 15 s (`probe:21`, `probe:22`, `probe:31`).
- First frame is always `{id:"evt_…",type:"server.connected",data:{}}` with no `created`/`location`.
- Records are `{id, created, type, location?, data, durable?}`. **On the wire `data` is a JSON object**, not the encoded
  string `V2EventEncoded` declares; the decoder must accept both.
- Durable events seen were all `session.*` (`created`, `renamed`, `metadata.updated`, `agent.selected`,
  `inbox.enqueued`, `archived`, `unarchived`) with `durable:{aggregateID:<sessionID>, seq, version}`, `seq` from 0 per
  session. Only `session.created` and `session.inbox.enqueued` carried a `location`; `session.renamed`,
  `metadata.updated`, `agent.selected`, `archived` and `unarchived` did not. `permission.*`, `form.*`,
  `project.updated` and the `*.updated` catalog events are not durable.
- `types` is a repeated query parameter; `server.connected` is always sent; an unknown type → 400
  `InvalidRequestError` listing all 96 names. Id prefixes: `evt_ ses_ per_ frm_ msg_ psv_`.
- **No cursor.** `Last-Event-ID` (event id or seq), `?after=`, `?cursor=`, `?seq=` were all ignored. A rename made while
  disconnected (seq 9) never arrived after reconnecting; the next live frame was seq 10 (`probe:30`). The OpenAPI calls
  the stream "Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are
  missed". `event-feed.ts` keeps one bounded in-memory queue per subscriber (4096) and no history; when a queue is full
  the subscriber is removed and its stream fails with `EventFeed.SubscriberOverflow` (nothing is silently dropped).
- `GET /api/experimental/session/{id}/log?after=<seq>&follow=` exists but does nothing under `opencode serve`: the
  server wires `Bus.configured({ persist: options.events?.persist })` and the CLI never sets `events.persist`, so the
  `event` table stayed empty and every read (with or without `after`, `follow`) returned only one
  `{"type":"log.synced",…,"seq":<current>}` frame (seq 0 in `probe:20`, 10 in `probe:30`), and no live events followed.

So the 1.x reconnect rule ("no replay; rehydrate over REST") still holds, and a per-session `seq` gap is a reliable
signal to rehydrate.

### 2.4 Background service: `--server` avoids it (was a plan assumption)

`opencode --server <url> --session <id>` in a real PTY (screen never read) ran as one process with 14 TCP connections,
all to the private server; no child process, nothing on 49374, no `service.json`, only
`$XDG_STATE_HOME/opencode/latest/tui/tabs.json` and lock files. `opencode session list --server <url> --format json`
exits 0, and exits 1 without a password. `opencode service status` printed `stopped` (`probe:50`, `probe:51`). In
`server-connection.ts`, `--server` makes one health call (`server.info`) and warns on version mismatch; only the path
with neither `--server` nor `--standalone` (and no `disabled` service config) reaches `Service.ensure`. Every
server-backed subcommand takes the same flags and defaults to that path too (the help lists `--server` on `api`, `auth`,
`debug agents|config|heap-dump`, `mcp list|auth|logout`, `plugin list|check|update`, `models`, `stats`, `mini`, `run`,
`session`, `reload`), so **Puppeteer must always pass `--server`**.

Nearly every semantic rail the adapter normalizes changes name, envelope, route, or correlation key. Only Basic auth,
the loopback server, the data root, and the no-replay rule survive. Adapting to 2.x means a new Surface census, ASM,
persona, and adapter normalization, not a version bump.

### 2.5 A5 probe results (2026-11-04)

Probe results under the A5 governance in §4, with upstream source at `v2.2.5` read as text. Not Surface evidence.

**(i) The loopback fake provider works through 2.x config; model-backed scenarios are capturable.** Three variants
each completed three turns (text, text with a caller id, and a tool call) with `session.execution.succeeded`, four
requests to the fake provider and no off-loopback socket (`a5:a-native`, `a5:a-v1shape`, `a5:a-filev1`):

- *Native 2.x shape* in `OPENCODE_CONFIG_CONTENT`: `model: "test/test-model"`, `providers.test = {name, package:
  "@ai-sdk/openai-compatible", settings: {apiKey, baseURL}, models: {"test-model": {name, capabilities: {tools,
  temperature, reasoning: {supported}}, limit, cost}}}`, `update: "disable"`.
- *The census's 1.x shape* (`provider.test = {npm, options: {apiKey, baseURL}, models}`, `small_model`, `autoupdate:
  false`), both in `OPENCODE_CONFIG_CONTENT` and as `$OPENCODE_CONFIG_DIR/opencode.json`. 2.x normalizes it in memory
  (`core/src/config/normalize.ts` with `v1/config/*`): `npm` → `package: "aisdk:@ai-sdk/openai-compatible"`, `options`
  → `settings`, `small_model` → `agents.title.model`, `autoupdate: false` → `update: "disable"`, and `reasoning: true`
  adds low/medium/high variants. `GET /api/config` shows the normalized document.
- `@ai-sdk/openai-compatible` resolves to the bundled `@opencode/ai/providers/openai-compatible`; nothing is installed
  from npm. With `OPENCODE_DISABLE_MODELS_FETCH=1` the server made no outbound connection.
- Requests carry `Authorization: Bearer <apiKey>`, `user-agent: opencode/latest/2.2.5/cli`, `x-opencode-session`,
  `x-opencode-session-id`, `x-session-id`, `x-session-affinity`, `x-opencode-project`, `x-opencode-client`,
  `traceparent`, `b3`; body keys `max_completion_tokens messages model stream stream_options tools`. A session
  created without a title makes one extra tool-less request on its first turn and then emits `session.renamed`
  (title generation); sessions created with a title did not. The census provider must answer that request too.
- **The tool set and tool inputs changed.** Tools offered: `edit glob grep question read shell skill subagent webfetch
  websearch write execute`. A 1.x-shaped `read {filePath}` call failed with `session.tool.failed` (`error.type:
  "tool.execution"`, "Invalid arguments for tool \"read\": path: Missing key", `executed: false`) and the turn still
  succeeded. Every scripted tool call in the 2.x census must use the 2.x input schemas (`read {path}`, `shell`, not
  `bash`, `subagent`, not `task`).
- A text turn emits `session.inbox.enqueued → execution.started → instructions.updated (first turn only) →
  inbox.delivered → step.started → reasoning.started/delta/ended → text.started/delta/ended → step.streamed →
  step.ended → usage.updated → execution.succeeded`. `*.delta` and `usage.updated` are not durable; everything else
  carries `durable.seq`. `session.instructions.updated`, `session.tool.success` and `session.tool.failed` are at
  durable version 2.

**(ii) Prompt echo.** `POST /api/session/{id}/prompt` returns `200 {data: {id, sessionID, time, type: "user", payload:
{text}, delivery: "steer"}}`. Its `id` is the user message id: a caller-supplied `id` (`msg_` + 26 chars was accepted)
is kept, otherwise the server mints one. The same id is `inboxID` in `session.inbox.enqueued {inboxID, sessionID,
item: {type, payload: {text}, delivery}}` and in `session.inbox.delivered {inboxID, sessionID}`, and is the user
entry's `id` in `/context` (oldest first) and `/message` (newest first; both also list `type: "idle"` entries with an
`outcome`). The echo carries the prompt text, so the adapter correlates a submitted prompt by id without reading
terminal text. There is no `message.updated` for the user turn.

**(iii) Directory scoping.** The 1.x `?directory=` is ignored by location-scoped routes: `GET /api/location?directory=B`
answered for the server's cwd. Scope is `?location[directory]=<abs>` or the `x-opencode-directory` header
(URL-encoded); an unknown directory is `404 LocationNotFoundError`. `GET /api/session?directory=` does filter the list
(and returns a `cursor`), while `?location[directory]=` on the list does not filter. A session read by id ignores a
mismatched location (200). Each location gets its own `projectID` and is listed by `GET /api/debug/location`.

**(iv) Config, skills, plugins, MCP** (`a5:b-ext`, `a5:b-ext-compat`; `core/src/config/discovery.ts`,
`config/plugin/{skill,compatibility,mcp}.ts`, `cli/src/server-process.ts`):

- `OPENCODE_CONFIG_DIR` **replaces** the global config directory (`Global.layerWith({config})`); it is not added beside
  it. A skill under `$XDG_CONFIG_HOME/opencode/skills` was not loaded while `OPENCODE_CONFIG_DIR` pointed elsewhere.
  Other inputs: `OPENCODE_CONFIG` (file), `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DISABLE_PROJECT_CONFIG` (or
  `OPENCODE_CONFIG_PROJECT_DISABLE`), a system directory (`/Library/Application Support/opencode`, `/etc/opencode`,
  `%ProgramData%\opencode`) and, on macOS, the MDM plist `ai.opencode.managed`. `OPENCODE_TEST_HOME` replaces the home
  directory used for `~` and the `.claude`/`.agents` roots.
- Skill roots: `<each config directory>/skill` and `/skills`, `.opencode/skills` walking up from the location, `skills: [...]`
  entries in config (paths, `~/`, or http(s) URLs), and `~/.agents/skills` plus project `.agents/skills`. `~/.claude/skills`
  and project `.claude/skills` load unless `OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` is
  set; probed both ways. Built-ins `opencode`, `report` and `browser` are always present. **Skills load
  asynchronously**: `GET /api/skill` right after readiness listed only two built-ins; the full list came after one
  `skill.updated`. A census must wait for that event. Skills reach the model through the single `skill {id}` tool.
- MCP: the 2.x key is `mcp.servers.<name> = {type: "local", command: [...]}` (or `remote`). The 1.x shape
  `mcp.<name> = {type, command, enabled}` is normalized to `mcp.servers.<name>` with `disabled: false`. **`/api/mcp`
  does connect**: the stdio server saw `initialize` (protocol `2025-11-25`, client `opencode 2.2.5`),
  `notifications/initialized`, `tools/list`, `resources/list`, `resources/templates/list`; status went `connected`
  (with the server's `title`), `POST /api/experimental/mcp/{name}/disconnect` → 204 and `disabled`, `/connect` → 204
  and a fresh `initialize`. `GET /api/mcp/resource` lists `{server, name, uri}`. Events `mcp.status.changed {server}`
  and `mcp.resources.changed {server}`, both carrying `location`. MCP tools are **not** offered to the model as direct
  tools: they sit behind the Code Mode `execute` tool (`core/src/codemode/tool.ts`; per-server `codemode` config).
  The CLI agrees over `--server`: `mcp list` printed `✓ probe connected`, `plugin list` "No plugins found", `models`
  `test/test-model`. `debug paths` has no `--server` flag (exit 1 "Unrecognized flag").
- `GET /api/command` lists built-in commands `init`, `review`, `goal`.

**(v) Credentials for profiles** (`a5:b-auth`; `cli/src/commands/handlers/auth/*`, `schema/src/credential*.ts`,
`core/src/database/migration.ts`):

- Credentials live in the data root's database (`credential` table: `id, integration_id, label, value, connector_id,
  method_id, active, time_created, time_updated`). **`value` is plain JSON and holds the key in the clear**, and
  `GET /api/credential` returns it too (`{id: "cred_…", integrationID, label, active, value: {type: "key", key}}`).
  `value.type` is `key`, `oauth` or `external`.
- `POST /api/credential {integrationID, label?, value, activate?}`: the newest credential became active even without
  `activate` (probed: B created after A with `activate: true` ended active). Events `credential.updated {}` and
  `credential.switched {integrationID, credentialID}`; `integration.updated` follows. The provider then received a
  Bearer token.
- `auth list --format json` lists integrations with `connections: [{type: "credential", id, label, method}]` and no
  secrets; without a password it exits 1 ("Server at … requires a password; set OPENCODE_PASSWORD"). `auth export`
  prints every credential **with its secret** as a JSON array (the help says so). `auth import <file>` (or stdin)
  creates them by id, keeps the destination's active choice for integrations it already has, and is idempotent
  (second run: "Imported 0 credentials, skipped 2 already present"). `auth switch <integration> <label|id>` activates
  one. All of these need `--server`.
- **A legacy `auth.json` is not imported into a fresh 2.x home.** `migration.ts` bootstraps an empty database from the
  schema snapshot and marks every migration complete, so `20260805200742_import_legacy_credentials` only runs when
  2.x opens an existing 1.x store (§2.2). Probed: `auth.json` with `{test: {type: "api", key}}` beside a fresh database
  → empty credential list, first turn sent no `Authorization`, and `auth.json` was left in place.
- Consequence for profiles: a 2.x profile's secret store is the data root's `opencode.db` (or `OPENCODE_DB`). Profile
  copy/move is `auth export | auth import` against a running private server; the export stream is a secret and must
  never be logged or persisted by Puppeteer.

**(vi) Distribution and autoupdate** (`install` and `cli/src/services/updater*.ts` at the tag, the tap formula, and the
update API, metadata only):

- `https://opencode.ai/v2/install` reads `https://opencode.ai/update/api/latest/cli/npm` (`{version: "2.2.5",
  metadata: {package: "@opencode/cli"}, minimum: false, …}`), picks `@opencode/cli-<os>-<arch>[-baseline][-musl]`
  (baseline from CPU flags, musl from `ldd`), and falls back to `@opencode-ai/cli-<target>` for a requested version the
  new scope lacks. It installs `$HOME/.opencode/bin/opencode` plus an `opencode2` shim (`opencode2.cmd` on Windows) and
  edits shell rc files to add the directory to `PATH`.
- Homebrew: `anomalyco/tap/opencode-v2` (formula `opencode-v2.rb`, 2.2.5 on 2026-10-30) downloads
  `https://opencode.ai/files/bin/<version>/opencode-<platform>.zip|tar.gz`, not npm, uses the `-baseline` build on x64,
  `depends_on "ripgrep"` and `conflicts_with "opencode"`. The update API's `homebrew` distribution names it.
- `opencode upgrade [target] [--method curl|npm|pnpm|bun|yarn|vp|brew|winget]`; WinGet id `Anomaly.OpenCode`. The
  method is inferred from the executable path (npm package manifest, `Cellar/opencode|opencode-beta|opencode-v2`, WinGet
  package directory).
- The update policy is read only from `config.json`, `opencode.json`, `opencode.jsonc` in the global config directory
  (so `$OPENCODE_CONFIG_DIR`), not from `OPENCODE_CONFIG_CONTENT`: `update: disable|notify|auto`, or the 1.x
  `autoupdate: false|"notify"|true`. **The default is `notify`.** `OPENCODE_DISABLE_AUTOUPDATE=1|true` skips the check
  entirely. The TUI (`default.ts`) runs the check at start and every 10 minutes, with or without `--server`; under
  `auto` it installs any differing release, with no major-version gate. Puppeteer launches must keep
  `OPENCODE_DISABLE_AUTOUPDATE=1`, and a managed profile should write `update: "disable"` into its config directory.

**(vii) Windows executable name: `bin/opencode.exe`** in `@opencode/cli-windows-x64`, `-x64-baseline` and `-arm64`
2.2.5 (unpkg file listings; 259,169,160 / 259,169,160 / 239,739,784 bytes). The installer renames nothing
(`opencode.exe`) and adds `opencode2.cmd`.

**CLI parser** (`draft/opencode-2/invocation-grammar.json`; effect/cli 4.0.6 source, the catalog pin, and offline
`debug paths`/`--version` probes): `--flag=value`, `-f=value`, short clusters, booleans with an inline value or a
following `true|false|yes|no|on|off|1|0`, `--no-<flag>` negation, `--` ends options, and a value flag never consumes an
option-like token. `--help`, `--version` and `--completions` are extracted before parsing, so `--bogus --version` and
`--session --version` both print the version and exit 0. An unknown flag is exit 1 with `Unrecognized flag`. Hidden
root and `run` flags: `--yolo`, `--dangerously-skip-permissions`; hidden `mini --demo`. The first `debug paths` on a
fresh home did not finish within 20 s and was killed; repeats returned at once. Not investigated.

## 3. Decision: who owns 2.x

**Ruled 2026-11-04 by the owner: option (a), a second release line of `opencode`.** The adapter, persona, canonical
file, map and ledger move to 2.x together in one switch, and 1.x support ends at the 2.x promotion. The analysis below
is kept as the record of what the ruling accepts. Its cost list, including the §2.2 shared-store migration and the
refusal of 1.x installs after promotion, is now a set of explicit tasks in §4 B, not a reason to reopen the decision.

Before the ruling the owner had not decided. Nothing in the repository may presuppose the answer: no `vendors/opencode-v2`, no
`opencode@2.*` model folder, no ledger row or `candidateVersion`, no adapter package. Repo rules that shape the options:
a manifest's vendor must equal its folder; model folders are `<vendor>@<version>`; Imposter's `loadModel` reads only
the vendor's `groundtruth.json`; `upstream.json` resolves one authoritative stable detector
(`detect-upstream-agents.mjs`) and one acquisition template per platform;
the ledger has one row per id and no release-line notion; and a `groundtruth-map.json` digest-locks one surface per
adapter.

### Option (a): a second release line of `opencode`

- **Layout.** `vendors/opencode/{model,captures,probes,references}/opencode@2.2.x` beside `@1.19.5`, a v2 harness, and
  a line switch in the generator. `groundtruth.json` stays on 1.19.5 until promotion, then flips.
- **Ledger.** The same row may carry `candidateVersion: 2.x` while 1.19.5 stays verified; promotion replaces
  `currentVersion` and the receipt. Nothing can say 1.x is still supported.
- **`upstream.json`.** Keep `^v(\d+\.\d+\.\d+)$`; acquisition switches to `@opencode/cli-<platform>` in the 2.x lane
  (switching early breaks re-acquiring 1.x).
- **Persona and adapter.** The 2.x persona cannot land on main before promotion (it validates against the canonical
  file). `packages/adapter-opencode` is rewritten in place. Adapter, persona, canonical file, map and ledger switch in
  **one PR**, developed on a long-lived branch while 2.x ships roughly weekly.
- **Cost to 1.x users.** Support ends at promotion. 1.x is still the default installer and the GitHub Latest release,
  and version detection would refuse it, so most current installs drop out. Saved continuations and the resume picker
  survive only for sessions written before the user's first 2.x launch (§2.2). A Puppeteer-run 2.x backend migrates a
  profile's store under a user who still runs 1.x. The distribution upgrade recipe becomes `upgrade --major` or the v2
  installer.
- **Benefit.** One OpenCode entry, one adapter, one census, one promotion lane; matches "one agent, one runtime
  authority" once 1.x is gone.

### Option (b): a separate vendor id (name is the owner's call; `opencode-v2` below is a placeholder)

- **Layout.** `vendors/opencode-v2/` with its own `upstream.json`, census, `model/opencode-v2@2.2.5` and
  `groundtruth.json`, importing shared harness pieces from `../opencode/census` or an extracted module.
- **Ledger.** A second row (`@vibefield/puppeteer-adapter-opencode-v2`, persona `opencode-v2`), `baseline-pending` with
  blockers until promoted. The 1.x row is untouched; no schema change.
- **`upstream.json`.** Narrow 1.x to `^v(1\.\d+\.\d+)$` (the §1 objection disappears because 2.x is tracked
  elsewhere); the new vendor uses `^v(2\.\d+\.\d+)$` or the npm `@opencode/cli` latest with `@opencode/cli-*`
  acquisition.
- **Persona.** `personas/opencode-v2`. The `opencode` shim name collides (the last persona wins), so use a distinct shim
  or `AI_PERSONA`. The Imposter HTTP engine must serve both envelopes.
- **Adapter.** New `packages/adapter-opencode-v2`, depending on `adapter-opencode` for loopback fetch, the SSE decoder,
  the backend lifecycle, the prompt gate and the distribution/profile helpers (as `adapter-grok` depends on
  `adapter-acp`). Registration: `scripts/check-package-layout.mjs`, `public-packages.mjs`,
  `check-adapter-groundtruth-maps.mjs`, `release-please-config.json`, builtin-providers (`ProviderId`, descriptor,
  services), imposter-control, the views service marks, and the `agent-*` workflows.
- **Cost.** No functional cost to 1.x users. Instead: both lines install the same `opencode` command, so each provider
  must refuse the other's binary by version string; users see two OpenCode entries, one "not installed"; both bind the
  same `opencode.db`, so profile roots must be per line or guarded against the one-shot migration (§2.2); maintenance
  doubles (two adapters, censuses and promotion lanes, against 44 numbered 2.x releases in seven weeks, 2.0.0 on 09-11
  to 2.2.5 on 10-30). When upstream ends 1.x,
  the `opencode` row becomes `deprecated` (the schema supports it) and the placeholder name outlives its reason.

### Pre-ruling recommendation (not adopted): (b), with a planned exit to a single row

1. 1.x is verified today and is what `/install`, Homebrew `opencode` and GitHub Latest install. Option (a) would refuse
   most current installs at the moment of promotion; (b) costs 1.x users nothing.
2. (a) forces a big-bang single PR (adapter + persona + canonical file + map + ledger) built on a branch that must chase
   a weekly-shipping upstream. (b) lets 2.x land incrementally on main as `baseline-pending` with blockers, through the
   normal Stage 1–6 gates.
3. The shared-store hazard (§2.2) exists under both options; (b) is the one that can keep a 1.x home working while it
   is still the default install.
4. (b)'s main costs (registration, a second lane) are one-time and mechanical, and the reuse prepared in §4 A2–A4 keeps the
   duplicated surface to roughly 1k lines.

Pick a neutral id rather than one that hard-codes "v2" if the row is meant to outlive 1.x, and record an exit rule now:
when upstream marks 2.x Latest or `/install` switches to 2, mark `opencode` `deprecated` and stop its promotion lane.
Choose (a) instead if the owner expects 1.x to be retired upstream before a 2.x adapter could be promoted anyway
(weeks, not months); then the second row is pure overhead.

## 4. Work breakdown

Ordered. Part A is decision-independent and can start now; each item must leave the 1.x lane green and must not create
a vendor directory, model folder, ledger entry or adapter package for 2.x. Part B starts after the decision.

### A. Before the decision

1. **1.x guards both options need.** In `packages/adapter-opencode`: refuse a binary whose `--version` matches
   `^opencode v2\.` with a typed result, not a crash; never pass `--major` to `upgrade`; detect a store that 2.x has
   opened (`kv` `migration.v1-v2`, or `session_v2` present) and surface it as a qualified profile warning (sessions
   created by 1.x after that point are invisible to 2.x). Scrub `OPENCODE_PASSWORD` as well as
   `OPENCODE_SERVER_PASSWORD` from 1.x launch environments that Puppeteer does not own.
2. **Parameterize reusable transport in `adapter-opencode`, behavior-preserving for 1.x.** `transport/event-stream.ts`:
   envelope key (`properties` vs `data`), object-or-string `data`, path, repeated `types` filter, and an optional
   per-aggregate `seq` gap hook that triggers REST rehydration. `launch/backend.ts`: readiness prefix and flag set as
   inputs. These are reused under (a) in place and under (b) as a dependency.
3. **Imposter HTTP engine made data-driven.** Move the envelope key, the readiness template, the auth realm, and
   `--server` attach emulation into `http-serve.json`; keep the 1.x persona byte-for-byte green
   (`conformance.opencode`, `opencode-mode`, `scenarios.opencode`). About 200 lines of the session state store become
   envelope-neutral.
4. **Surface shared tooling.** Add a decode-before-redact hook to `@vibefield/puppeteer-surface/sanitize` (type-
   preserving for encoded `data`); teach the generator's HTTP half OpenAPI 3.1; add generic support for an
   `exact-source` event contract (the 2.x events are not in the OpenAPI). Extract the vendor-neutral parts of
   `vendors/opencode/census/harness.mjs` (utilities, isolated env, fake provider, fetch; about 450 lines) into a module
   the 1.x harness imports unchanged.
5. **Remaining 2.x probes, in scratch, recorded here (done 2026-11-04; results in §2.5).** (i) Does the loopback fake provider work through 2.x config and
   environment handling — this gates every model-backed scenario; (ii) the prompt echo event; (iii) `?directory=`
   scoping on `/api/*`; (iv) the 2.x config/plugin/skill/MCP loaders from source, and whether `/api/mcp` connects to
   servers; (v) `auth export/import`/`switch` and the `credential` table for profiles; (vi) the `v2/install`,
   Homebrew `opencode-v2` and 2.x autoupdate rules for distribution; (vii) the Windows executable name. Keep binaries
   only in scratch with sha256 recorded, isolated homes, `--server` always, autoupdate off.
6. **Draft the 2.x invocation grammar and event contract as data under `draft/`**, from the help tree and
   `packages/protocol`/`packages/schema` at the exact tag, so either option's census can consume them. **Done
   2026-11-04:** `draft/opencode-2/invocation-grammar.json` (the 48 parsed help pages, parser traits, the offline
   parser probes, hidden flags from `commands.ts`, and a proposed `NativeInvocationGrammar` for the TUI root) and
   `draft/opencode-2/event-contract.json` (transport and envelope rules, then 107 current event types from every
   `Event.durable`/`Event.ephemeral` call in `packages/schema/src`: durability, durable version and aggregate
   (`sessionID` or `projectID`), data fields, whether the type is on the public stream (96 plus `server.connected`),
   and the keys seen in 267 probe frames for 41 types; the 14 `v1/` legacy definitions are listed apart). The upstream
   source was read as text, not executed, so field schemas are source expressions and spreads from other files stay
   unresolved. HTTP operations stay with `/openapi.json` (A4's OpenAPI 3.1 projection).

### B. After the decision

7. **Layout.** (a): `vendors/opencode/*/opencode@2.2.x` and a generator line switch. (b): `vendors/opencode-<id>/`, a
   `baseline-pending` ledger row with blockers, and the 1.x tag pattern narrowed to `^v(1\.`.
8. **`upstream.json`.** Detector `github-release` with a version-aware pattern (or the update API once the schema allows
   it); acquisition `https://registry.npmjs.org/@opencode/cli-<platform>/-/cli-<platform>-${version}.tgz`,
   `executableBasenames: ["opencode"]` (Windows `opencode.exe`, confirmed from the package listings, §2.5 vii),
   `maxBytes` above the 118 MB linux-x64 tarball. `pnpm upstream:check`.
9. **Census** (v2 harness on the shared module from A4). Private `serve --hostname 127.0.0.1 --port 0`, password through
   `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`, isolated XDG/OPENCODE dirs, fake provider. Subscribe to
   `/api/event` before creating the session. Scenarios: turn, lifecycle/fork/archive/delete, file write/edit/delete,
   task/subtask/background, permission once/always/reject (via `session.permission.create` and a session `ask`
   ruleset), form reply/cancel/invalid/settled, interrupt during stream and tool, retry, provider error, reconnect with
   a seq gap, backend restart with exact resume, manual/auto/overflow compaction, unknown context, a 1.x-store
   migration case (§2.2), and the TUI on `--server` in a PTY with a check that port 49374 and `service status` stay
   quiet.
10. **Sanitizer/privacy** for the vendor: new id keys (`aggregateID`, `frm_`, inbox ids, `psv_`), `location.directory`,
    `created` clocks, using the A4 hook.
11. **ASM generation** from `/openapi.json` (HTTP) plus the exact-source event contract; record the limitation.
12. **Adapter.** Rewrite `transport/client.ts` (`/api/*`, per-session permissions, forms, interrupt, compact, no console
    orgs), the `launch/` invocation (`opencode --server <origin> --session <id> <cwd>`, never the background service;
    check the session exists before `-s` because it creates missing ones; continuation state v3 recording the line),
    `detection.ts` (`^opencode v(\d+\.\d+\.\d+)$`), and every `normalization/` category onto
    `session.execution/step/text/reasoning/tool/usage/inbox`, `permission.*` (`decision` in, `reply` out) and `form.*`
    (mapped to Core `interaction:question-*` only where the form is a question). History becomes REST rehydration on a
    seq gap. Profiles, extensions, models and distribution follow the A5 findings. New `groundtruth-map.json` and tests.
    (a) rewrites `adapter-opencode` in place; (b) builds the new package on the A2 pieces and registers it everywhere
    listed in §3.
13. **Imposter persona** for 2.x on the A3 engine. (b): distinct shim name.
14. **Gates.** `docs/guides/adapting-an-agent.md` Stage 1–6, then the four-platform protected lane. (a): the switch PR
    carries adapter, persona, canonical file, map and ledger together. (b): promote the new row; apply the exit rule
    from §3 when its trigger fires.

## 5. Open questions

- How long does upstream keep shipping 1.x? No release, snapshot or `v1` commit since 2026-10-28 while 2.x shipped five
  patches and daily snapshots; no EOL notice. This sets the timing of the §3 exit rule and weighs on (a) vs (b).
- ~~Can the census's fake provider drive 2.x model turns (A5 i)?~~ Yes, in both config shapes (§2.5 i). Still open for
  the census: the 2.x tool input schemas for every scripted tool call, and answering the title-generation request.
- Code Mode puts MCP tools behind `execute`. How a tool call made inside `execute` appears on the event stream
  (`session.tool.progress` rows? nested ids?) is unprobed and decides how the adapter reports MCP tool activity.
- Where should a managed 2.x profile keep secrets? The `credential` table stores keys in the clear in `opencode.db`,
  `GET /api/credential` and `auth export` return them, and a fresh home ignores `auth.json` (§2.5 v). The profile
  design must treat the whole data root as secret and never route `auth export` output through logs.
- `OPENCODE_CONFIG_DIR` replaces the user's global config directory in 2.x (§2.5 iv). A 1.x-style isolated config
  dir therefore also drops the user's own skills and MCP servers; decide whether profiles point it at the profile root
  or leave it unset and rely on `OPENCODE_CONFIG_CONTENT`.
- The first `debug paths` on a fresh home hung for over 20 s once (§2.5 parser note). Check whether first-launch
  initialization also delays `serve` readiness before the census sets its timeouts.
- `opencode-ai@1.x` clients run `opencode upgrade --major` to move to 2. A Puppeteer-managed 1.x binary must not
  self-upgrade. 1.19.0 made autoupdate notify-only ("Updates are never installed automatically"; upstream
  `v1.19.0` `packages/opencode/src/cli/upgrade.ts`, recorded in the Surface findings §0.7), and the census keeps
  `OPENCODE_DISABLE_AUTOUPDATE=1`.

Answered by the 2026-11-04 probe (still to be re-captured as Surface evidence): 2.x reads the 1.x store in place and
migrates it once (§2.2); `durable.seq` is not a replay cursor and the CLI log route does not replay (§2.3); `--server`
keeps the TUI and CLI off the background service (§2.4). Answered by the A5 probes (same caveat, §2.5): the fake
provider works through 2.x config; the prompt echo is `session.inbox.enqueued`; scoping is `location[directory]` or
`x-opencode-directory`; `/api/mcp` connects servers; credentials are database rows with an export/import pair;
autoupdate defaults to `notify` and `OPENCODE_DISABLE_AUTOUPDATE` still disables it; the Windows binary is
`opencode.exe`.
