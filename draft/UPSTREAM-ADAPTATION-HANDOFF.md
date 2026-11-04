# Upstream adaptation handoff — 2026-11-04

**Status:** Review fixes and the Rosetta dependency landed on their intended branches; capture gaps and promotion remain.
Every vendor has a staged candidate or a recorded blocker.
Every confirmed review finding is fixed. Codex 0.166.0 is now promoted through the protected workflow. This file is the resume point for the draft PR
[vibefield/puppeteer#59](https://github.com/vibefield/puppeteer/pull/59). Delete it when the PR is ready for review.

PR #59's branch, `claude/nice-darwin-0vugls`, now includes the review-completion work through `a4965f2`
and the JSONC parsing fix `a1a59c85`. The continuation branch no longer needs to be moved into the PR.

Goal: bring every agent in `support/agents.json` up to its latest upstream stable release, following
[`docs/guides/adapting-an-agent.md`](../docs/guides/adapting-an-agent.md) and
[`docs/guides/surface-adaptation.md`](../docs/guides/surface-adaptation.md).

## Where each agent stands

Upstream versions were read on 2026-11-03 from git tags, npm and the vendor channels. The session's GitHub REST API
was scoped to this repository, so `pnpm upstream:detect` could not read GitHub releases.

| Agent       | Ledger before    | Latest upstream stable                                  | Staged in this branch   | Adaptation commits              | Review fixes (merge) |
| ----------- | ---------------- | ------------------------------------------------------- | ----------------------- | ------------------------------- | -------------------- |
| Claude Code | verified 2.1.308 | 2.1.311 (`stable` channel; `latest` is 2.1.317)         | verified 2.1.311        | `d817eed`                       | `2b75e0f`, `6e4bdb7` |
| Codex       | verified 0.164.0 | 0.166.0 (`rust-v0.166.0`)                               | verified 0.166.0        | `e9fab8a`, `c76adca`            | `a2bb042`            |
| Grok Build  | verified 1.0.70  | 1.0.70                                                  | — (already current)     | —                               | —                    |
| Hermes      | pending 0.20.0   | 0.21.5 (`v2026.9.24`)                                   | candidate 0.21.5        | `919aded`                       | `3673427`            |
| Kimi Code   | pending 0.34.0   | 2.4.1 (`@moonshot-ai/kimi-code@2.4.1`)                  | candidate 2.4.1         | `4ac97ba`                       | `eb2e28c`            |
| OpenCode    | pending 1.18.16  | 1.19.5 on the default 1.x line; 2.2.5 (`@opencode/cli`) | candidate 1.19.5        | `1cff3a8`, `e78b8b3`, `b08a638` | `611a05d`            |
| Copilot CLI | pending 1.0.80   | 1.0.105                                                 | candidate 1.0.105       | `da3d9df`, `eed27fb`            | `845ce4d`, `cab3aa5` |
| Pi          | pending 0.84.3   | 1.5.0                                                   | candidate 1.5.0         | `9cd192e`                       | `bedd9d5`, `5e4d98f` |
| Antigravity | pending 1.1.20   | 1.4.12                                                  | none — blocker recorded | `45ca9f8`                       | —                    |

Verified entries keep `currentVersion` and `verification`, with `candidateVersion` staged beside them by
`scripts/stage-agent-candidate.mjs`. Pending entries keep `baseline-pending` and carry updated `blockers`. No artifact
digest, receipt or `currentVersion` was written by hand. Codex, Claude, OpenCode, Hermes, Kimi, Copilot and Pi now have acquired artifact identities on all four platforms.
Acquisition alone does not promote support or relabel earlier runtime captures.

The complete `COLORTERM=truecolor pnpm test` run passed on `41da191d`: 191 script tests and every package/app
suite. Surface audits for all nine vendors, generated models, evidence, workflow checks, adapter mappings,
support ledger and formatting also pass. All seven CI checks passed on that commit. The subsequent Hermes fix passed all 205 adapter tests with live mode enabled; its saved-frame regression tests also pass without an installed agent. Five OpenCode assertions with old capture
IDs now use the fresh observed IDs; Kimi's identity assertion selects its exact Linux artifact by ID.

## Completed dependency work and remaining readiness checks

### 1. Rosetta dependency merged; re-import verified

The Copilot and Pi imports read the `vibefield/rosetta` branch `groundtruth/upstream-rosetta-trio`, based on `main` at
`972d090`, in [vibefield/rosetta#39](https://github.com/vibefield/rosetta/pull/39).
That PR is now merged into Rosetta `main` as `4282c44276d070958fbc442ca7a5b7021354aa5e`.
The original evidence commits were:

- `8ebdd48d2cd52586ee7c524b6a36261295ce4ead` — capture Copilot CLI 1.0.105, with farm fixes for single-executable
  packages, FTS5 store reduction and empty lock files.
- `768de81d529d187523cbdf2f0995c6f63a6be8fc` — capture Pi 1.5.0. `sources/1.5.0.writer.json` is the 0.84.3 writer
  document with the v0.84.3..v1.5.0 persistence-type diff applied (source-derived). The canonical version rule now pins
  the newest farmed release.
- `a6fbaadfbc3b3d9f7daa3ba64779383542aa5083` — the Gemini mock fills whatever shell-tool schema is declared, which
  Antigravity 1.4.12 needs.

**Re-import verified on 2026-11-04.** With merged Rosetta `main` at `4282c44276d070958fbc442ca7a5b7021354aa5e`
checked out as the sibling `../rosetta`, `surface:census:copilot`,
`surface:model:copilot`, `surface:census:pi`, `surface:model:pi` and `surface:groundtruth:write` reproduce this
the then-current committed output byte for byte. Pi's primary journals were subsequently replaced by the
artifact-bound official-release census described below; re-importing its old npm fixtures would intentionally
replace that newer runtime evidence. That original import included the Copilot and Pi sanitizer fixes from §2, which change the
import but not Rosetta.

**rosetta#39's two privacy questions, checked against its fixtures:**

- Copilot's raw session UUIDs as `usageAccountingWatermarks` keys. In Rosetta these are random ids the farm generated
  on a disposable VM. Rosetta keeps them unredacted everywhere (session directory names, `sessionId`, and the 1.0.80
  corpus), so the keys add nothing. In Puppeteer they reversed the `sessionId` pseudonym. Fixed on the Puppeteer side
  (§2, Copilot).
- Pi's SystemMessage `sections`/`toolsAdded`. In these fixtures this is Pi's own built-in harness prompt, and the
  only environment values (cwd, install path) are already `<PROJECT>`/`<WORK>`. No user-authored text is present. A
  non-hermetic capture could carry context files, so Puppeteer now redacts these fields (§2, Pi).

The re-import ended with `git diff --exit-code` passing. Before merge, Rosetta's two failing capture-tolerance
tests were fixed to discover their physical fixture paths and exercise every recorded basic-chat version.
The original skipped-source, ledger and streaming-state assertions remain intact. All required checks,
including the complete Rust workspace tests on Linux and macOS, passed in
[Rosetta CI run 41776404902](https://github.com/vibefield/rosetta/actions/runs/41776404902).

### 2. Review findings: all confirmed findings fixed

Each vendor's commits got independent reviewers for the dimensions that had not run: integrity, privacy, drift-claims
and code. Every candidate, whether carried over from the 2026-11-03 review or newly found, then went to three
independent verifiers with different lenses (reproduce, refute, impact). It was confirmed when at least two upheld it.
The fixes were made on per-vendor branches and merged.

- **OpenCode** (`611a05d`). OC-1..3 plus four new findings.
  - The loopback fetch re-sends only GET/HEAD/OPTIONS. Every other method goes out once on its own connection; the
    census harness follows the same rule and traces each retry.
  - `/provider` and `/experimental/console/orgs` now go through it.
  - Auto-update is classified from the version, config, environment and install-method evidence. It reads
    `config.json`, `opencode.json` and `opencode.jsonc` in upstream merge order.
  - All three files accept comments and trailing commas using upstream's JSONC parser. Parse errors never contribute
    a recovered partial document; malformed configs and unresolved `{env:}`/`{file:}` substitutions remain
    `unknown` on 1.18.x. Distribution and extension inventory share this parser. The OpenCode suite has 167
    passing non-live tests.
  - The 1.19.0 boundary is cited from upstream source digests (findings §0.7), and the migration plan's "1.19.5" is
    corrected.
- **Codex** (`a2bb042`). CX-1..5.
  - The TUI resume tap now handles and publishes the provider refusal.
  - Any provider id decodes.
  - The gated-request list now includes `model/list` and `thread/sample`.
  - The probe README is truthful about how the baseline was produced, and the probe has its own `capturedAt`.
- **Kimi** (`eb2e28c`). 11 confirmed.
  - The workdir-slug and free-text leaks are closed.
  - Resumed subagents reopen in delegation and in the monitor.
  - The drift and live-lane claims are corrected.
  - Rejected: KI-D6, KI-D7.
- **Copilot** (`845ce4d`, `cab3aa5`). 13 confirmed.
  - UUID map keys are aliased and the session clocks pinned.
  - The 1.0.105 model is built from 1.0.105 sources only, and the model date comes from the import.
  - New commands are classified, and the assisted permission mode has its own label.
  - The persona's tool start now matches 1.0.105.
  - `workflow --help` and `workflow run --help` were captured offline in a network-deny namespace; the group has one
    subcommand, `run`.
  - Rejected: CO-D2.
- **Pi** (`bedd9d5`). 7 confirmed.
  - SystemMessage sections and tool text are redacted.
  - The model is built from 1.5.0 sources only.
  - Monitor-capability families no longer mark native events consumed.
  - The 1.5.0 session-file rule is stated, and a malformed tool call's `{}` is not reported as input.
- **Claude Code** (`2b75e0f`, `6e4bdb7`). 7 confirmed.
  - Egress and credential claims are scoped to the evidence.
  - The headless claim is emitted only for captured print lanes.
  - The second `/compact` stop is labelled as 2.1.311's summary retry (read from the bytes, not recaptured).
  - The event-map footer matches the ledger.
  - Rejected: CC-4, CC-5.
- **Hermes** (`3673427`). 11 confirmed.
  - The `resumed` stored id is aliased.
  - Results are correlated through the census direction marker.
  - Native-TUI approvals settle on their tool or turn.
  - Drift and census claims are corrected, including the hand-written `findings.md`.
  - Rejected: HM-3, HE-C3, HE-D5.

Residual items the fixers recorded but could not close in a container:

- **Claude Code:**
  - All nine modes now have a network-deny sandbox capture; that original gap is closed.
  - The nominal single-stop `/compact` path on 2.1.311 is read from code, not captured.
  - Runtime recapture claims now have their own completion timestamp; original probe dates are retained.
- **OpenCode:**
  - The corrected census was re-run on 2026-11-04 against the exact linux-x64 1.19.5 artifact: all 27 scenarios passed,
    including both native-attach paths. Sanitized fixtures and per-scenario timestamps were regenerated. No transport
    retry occurred in this run. Native resume needed a 30-second TUI startup allowance under Docker emulation.
  - Installs from 1.18.17 to 1.18.34 and from 1.19.1 to 1.19.4 are classified by source reading.

### 3. Remaining per-vendor blockers (survey work)

- **Claude Code 2.1.311:** all nine census modes were recaptured inside the strict network-deny namespace in
  [run 41782999182](https://github.com/vibefield/puppeteer/actions/runs/41782999182), with zero non-loopback
  attempts. The whole sanitized set replaces the earlier mixed set; runtime and probe dates are separate.
  Four-platform acquisition and protected native-TUI/resume promotion passed in [run 41788894962](https://github.com/vibefield/puppeteer/actions/runs/41788894962).
- **Hermes 0.21.5:** source archive and all four installed consoles were acquired with the pinned toolchain in
  [run 41781642980](https://github.com/vibefield/puppeteer/actions/runs/41781642980). Earlier survey claims
  still reference their original source identity. Approval denial, clarify answer and `request.cancel` now pass against a real attached TUI on macOS arm64, with retained adapter regression fixtures. That run found and fixed unanswered adapter question state after a native TUI answer. The local Python runtime identity is recorded separately; four-platform protected verification remains.
- **Kimi 2.4.1:** all four artifacts were acquired and attested in
  [run 41785477841](https://github.com/vibefield/puppeteer/actions/runs/41785477841). Native-TUI approval allow/deny, question submission and Esc-cancel are now captured on darwin-arm64 against the acquired executable. Steer, undo, question dismissal and ACP shapes remain unexercised. Account and profile services rest on 2.0.2 evidence.
- **OpenCode:** 2.x (`@opencode/cli`, an `/api/*` HttpApi with a new event envelope) is a separate integration family.
  The plan is in [`OPENCODE-2-MIGRATION-PLAN.md`](OPENCODE-2-MIGRATION-PLAN.md). The `github-stable` detector
  deliberately still sees 2.x tags, and the 1.x acquisition URLs would 404 for them.
- **Pi 1.5.0:** complete release-bundle acquisition passed on all four platforms in
  [run 41784334179](https://github.com/vibefield/puppeteer/actions/runs/41784334179). All seven scenarios were
  recaptured on the exact Linux release under Docker `--network none`: 62 records, eight journal files.
  Runtime claims now bind to the acquired release; Rosetta schema references retain their original provenance.
  The protected native-TUI/resume lane is now implemented. Its local official-release proof and all 103 Pi tests pass. It checks native output, normalized completion, durable journal observation and same-session replay with exactly one loopback provider request. The workflow verifies the complete release bundle before and after this test; four-platform rehearsal and protected promotion remain pending.
- **Antigravity 1.4.12:** see its findings section and ledger blocker. It needs a writer document from the binary's
  protobuf descriptors, Rosetta raw types and goldens, and adapter tool-result matching that no longer relies on
  `RUN_COMMAND`/`exit_code`, because results are now `GENERIC` steps.
- **Copilot 1.0.105:** all four native executable probes and immutable report assembly passed in
  [run 41786233830](https://github.com/vibefield/puppeteer/actions/runs/41786233830). That run exposed a replay
  bug: it validated the outer journal envelope as the nested `data` payload. Replay now uses the declared payload
  path and still checks the complete envelope. All nine vendors' committed captures now have replay tests.
  The corrected acquisition and analysis completed successfully in
  [run 41787728386](https://github.com/vibefield/puppeteer/actions/runs/41787728386).
- **Copilot:** the protected native-TUI/resume lane is now implemented. All 130 local adapter tests pass with the exact 1.0.105 executable; the live proof confirms prompt submission, native completion and same-session journal replay with exactly one loopback provider request. Four-platform rehearsal and protected promotion remain pending.
- **Antigravity** is now the only vendor without a protected promotion lane; its upstream writer and adapter migration must precede that proof.

### 4. Promotion

Codex 0.166.0 promotion completed in
[run 41784518623](https://github.com/vibefield/puppeteer/actions/runs/41784518623) after the repository owner's
protected-environment approval. Its generated commit `1ec8cc98` was merged into PR #59 as `be603cff`.
The first attempt was correctly refused because its snapshot preceded the OpenCode fixture-ID corrections.
Claude 2.1.311 rehearsal passed on `claude/claude-2.1.311-promotion` in
[run 41787723616](https://github.com/vibefield/puppeteer/actions/runs/41787723616). Its promote run
[41788894962](https://github.com/vibefield/puppeteer/actions/runs/41788894962) completed successfully after the repository owner approved the protected environment. Generated commit `ce70f3df` was merged into PR #59 as `6638394c`.
Its earlier attempt passed all native lanes but the final transaction caught Kimi's artifact-order test assumption;
the successful rehearsal and promotion include that correction.

Hermes 0.21.5 rehearsal [41791044639](https://github.com/vibefield/puppeteer/actions/runs/41791044639), from `fea59d0c`, stopped at immutable artifact assembly. Only darwin-x64 changed: cryptography 50.0.0 has no Intel macOS wheel in the lockfile and its source-built installed-file digest differed. The gate correctly refused it; no prior digest was replaced. A read-only two-build diagnostic is running on the separate `claude/hermes-build-diagnostic` branch in [run 41792349819](https://github.com/vibefield/puppeteer/actions/runs/41792349819). That diagnostic branch is not part of PR #59.

For each staged vendor:

1. `gh workflow run agent-adaptation.yml --ref <branch> -f vendor=<v> -f version=<ver> -f ground_truth=packages/surface/vendors/<v>/groundtruth.json -f publish_draft=false`.
   Add `-f source_reference=v2026.9.24` for Hermes. This acquires and attests the other three platforms.
2. `gh workflow run agent-surface-promotion.yml --ref <branch> -f vendor=<v> -f version=<ver> -f ground_truth=... -f confirm=rehearse`,
   then `confirm=promote` with environment approval. Promotions of different vendors on one branch run one at a time,
   in sequence. Dispatch the next one only after the previous promotion commit has landed.
3. Re-run CI on the branch after each promotion push, as the promotion guide describes.

## Environment notes for the next session

- In a cloud container, GitHub REST and web are blocked outside the session's repo scope, and so is codeload.
  Release-asset downloads (via redirect), raw.githubusercontent.com and npm all work. Public repositories such as
  `vibefield/rosetta` clone anonymously; pushing to them needs the repository attached with push access.
- `pnpm install` needs the sibling Ghosttea checkout: run `node scripts/prepare-ghosttea-ci.mjs`, then
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile`.
- Two environment-only test failures appear in containers. `packages/imposter/src/tui/app.test.ts` ("paints in violet
  and blue") needs `COLORTERM=truecolor`. `apps/imposter-control` `src/main/plane.test.ts` needs an Electron binary;
  run `node install.js` in `node_modules/.pnpm/electron@<version>/node_modules/electron` to fetch it.
- Running a vendor binary in a container: use an unprivileged network namespace (`unshare -rn`) with a scrubbed
  environment and a throwaway HOME. `ip` is absent; `census/netns-enter.py` brings loopback up with an ioctl.
