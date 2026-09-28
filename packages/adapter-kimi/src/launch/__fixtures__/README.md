# kimi invocation grammar evidence

Captured 2026-09-28 from the installed native CLI, version 2.0.2, using
`--version` and `--help`. These fixtures describe the command parser, not session
state inferred from terminal text. Machine-specific diagnostics are omitted;
trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

Required option values follow Commander consumption, including option-looking
values. The `-S` selector has an optional ID; the managed launch requires an exact
one. The official command reference also documents hidden `-r`/`--resume` and
`--yes`/`--auto-approve` aliases; those have dedicated tests and are excluded from
the public-help census. Legacy Python CLI `--print`/`--wire` flags are not inferred.
`--prompt` is non-interactive; `session` is a non-interactive management group.
Captured nested help includes `fork` and `session`.

References:
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
