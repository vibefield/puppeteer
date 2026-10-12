# copilot invocation grammar evidence

Captured 2026-09-28 from the installed native CLI, version 1.0.88, using
`--version` and `--help`. These fixtures describe the command parser, not session
state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

Prompt mode and stdio/ACP server mode pass through before managed preparation.
Initial interactive prompts, custom configuration directories, and unsupported
permission clauses are explicit refusals. A name on an exact resume is refused
because the existing launch recipe can name new sessions only. `--reasoning-effort`
is supported; no undocumented `--effort` alias is invented.

Reference: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
