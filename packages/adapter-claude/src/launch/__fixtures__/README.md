# Claude help captures

`claude-help-<version>.txt` is `claude --help` exactly as that version prints it. The census in
`../invocation-grammar.test.ts` holds `CLAUDE_OPTIONS` and `CLAUDE_SUBCOMMANDS` to the newest capture in
both directions, and fails while the newest capture is not the version `CLAUDE_INVOCATION_GRAMMAR_VERSION`
names.

After a Claude Code release, capture it beside the old one (run from the repository root):

```sh
claude --help > "packages/adapter-claude/src/launch/__fixtures__/claude-help-$(claude --version | cut -d' ' -f1).txt"
```

The census then lists exactly the options and subcommands that were added, removed or changed. Classify
each from evidence (the help, `packages/surface/vendors/claude/findings.md`, a probe), record the evidence
there, bump the version, and delete the old capture.
