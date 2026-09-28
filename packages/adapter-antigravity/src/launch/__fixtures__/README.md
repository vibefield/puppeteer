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

References:
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/reference/

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
