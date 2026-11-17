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
- Steps 1 to 4 need no `pnpm install`: they import Node built-ins and repository files only. Step 5 imports
  `@vibefield/puppeteer-surface/sanitize`, a TypeScript file in this package, which Node reaches by package
  self-reference with its default type stripping. If that does not resolve on the runner, run step 5 after
  `pnpm install`.
- An empty scratch directory for `TMPDIR`, under `/tmp` (or `/private/tmp`). Every scenario creates its disposable
  root under it and removes it after. Keep it under `/tmp`: the privacy detector recognizes a leaked `/tmp/…` path
  by pattern, but a root on another volume would be invisible to it wherever no path key redacts it.

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
- checks the tarball's sha512 against the registry;
- extracts exactly one `opencode`;
- reads (does not run) `codesign -dv` for the TeamIdentifier.

Output, gitignored:

- `packages/surface/vendors/opencode/captures-raw/artifacts/opencode@V/darwin-arm64/opencode`
- `packages/surface/vendors/opencode/captures-raw/artifacts/opencode@V/darwin-arm64/artifact.json`, holding the binary
  and tarball sha256, the integrity, the TeamIdentifier, `sourceTag`, and `sourceRevision: null`.

## 3. Acquire the 1.19.5 seed (for the store-migration scenario)

```sh
node packages/surface/vendors/opencode/census/acquire-v2.mjs --seed --platform darwin-arm64
```

This goes through the governed `downloadAgentArtifact` with today's `upstream.json` (still the 1.x template). It
requires the binary's sha256 to equal the ledger's own darwin-arm64 digest for opencode 1.19.5, read from
`support/agents.json`. Do this before the switch PR flips `upstream.json`, because afterwards the 1.x bytes can no
longer be fetched this way. Output: `captures-raw/artifacts/opencode@1.19.5/darwin-arm64/{opencode,artifact.json}`.

## 4. Run the census

```sh
export TMPDIR=<an empty scratch directory under /tmp>
A=packages/surface/vendors/opencode/captures-raw/artifacts
node packages/surface/vendors/opencode/census/harness-v2.mjs \
  --artifact "$A/opencode@V/darwin-arm64/opencode" \
  --version V \
  --seed-artifact "$A/opencode@1.19.5/darwin-arm64/opencode" \
  --artifact-metadata "$A/opencode@V/darwin-arm64/artifact.json"
```

Environment the harness reads from the runner: `TMPDIR`, `PATH` (passed on, as in the 1.x census),
`SHELL`/`LANG`/`LC_ALL` (passed on), and optionally `PUPPETEER_OPENCODE_BIN`, `PUPPETEER_OPENCODE_VERSION` and
`PUPPETEER_OPENCODE_SEED_BIN` in place of the three flags. Nothing else from the runner's environment reaches the
binary: each launch gets a fully replaced environment. That environment has a private HOME, TMPDIR, XDG and OpenCode
directories, and a password generated in memory and passed only as `OPENCODE_PASSWORD` and
`OPENCODE_SERVER_PASSWORD`. `run.json` records every variable it sets, with what is known about it.

Flags:

- `--scenario NAME` runs one scenario.
- `--set core|extended|all` picks a set. The default is `all`.
- `--stop-on-failure` stops at the first failure. Otherwise a failed scenario is recorded and the run goes on.
- `--skip-probes` skips the offline probes.
- `--output DIR` and `--probes-output DIR` move the outputs.
- `--allow-host-config` overrides the host-config refusal (see "Refusals and failures"). Use it only with VF-PM's
  word.

Scenarios. Core: `turn`, `title-generation`, `tool-read` (`read {path}`), `tool-shell`, `tool-failure` (the 1.x
`read {filePath}` shape), `subagent`, `resume` (backend restart, exact session, `GET /api/session?directory=`,
`opencode session list --server … --format json`, `opencode service status`), `event-stream` (`/api/event` `data:`
frames, `types` filter, unknown type 400, unauthenticated 401) and `store-migration` (needs `--seed-artifact`).
Extended: `interrupt-stream`, `reconnect-seq-gap`, `provider-retry`, `provider-error` and `manual-compaction`.

Outputs, all gitignored, under `packages/surface/vendors/opencode/`:

