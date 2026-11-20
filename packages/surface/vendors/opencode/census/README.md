# OpenCode census

Two release lines share this vendor (draft/OPENCODE-2-MIGRATION-PLAN.md §3, option (a), ruled 2026-11-04):

| Line | Harness | Sanitizer | Generator | Evidence trees |
| --- | --- | --- | --- | --- |
| 1.x (verified, canonical) | `harness.mjs` | `sanitize.mjs` | `generate-model.mjs` | `*/opencode@1.19.5` |
| 2.x (census tooling, Part B) | `harness-v2.mjs` | `sanitize-v2.mjs` | `generate-model-v2.mjs` | `*/opencode@<2.x.y>` |

Both harnesses share `harness-common.mjs`. `groundtruth.json`, `upstream.json`'s acquisition, the adapter and the
ledger stay on 1.19.5 until the switch PR. Nothing in the 2.x tooling writes them.

The rest of this file is the 2.x census run, written for the runner that executes it. Every command runs from the
repository root.

## What the run needs

- A darwin-arm64 host (the census executes only native bytes). Node per `.nvmrc` (22.18 or later), `git` on `PATH`.
- No model-provider key and no vendor login. The only model is a loopback fake provider started by the harness.
- Steps 1 to 3 need no `pnpm install`: they import Node built-ins and repository files only. Steps 4 and 5 also
  import `@vibefield/puppeteer-surface/sanitize` (step 4 sanitizes every carrier in memory before writing it), a
  TypeScript file in this package, which Node reaches by package self-reference with its default type stripping. If
  that does not resolve on the runner, run steps 4 and 5 after `pnpm install`.
- An empty scratch directory for `TMPDIR`, under `/tmp` (or `/private/tmp`). Every scenario creates its disposable
  root under it and removes it after. The harness refuses a `TMPDIR` that resolves anywhere else: the privacy
  detector recognizes a leaked `/tmp/…` path by pattern, while a root on another volume would be invisible to it
  wherever no path key redacts it. (The harness also sanitizes every carrier in memory and fails the scenario if the
  disposable root survives, so a missed key is caught either way.)

## Hosts

| Step | Hosts |
| --- | --- |
| 1 to 3 (version and acquisition) | `registry.npmjs.org` only, over HTTPS. No npm client runs, so no npm rc file is read. |
| 4 (census) | `127.0.0.1` only: the private `opencode serve`, the fake provider, and a connect probe on port 49374. |
| 5 (sanitize) | none |

The census binary is configured for no outbound connection: the only provider is the loopback fake,
`OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, and `update: "disable"` in its private config
directory. The harness itself does no per-process read (no `ps`, `lsof` or `top`). It cannot prove that the binary
made no other connection. Its evidence is that configuration, the fake provider's inbound connection count, and the
49374 probe. If a hard egress guarantee is wanted, the operator wraps step 4 in a deny-egress sandbox. That is the
operator's call, and the harness does not ship one.

## 1. Pick the version

```sh
node packages/surface/vendors/opencode/census/acquire-v2.mjs --resolve-latest
```

This prints the latest stable `@opencode/cli` (2.2.5 on 2026-11-04). It refuses a prerelease or a non-2.x
`latest`. Call the printed version `V` below. Then check that all four platform packages publish `V` with the
tarball URL the census policy builds. This reads metadata only and downloads nothing:

```sh
node packages/surface/vendors/opencode/census/acquire-v2.mjs --version V --check-platforms
```

## 2. Acquire the 2.x binary (never executed by this step)

```sh
node packages/surface/vendors/opencode/census/acquire-v2.mjs --version V --platform darwin-arm64
```

The step:

- reads `https://registry.npmjs.org/@opencode%2fcli-darwin-arm64/V` and requires it to name
  `https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-V.tgz`;
- downloads that tarball through the governed `fetchArtifact`;
- checks the tarball's sha512 against the registry before anything is extracted or written;
- extracts exactly one `opencode`;
- reads (does not run) `codesign -dv` for the TeamIdentifier.

Output, gitignored:

