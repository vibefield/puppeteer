# Codex CLI grammar census fixtures

`codex --help` and `codex resume --help`, captured verbatim from the release named in the file name.
`invocation-grammar.test.ts` holds every row of `invocation-grammar.ts` to them in both directions: every
option and subcommand the help shows has a row with the same names, arity and values, and every row is in the
help or marked hidden with the probe that found it.

## Refreshing after a codex release

```sh
version=$(codex --version | awk '{print $2}')
codex --help > "codex-help-$version.txt"
codex resume --help > "codex-resume-help-$version.txt"
```

Then set `CODEX_GRAMMAR_VERSION` in `../invocation-grammar.ts` to `$version` and run
`TMPDIR=/tmp pnpm --filter @vibefield/puppeteer-adapter-codex test`. The census goes red with exactly the new and
changed options and subcommands. Class each new row on evidence (the probes and their record are under
`packages/surface/vendors/codex/probes/codex@<version>/`), then delete the previous release's two files.
