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
print mode. In 0.21.4, `chat -q` can start an interactive conversation on a TTY.
Root `--oneshot`/`-z` takes a prompt; chat `--oneshot` is boolean. `sessions browse`
calls `relaunch(["--resume", selected_id])` and must be refused. The nested grammar
allows actual management operations while withholding that interactive escape.
`--resume latest` is not an exact session identity and is refused.

Correction (2026-09-28): chat `--oneshot` and `--quiet`/`-Q` do not alone prove
one-shot mode. Without input they enter the classic REPL; the configured TUI
also takes precedence even with a query. The grammar requires explicit `--cli`
plus a nonempty query, query-file path, or image and an exit/quiet flag.
`_read_query_file` exits on unreadable/empty files before the classic loop.
Stream-json explicitly rules out the TUI (invalid combinations exit), and a
nonempty root `-z` prompt dispatches before chat preferences. Empty root prompts
are refused. Option values and repeated selectors are resolved before this decision.

`dispatch-probes.json` records the installed parser and dispatch source hashes,
TTY/TUI preconditions, and fourteen observed routes. The native functions ran
with provider setup and process/model execution replaced by route sentinels;
no credentials, network, or model turn was used. It includes forced classic mode,
TUI precedence, absent/empty queries, and empty query files. The adapter test
checks its decisions against these captured native routes.

References (installed parser takes precedence when documentation differs):
- https://hermes-agent.nousresearch.com/docs/user-guide/cli
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