- `packages/surface/vendors/opencode/captures-raw/artifacts/opencode@V/darwin-arm64/opencode`
- `packages/surface/vendors/opencode/captures-raw/artifacts/opencode@V/darwin-arm64/artifact.json`, holding the binary
  and tarball sha256, the integrity, the TeamIdentifier, `sourceTag`, and `sourceRevision: null`. Step 4 hashes the
  binary against it before running it.

## 3. Acquire the 1.19.5 seed (for the store-migration scenario)

```sh
node packages/surface/vendors/opencode/census/acquire-v2.mjs --seed --platform darwin-arm64
```

This goes through the governed `downloadAgentArtifact` with today's `upstream.json` (still the 1.x template). The
download lands as `opencode.unverified`, not executable. Only bytes whose sha256 equals the ledger's own darwin-arm64
digest for opencode 1.19.5 (read from `support/agents.json` before anything is fetched) are renamed to `opencode`;
other bytes are removed. Do this before the switch PR flips `upstream.json`, because afterwards the 1.x bytes can no
longer be fetched this way. Output: `captures-raw/artifacts/opencode@1.19.5/darwin-arm64/{opencode,artifact.json}`.

## 4. Run the census

```sh
export TMPDIR=<an empty scratch directory under /tmp>
A=packages/surface/vendors/opencode/captures-raw/artifacts
node packages/surface/vendors/opencode/census/harness-v2.mjs \
  --artifact "$A/opencode@V/darwin-arm64/opencode" \
  --artifact-metadata "$A/opencode@V/darwin-arm64/artifact.json" \
  --version V \
  --seed-artifact "$A/opencode@1.19.5/darwin-arm64/opencode"
```

`--artifact` and `--artifact-metadata` are required; there is no `PATH` lookup. Before anything runs, the harness
hashes the binary and requires the metadata's `vendor`, `version`, this host's platform and `sha256` to match, and,
when a seed scenario is selected, hashes the seed against the ledger's 1.19.5 digest for this host.

Environment the harness reads from the runner: `TMPDIR`, `PATH` (passed on, as in the 1.x census),
`SHELL`/`LANG`/`LC_ALL` (passed on), and optionally `PUPPETEER_OPENCODE_BIN`, `PUPPETEER_OPENCODE_METADATA`,
`PUPPETEER_OPENCODE_VERSION` and `PUPPETEER_OPENCODE_SEED_BIN` in place of the four flags. Nothing else from the
runner's environment reaches the binary: each launch gets a fully replaced environment. That environment has a
private HOME, TMPDIR, XDG and OpenCode directories, and a password generated in memory and passed only as
`OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`. The controlled workspace's `git init` runs without the runner's
global or system git config. `run.json` records every variable the launch sets, with what is known about it.

Flags:

- `--scenario NAME` runs one scenario.
- `--set core|extended|all` picks a set. The default is `all`.
- `--stop-on-failure` stops at the first failure. Otherwise a failed scenario is recorded and the run goes on.
- `--skip-probes` skips the offline probes.
- `--output DIR` and `--probes-output DIR` move the outputs.
- `--allow-host-config` overrides the host-config refusal (see "Refusals and failures"). Use it only with a maintainer's
  approval.

Scenarios.

- Core: `turn`, `title-generation`, `tool-read` (`read {path}`), `tool-shell`, `tool-failure` (the 1.x
  `read {filePath}` shape), `subagent`, `resume` (backend restart, exact session, `GET /api/session?directory=`,
  `opencode session list --server … --format json`, `opencode service status`), `event-stream` (`/api/event` `data:`
  frames, `types` filter, unknown type 400, unauthenticated 401) and `store-migration` (needs `--seed-artifact`).
- Extended, model-driven: `interrupt-stream`, `interrupt-tool` (a running `shell` `sleep 30`), `reconnect-seq-gap`,
  `provider-retry`, `provider-error`, `manual-compaction`, `auto-compaction`, `overflow-compaction` (a 413 from the
  provider), `unknown-context` (context limit 0), `file-write` and `file-edit`. The `write {path, content}` and
  `edit {path, oldString, newString}` inputs are inferred from the 2.x `read {path}` rename and are unverified until
  this run; a wrong key ends in `session.tool.failed`, which names it, and the scenario fails.
