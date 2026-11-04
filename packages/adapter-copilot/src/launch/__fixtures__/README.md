# copilot invocation grammar evidence

Captured 2026-11-03 from the native CLI, version 1.0.105 (npm
`@github/copilot-linux-x64`, run in a disposable offline home), using `--version`
and `--help`. 1.0.105 drops `--remote-export` and `--no-remote` (both now native
parse errors) from the parser, and stops listing `--remote` and
`--no-remote-export`, which still parse and stay as hidden rows. It separately
adds `--sync-session[=<on|off>]` (read-only account history sync); whether that
replaces `--remote-export` is not established. These fixtures describe the
command parser, not session state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

Prompt mode and stdio/ACP server mode pass through before managed preparation.
Initial interactive prompts, custom configuration directories, and unsupported
permission clauses are explicit refusals. A name on an exact resume is refused
because the existing launch recipe can name new sessions only. `--reasoning-effort`
is supported; no undocumented `--effort` alias is invented.

`copilot-workflow-help-1.0.105.txt` and `copilot-workflow-run-help-1.0.105.txt`
were captured 2026-11-04 from the same 1.0.105 executable with `workflow --help`
and `workflow run --help`, offline (`COPILOT_OFFLINE=1`) in a disposable home
inside a network namespace with no route off the machine. The group has exactly
one subcommand, `run <name>`, which runs a registered workflow without a parent
agent turn, so the whole `workflow` group stays classed one-shot; `workflow list`
is a native parse error. No other subcommand help is captured.

Reference: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