- `captures-raw/opencode@V/<scenario>/`:
  - `manifest.json` holds `outcome`, named `checks`, `notes`, the 49374 probe before and after, the provider's request
    and connection counts, and the openapi sha256.
  - `events.jsonl` holds every `/api/event` record. `events-<phase>.jsonl` holds the same per stream phase.
  - `http-roundtrip.jsonl`, `provider-requests.jsonl` (with headers), `state.jsonl` (the session, its messages and
    context, `/api/config`), `cli.jsonl` and `server.log`.
  - A failed scenario writes `outcome: "failed"`, `failure`, and `*.failure.jsonl`/`server.failure.log` instead.
- `captures-raw/opencode@V.probes/`:
  - `version.txt`, `help/<command>.txt` for every command path of `draft/opencode-2/invocation-grammar.json`, and
    `help.json` (exit status per page). The probe root is replaced by `<probe-root>`.
  - `openapi.json`: the first scenario's `/openapi.json`, byte for byte. Later scenarios check that theirs is
    identical.
  - `artifact.json`: copied from step 2 after its sha256 is checked against the binary.
  - `run.json`: per-scenario outcomes, the environment table, and host inputs by label (no paths, no clocks).

The console prints one line per scenario (event count, provider requests, terminal event, event types) and the two
output roots.

Refusals and failures:

- The run refuses to start when a host-wide OpenCode input that 2.x reads and the census cannot redirect is present.
  These are `/Library/Application Support/opencode` and the managed-preferences plists `ai.opencode.managed`. They
  are stat'ed only, never opened.
- The operator's own OpenCode homes (`~/.local/share/opencode`, `~/.local/state/opencode`, `~/.config/opencode`,
  `~/.opencode`) are stat'ed before and after, never opened or listed. A change in presence, size or mtime fails the
  run.
- A scenario fails when port 49374 opens during it.
- The process exits 1 when any scenario failed or a watched home changed.

## 5. Sanitize (after reading the run)

```sh
node packages/surface/vendors/opencode/census/sanitize-v2.mjs --version V
```

(The same command is the package script `surface:sanitize:opencode:v2`.)

This writes, all-or-nothing, after the 2.x privacy check (`opencodeV2Rules` in `../privacy.mjs`):

- `captures/opencode@V/`: the JSONL carriers of passed scenarios only, plus `census-run.json`,
  `capture-fidelity.json` and `SANITIZATION.md`;
- `probes/opencode@V/`: `version.txt`, help pages and `artifact.json`, verbatim, only when no unsafe pattern
  matches;
- `references/opencode@V/`: `openapi.json` byte for byte, and `SOURCE.json`.

`node packages/surface/vendors/opencode/census/sanitize-v2.mjs --version V --check-only` re-checks them. Nothing is
committed by the script.

## After the run (not the runner's steps)

1. A reviewer records the commit of tag `vV` as `sourceRevision` in `probes/opencode@V/artifact.json`.
2. With an opencode checkout at `vV` (github.com, a host outside this run), build the exact-source event contract:
   `node packages/surface/vendors/opencode/census/event-contract-v2.mjs --version V --source-root <checkout>`.
   It refuses a draft from another tag. When `V` is not 2.2.5, re-derive `draft/opencode-2/event-contract.json` at
   `vV` first.
3. Author `census/behavior-v2.seed.json` from the census event order. The generator needs a reviewed seed.
4. `node packages/surface/vendors/opencode/census/generate-model-v2.mjs --version V` writes
   `model/opencode@V/`. It never writes `groundtruth.json`. The canonical file flips only in the switch PR
   (`surface:groundtruth:write -- packages/surface/vendors/opencode/model/opencode@V`).

## Not covered yet

- Permission once/always/reject, form reply/cancel/invalid/settled, and the fork/archive/delete lifecycle. Their
  request bodies are not recorded anywhere yet. The first run's `references/opencode@V/openapi.json` is where they
  come from.
- The TUI on `--server` in a PTY, and an MCP tool call through Code Mode `execute`.
- Any non-darwin census. The other platforms are acquired and hashed in a later step, never executed here.
- Every variable marked "carried from 1.x" in `run.json` must be checked against the 2.x source at `vV` before the
  census is cited.
