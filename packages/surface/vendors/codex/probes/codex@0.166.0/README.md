# Codex 0.166.0 artifact, grammar and runtime-meaning probes

**Probed:** 2026-11-03 (UTC), `codex-cli 0.166.0`, linux-x64. The session-free and census-based methods of
`probes/codex@0.164.0/` re-run against 0.166.0, each beside a same-platform 0.164.0 re-run, so that a platform branch
is not mistaken for release drift. Findings: `findings.md` C9.

## Artifact

`artifact.json`. The release package `codex-package-x86_64-unknown-linux-musl.tar.gz` from
`https://github.com/openai/codex/releases/download/rust-v0.166.0/` (sha256 `1d44b28b…`; tag `rust-v0.166.0` = commit
`6ff1e1ca…`), extracted into an empty directory. Its `bin/codex` (`b8a11fed…`) is byte-identical to the standalone
executable `pnpm surface:download` extracts; `bin/codex-code-mode-host` (`657f4e90…`) runs the `exec` tool's JavaScript
isolate. New in the package at 0.166.0: `bin/codex-exec-server` (advertised by `codex-package.json` as `execServer`)
and `codex-resources/voice/`; neither is started by any method here. The GitHub-published asset digest was not compared
(the REST API was unreachable).

For the comparisons only, the 0.164.0 linux-x64 package was re-acquired the same way (`bin/codex` `b93f6811…`, equal
to the promoted linux-x64 digest). Nothing from that run is committed beyond the digests in `artifact.json`.

## Bounds

No account, no model, no billed call. Every run used throwaway HOME and CODEX_HOME directories, an allowlisted
environment and a loopback Responses endpoint; nothing ran against anyone's real `~/.codex`. The session-free probes ran
with `TMPDIR` outside `/tmp`: under `/tmp` codex 0.164.0 and 0.166.0 both print a first-line warning ("Refusing to
create helper binaries under temporary dir") that would mask the answer being recorded. Isolated is not offline: a run
that starts an app-server lets its curated-plugin sync reach the network unauthenticated (findings C8).

The scripts are the 0.164.0 scripts, copied unchanged so each record names the directory it lives in. They run only the
executable they are given (`PUPPETEER_CODEX_BIN`, `--bin` or `--package-root`), never `codex` on `PATH`.

## Method 1 — session-free parse and config probes

`parse-probe.mjs` on `parse-cases.json` (170 cases) and `config-probe.mjs` on `config-cases.json` (14 cases), merged
into `parse-results.json` in the 0.164.0 record's shape.

- Against the 0.164.0 record (darwin-arm64): all 184 answer the same exit code and first/last line but for the six
  `-V`/`--version` cases, which print `0.166.0`.
- Against 0.164.0 re-run on linux-x64: the same six differ, nothing else.

`codex-help.txt` and `codex-resume-help.txt` are the stdout of `codex --help` and `codex resume --help`. The resume help
is byte for byte the 0.164.0 file. The root help is byte for byte 0.164.0's on linux-x64; against the darwin-arm64
0.164.0 fixture it lacks only the `app` row, because `Subcommand::App` is compiled for macOS and Windows alone
(`#[cfg(any(target_os = "macos", target_os = "windows"))]`, unchanged at both tags). The clap `Subcommand` enum and the
TUI's `cli.rs` are unchanged between the two tags; `config_override_args.rs` moved its override collection into
`codex_utils_cli::collect_config_overrides` with the same behaviour, and `codex queue` gained option validation.

`codex features list` (not recorded as a file; the config cases run it): `reasoning_effort_override` became stable and
on; `plugin_discovery_prefetch` and `prediction_preserve_parent_tools` are new, stable and on;
`code_mode_tool_description_first` is removed; ten new rows are under development and off.

## Method 2 — live invocation landing (not re-run)

The S1–S35 landing (`packages/adapter-codex/src/launch/invocation-probe.live.test.ts` on
`probes/codex@0.164.0/live-cases.json`) was not re-run at 0.166.0. The grammar evidence above is what holds the adapter's
grammar to this release; the landing digests remain 0.164.0's.

## Method 3 — what `FileUpdateChange.diff` means at runtime

`file-change-probe.mjs`, `file-change-results.json`: identical to the 0.164.0 record but for the version and digests —
`add` carries the whole new file, `update` the unified hunk without file headers, in path order; `item/started` already
carries the changes; `turn/diff/updated` arrives three times; `item/fileChange/patchUpdated` never does. The runtime
counterpart of `references/codex@0.166.0/source/file-changes.json`, carried forward under the renamed
`ThreadItemPayload::FileChange` (findings C9).

## Method 4 — history replays a capped command output

`history-truncation-probe.mjs`, `history-truncation-results.json`: identical to 0.164.0's but for the version and digest.
Live `aggregatedOutput` carries all 100 000 bytes; `thread/turns/list` (`full`) and `thread/read` (`includeTurns`) carry
65 536 bytes around the marker `\n... command output truncated for persistence ...\n`; one deprecation notice.

## Method 5 — `auth = "ema_auth"` (not re-run)

`probes/codex@0.164.0/ema-auth-probe.mjs` denies the network with macOS `sandbox-exec`, which linux-x64 does not have.
Not re-run; the 0.164.0 record stands.

## Method 6 — model-provider admission (new at 0.166.0)

`provider-mismatch-probe.mjs`, `provider-mismatch-results.json`. Two loopback providers, `fake` and `other`, both
pointing at the probe's own Responses endpoint; each case in its own throwaway home:

- **mismatch:** app-server A (`model_provider = "fake"`) starts a thread and runs one turn; app-server B on the same
  home selects `other` and sends `thread/resume {excludeTurns: true}`. 0.166.0: -32600 with `data`
  `{type: modelProviderMismatch, modelProvider: fake, currentModelProvider: other}`. 0.164.0: the resume succeeds
  (the saved provider is adopted).
- **notConfigured:** the same, but B configures only `other`. 0.166.0: -32600 with `data`
  `{type: modelProviderNotConfigured, modelProvider: fake}`. 0.164.0: -32600 too, but with `data: null` and only a
  "failed to load configuration" message.
- **inputMismatch:** one app-server reads `model_provider` from `config.toml`; after one turn the file selects `other`
  and the same connection sends `turn/start` and then `thread/resume` of the still-loaded thread. 0.166.0: both -32600
  with `modelProviderMismatch` data. 0.164.0: both succeed.

The error message is a display string (the source's `Display` for `ModelProviderError`); the record keeps a digest of
it, since the privacy rules treat `message` as free text. The 0.164.0 answers are under `baseline` (the same script
run against the 0.164.0 linux-x64 package). `modelProviderPolicyConflict` needs a managed requirements layer and is
source-read only.

## Files

| File | What |
| --- | --- |
| `artifact.json` | release, package, executable and companion identity; the 0.164.0 baseline digests; help digests |
| `codex-help.txt`, `codex-resume-help.txt` | stdout of `codex --help` and `codex resume --help` (linux-x64) |
| `parse-probe.mjs`, `config-probe.mjs`, `parse-cases.json`, `config-cases.json`, `parse-results.json` | Method 1 |
| `file-change-probe.mjs`, `file-change-results.json` | Method 3 |
| `history-truncation-probe.mjs`, `history-truncation-results.json` | Method 4 |
| `provider-mismatch-probe.mjs`, `provider-mismatch-results.json` | Method 6 |
