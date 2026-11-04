# opencode invocation grammar evidence

Captured 2026-11-03 from the governed linux-x64 1.19.5 artifact
(`packages/surface/vendors/opencode/probes/opencode@1.19.5/help.txt`) in an
isolated home. These fixtures describe the command parser, not session state
inferred from terminal text. Machine-specific diagnostics are omitted; trailing
whitespace is normalized. Against the previous 1.18.32 fixture the only change is
the `import` description (1.19.5 imports a JSON file only, no URL); every command,
alias, and root option is unchanged.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

Boolean inline values follow the native yargs surface; false values are refused
instead of erased. Managed launches already own the backend and use `--pure`;
exact session selection is supported. `attach`, `serve`, `web`, and `acp` have
external ownership. `github` and `pr` may enter interactive sessions, so they are
refused rather than classed as management utilities.

Correction (2026-09-28): yargs resolves help/version after parsing, not on first
sighting. Isolated-home native probes reproduced TUI startup for
`--help --help=false`, `--version --version=false`, and `--help false`.
The control `--help` and the re-enabled `--help=false --help` printed help and
exited. The reader therefore defers utility options, consumes separated literal
booleans, and cancels a prior mode on false. Unknown negation syntax is refused;
payloads and operands after `--` do not cancel an active help flag.

Reference: https://opencode.ai/v2/docs/cli/commands/

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
