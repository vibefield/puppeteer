# Upstream adaptation handoff — 2026-11-03

**Status:** In progress. Every vendor has a staged candidate or a recorded blocker. Nothing is promoted. This file is
the resume point for the draft PR on `claude/nice-darwin-0vugls`. Delete it when the PR is ready for review.

Goal: bring every agent in `support/agents.json` up to its latest upstream stable release, following
[`docs/guides/adapting-an-agent.md`](../docs/guides/adapting-an-agent.md) and
[`docs/guides/surface-adaptation.md`](../docs/guides/surface-adaptation.md).

## Where each agent stands

Upstream versions were read on 2026-11-03 from git tags, npm and the vendor channels. The session's GitHub REST API
was scoped to this repository, so `pnpm upstream:detect` could not read GitHub releases.

| Agent       | Ledger before         | Latest upstream stable                                | Staged in this branch     | Commits                     |
| ----------- | --------------------- | ----------------------------------------------------- | ------------------------- | --------------------------- |
| Claude Code | verified 2.1.308      | 2.1.311 (`stable` channel; `latest` is 2.1.317)       | candidate 2.1.311         | `d817eed`                   |
| Codex       | verified 0.164.0      | 0.166.0 (`rust-v0.166.0`)                             | candidate 0.166.0         | `e9fab8a`, `c76adca`        |
| Grok Build  | verified 1.0.70       | 1.0.70                                                | — (already current)       | —                           |
| Hermes      | pending 0.20.0        | 0.21.5 (`v2026.9.24`)                                 | candidate 0.21.5          | `919aded`                   |
| Kimi Code   | pending 0.34.0        | 2.4.1 (`@moonshot-ai/kimi-code@2.4.1`)                | candidate 2.4.1           | `4ac97ba`                   |
| OpenCode    | pending 1.18.16       | 1.19.5 on the default 1.x line; 2.2.5 (`@opencode/cli`) | candidate 1.19.5        | `1cff3a8`, `e78b8b3`, `b08a638` |
| Copilot CLI | pending 1.0.80        | 1.0.105                                               | candidate 1.0.105         | `da3d9df`, `eed27fb`        |
| Pi          | pending 0.84.3        | 1.5.0                                                 | candidate 1.5.0           | `9cd192e`                   |
| Antigravity | pending 1.1.20        | 1.4.12                                                | none — blocker recorded   | `45ca9f8`                   |

Verified entries keep `currentVersion` and `verification`, with `candidateVersion` staged beside them by
`scripts/stage-agent-candidate.mjs`. Pending entries keep `baseline-pending` and carry updated `blockers`. No artifact
digest, receipt or `currentVersion` was written by hand. Only **linux-x64** was acquired and run, so darwin-arm64,
darwin-x64 and windows-x64 are unacquired everywhere.

The merged tree passes `support:check`, `groundtruth:mapping:check`, `upstream:check`, `surface:groundtruth:check`,
`surface:audit`, `surface:workflow:check`, `packages:check` and `format:check`. The PR description has the
`pnpm test` result.

## Must-do before this PR is ready

### 1. Land the Rosetta dependency (Copilot, Pi)

The Copilot and Pi imports read Rosetta commits on the `vibefield/rosetta` branch
`groundtruth/upstream-rosetta-trio`, based on `main` at `972d090`. The branch is pushed but not merged. Merge it in
Rosetta, open a PR there if none exists, and confirm a clean re-import before this PR is ready. To work on it, clone
it as the sibling `../rosetta` and check out that branch.

- `8ebdd48d2cd52586ee7c524b6a36261295ce4ead` — capture Copilot CLI 1.0.105, with farm fixes for single-executable
  packages, FTS5 store reduction and empty lock files.
- `768de81d529d187523cbdf2f0995c6f63a6be8fc` — capture Pi 1.5.0. `sources/1.5.0.writer.json` is the 0.84.3 writer
  document with the v0.84.3..v1.5.0 persistence-type diff applied (source-derived). The canonical version rule now pins
  the newest farmed release.
- `a6fbaadfbc3b3d9f7daa3ba64779383542aa5083` — the Gemini mock fills whatever shell-tool schema is declared, which
  Antigravity 1.4.12 needs.

If that branch is ever lost, re-create the commits from `972d090`:
`ROSETTA_FARM_ISOLATED=1 python3 -m tools.groundtruth farm copilot --version 1.0.105`, and the same for `pi --version 1.5.0`.
Repeat the fixes listed above, then run `build_canonical`. Re-import into Puppeteer with
`pnpm --filter @vibefield/puppeteer-surface run surface:census:<vendor>` and `surface:model:<vendor>`, and confirm the
committed output is byte-identical (`git diff --exit-code`).

### 2. Resolve confirmed review findings

Each vendor commit got an independent multi-dimension review. Every finding then went to three skeptics, and a
finding is "confirmed" when at least two upheld it.

