# pi invocation grammar evidence

Captured 2026-11-03 from the native CLI, version 1.5.0 (npm
`@earendil-works/pi-coding-agent`, `--ignore-scripts`, run in a disposable offline
home), using `--version` and `--help`. 1.5.0 adds the `mcp` command and
`--no-mcp`, keeps `--export` at one value (its `[output]` is a positional), makes
fullscreen the default `--tui-mode`, and refuses `--provider` without `--model`
(`Error: --provider requires --model`, probed). These fixtures describe the command parser, not session
state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

The installed `@earendil-works/pi-coding-agent/dist/cli/args.js` was inspected (0.87.1; re-read for the
changed options at 1.5.0).
It recognizes split flags and exact multi-letter aliases, not `--flag=value` or
short clusters. Most required values consume the next token verbatim; `--mode`
refuses an option-looking value. Repeated mode flags use the last value: text is
interactive, json is one-shot, rpc is externally driven. Commands are recognized
only at argv[0]. The fixture omits a machine-specific diagnostic path emitted
before help. No native-session support promotion is claimed from this inspection.

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
