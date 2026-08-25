# Claude Code 2.1.226 capture sanitization

These JSONL files were produced by the isolated census in
`vendors/claude/census/harness.mjs` and sanitized with
`vendors/claude/sanitize-captures.mjs` before entering the repository.

The sanitizer replaces prompts, assistant text, errors, titles, tool content,
and other free-form values with typed redaction markers. UUIDs are mapped to
stable fixture UUIDs, and user-specific filesystem paths are rewritten under
`/workspace`. Raw captures and process logs remain in the gitignored
`captures-raw/claude@2.1.226` directory.

This baseline deliberately used a disposable `CLAUDE_CONFIG_DIR` without user
credentials, settings, plugins, hooks, transcripts, or tokens. It covers the
authentication-independent init and failed headless-turn paths; the evidence
index marks all other officially documented events as unverified.