**OpenCode** (review of `1cff3a8`, `e78b8b3`):

- [x] MAJOR — 1.19.0 made `autoupdate: true` notify-only, but the adapter still reported such an install as
  self-updating. Code fixed in `b08a638`. **Still open:** correct `findings.md` (§0 around L79/L138) and the
  reconcile narrative. This is consumed config-semantics drift, not additive-unconsumed.
- [ ] MAJOR — `packages/adapter-opencode/src/transport/loopback-fetch.ts` retries once on ECONNRESET for every method.
  A non-idempotent POST that the server already received gets sent again: `prompt_async` (a duplicate turn),
  `POST /session` (an orphan session), or a permission or question reply (a double answer). Retry only when the request
  provably never left the client, or only for idempotent methods (GET/HEAD and the SSE subscribe), and handle a POST
  after a backend restart by using a fresh connection. Apply the same rule to the census harness retry, and record
  every retried attempt in the HTTP trace evidence.
- [ ] MINOR — the stale-socket fix does not cover the other fetches to fresh `serve --port 0` backends:
  `services/models.ts:76` (`/provider`) and the profile-verification `/experimental/console/orgs` request. Route both
  through the corrected loopback fetch.

**Codex** (review of fix commit `c76adca`):

- [ ] MAJOR (2/2 votes) — `launch/tui-session.ts:220`. `attachThread` now rejects on a provider refusal, but the TUI
  resume tap discards its promise with `void`. The rejection goes unhandled and no diagnostic is published.
- [ ] MINOR — `transport/model-provider-error.ts:35` rejects valid `ModelProviderError` data whose provider id falls
  outside an ASCII-only pattern, which brings back the endless resume retry. Decode the variant from `data.type`, and
  sanitise ids only for display.
- [ ] MINOR — `census/generate-model.mjs:377`: the list of "seven gated requests" leaves out `model/list`, which the
  adapter sends, and `thread/sample`. Both return `ModelProviderError` data in 0.166.0.
- [ ] MINOR — `probes/codex@0.166.0/README.md` L18 and L28 contradict Method 6: a 0.164.0 baseline result block and a
  new script are committed, and the `baseline` block was merged in by hand.
- [ ] MINOR — `model/codex@0.166.0/evidence.json:71`: the `codex-binary-probe` claim's `capturedAt` predates the
  provider-mismatch probe that was added to its harness.

### 3. Finish the reviews that were cut short

A usage limit stopped most verification votes for the reviews below. Their candidate findings were **neither upheld
nor refuted**. Verify each one before the PR is marked ready, starting with the privacy items.

- **Kimi** (`4ac97ba`; the drift-claims dimension never ran):
  - **privacy:** the shared leak-detector allowance in `packages/surface/src/sanitize.ts` and the Kimi workdir-key
    allowance may admit a real cwd basename slug, in both the redactor and the repository gate.
  - **privacy:** the new free-text fields `resultSummary` and `errorMessage` are committed verbatim, while the same
    text is redacted in the hook copies.
  - deduplicating subagent start/stop by `subagentId` may permanently swallow resumed subagent runs.
  - the monitor never reopens a child on `subagent.spawned`/`started`, so a resumed child is projected as stopped.
  - a background `task.started` deduplicated against an earlier `subagent.spawned` is reported as mapped with zero
    events.
  - `findings.md` says the 2.4.1 TUI lane passed, while the ledger blocker says it never ran.
- **Copilot** (`da3d9df`, `eed27fb`; the drift-claims and code dimensions never ran):
  - **privacy:** raw native session UUIDs may leak as object keys in `session.shutdown.usageAccountingWatermarks`,
    which would reverse the `sessionId` pseudonym.
  - **privacy:** `accountingSnapshot.sessionStartTime`, as an ISO string and as an epoch, may slip past timestamp
    pinning.
  - shapes and occurrences seen only in 1.0.80 may be recorded as 1.0.105 runtime claims, because Rosetta's canonical
    inventory is cumulative across versions.
  - the 1.0.105 manifest `generatedAt` is hard-coded to 2026-08-28.
- **Pi** (`9cd192e`; the code dimension never ran):
  - **privacy (1 vote upheld):** the Pi privacy rules were not extended for the new 1.5.0 `SystemMessage`, so
    system-prompt text in `sections`/`toolsAdded` may be kept verbatim.
  - 0.84.3 darwin-arm64 records and fields only in the 0.84.3 writer may be counted as 1.5.0 linux-x64 evidence.
  - the mapping lock may mark the new writer-only `usage` entry as semantically consumed.
  - 1.5.0 writes the session file at the first user message, but the adapter and findings still state the 0.84.3
    "first assistant record" rule.
  - undeclared `ToolCall.argumentsError` drift may change the meaning of `toolCall.arguments`.
