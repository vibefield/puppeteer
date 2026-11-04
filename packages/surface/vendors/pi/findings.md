# Pi 1.5.0 surface findings

Status: canonical ground truth, adapter, Imposter persona, built-in provider,
and local conformance are implemented. The baseline remains
`baseline-pending` until a guarded, matching-platform native-TUI/resume lane is
implemented and records artifact-bound durable-observation receipts on all
four platforms.

## Ground truth and identity

The vendor-root `groundtruth.json` is the single Puppeteer truth artifact. It
is generated from the complete Rosetta `rosetta-groundtruth/1` inventory,
controlled `1.5.0` fixtures, and the pinned open-source writer contract.
Version 3 session JSONL is authoritative; branch summaries,
extension-defined custom entries, and labels remain writer-backed where no
controlled fixture exists.

Official acquisition now preserves the complete platform release bundle: executable,
package metadata, native libraries, themes and other companion files. Extracting only the
Bun executable loses the adjacent `package.json` and reports `0.0.0`. The downloader now
binds the archive, complete extracted tree and entry-point digest; both the isolated version
probe and report assembly verify all of them. All four `1.5.0` version probes passed in
[run 41784334179](https://github.com/vibefield/puppeteer/actions/runs/41784334179).

### Official release recapture (2026-11-04)

`census/release.py` drove the exact linux-x64 release through the pinned Rosetta farm's
seven scenarios: basic chat, tool use, resume, fork, error, compaction and usage. The
run lasted 2026-11-04T06:20:28Z–06:20:53Z and produced 62 journal records in eight files.
It ran in a read-only Docker container with `--network none`, a fresh temporary home,
read-only release/farm mounts, zero non-loopback routes and a refused public-address probe.
The model provider was a loopback mock; no user files or credentials were mounted.

The release manifest SHA-256 is
`3262e81938a6dfbaa1cc65eb87cda26dfb0b9b3ffce69f5d88e512d827b9f57d`, identical to the
four-platform acquisition report's Linux identity. The receipt is committed as
`captures/pi@1.5.0/release-capture.json`. All primary journal fixtures were replaced by
this capture set, and the Surface schema/privacy audit passes. Runtime claims bind to
that exact release identity and timestamp. Rosetta's source/observed-schema claims keep
their original fixture-corpus identity and dates; they are not relabeled as release captures.

## 1.5.0 capture and drift from 0.84.3

The original 1.5.0 corpus was farmed by Rosetta (commit
`768de81d529d187523cbdf2f0995c6f63a6be8fc`, on branch `groundtruth/upstream-rosetta-trio`,
vibefield/rosetta#39, merged as `4282c44276d070958fbc442ca7a5b7021354aa5e`) from the
npm `@earendil-works/pi-coding-agent` package on linux-x64, offline, against
Rosetta's loopback mock model; the 0.84.3 corpus was farmed on darwin-arm64.
The official-release recapture above supersedes its primary journals. The original
npm corpus remains the provenance of Rosetta's generated schema reference. Rosetta's `sources/1.5.0.writer.json` is its 0.84.3 writer document with
the reviewed v0.84.3..v1.5.0 diff of the persistence types applied. Rosetta's
canonical inventory is cumulative across its pinned versions, so the 1.5.0
model is rebuilt from the 1.5.0 writer and fixture sources only
(`versionScopedSources`): shapes and occurrence counts seen only in the 0.84.3
darwin-arm64 corpus or writer (for example `toolResult.addedToolNames` or the
mock `message_start.responseId`) are not credited to 1.5.0.

- The session header stays at version 3 and the record types are unchanged in
  the fixtures. 1.5.0 persists the system prompt as a `message` entry with
  `role: "system"` (`content`, `sections`, `toolsAdded`, `toolsRemoved`) after
  `thinking_level_change`, and on `compaction.systemMessage`. The adapter keeps
  it as a retained native `message:system`; it is prompt scaffolding, not a
  turn.
- Assistant messages gain `durationMs`, `thinkingLevel` and
  `providerThinkingLevel`; tool results gain `durationMs` and `nestedCalls`;
  `usage.cost.totalFromProvider` is new. None of these changes a consumed
  field.
- `ToolCall` gains `argumentsError`, which changes the meaning of the consumed
  `toolCall.arguments`: when a finished call's arguments text is not a JSON
  object, 1.5.0 persists `arguments: {}` beside `argumentsError` (the parse
  error plus the raw text the model sent) and Pi fails the call, where 0.84.3
  kept the partially parsed prefix. The adapter reports no tool input and no
  proposed file operation for such a call and never copies `argumentsError`;
  the privacy rules redact it.
- Journal creation moves earlier: 0.84.3 deferred the whole file until the
  first assistant message; 1.5.0 writes it at the first user or assistant
  message entry (`SessionManager._hasConversation`). An aborted first turn now
  leaves a resumable journal holding only the user message.
- New writer-only entries: `usage` (prompt-cache warming and other
  model-attributed usage) and `context_edit`. Both are retained native events;
  usage stays excluded from the session-JSONL usage family as before.
- Invocation (`--help`, 1.5.0): a `mcp` command and `--no-mcp`; `--provider`
  without `--model` now exits (`--provider requires --model`), so both the
  argv normalizer and the managed launch refuse that combination; fullscreen
  is now the default `--tui-mode`, which the hosted terminal accepts as is.

## Adapter boundary

The adapter launches the native `pi` TUI and tails exactly one append-only
session JSONL under the resolved `PI_CODING_AGENT_SESSION_DIR`. It does not
parse terminal output or treat settings, model catalogs, credentials,
extensions, or package trees as event rails. Fresh launches assign
`--session-id`; resume accepts the documented `--session <id-or-unique-prefix>`,
resolves it to one durable header, and launches with the canonical full ID.
Interactive picker flags are not silently reinterpreted as managed resume.

Versioned session entries normalize session/environment, model, thinking
effort, user and assistant turns, tools, response usage, completed compaction,
and tool-input-backed workspace file operations. A durable compaction row
proves completion and context invalidation, not an invented start time. Pi's
native `usage.totalTokens` includes cache/reasoning accounting, while the
portable billable meter is deliberately input plus output; both facts are
kept distinct.

Pi 1.5.0 creates the session file, with the setup entries it buffered, when
the first user or assistant message is appended, and appends each entry
immediately after that; a setup-only session still leaves no file. The user
record is written by Pi's own submission handling, not by the terminal paste,
so prompt submission returns an honest `uncertain` receipt after accepted
terminal automation; later durable observation establishes the turn. Resume captures the byte boundary before
launch, and JSONL replacement/truncation advances a source generation so
deduplication identities cannot collide. Observer failure degrades the
monitor rail without claiming the native TUI process stopped.

## Verification and remaining gate

Deterministic tests cover detection, cwd/session-directory encoding, exact and
unique-prefix resume, managed argv and continuation state, fresh and resumed
journal observation, normalization, compaction and usage semantics,
observation degradation, and the shared agent/monitor conformance suites.

Promotion still requires protected matching-platform runs through each exact
acquired executable proving native TUI launch, durable session attachment,
accepted prompt control, normalized completion, and `--session` resume. Any
session-format version change must reopen the ground-truth and adapter
mapping review rather than being treated as compatible by default.
