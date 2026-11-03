# kimi invocation grammar evidence

Captured 2026-11-03 from the official linux-x64 release executable, version
2.4.1 (SHA-256 `f2b3634c17b604e5b0f0c578b6a787fd01bcafb40a3c0dd62203ae14ff2ea068`),
using `--version` and `--help`, in an isolated home. The `fork` and `session`
nested help is byte-identical to the earlier 2.0.2 capture; the root help adds
the `app [path]` and `import-sessions` commands. These fixtures describe the
command parser, not session state inferred from terminal text.
Machine-specific diagnostics are omitted; trailing whitespace is normalized.
The bidirectional option and command census checks each public spelling against
the grammar table. The matrix separately checks classification and mapping.

Required option values follow Commander consumption, including option-looking
values. The `-S` selector has an optional ID; the managed launch requires an exact
one. The official command reference also documents hidden `-r`/`--resume` and
`--yes`/`--auto-approve` aliases; those have dedicated tests and are excluded from
the public-help census. Legacy Python CLI `--print`/`--wire` flags are not inferred.
`--prompt` is non-interactive; `session` is a non-interactive management group.
`app` hands the directory to the desktop app (`kimi-code://open`), so it runs
elsewhere; `import-sessions` is a standalone interactive import screen that
never starts an agent session. Captured nested help includes `fork` and `session`.

References:

- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html

The normalizer preserves the existing managed launch subset. Remaining
interactive options are explicit refusals, never silently dropped. This grammar
evidence does not promote the Surface/support ledger's adapter version.