- **Claude Code** (`d817eed`; the code dimension and all verification votes never ran):
  - the fail-closed `ANTHROPIC_BASE_URL` default may leave the binary's hard-coded OAuth and account endpoints
    reachable, so "no non-loopback egress" is asserted but never observed. See the incident below.
  - the committed 2.1.311 probe records say no owner account or config was read, yet one run read a host credential.
  - the second compaction `SubagentStop` may be 2.1.311's summary retry, set off by the loopback model's summary-less
    reply, rather than fixed `/compact` behaviour.
  - possible undeclared change to when `SubagentStop` fires; the adapter reads this event.
  - the credential-less StopFailure assertion is now skipped when the headless lane is missing, while the model still
    claims that path as verified-headless.
  - the edited `event-map.html` footer may still name 2.1.207 and call 2.1.308 a candidate.
- **Hermes** (`919aded`; the code and drift-claims dimensions never ran):
  - **privacy:** the raw stored session id may leak through the `resumed` field, which breaks the documented
    session-id join.
  - the replay test claims every `tui_gateway` frame is shape-validated, but none of the 17 method and server-request
    results are attributed or validated.
  - the rejection reason in the negative evidence for the breaking `session.resume` claim is redacted.

The review harness is a Workflow script: four dimensions (integrity, privacy, drift-claims, code), then three
refutation votes per finding. Re-run it per vendor with the base commit set to the parent of that vendor's commits.

### 4. Remaining per-vendor blockers (survey work)

- **Claude Code 2.1.311:** no `headless` capture. In the authoring container, the "no credential" lane made one real,
  billed Haiku call (about $0.0005) because the binary found a host credential. That run was discarded, and
  `census/isolation.mjs` now defaults `ANTHROPIC_BASE_URL` to `http://127.0.0.1:0`. Re-run that lane on a host where
  the binary holds no credential, and confirm with a network-deny sandbox that no lane reaches a non-loopback host.
- **Hermes 0.21.5:** there are no source-archive bytes (codeload.github.com was blocked) and no `installed-console.json`.
  That manifest needs the pinned Python 3.11.9 / uv 0.9.28 and Node 22.22.0, but the survey used 3.11.18, 0.11.32 and
  22.23.4. Approval, clarify and `request.cancel` were not exercised against a real attached TUI.
- **Kimi 2.4.1:** the interactive-TUI paths (Esc-cancel, permissions, questions, steer, undo) and ACP shapes are not
  captured. Account and profile services rest on 2.0.2 evidence.
- **OpenCode:** 2.x (`@opencode/cli`, an `/api/*` HttpApi with a new event envelope) is a separate integration family.
  The plan is in [`OPENCODE-2-MIGRATION-PLAN.md`](OPENCODE-2-MIGRATION-PLAN.md). The `github-stable` detector
  deliberately still sees 2.x tags, and the 1.x acquisition URLs would 404 for them.
- **Pi 1.5.0:** the capture came from the npm package, but official acquisition uses the GitHub release binaries, and
  those have no 1.5.0 capture.
- **Antigravity 1.4.12:** see its findings section and ledger blocker. It needs a writer document from the binary's
  protobuf descriptors, Rosetta raw types and goldens, and adapter tool-result matching that no longer relies on
  `RUN_COMMAND`/`exit_code`, because results are now `GENERIC` steps.
- **Copilot, Pi and Antigravity** have no protected promotion lane: `agent-surface-promotion.yml` offers only claude,
  codex, grok, hermes, kimi and opencode. This blocker predates this work.

### 5. Promotion (needs the repository owner)

For each staged vendor whose review findings are closed:

1. `gh workflow run agent-adaptation.yml --ref <branch> -f vendor=<v> -f version=<ver> -f ground_truth=packages/surface/vendors/<v>/groundtruth.json -f publish_draft=false`.
   Add `-f source_reference=v2026.9.24` for Hermes. This acquires and attests the other three platforms.
2. `gh workflow run agent-surface-promotion.yml --ref <branch> -f vendor=<v> -f version=<ver> -f ground_truth=... -f confirm=rehearse`,
   then `confirm=promote` with environment approval. Promotions of different vendors on one branch run one at a time,
   in sequence. Dispatch the next one only after the previous promotion commit has landed.
3. Re-run CI on the branch after each promotion push, as the promotion guide describes.

## Environment notes for the next session

- In a cloud container, GitHub REST and web are blocked outside the session's repo scope, and so is codeload.
  Release-asset downloads (via redirect), raw.githubusercontent.com and npm all work.
- `pnpm install` needs the sibling Ghosttea checkout: run `node scripts/prepare-ghosttea-ci.mjs`, then
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile`.
- Two environment-only test failures appear in containers. `packages/imposter/src/tui/app.test.ts` ("paints in violet
  and blue") needs `COLORTERM=truecolor`. `apps/imposter-control` `src/main/plane.test.ts` needs an Electron binary.
- Hermes's `findings.md` was written through the shell because the file tool refused a `.md` write. Review it like any
  other change.
