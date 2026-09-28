# pi invocation grammar evidence

Captured 2026-09-28 from the installed native CLI, version 0.87.1, using
`--version` and `--help`. These fixtures describe the command parser, not session
state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

The installed `@earendil-works/pi-coding-agent/dist/cli/args.js` was inspected.
It recognizes split flags and exact multi-letter aliases, not `--flag=value` or
short clusters. Most required values consume the next token verbatim; `--mode`
refuses an option-looking value. Repeated mode flags use the last value: text is
interactive, json is one-shot, rpc is externally driven. Commands are recognized
only at argv[0]. The fixture omits a machine-specific diagnostic path emitted
before help. No native-session support promotion is claimed from this inspection.

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