- Extended, model-free operations: `permission-once`, `permission-always`, `permission-reject` (a session `ask`
  ruleset, `session.permission.create`, a `{decision}` reply, then a settled reply, the 1.x `{reply}` body and an
  unknown request), and `session-lifecycle` (rename, metadata, archive, unarchive, fork, delete of the fork). The
  permission scenarios make no model request; `session-lifecycle` first makes one scripted turn, so the session has a
  history to fork. Their routes and bodies are taken from the served `/openapi.json`; when the census's fields do not
  fit the served schema, the scenario fails and names the schema's own fields. A metadata, archive or unarchive write
  is found by its own route, else by the session's own write whose body declares the field (2.2.5 serves all three
  through `session.update`, `PATCH /api/session/{sessionID}`, with `metadata` and `archived`). A write the served
  document does not declare is recorded as `<step>-supported: false` with a note naming every form looked for, and the
  lifecycle goes on; a write that is found and then misbehaves fails the scenario.

Each scenario records named checks. A hard check (the unauthenticated 401s, the out-of-band title and subagent
calls, the kept caller message id, `interrupted`, the CLI `session list` over `--server`, `service status` reporting
`stopped`, the file contents after a write or edit, the permission reply carried as `reply`) fails the scenario. The
rest are informational: they are printed when false, kept in `manifest.json`, and carried into the committed
`census-run.json`.

Outputs, all gitignored, under `packages/surface/vendors/opencode/`:

- `captures-raw/opencode@V/<scenario>/`:
  - `manifest.json` holds `outcome`, named `checks`, `notes`, the 49374 probe before, its count and after, the
    provider's request and connection counts, and the openapi sha256.
  - `events.jsonl` holds every `/api/event` record. `events-<phase>.jsonl` holds the same per stream phase.
  - `http-roundtrip.jsonl`, `provider-requests.jsonl` (with headers), `state.jsonl` (the session, its messages and
    context, `/api/config`), `cli.jsonl` and `server.log`.
  - A failed scenario writes `outcome: "failed"`, `failure`, and `*.failure.jsonl`/`server.failure.log` instead.
- `captures-raw/opencode@V/run.json`: per-scenario outcomes, the informational checks that failed, the environment
  table, and host inputs by label (no paths). It is a raw run note and is never promoted.
- `captures-raw/opencode@V.probes/`:
  - `version.txt` (the binary must print `opencode vV` before any other probe runs), `help/<command>.txt` for every
    command path of `draft/opencode-2/invocation-grammar.json`, and `help.json` (`commandPath` and exit status per
    page). The probe root is replaced by `<probe-root>`.
  - `openapi.json`: the first scenario's `/openapi.json`, byte for byte. Later scenarios check that theirs is
    identical.
  - `artifact.json`: the step 2 metadata, copied after its sha256 is checked against the binary.

The console prints one line per scenario (event count, provider requests, terminal event, event types, and any
informational check that failed) and the two output roots, relative to the repository.

Refusals and failures:

- The run refuses to start when `TMPDIR` resolves outside `/private/tmp` or `/private/var/folders`, when the binary
  or the seed does not match its digest, or when port 49374 is already open (a running OpenCode service would make
  the probe meaningless and would answer the census's `service status`).
- The run refuses to start when a host-wide OpenCode input that 2.x reads and the census cannot redirect is present.
  These are `/Library/Application Support/opencode` and the managed-preferences plists `ai.opencode.managed`. They
  are stat'ed only, never opened.
- The operator's own OpenCode homes (`~/.local/share/opencode`, `~/.local/state/opencode`, `~/.config/opencode`,
  `~/.opencode`) and their known files (`opencode.db` with its `-wal` and `-shm`, `auth.json`,
  `latest/tui/tabs.json`, the `opencode.json`/`opencode.jsonc`/`config.json` config files, `bin/opencode`) are
  stat'ed before and after, never opened or listed. A change in presence, size or mtime fails the run.
- A scenario fails when port 49374 is open before it, after any turn or CLI call, or at its end.
- A scenario fails, before any raw file is written, when a carrier still holds the disposable root after the 2.x
  sanitization, or when a carrier or its manifest holds the server password. Raw logs and failure dumps are written
  with the password scrubbed.
- The process exits 1 when any scenario failed or a watched home changed.

## 5. Sanitize (after reading the run)

```sh
node packages/surface/vendors/opencode/census/sanitize-v2.mjs --version V
```

