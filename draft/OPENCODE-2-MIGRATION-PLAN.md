# OpenCode 2 Migration Plan

Status: **Unstarted.** Recorded 2026-11-03 while advancing the 1.x candidate to 1.19.5.
Current candidate: OpenCode **1.19.5** (`support/agents.json`, `baseline-pending`).
Target line: OpenCode **2.x** (`@opencode/cli`, latest 2.2.5).

This note says why the candidate stayed on 1.x, what OpenCode 2 changes, and the work a 2.x adaptation needs. None of the
2.x facts below are Surface evidence. They come from one read-only linux-x64 probe and from upstream source. A 2.x
adaptation must capture them again through the governed census.

## 1. Two maintained release lines

| Signal | OpenCode 1.x | OpenCode 2.x |
| --- | --- | --- |
| npm package | `opencode-ai` (`latest` 1.19.5, 2026-10-28) | `@opencode/cli` (`latest` 2.2.5, 2026-10-30) |
| platform packages | `opencode-<platform>` | `@opencode/cli-<platform>` (12 targets, including `-musl` and `-baseline`) |
| source line | branch `v1` (head `006d837`), tag `v1.19.5` = `810c0eb` | branch `dev` / `production`, tag `v2.2.5` = `9bbb8ce` |
| first release | n/a | `v2.0.0`, 2026-09-11. The two lines ship in parallel. |
| GitHub release | `gh release edit --latest` (`script/publish.ts`) | `gh release create --latest=false`, then `edit --draft=false --latest=false` (`.github/release/publish-github-release.sh`). Not a prerelease. |
| GitHub "Latest" | `releases/latest/download/opencode-linux-x64.tar.gz` resolves to the v1.19.5 asset | never marked Latest |
| default installer | `https://opencode.ai/install` redirects to `refs/heads/v1/install`, which "only installs OpenCode 1" and refuses 2.x | `https://opencode.ai/v2/install`, reading `https://opencode.ai/update/api/latest/cli/npm` (2.2.5, `@opencode/cli`) |
| upgrade path | `opencode upgrade --major` moves a 1.x install to 2 | n/a |
| docs and packages | `/docs`, Homebrew `anomalyco/tap/opencode`, AUR `opencode-bin` | `/v2/docs`, Homebrew `anomalyco/tap/opencode-v2`, AUR `opencode-beta` |

Upstream treats both lines as stable. 1.x is the default install and the GitHub Latest release. 2.x is an opt-in major
that moves fast: 46 numbered releases between 2026-09-11 and 2026-10-30.

**Detector consequence.** `upstream.json`'s `github-stable` detector takes the first non-draft, non-prerelease tag
that matches `^v(\d+\.\d+\.\d+)$` in API order. v2 releases are non-prerelease and are created after the matching v1
releases, so the detector can report a 2.x version. The 1.x acquisition URLs (`opencode-<platform>@2.x`) then 404.
Detection stays as it is on purpose, so the 2.x line keeps showing as upstream activity. The ledger blocker and this plan
are how reviewers see it. Narrowing the tag pattern to `v1.` would hide a real upstream change.

## 2. Why 2.x is a new integration family

Probe: `@opencode/cli-linux-x64@2.2.5` (tarball sha256 `92690eee07a680d3cb760ca02ba43878de9eab1b4e5d5dfae8795518c53628f4`,
`bin/opencode` sha256 `8d060e1d2fbb9bb44cf09ae6ed1f3f6a7cff070b5227e2f90970132b23a92050`). It ran in an empty
isolated home with an environment-only server password. No model or account was used.

| Puppeteer dependency (1.x, verified) | 2.2.5 observation |
| --- | --- |
| `opencode --version` prints bare `1.19.5` | prints `opencode v2.2.5`. `OPENCODE_VERSION_PATTERN` and `detection.json` must change. |
| `opencode serve` = instance REST + SSE | `serve` = "Start the v2 API and web server", with flags `--hostname --port --cors --service --stdio`. Startup prints `server listening on http://…`, without the `opencode ` prefix the 1.x harness matches. |
| `opencode attach <url> --dir --session --pure` | no `attach` command. The root TUI takes `--server <url>`, `--standalone`, `--session/-s` (which creates the session if it is missing), `--continue`, `--prompt`, and `--auto`. By default it connects to a shared **background service** (`opencode service …`) that Puppeteer must not use. |
| Basic auth from `OPENCODE_SERVER_PASSWORD` | still accepted: `/openapi.json` returned 401 without credentials and 200 with `opencode:<password>`. Unauthenticated paths serve the web app. |
| `GET /doc` OpenAPI (188 operations) | `GET /openapi.json`, titled "opencode HttpApi … Experimental HttpApi surface". It has 138 paths, all under `/api/*` apart from `/auth/connect/{code}`. sha256 `f5c4571bf7e9afc22a440875a746f593f988c4c31bf824f602601c04b20e6c8e`. |
| `GET /event` `{id,type,properties}` | `GET /api/event` (`event.subscribe`, an optional `types` filter over 96 names). Records are `{id, created, type, location, data, durable:{aggregateID, seq, version}}`. The OpenAPI types `data` only as an encoded JSON string (`V2EventEncoded`). Heartbeats are SSE comments. |
| `POST /session/:id/prompt_async` with a caller `messageID` | `POST /api/session/{id}/prompt` with optional `id`, `text`, `files`, `agents`, `skills`, `metadata`, and `delivery` |
| `message.updated` / `message.part.updated` / `message.part.delta` | replaced by `session.execution.*`, `session.step.*`, `session.text.*`, `session.reasoning.*`, `session.tool.{input.*,called,progress,success,failed}`, `session.compaction.*`, `session.retry.scheduled`, `session.usage.updated`, and `session.inbox.*` |
| `permission.asked/replied`, `POST /permission/:id/reply {reply}` | `permission.asked/replied` remain. The reply is `POST /api/session/{id}/permission/{requestID}/reply {decision: once\|always\|reject, message?}`. |
| `question.*`, `POST /question/:id/reply\|reject` | no question routes. `form.created/replied/cancelled` and `/api/session/{id}/form/{formID}/reply {answer}` take their place. |
| `POST /session/:id/abort` | `POST /api/session/{id}/interrupt`, plus a `session.execution.interrupted` event |
| `POST /session/:id/summarize` | `POST /api/session/{id}/compact` |
| no SSE replay cursor | each durable event carries `aggregateID`/`seq`. Whether `/api/event` can resume from a cursor is **unproven**. |
| `@agentclientprotocol/sdk` | the CLI depends on `@agentclientprotocol/sdk` 1.6.0, and `opencode acp` remains |
| v1 data | `GET /api/experimental/migration/v1` exists. Whether 2.x reads 1.x session storage in place is unproven. |

