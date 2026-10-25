# grok invocation grammar evidence

Captured from the exact Grok 1.0.70 darwin-arm64 artifact
(`grok 1.0.70 (f50904eaee6c)`, sha256 `5c8a6882…cec`) by
`packages/surface/vendors/grok/census/harness.mjs --probes-only`, in a disposable
HOME/GROK_HOME with an explicit environment. Each fixture is a copy of a file in
`packages/surface/vendors/grok/probes/grok@1.0.70/` with trailing whitespace
normalized. These fixtures describe the command parser, not session state inferred
from terminal text.

| Fixture                                 | Probe file                      | argv                       |
| --------------------------------------- | ------------------------------- | -------------------------- |
| `grok-help-1.0.70.txt`                  | `help-long.txt`                 | `help` (the long form)     |
| `grok-agent-help-1.0.70.txt`            | `agent-help.txt`                | `help agent`               |
| `grok-leader-help-1.0.70.txt`           | `leader-help.txt`               | `leader --help`            |
| `grok-leader-worker-help-1.0.70.txt`    | `leader-worker-help.txt`        | `leader worker --help`     |
| `grok-sessions-help-1.0.70.txt`         | `sessions-help.txt`             | `sessions --help`          |
| `grok-worktree-help-1.0.70.txt`         | `worktree-help.txt`             | `worktree --help`          |
| `grok-worker-help-1.0.70.txt`           | `worker-help.txt`               | `worker --help`            |
| `grok-cursor-worker-help-1.0.70.txt`    | `hidden-cursor-worker-help.txt` | `cursor-worker --help`     |
| `grok-parse-probes-1.0.70.txt`          | `parse-probes.txt`              | value-less alias misuse    |
| `grok-global-optspecs-1.0.70.fish`      | `completions.fish` lines 1–4    | `completions fish`         |

Since 1.0.70, `--help`/`-h` print the short clap summary; `grok help` prints the long
form the census reads (both forms list the same options).

The census holds the grammar to this evidence in both directions:

- every option of the long help, with its `[aliases: …]` lines and its arity, has
  exactly one non-hidden row, and every non-hidden row is in the help;
- a hidden option row is either an alias clap resolves to a public option — its
  canonical option is the one clap names in `grok-parse-probes` (for example
  `--print` → `--single`, `--yolo`/`--dangerously-skip-permissions` →
  `--always-approve`, `--append-system-prompt` → `--rules`) and the row must classify
  exactly as that option — or a root option the help omits, whose arity
  `__fish_grok_global_optspecs` records (`=` when it takes a value);
- every command and alias of the help has a row; `cursor-worker` is the one hidden
  command, recorded by its own help;
- the nested `leader` grammar matches `grok leader --help`.

The root CLI uses clap-style arity. A required option value cannot be mistaken for
`--help`. `agent` runs protocols and servers without the local interactive UI;
`wrap`, `clone`, `worker`, `cursor-worker`, and `leader worker` also have external
ownership (a Cursor private worker's agents do not live in this process). The rest of
`leader` manages leader processes. `dashboard` can open an interactive session and
is refused. `--add-dir` is refused: a resumed session keeps the folders it was
created with, and Grok's ACP `initialize` advertises no `additionalDirectories`
capability through which the managed launch could carry them. The hidden
headless/daemon-only options (`--mode`, `--header`, `--harness`, …) are refused for an
interactive session and pass through beside a one-shot. The hidden `--leader` switch
is used by the adapter's own recipe.

Reference: https://docs.x.ai/build/cli/reference

The normalizer preserves the existing managed launch subset. Remaining interactive
options are explicit refusals, never silently dropped. This grammar evidence does not
promote the Surface/support ledger's adapter version.