(The same command is the package script `surface:sanitize:opencode:v2`.)

This writes, all-or-nothing, after the 2.x privacy check (`opencodeV2Rules` in `../privacy.mjs`, plus a
key-independent check that refuses any number in the epoch-millisecond range other than a pinned clock):

- `captures/opencode@V/`: the JSONL carriers of passed scenarios only, plus `census-run.json` (with each scenario's
  named checks), `capture-fidelity.json` and `SANITIZATION.md`;
- `probes/opencode@V/`: an allow-list, `version.txt`, `help/<command>.txt`, `help.json` and `artifact.json`, verbatim,
  only when no unsafe pattern matches (and, for the JSON files, the 2.x rules find nothing). `openapi.json` goes to
  references; anything else in the raw probes tree stays raw;
- `references/opencode@V/`: `openapi.json` byte for byte, and `SOURCE.json`.

Each destination is replaced whole, so once it exists it must be the vendor's own `<kind>/opencode@<2.x.y>`; the
script refuses any other existing `--out`, `--probes-out` or `--references-out` (`generate-model-v2.mjs` does the
same for `--out` under `model/`).

`node packages/surface/vendors/opencode/census/sanitize-v2.mjs --version V --check-only` runs the same checks on the
committed trees (captures, the probes allow-list, and the references with `SOURCE.json`'s digest). Nothing is
committed by the script.

## After the run (not the runner's steps)

1. A reviewer records the commit of tag `vV` as `sourceRevision` in `probes/opencode@V/artifact.json`.
2. With an opencode checkout at `vV` (github.com, a host outside this run), build the exact-source event contract:
   `node packages/surface/vendors/opencode/census/event-contract-v2.mjs --version V --source-root <checkout>`.
   It refuses a draft from another tag. When `V` is not 2.2.5, re-derive `draft/opencode-2/event-contract.json` at
   `vV` first.
3. Author `census/behavior-v2.seed.json` from the census event order. The generator needs a reviewed seed.
4. `node packages/surface/vendors/opencode/census/generate-model-v2.mjs --version V` writes
   `model/opencode@V/`. Only a 2xx answer verifies an HTTP operation; an operation the census saw only refused stays
   unverified and its notes name the statuses. It never writes `groundtruth.json`. The canonical file flips only in
   the switch PR (`surface:groundtruth:write -- packages/surface/vendors/opencode/model/opencode@V`).
5. Before step 4's output is committed (planner step C3), `audit.mjs`, `model.test.ts` and `captures.test.ts` need a
   2.x path (shape-aware route matching, the event contract, `opencodeV2Rules`); today they audit 1.19.5 only.

## Not covered yet

Plan B9 items with no scenario, each with the reason (`NOT_COVERED_V2` in `harness-v2.mjs` holds the same list):

- form reply/cancel/invalid/settled: the form create body (Form `Info`) and the answer (`Answer`) are recorded
  nowhere. The plan gives only the status codes (§2.1), and the event contract leaves both unresolved. The first
  run's `references/opencode@V/openapi.json` names them.
- file delete: the tool set the 2.2.5 server offered (plan §2.5 i) has no delete tool and no `apply_patch`. A delete
  through `shell` would prove the shell tool, not a file operation.
- background subagents: no background flag of the 2.x `subagent` input is recorded, and
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` is carried from 1.x with its 2.x effect unproven.
- TUI on --server in a PTY: Node has no PTY without a native module, and the census runs headless (the 1.x attach
  census needed an interactive TTY). `resume` covers `--server` for the CLI, and the 49374 probe runs after every
  CLI call.
- MCP tool call through Code Mode execute: it needs a stdio MCP server fixture and the `execute` tool input, neither
  recorded. How a call inside `execute` appears on the stream is still an open question (plan §5).

Also open:

- The census writes no `disabled` service config into its private config directory (plan §2.4 names that guard
  without its key or file, and an unverified key in 2.x's validated config could refuse every launch). Every CLI call
  but `service status` passes `--server`, and the 49374 probe runs after each.
- Any non-darwin census. The other platforms are acquired and hashed in a later step, never executed here.
- Every variable marked "carried from 1.x" in `run.json` must be checked against the 2.x source at `vV` before the
  census is cited.