Nearly every semantic rail the adapter normalizes changes name, envelope, route, or correlation key. Only Basic auth and
the idea of a loopback server stay. Adapting to 2.x therefore means a new Surface census, ASM, persona, and adapter
normalization, not a version bump.

## 3. Migration work

1. **Ownership decision.** Pick one of two shapes: (a) a second release line of the same `opencode` vendor, which
   replaces the canonical ground truth once 2.x is promoted, or (b) a separate vendor id while 1.x stays supported.
   One agent has one runtime authority. Option (a) means the adapter and the ledger move to 2.x together, and 1.x
   support ends at that promotion. Decide this first, because it sets the `upstream.json`, ledger, and persona layout.
2. **`upstream.json`.** Use the detector `kind: github-release` with a version-aware tag pattern, or the update API
   once the schema allows it. Acquire from
   `https://registry.npmjs.org/@opencode/cli-<platform>/-/cli-<platform>-${version}.tgz` with
   `executableBasenames: ["opencode"]` (Windows: `opencode.exe`, unverified). Keep `maxBytes` above the 118 MB linux-x64
   tarball. Run `pnpm upstream:check`.
3. **Census harness** (`census/harness.mjs` v2 variant). Use private `serve --hostname 127.0.0.1 --port 0` with an
   environment password and isolated XDG/OPENCODE dirs, and the fake OpenAI-compatible provider. Subscribe to
   `/api/event` before creating the session. Capture the 1.x scenario set again against the new routes: turn,
   lifecycle/fork/archive/delete, file write/edit/delete, task/subtask/background, permission once/always/reject, form
   reply/cancel, interrupt during stream and tool, retry, provider error, reconnect, backend restart with exact
   resume, manual/auto/overflow compaction, and unknown context. Add a cursor-resume probe for `durable.seq`. Use
   `opencode --server <url> --session <id>` in a PTY for the interactive lanes. Confirm the TUI never starts or joins
   the background service: `--server` must be explicit, and `opencode service status` must stay empty in the isolated
   home.
4. **Sanitizer/privacy.** v2 IDs, `location.directory`, `created` clocks, and `durable.aggregateID`. The encoded `data`
   string must be decoded before redaction so the type-preserving guarantee holds.
5. **ASM generator.** OpenAPI 3.1 from `/openapi.json`. The event schemas are not in the OpenAPI (they are an encoded
   string), so take them from `packages/protocol`/`packages/schema` source at the exact tag as an `exact-source`
   contract. Record that limitation.
6. **Adapter.** Build a new `transport/` client (`/api/*`, `/api/event` framing, durable seq) and `launch/` (`serve`
   without `--pure`, which does not exist in 2.x; TUI via `--server`/`--session` instead of `attach`, and version
   parsing for `opencode vX.Y.Z`). Rewrite every category in `normalization/` (execution/step/text/tool/form/inbox).
   Map `form.*` to Core `interaction:question-*` only where the native form is a question. The services for prompt
   (deterministic `id`), approvals (`decision`), interrupt, compact, and history move to the new routes. The
   invocation grammar needs a new 2.x help fixture: the 2.x command set differs (`mini`, `pair`, `service`, `api`,
   `reload`, and no `attach/web/github/pr/import/export` at the root).
7. **Imposter.** A new `http-serve.json`, ops, and scenarios for the v2 routes and envelope, plus `--server` attach
   emulation.
8. **Profiles and extensions.** 2.x moves credentials to `/api/credential` and integrations, with `auth export/import`
   and `switch`. The 1.x SQLite readers in `services/profiles.ts` and the plugin/skill loaders in
   `services/extensions.ts` must be read again from the 2.x source.
9. **Gates.** Run the full `docs/guides/adapting-an-agent.md` Stage 1–6 matrix, then the four-platform protected lane.

## 4. Open questions

- How long does upstream keep shipping 1.x? The `v1` branch and 1.19.5 (two days before 2.2.5) say it is maintained
  today. No end-of-life notice was found.
- Does 2.x read 1.x session storage in place, or only through `experimental.migration.v1`? This decides whether
  Puppeteer resume survives a user's 1→2 upgrade.
- Is `durable.seq` a replay cursor for `/api/event`? If it is, the reconnect rule ("no replay; rehydrate over REST")
  changes.
- `opencode-ai@1.x` clients run `opencode upgrade --major` to move to 2. A Puppeteer-managed 1.x binary must not
  self-upgrade. 1.19.0 made autoupdate notify-only ("Updates are never installed automatically"; upstream
  `v1.19.0` `packages/opencode/src/cli/upgrade.ts`, recorded in the Surface findings §0.7), and the census keeps
  `OPENCODE_DISABLE_AUTOUPDATE=1`.
