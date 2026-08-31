# Pi 0.84.3 surface findings

Status: canonical ground truth, adapter, Imposter persona, built-in provider,
and local conformance are implemented. The baseline remains
`baseline-pending` until a guarded, matching-platform native-TUI/resume lane is
implemented and records artifact-bound durable-observation receipts on all
four platforms.

## Ground truth and identity

The vendor-root `groundtruth.json` is the single Puppeteer truth artifact. It
is generated from the complete Rosetta `rosetta-groundtruth/1` inventory,
controlled `0.84.3` fixtures, and the pinned open-source writer contract.
Version 3 session JSONL is authoritative; branch summaries,
extension-defined custom entries, and labels remain writer-backed where no
controlled fixture exists.

Official acquisition uses the four platform release assets from
`earendil-works/pi`. The executable version is probed from the extracted
artifact before it can enter the evidence workflow.

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

Pi flushes a user message with the first assistant record rather than at
terminal submission time. Prompt submission therefore returns an honest
`uncertain` receipt after accepted terminal automation; later durable
observation establishes the turn. Resume captures the byte boundary before
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
accepted prompt control, normalized completion, and `--session` resume. Pi is
pre-1.0, so any session-format version change must reopen the ground-truth and
adapter mapping review rather than being treated as compatible by default.
