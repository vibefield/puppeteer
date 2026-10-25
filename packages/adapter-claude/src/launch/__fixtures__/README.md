# Claude help captures

`claude-help-<version>.txt` is `claude --help` exactly as that version prints it. The census in
`../invocation-grammar.test.ts` holds `CLAUDE_OPTIONS` and `CLAUDE_SUBCOMMANDS` to the newest capture in
both directions, and fails while the newest capture is not the version `CLAUDE_INVOCATION_GRAMMAR_VERSION`
names.

After a Claude Code release, capture the help of the **exact downloaded artifact** — never a `claude`
on `PATH` — in a disposable environment, beside the old capture (run from the repository root):

```sh
node --input-type=module -e "
import { probeClaude, claudeVersionOf } from './packages/surface/vendors/claude/census/harness.mjs';
import { writeFileSync } from 'node:fs';
const artifact = process.argv[1];
const { version } = claudeVersionOf(artifact);
writeFileSync('packages/adapter-claude/src/launch/__fixtures__/claude-help-' + version + '.txt', probeClaude(artifact, ['--help']) + '\n');
" .agent-adaptation/artifacts/claude@<version>/<platform>/claude
```

`probeClaude` runs the artifact with a throwaway HOME, `CLAUDE_CONFIG_DIR` and TMPDIR and nothing inherited
from the caller (`census/isolation.mjs`). The capture must be byte-identical to the Surface's
`packages/surface/vendors/claude/probes/claude@<version>/help.txt`.

The census then lists exactly the options and subcommands that were added, removed or changed. Classify
each from evidence (the help, `packages/surface/vendors/claude/findings.md`, the probes under
`probes/claude@<version>/`), record the evidence there, bump the version, and delete the old capture.
