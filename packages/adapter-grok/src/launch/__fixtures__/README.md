# grok invocation grammar evidence

Captured 2026-09-28 from the installed native CLI, version 1.0.41, using
`--version` and `--help`. These fixtures describe the command parser, not session
state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

The root CLI uses clap-style arity. A required option value cannot be mistaken for
`--help`. `agent` runs protocols and servers without the local interactive UI;
`wrap`, `clone`, and `cursor-worker` also have external ownership. `dashboard`
can open an interactive session and is refused. Captured nested help covers
`agent`, `leader`, `sessions`, and `worktree`. The hidden `--leader` switch is
also used by the existing adapter recipe; the three compatibility aliases are
spelled out in native root help.

Reference: https://docs.x.ai/build/cli/reference

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
