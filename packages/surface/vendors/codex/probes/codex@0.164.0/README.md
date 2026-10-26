# Codex 0.164.0 artifact, grammar and invocation-landing probes

**Probed:** 2026-10-24 (US Pacific; timestamps in the results are UTC), `codex-cli 0.164.0`, darwin-arm64, macOS.
The 0.157.1 record (`probes/codex@0.157.1/`) re-run against 0.164.0, plus the runtime meaning of
`FileUpdateChange.diff` and the command-output cap in replayed history. Findings: `findings.md` C8.

## Artifact

`artifact.json`. The release package `codex-package-aarch64-apple-darwin.tar.gz` from
`https://github.com/openai/codex/releases/download/rust-v0.164.0/` (sha256 `dd99e909…`, equal to the digest GitHub
publishes for that asset; tag `rust-v0.164.0` = commit `6aaac694…`), extracted into an empty directory. Its
`bin/codex` (`d8990e3e…`) is byte-identical to the standalone executable `pnpm surface:download` extracts; its
`bin/codex-code-mode-host` (`416721e3…`) runs the `exec` tool's JavaScript isolate. Every probe below ran the
package's `bin/codex` with the companion beside it.

## Bounds

No account, no model, no billed call. Every run used throwaway HOME, CODEX_HOME and TMPDIR directories with short
paths under the shared temp root (so Unix socket paths stay under `SUN_LEN`), an allowlisted environment, and a
loopback Responses endpoint. Nothing ran against anyone's real `~/.codex`. Isolated is not offline: a run that starts an
app-server (Methods 2–4) lets its curated-plugin sync make unauthenticated requests to github.com and chatgpt.com
(findings C8, Known gaps); Method 1 starts none, and Method 5 ran with outbound network denied.

The scripts run only the executable they are given (`PUPPETEER_CODEX_BIN`, `--bin`, `--package-root`, or Method 5's
argument), never `codex` on `PATH`, and keep no other codex directory on the child's `PATH`. No sanitizer writes these
records, so `pnpm surface:privacy:codex`, the codex audit and `model.test.ts` run the detector over every record here
(`checkProbeRecords`, `census/sanitize.mjs`), and `whitelist-live.mjs` writes nothing the detector flags.

## Method 1 — session-free parse and config probes

`parse-probe.mjs` and `config-probe.mjs` are the 0.157.1 methods, unchanged except that a case carries its batch and
the executable is named by `PUPPETEER_CODEX_BIN`. Cases: `parse-cases.json` (the 163 parse cases of the 0.157.1
record, plus seven for the new subcommand) and `config-cases.json` (its 14 config-loader cases). Results:
`parse-results.json`, in the 0.157.1 shape.

- 169 cases answer exactly as on 0.157.1 (exit code and first line).
- Six differ only in the version a `-V` prints (`codex-cli 0.164.0`, `codex-cli-resume 0.164.0`, …).
- Two config3 cases differ only in the feature table's last line: `write_stdin_approval` is `stable` (it was
  `under development`).
- New (batch7): `migrate-nfs-db --help` and `help migrate-nfs-db` print "[experimental] Migrate configured SQLite
  databases to DELETE mode in place"; `migrate-nfs-db -V` and `--version` exit 2 ("unexpected argument");
  `--sandbox bogus migrate-nfs-db --help` prints the subcommand's help (clap's pending-value rule, as for `mcp`);
  `sandbox uninstall --help` exists ("Remove the legacy Windows sandbox's machine-wide accounts and network rules").

`codex-help.txt` and `codex-resume-help.txt` are the stdout of `codex --help` and `codex resume --help` (stderr is not
part of them). The root help differs from the 0.157.1 fixture by one row, `migrate-nfs-db`; the resume help is byte
for byte the 0.157.1 file.

## Method 2 — live, isolated

