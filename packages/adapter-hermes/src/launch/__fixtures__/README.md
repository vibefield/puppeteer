# hermes invocation grammar evidence

Captured 2026-09-28 from the installed native CLI, version 0.21.4, using
`--version` and `--help`. These fixtures describe the command parser, not session
state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

Additional captures: `chat --help` and `sessions --help`. Installed source was
inspected in `hermes_cli/main.py`, `_parser.py`, and `sessions_cmd.py`:
`_scan_profile_flag` consumes `-p`/`--profile` before argument parsing; it is not
print mode. In 0.21.4, `chat -q` can start an interactive conversation on a TTY;
only `--oneshot`, `--quiet`/`-Q`, or stream-json format select a one-shot path.
Root `--oneshot`/`-z` takes a prompt; chat `--oneshot` is boolean. `sessions browse`
calls `relaunch(["--resume", selected_id])` and must be refused. The nested grammar
allows actual management operations while withholding that interactive escape.
`--resume latest` is not an exact session identity and is refused.

References (installed parser takes precedence when documentation differs):
- https://hermes-agent.nousresearch.com/docs/user-guide/cli
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
