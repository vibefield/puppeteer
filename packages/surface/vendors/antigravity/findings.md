# Antigravity CLI 1.1.12 Surface findings

Status: Stage 0 complete. Stage 1 authorized print-mode survey in progress on
`darwin-arm64`. This is not an Agent Surface Model, adapter implementation,
support entry, or promotion claim. Native-TUI PTY census is still outstanding.

## Authorization boundary

The operator authenticated the already-pinned `1.1.12` `agy` binary on this
host and asked the census to continue. Live probes used a synthetic workspace,
`AGY_CLI_HIDE_ACCOUNT_INFO=1`, and did not write hook or status-line config
into `~/.gemini/antigravity-cli/settings.json`. Raw records stay in gitignored
`captures-raw/`. Committed fixtures are sanitized projections.

The [Antigravity terms](https://antigravity.google/terms) question in
`draft/ANTIGRAVITY-ADAPTATION-PLAN.md` section 2 is still a project-owner
record, not a repository legal determination. Do not provision CI credentials
or a support-ledger entry from this slice.

## Exact release identity

The official GitHub release API returned stable release `1.1.12`, release ID
`368267156`, tag revision
`f7519c9084190ed421e89dd81c63970b5177c9ef`, and publication time
`2026-08-11T01:26:58Z`. The reviewed projection is retained at
`references/antigravity@1.1.12/release.json` with the official asset IDs,
sizes, URLs, and GitHub-published SHA-256 digests.

The required Puppeteer matrix maps to:

| Platform       | Asset                      | Published archive SHA-256                                          | Extracted executable SHA-256                                       |
| -------------- | -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `darwin-arm64` | `agy_cli_mac_arm64.tar.gz` | `7b70bdf27727a68d58c1bebfd3fd2e87d1172dc32eab9827d52fd62ad64f286b` | `c8fd3c0016e101689f923f82da1c068b0e6dce3abcb0089e282742693ad4d344` |
| `darwin-x64`   | `agy_cli_mac_x64.tar.gz`   | `82f5ccc62ae77e202c33cd0347b564ffe645b7cdb2a35c45bb6eb34d516e8832` | `a3e9175bfc15656a70e87ed5df627c2691da3dee88acf69ae0601e5ecf146c48` |
| `linux-x64`    | `agy_cli_linux_x64.tar.gz` | `c778ae4fd11e5dc2dbddfd7108ee1974ae60fd531afb246be41c6e4bb49c81ca` | `dfa88b922a2a16f4b9f28553a9625390c010bd011304b4dc892ce72a6d58b144` |
| `windows-x64`  | `agy_cli_windows_x64.zip`  | `270d71910675d614499a0f7f165f275aff0a03c00b0f92cc9ed09f352c58de85` | `fba49b64595e1484449a951442c0dfcdb488229ff47299d82381c31f10fa99f4` |

GitHub reports the release as non-immutable. A numeric-version match is
therefore insufficient: the generic detector's release-signal digest must also
surface a same-version asset replacement. Exact executable hashes are captured
per platform only after validating the downloaded archive hash and proving the
executable bytes match the single reviewed archive member.

The public repository contains documentation, changelogs, and examples but not
the implementation that produced the binary. The release tag is valid release
provenance; it is not exact source-to-binary correspondence.

## Offline binary probe

All four required archives were downloaded and their executable members were
identified without execution on a `darwin-arm64` probe host. The initial
`darwin-arm64` parser probe executes only:

- `antigravity --version`;
- `antigravity --help`;
- one deliberately unknown option.

The harness supplies an allowlisted environment with disposable `HOME`,
`USERPROFILE`, and temporary directories. It fails if those parser-only probes
write a file beneath the isolated home. It does not call print mode, slash
commands, models, agents, update, install, or any service-backed operation.

Observed facts:

- version output is exactly `1.1.12`;
- the release archive contains one executable named `antigravity`, while the
  documented installed command is `agy`;
- the unknown option exits non-zero and identifies the rejected option;
- visible flags include `--add-dir`, `--conversation`, `--continue`,
  `--log-file`, `--model`, `--mode`, `--sandbox`, `--print`,
  `--output-format`, and `--prompt-interactive`;
- visible subcommands include `agents`, `models`, `plugin`, and `update`;
- both macOS artifacts contain an embedded code directory naming team
  `EQHXZ8M8AV`, but `codesign --verify --strict` reports each exact official
  archive member as `invalid signature (code or signature have been modified)`.

The signature failure is not explained away by local extraction: the archive
matches GitHub's published digest, and the executable used for verification
matches the single archive member byte-for-byte. The probe records both the
embedded identity and the failed integrity result without retaining its private
temporary path. This release must not pass macOS promotion unless the failure
is explained and the repository adopts an explicit reviewed policy for it, or
an upstream artifact with a valid signature is pinned instead.

All four executables contain the static byte sequence
`AGY_CLI_DISABLE_AUTO_UPDATE`. The probe labels it an
`unverified-contract`: a binary string does not prove that the environment
variable is honored, when it is read, or whether it prevents every updater
path. It must not be used as the pinned-real safeguard until an isolated
behavior probe establishes those facts.

The committed probe files contain no local artifact path, home path, account,
credential, or prompt content.

## Documented native rails, not yet runtime-verified

The curated projection is
`references/antigravity@1.1.12/docs.json`. It is a documentation-lead, not
runtime evidence. Official pages and the 1.1.12 changelog are the sources;
the shipped executable remains the runtime authority.

### Channel inventory

| Channel                   | Documented carrier                                                             | Offline verdict                                                     | Adapter implication                                          |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| PTY/TUI                   | Visible `agy` process, `prompt.submit`, Esc/`Ctrl+C`                           | Parser flags and TUI docs only                                      | Required control surface; never parsed for semantics         |
| Command hooks             | stdin/stdout JSON from `.agents/hooks.json` via `--add-dir`                    | Live: `--add-dir` loads hooks; untrusted cwd `.agents/` does not    | Preferred observer. Hook `workspacePaths` is the extra dir   |
| Transcript JSONL          | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` | Live print-mode files exist, with a `transcript_full.jsonl` sibling | Required rail; hook `transcriptPath` points at the full file |
| SQLite conversation store | `~/.gemini/antigravity-cli/conversations/<id>.db`                              | Live `.db` / `.db-shm` / `.db-wal` created per conversation         | Distinct durable rail; do not commit the bytes               |
| Status line               | `settings.json` `statusLine.command` stdin JSON                                | Docs + static strings only                                          | Deferred. Installing it requires writing user settings       |
| Continue cache            | `~/.gemini/antigravity-cli/cache/last_conversations.json`                      | Live map of launch cwd → conversation UUID                          | Adapter resume must use `--conversation`, not `--continue`   |
| Process lifecycle         | spawn/exit                                                                     | Print-mode exits captured; PTY lifecycle not yet                    | Required for the TUI adapter                                 |
| Print / stream-json       | `--print --output-format json\|stream-json`                                    | Live `init` / `step_update` / `result` and slash `command_result`   | Survey oracle only. Forbidden beside the TUI                 |
| Terminal text             | TUI                                                                            | Never semantic evidence                                             | Never parsed                                                 |

### Hook contract lead

Official hook docs describe five families, command handlers with a 30s default
timeout, and camelCase JSON on stdin/stdout. Common fields are
`conversationId`, `workspacePaths`, `transcriptPath`,
`artifactDirectoryPath`, and `modelName`.

- `PreToolUse` adds `toolCall` and `stepIdx`. Documented decisions are
  `allow`, `deny`, `ask`, `force_ask`, and `deny_unless_prior_grant`.
  Changelog 1.0.16 says an empty decision used to crash with
  `unknown pre-tool hook decision` and is now handled. Empty is not
  documented as allow. That exact error string is present in the 1.1.12
  executable.
- `PostToolUse` is documented as returning `{}`.
- `PreInvocation` / `PostInvocation` can return `injectSteps`; post can also
  return `terminationBehavior` (`force_continue`, `terminate`, or empty).
- `Stop` includes `fullyIdle` and `terminationReason`. Returning
  `decision: "continue"` re-enters the loop. Changelog 1.1.9 says a hook
  that always continues is eventually ignored.

Workspace hooks are documented at `.agents/hooks.json` after folder trust.
Changelog 1.1.8 says global hooks belong at `~/.gemini/config/hooks.json`,
not under `antigravity-cli`. `--add-dir` is documented to reload discovered
customizations. That is still not proof that an auxiliary workspace is a
safe launch-scoped hook seam.

### Status line lead

A custom status line is a `command` block in
`~/.gemini/antigravity-cli/settings.json`. There is no documented
launch-scoped flag. The payload includes `conversation_id`,
`transcript_path`, `agent_state`
(`idle`/`thinking`/`working`/`tool_use`/`initializing`), pending-input and
tool-confirmation flags, and privacy-sensitive `email`, `plan_tier`, and
`quota`. The first adapter must not write the user's settings file to
install this rail.

### Resume lead

`--conversation <uuid>` is the explicit resume path. `--continue` / `-c`
resolves the launch cwd through `last_conversations.json` and starts fresh
if the id is missing or deleted. Changelog 1.1.10 warns when the same
conversation is already open and points at `/fork`. Getting-started docs
say first launch asks for workspace trust before indexing.

### Print-mode survey oracle

Changelog 1.1.11–1.1.12 say `-p /hooks`, `/permissions`, `/help`,
`/changelog`, `/config`, and several quota/model commands can answer without
starting an agent turn, spending quota, or leaving a conversation.
Changelog 1.1.2 says print mode can still prompt for OAuth on `/dev/tty`.
The exact executable contains `Please sign in to view available models`.
Authorized print-mode probes on this host confirmed the no-quota slash
answers: empty `conversation_id`, `num_turns: 0`, zero token usage, and no
`settings.json` mutation. Slash stream-json emits `command_result` then
`result`, not the agent-turn `init`/`step_update` vocabulary.
`models --output-format` and `agents --output-format` are rejected by the
exact binary (`flags provided but not defined: -output-format`).

### Authorized live census

Installed `agy` at the user command path matched
`c8fd3c0016e101689f923f82da1c068b0e6dce3abcb0089e282742693ad4d344`.
Sanitized fixtures: `captures/antigravity@1.1.12/`.

`--add-dir <extra>` loaded `.agents/hooks.json` from the extra workspace
into `/hooks` and into the execution loop. The same hook file in an
untrusted launch cwd was invisible to `/hooks`. `settings.json` was not
mutated. Hook stdin matched the documented camelCase fields. Observed:

- `PreInvocation` / `PostInvocation` with `invocationNum` and
  `initialNumSteps`;
- `PreToolUse` / `PostToolUse` with `toolCall.name`, `toolCall.args`, and
  `stepIdx`;
- `Stop` with `fullyIdle: true` and `terminationReason: "NO_TOOL_CALL"`
  (including after a tool turn whose last invocation made no tool call);
- empty `PostToolUse.error` on success;
- `workspacePaths` listing the `--add-dir` extra, not `init.cwd`;
- resume of the same conversation accumulating a stale previous extra path
  in `workspacePaths`.

`init.cwd` stayed the launch project. `--add-dir` is therefore a working
hook-delivery seam for the same conversation, but hook `workspacePaths`
must not be treated as the user project. That is a material identity
quirk, not a reason to write hooks into the user's tree.

Print-mode agent turns emit `init` (`permission_mode`, tool name list),
`step_update` (`user_input`, `unknown`, `agent_response`, `tool`,
`checkpoint`, `system_message`, `error_message`) with `state` ACTIVE/DONE,
and `result`. Tool updates carry `tool_name` and `tool_info`
(`name`, `parameters`, `output`). Transcript JSONL types observed:
`USER_INPUT`, `CONVERSATION_HISTORY`, `PLANNER_RESPONSE`, `CHECKPOINT`,
`LIST_DIRECTORY`, `VIEW_FILE`, `ERROR_MESSAGE`. `USER_INPUT.source` was
`USER_EXPLICIT`. `--conversation <uuid>` reused the same native id and
incremented `num_turns` to 2.

These print-mode records are a survey oracle. They are not proof that the
native TUI emits the same stream on its PTY, and they must not be merged
into a TUI session.

### Exact-byte static strings

`probes/antigravity@1.1.12/darwin-arm64/static-strings.json` records
presence of the documentation-lead byte sequences in the exact
`c8fd3c0016e101689f923f82da1c068b0e6dce3abcb0089e282742693ad4d344`
executable. Every candidate is `unverified-contract`. Notable environment
strings also present, still unverified: `AGY_CLI_HIDE_ACCOUNT_INFO`,
`AGY_CLI_DISABLE_LATEX`, `AGY_CLI_CMD_OUTPUT_PERCENTAGE`,
`AGY_CLI_DISABLE_MERMAID_ASCII`, `AGY_CLI_EXPERIMENTAL_RENDERING`,
`AGY_CLI_FORCE_OSC8`, `AGY_CLI_INTERACTIVE_HEADLESS`,
`AGY_CLI_LOGO_STYLE`, and `AGY_CLI_NEW_HARNESS`.

Other platforms were not re-scanned for the expanded catalog. They still
have the original archive-only `AGY_CLI_DISABLE_AUTO_UPDATE` candidate.

### Extra parser-only help

Isolated `help <subcommand>` and `<subcommand> --help` on darwin-arm64 did
not write to the disposable home:

- `agents` / `models` help only lists `-h` / `--help`. They do **not** list
  the `--output-format` flag claimed by changelog 1.1.12.
- `plugin` help lists list/import/install/uninstall/enable/disable/validate/link.
- `install` help lists `--dir`, `--skip-aliases`, and `--skip-path`.
- `update --help` and `help update` exit 2 with only `Usage of update:`.

Those contradictions are retained in the documentation projection rather
than resolved in favor of the changelog.

## Decisions still requiring evidence

1. Whether `--add-dir` changes tool-permission scope or context in a way
   that makes it unsafe as a launch-scoped hook seam. Hook `workspacePaths`
   is already the extra dir; `init.cwd` stayed the launch project.
2. Neutral `PreToolUse` replies other than `allow`, and `Stop` replies
   other than `{}`. This census used `allow` / `{}` only.
3. Hook failure, timeout, malformed-output, and bridge-disconnect behavior.
4. Transcript rotation/truncation and TUI-vs-print durability. Print mode
   wrote JSONL plus sqlite; TUI is unproven.
5. A semantic startup/readiness signal that does not parse terminal output.
6. Exact prompt confirmation after guarded terminal paste. Print-mode
   `result` is not a TUI paste receipt.
7. TUI `--conversation` replay/live boundaries and concurrent-open banner.
8. Whether `AGY_CLI_DISABLE_AUTO_UPDATE` actually pins the attached binary.
9. Native permission request/outcome identities without
   `--dangerously-skip-permissions`.
10. Status-line composition without modifying global settings.

## Stage status

Stage 0 identity and offline scaffolding is committed.

Stage 1 now has sanitized print-mode and hook evidence for:

- no-quota slash commands;
- `--add-dir` hook discovery and execution;
- a no-tool turn, a resume of the same conversation UUID, and a tool turn;
- transcript JSONL types and stream-json `init` / `step_update` / `result`.

Still outstanding before the survey exit gate:

- native-TUI PTY capture (print-mode is an oracle only);
- permission / interrupt / hook-fault variants;
- matching-platform parser execution on darwin-x64, linux-x64, windows-x64;
- macOS signature-integrity promotion gate.

No model, persona, adapter, runtime provider, application entry,
support-ledger entry, or promotion workflow should be added yet. The next
implementation slice can start an ASM v2 from these sanitized print-mode
and hook fixtures while the TUI census remains open.