`packages/adapter-codex/src/launch/invocation-probe.live.test.ts` (unchanged), on `live-cases.json`: the 0.157.1
cases made replayable — the harness's `id` field in place of `case`, the harness's own prompt (`Reply with the single
word ok.`) where the 0.157.1 record had `<redacted:prompt>`, and `-C <root>/workspace` on the two typed-remote cases,
which the harness refuses without it. `whitelist-live.mjs` projects the raw output into `live-results.json` (the
0.157.1 record shape plus `excludeTurns` on the TUI's `thread/resume`, `dynamicTools` on its `thread/start` and the
TUI's own `Error:` lines); screens, directories, ids and prompt text are dropped. 35 sessions, 295 s.

Digests are the permissions / filesystem block digests (first 16 hex of the sha256 of the exact text, the case root as
`<root>`).

| Relation | 0.157.1 | 0.164.0 |
| --- | --- | --- |
| S25 = S24 (home A, typed vs `thread/start` without permissions) | `29dad5ed…` / `cad731d0…` | same |
| S28 = S27 (home B) | `937f202d…` / `f921d497…` | same |
| S29 = S24 = S33 = S34 = S3 = S4 = S22 (read-only, never) | `29dad5ed…` / `cad731d0…` | same |
| S31 = S35 (and now S32) — workspace-write, never, extra root | `b45c9df4…` / `fcfa7dc7…` | `b45c9df4…` / `85bbbf4c…` |
| S26 and the workspace-write defaults (S1, S8, S13, S14, S18–S21) | `5f3fe02b…` / `cf88e8fe…` | `5f3fe02b…` / `216c19ba…` |
| S10 = S11 = S23 (no sandbox, never) | — | `681b5ba5…` / `f921d497…` |
| S6 = S17 (`--add-dir` typed) | — | `2bf535d2…` / `85bbbf4c…` |

The 0.157.1 record measured digests from S24 on, so its column holds S24–S35's values only; the other sessions in a
row joined it on 0.164.0.

What changed and what did not:

- **Permission parity holds.** Every equality the grammar and the recipe rely on holds again.
- **The workspace-write filesystem block changed:** every writable workspace root now also gets a read-only
  `<root>/.aws` entry beside `.git`, `.agents` and `.codex`. That is the whole filesystem-digest change.
- **The permissions text did not change.** The permissions digests equal 0.157.1's. The critic's earlier re-run
  reported different ones because the writable-roots sentence lists the roots in an order that depends on where the
  case root lives (there: `<root>/tmp`, `<root>/workspace`, `/private/tmp`; here and on 0.157.1: `/private/tmp`,
  `<root>/tmp`, `<root>/workspace`). Compare permissions digests within one run only.
- **Refusals are unchanged:** `--add-dir` with `--remote` (S5, S12, S15 — now reported as "Codex TUI exited during
  startup"), permission overrides on a remote resume (S7), `thread/start.runtimeWorkspaceRoots` without
  `experimentalApi` (S16), resume-time config for a held thread (S13 sends `model_reasoning_effort` and the request
  has no effort; S14 sends `web_search: live` and the request keeps `external_web_access: false`).
- **The recipe:** S30 and S32 now equal S34 and S35 — the current recipe puts permission `-c` on the app-server's
  line only, so the old refusals no longer occur.
- **S18 (typed-remote, now with `-C`)** starts its own thread with `config` `{model_reasoning_effort: high,
  web_search: live, features: {goals: false}}` and `dynamicTools: [namespace:codex_tui]`; the request carries
  `effort: high`, `summary: auto`, live web search and no goal tools.
- **S2 (bare `codex`)** now completes: with the short root the shared daemon's socket binds. Two daemon processes were
  swept after the case.
- **The TUI's own history read is paginated:** on `resume <thread> --remote` it sends `thread/resume` with
  `excludeTurns: true`, then `thread/turns/list` and `thread/items/list`. It also sends
  `account/bedrock/checkGovCloudRequirements`.
- **Task tools now depend on who starts the thread.** The in-process controls (`--no-daemon`) offer
  `namespace:mcp__codex_worktrees` and `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`; the
  bare daemon session (S2) offers `namespace:mcp__codex_tui` and the same three resource tools. Every managed and
  recipe session — a thread the controller starts — offers none of them, while its permission digests equal the
  typed run's. On 0.157.1 the tool sets were equal. This is a limitation of the controller-owned thread (C8), not a
  grammar row.
- **Every request carries `reasoning.summary: auto`**, controls included (on 0.157.1 the in-process controls sent
  none).
- **S20/S21:** an image given without a prompt is still its own first turn; the pasted prompt follows as a second.

## Method 3 — what `FileUpdateChange.diff` means at runtime

`file-change-probe.mjs` runs the census's own `file-change` scenario (`census/harness.mjs`: a seeded `hello.txt`, one
`tools.apply_patch` that adds `added.txt` and updates `hello.txt`) and compares each change with the patch and with
the bytes on disk. `file-change-results.json`: the `add` diff is the whole new file (`new file line\n`, equal to the
file on disk); the `update` diff is the unified hunk `@@ -1 +1 @@\n-hello\n+hello world\n` (no file headers,
`move_path: null`); the changes are in path order; `item/started` already carries the same changes as
`item/completed`; `turn/diff/updated` arrives three times; `item/fileChange/patchUpdated` never does. This is the
runtime counterpart of the exact-source contract in `references/codex@0.164.0/source/file-changes.json`.

## Method 4 — history replays a capped command output

`history-truncation-probe.mjs` runs one command that prints 100 000 bytes of `a` through the census harness, then
reads the turn back on the same connection. `history-truncation-results.json`: the live `item/completed` carries all
100 000 bytes; `thread/turns/list` (`itemsView: 'full'`) and `thread/read` (`includeTurns: true`) both return exactly
65 536 bytes — the first and last 32 743 bytes around the in-band marker `\n... command output truncated for
persistence ...\n`. The cap applies even while the thread is loaded, so any replay of history (the observer's
included) can differ from what was streamed live (rust-v0.162.0 #50427).

## Method 5 — an enterprise-managed MCP server (`auth = "ema_auth"`)

`ema-auth-probe.mjs` (adapter stage) writes a throwaway `config.toml` with one `auth = "ema_auth"` server and one plain
HTTP server, then asks Codex about them with no account, no enterprise IdP profile and the network denied
(`sandbox-exec`): `config/read` over the app-server's stdio, `codex mcp list --json`, `codex mcp login` and
`codex mcp logout` on the enterprise server. `ema-auth-results.json`, for 0.164.0 and 0.150.0:

- **0.164.0** returns `auth: "ema_auth"` in `config/read`'s merged `mcp_servers` (and an `origins` key for it);
  `mcp list` reports the server `unsupported` (no enterprise registration) and does not show `auth`; `mcp login`
  exits 1 with "Enterprise MCP authorization is managed by Codex account sign-in. Open Codex to sign in."; `mcp logout`
  exits 1 with "Sign in to your Codex account before removing enterprise authorization".
- **0.150.0** refuses the whole configuration: "unknown variant `ema_auth`, expected `oauth` or `chatgpt`".

What a signed-in enterprise account changes (the shared grant's removal on logout) is source-read only
(findings C8).

## Deviations

- **One accidental launch attempt.** A zsh loop passed `resume --help` as ONE argument; codex read it as a prompt and
  refused to start the TUI ("TERM is set to \"dumb\"", stdin `/dev/null`) in a throwaway home. No session started;
  the home held only codex's own `tmp/` lock. The help captures here come from explicit argv.
- **One literal changed.** The 0.157.1 config case typed `writable_roots=["/tmp/codex-extra"]`; the replay types
  `/opt/codex-extra`, so no file here carries a temp-root path. The config loader accepts both alike.
- **Privacy.** Every JSON file here passes `checkCaptureFile` from `@vibefield/puppeteer-surface/sanitize` with the
  default rules, except `live-cases.json`, whose `id` fields — case names the harness requires, such as
  `S1-managed-baseline` — are read by the key rule as identifiers.

## Files

| File | What |
| --- | --- |
| `artifact.json` | release, package, executable and companion identity; help digests |
| `codex-help.txt`, `codex-resume-help.txt` | stdout of `codex --help` and `codex resume --help` |
| `parse-probe.mjs`, `config-probe.mjs`, `parse-cases.json`, `config-cases.json`, `parse-results.json` | Method 1 |
| `live-cases.json`, `whitelist-live.mjs`, `live-results.json` | Method 2 |
| `file-change-probe.mjs`, `file-change-results.json` | Method 3 |
| `history-truncation-probe.mjs`, `history-truncation-results.json` | Method 4 |
| `ema-auth-probe.mjs`, `ema-auth-results.json` | Method 5 |
