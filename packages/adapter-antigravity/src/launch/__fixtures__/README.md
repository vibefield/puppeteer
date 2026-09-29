# antigravity invocation grammar evidence

Captured 2026-09-28 from the installed native CLI, version 1.2.12, using
`--version` and `--help`. These fixtures describe the command parser, not session
state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

The native executable is `agy`. `parse-probes.json` records read-only parser
probes with an isolated home and no model prompts submitted. Raw `--help`, `-h`,
and `--version` tokens are recognized before parsing, even as a would-be value or
after `--`. `--model=--help` is not that raw utility token. `-v` is not a version
alias. `--print`/`--prompt` consumes one value, including an option-looking value;
`--prompt-interactive` remains interactive and is refused.

Correction (2026-09-28): these exact help/version entry shortcuts are not
boolean parser options. A bounded native `--version=true` probe with an empty
temporary home entered terminal UI setup instead of printing the version and
exiting; `--help=true` exited with a help-pattern error. The shortcuts live only
in the exact-token entry check, so inline spellings cannot earn passthrough.
Other actual boolean options retain their native equals syntax.

References:
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/reference/

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
