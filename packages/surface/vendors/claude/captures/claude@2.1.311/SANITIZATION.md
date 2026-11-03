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

Every lane ran the pinned linux-x64 artifact in a disposable HOME, `CLAUDE_CONFIG_DIR`, and
TMPDIR with nothing inherited from the caller's environment and a keychain stub first on PATH.
Every lane that talks to a model named the census's own loopback Messages API with a placeholder
token; every other execution named the fail-closed endpoint `http://127.0.0.1:0`
(`census/isolation.mjs`).

**No `headless` lane.** On the hosted Linux container that ran this census, the artifact sent an
`Authorization` header even with an empty environment, so the "no credential at all" print lane
was not credential-less there: its first run reached the real API. That run is not committed;
`findings.md` (2.1.311) records the incident and the fail-closed default added because of it. The
`headless` mode needs a host on which the artifact holds no credential.

| Mode | Lane |
| --- | --- |
| `init` | `--init-only` |
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

`ordering.json`, `transcript-shape.json`, and `statusline-shape.json` are value-free
projections (event names, enum discriminators, record types, key names, counts) declared
as `semantic-projection` in `capture-fidelity.json`. Raw transcripts, status-line payloads,
and process logs remain in the gitignored `captures-raw/claude@2.1.311` and
`captures-raw/claude@2.1.311-aux` directories.
