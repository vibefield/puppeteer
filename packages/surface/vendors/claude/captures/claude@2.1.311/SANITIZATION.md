# Claude Code 2.1.311 capture sanitization

These files were produced by the isolated census in `vendors/claude/census/harness.mjs`
and sanitized with `vendors/claude/sanitize-captures.mjs` before entering the repository:

```sh
node packages/surface/vendors/claude/census/harness.mjs \
  --artifact packages/surface/vendors/claude/captures-raw/artifact-2.1.311/claude --version 2.1.311 \
  --lanes init,api-error,interactive
node packages/surface/vendors/claude/sanitize-captures.mjs \
  packages/surface/vendors/claude/captures-raw/claude@2.1.311 \
  packages/surface/vendors/claude/captures/claude@2.1.311
node packages/surface/vendors/claude/sanitize-captures.mjs --check \
  packages/surface/vendors/claude/captures/claude@2.1.311
```

The `headless` mode came from a second run on 2026-11-04, merged into this set:

```sh
node packages/surface/vendors/claude/census/harness.mjs \
  --artifact packages/surface/vendors/claude/captures-raw/artifact-2.1.311/claude --version 2.1.311 \
  --lanes headless
node packages/surface/vendors/claude/sanitize-captures.mjs --merge \
  packages/surface/vendors/claude/captures-raw/claude@2.1.311 \
  packages/surface/vendors/claude/captures/claude@2.1.311
```

Every lane ran the pinned linux-x64 artifact in a disposable HOME, `CLAUDE_CONFIG_DIR`, and
TMPDIR with nothing inherited from the caller's environment and a keychain stub first on PATH.
Every lane that talks to a model named the census's own loopback Messages API with a placeholder
token; every other execution named the fail-closed endpoint `http://127.0.0.1:0`
(`census/isolation.mjs`).

**The `headless` lane ran separately, in the network-deny sandbox.** On the hosted Linux container
that ran the first census, the artifact sent an `Authorization` header even with an empty
environment. The "no credential at all" print lane was therefore not credential-less there, and its
first run reached the real API. That run is not committed. The artifact reads a fixed
remote-session credential path that no environment can hide (`findings.md`, 2.1.311).

The committed `headless` mode comes from the 2026-11-04 run. That run used the census network-deny
sandbox (`census/sandbox.mjs`): a fresh user, network and mount namespace with only loopback, that
credential directory and the caller's home hidden, and a scrubbed environment. Before the artifact
ran, the namespace showed that every public and caller-proxy destination was refused. The lane's
loopback tripwire received no request, and no egress attempt was recorded. `sandbox.json` keeps that
proof for the modes it names. The other modes ran on 2026-11-03 without the sandbox.

| Mode | Lane |
| --- | --- |
| `init` | `--init-only` |
| `headless` | print turn with no credential; its model endpoint was a loopback tripwire that received no request |
| `api-error-<status>` | print turn; the loopback API answered that HTTP status |
| `interactive` | native TUI: plain, tool, failing tool, write, denied permission, background Agent, file and settings change, cd, `/compact`, `/model`, `/add-dir`, `/clear`, `/exit` |
| `resume` | `--resume <id>` of the interactive session, one turn, `/exit` |

Hook payloads arrived at a loopback sink in the adapter's own hook shape (SessionStart and
Setup through the command forwarder, every other event over HTTP with an interpolated
bearer), so each `<mode>/<Event>.jsonl` line is the native hook JSON before normalization.

The sanitizer applies the shared conservative engine plus Claude's rules in
`vendors/claude/privacy.mjs`: prompts, assistant text, tool content, error text, titles,
compaction summaries, task and background-task descriptions, MCP server names, and other
user-authored values become typed redaction markers; ids become stable shape-preserving
pseudonyms, so session, prompt, turn, and tool joins survive; every path, including
`scratchpad_dir`, added directories, and permission-suggestion directories, is rewritten
under `/workspace`. The closed StopFailure `error` and SessionEnd `reason` enums are kept
as protocol constants.

`ordering.json`, `transcript-shape.json`, `statusline-shape.json`, and `sandbox.json` are value-free
projections (event names, enum discriminators, record types, key names, counts; for the sandbox
proof, interface names, route counts, probe destinations and error codes) declared
as `semantic-projection` in `capture-fidelity.json`. Raw transcripts, status-line payloads,
and process logs remain in the gitignored `captures-raw/claude@2.1.311` and
`captures-raw/claude@2.1.311-aux` directories.
