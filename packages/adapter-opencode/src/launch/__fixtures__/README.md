# opencode invocation grammar evidence

Captured 2026-09-28 from the installed native CLI, version 1.18.32, using
`--version` and `--help`. These fixtures describe the command parser, not session
state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

Boolean inline values follow the native yargs surface; false values are refused
instead of erased. Managed launches already own the backend and use `--pure`;
exact session selection is supported. `attach`, `serve`, `web`, and `acp` have
external ownership. `github` and `pr` may enter interactive sessions, so they are
refused rather than classed as management utilities.

Reference: https://opencode.ai/v2/docs/cli/commands/

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
