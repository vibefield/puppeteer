# Antigravity census tools

`harness.mjs` is the offline parser census, `authorized-census.mjs` the historical 1.1.12 print-mode survey (it used
the operator's signed-in keyring: never reuse it), and `generate-model.mjs` / `extract-writer.py` build the model and
writer references. This page is the runbook for the one live tool here, the native-TUI capture.

## Native-TUI capture (1.4.12, staging steps C5/C6)

`packages/adapter-antigravity/src/tui-capture.live.test.ts` drives the real native TUI of an exact executable and
keeps what it wrote. It is evidence for the 1.4.12 staging, not a proof: it never attests, never asserts the surface
version (the pins still name 1.1.20), and leaves the attested `antigravity:native-tui-journal` lane untouched.

What every run does:

- runs only on macOS, and only with `ANTIGRAVITY_TUI_CAPTURE=1`, which no workflow sets;
- launches every process (the TUI and a `--version` probe) under `sandbox-exec` with the farm's loopback-only
  profile (outbound network is refused except loopback and Unix sockets) plus one rule: `/usr/bin/open` may not
  run, so no sign-in flow can hand a URL to a browser that would start outside the sandbox;
- answers model calls from a loopback Gemini provider with the dummy key `not-a-real-key`. Nothing signs in: a line
  that asks for an account, on any screen, standing for 3 s stops the run (`vendor-login`), and the runner escalates;
- uses a disposable `HOME`, a fixed `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and `SHELL=/bin/sh` (nothing else of the
  runner's environment but `LANG`/`LC_ALL`), `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `AGY_CLI_HIDE_ACCOUNT_INFO=1` and the
  settings `{modelProvider: gemini, enableTelemetry: false, toolPermission: always-proceed}`, so a tool call raises
  no approval prompt;
- checks the executable's SHA-256 against `ANTIGRAVITY_TUI_CAPTURE_SHA256` before the launch and after the last
  process exits; the sanitizer then holds every scenario to the committed pin
  (`references/antigravity@1.4.12/artifact.json`: its digest and its platform);
- never lists processes: terminals are stopped by signalling their process group;
- copies the journals and a store inventory out of the disposable root **before** the root is removed, also when
  the run fails.

### Scenarios

| Scenario       | Keys sent                       | What it captures                                                                                     |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `screens`      | none                            | the first screen's text, unanswered, and which of `live-pty-host.ts`'s first-run patterns it matches |
| `basic-chat`   | first-run walk, one prompt      | one native turn's journal                                                                            |
| `resume`       | first-run walk, two prompts     | a turn, then `--conversation <id>` and a second turn in the same journal                             |
| `tool-success` | first-run walk, one prompt      | a 1.4.12-schema `run_command` call of `sh -c 'echo puppeteer-capture-ok'` and its result             |
| `tool-failure` | first-run walk, one prompt      | the same call of `sh -c 'echo puppeteer-capture-failed; exit 3'`: the non-zero `GENERIC` shape       |

Every scenario but `screens` answers the first-run screens exactly as the attested host does: color scheme, terms
with the data-collection checkbox **unchecked**, workspace trust. That is a terms consent in a disposable home, so
it needs the standing approval (staging step C0) and the literal `ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED=1`. The
two literals differ: the terms gate takes `1`, the updater switch takes `true`.

### Preconditions

- The runner account has never signed in to Antigravity: no keychain item, no saved login. The CLI saves a login to
  the OS keyring first (the adapter's `services/profiles.ts`), and the sandbox confines the network, not the login
  keychain, so a credential from an earlier sign-in could still be read.
- The executable lives outside the runner's home (the capture refuses one under it): a binary that records its own
  path would otherwise name the home, and the sanitizer refuses that with no override.

### Environment

| Variable                                | Value                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `ANTIGRAVITY_TUI_CAPTURE`               | `1`                                                                                 |
| `ANTIGRAVITY_TUI_CAPTURE_DIR`           | absolute raw output directory; one subdirectory per scenario, never overwritten     |
| `ANTIGRAVITY_TUI_CAPTURE_SCENARIOS`     | comma list of scenario names, at least one; default `screens`                       |
| `PUPPETEER_ANTIGRAVITY_BIN`             | absolute path of the exact executable (no `PATH` lookup), outside the runner's home |
| `ANTIGRAVITY_TUI_CAPTURE_SHA256`        | the pinned SHA-256 of that executable (below)                                       |
| `ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED` | `1`, only for the scenarios that answer the terms                                   |

The darwin-arm64 1.4.12 pin is `34423fc9b0af3841e7646aa72a2d40ffeab8218b22d1cb99eac7355f9eba31e3`
(`references/antigravity@1.4.12/artifact.json`). Do not set `ANTIGRAVITY_LIVE`. Use the gitignored
`packages/surface/vendors/antigravity/captures-raw/antigravity@1.4.12-tui` as the raw directory, or a directory
outside the checkout.

### Running it

From the checkout root, after `pnpm install --frozen-lockfile --filter './packages/**'`:

```sh
ANTIGRAVITY_TUI_CAPTURE=1 \
ANTIGRAVITY_TUI_CAPTURE_DIR="$PWD/packages/surface/vendors/antigravity/captures-raw/antigravity@1.4.12-tui" \
ANTIGRAVITY_TUI_CAPTURE_SCENARIOS=screens \
PUPPETEER_ANTIGRAVITY_BIN=/absolute/path/to/antigravity \
ANTIGRAVITY_TUI_CAPTURE_SHA256=34423fc9b0af3841e7646aa72a2d40ffeab8218b22d1cb99eac7355f9eba31e3 \
pnpm --filter @vibefield/puppeteer-adapter-antigravity exec vitest run src/tui-capture.live.test.ts
```

Run `screens` first and report it. Only after the approval, run the rest in a second invocation, adding
`ANTIGRAVITY_DISPOSABLE_TERMS_APPROVED=1` and
`ANTIGRAVITY_TUI_CAPTURE_SCENARIOS=basic-chat,resume,tool-success,tool-failure`. A scenario directory that already
exists is refused, so a re-run first sets the old one aside (`mv -n`).

### Outputs (raw, gitignored, never committed as is)

Per scenario, under `ANTIGRAVITY_TUI_CAPTURE_DIR/<scenario>/`:

- `capture.json`: outcome and error, executable digests before and after, the `--version` output, the sandbox
  profile, provider counts (requests, `run_command` calls issued, results seen), the settings, the prompts, and
  privacy counts;
- `screens.json`: each first-run screen's text as met, with the patterns it matched; for `screens`, every distinct
  screen until it settled and the per-pattern verdicts;
- `logs/<conversation>/…`: the text files of `brain/<conversation>/.system_generated/logs/` (`transcript.jsonl`,
  `transcript_full.jsonl`, …); a binary file is listed, never copied;
- `store-inventory.json`: every entry of the disposable home and workspace with size and SHA-256, no contents;
- `provider-requests.json`: per model request its route, declared tool names, the answer given, and the
  `functionResponse` the binary sent back; the `run_command` declaration as declared;
- `adapter-events.json`: the event types the current adapter normalized from the run (evidence for the non-zero
  exit question, not asserted).

Every file is scrubbed as it is written: the disposable root becomes `$CAPTURE_ROOT`, the runner's home
`$OPERATOR_HOME`, and each whole word that is the runner's account name `$OPERATOR_NAME`. Home and name hits are
counted (`privacy.operatorHomeHits`, `privacy.operatorNameHits`); an error the run prints is scrubbed the same way.
The raw files are still the runner's own: never share them.

### Reporting and sanitizing

Report with the summary, which prints verdicts and counts only (no screen text, paths or journal contents):

```sh
node packages/surface/vendors/antigravity/census/sanitize-tui-captures.mjs --summary \
  --input packages/surface/vendors/antigravity/captures-raw/antigravity@1.4.12-tui
```

For `screens`, compare `screensOnly.patterns` with `live-pty-host.ts`: with no key sent only the first screen is
visible, so `welcome` and `color-scheme` (or whichever screen 1.4.12 opens with) are the verdicts that matter. A
`loginScreen: true` stops the plan.

Then sanitize into the committed shape:

```sh
node packages/surface/vendors/antigravity/census/sanitize-tui-captures.mjs \
  --input packages/surface/vendors/antigravity/captures-raw/antigravity@1.4.12-tui
```

It writes `captures/antigravity@1.4.12-tui/` (`--replace` to redo it): per scenario the sanitized `*.jsonl`
journals (keys, containers, types and order kept; text, ids and paths redacted in place), a manifest, the store
inventory, the provider summary and the screen pattern verdicts, plus `capture-fidelity.json`. It refuses a failed
scenario, a version other than `--version` (default `1.4.12`), a digest before or after other than the committed
pin's, a platform other than the pin's, a run outside the sandbox, a binary that named the runner's home, and, until
a person has looked where each `$OPERATOR_NAME` landed in the raw files and passes `--accept-operator-name-hits`,
any count of the runner's account name. A placeholder that replaced a journal key is refused even then: the native
shape changed, so the capture is re-run as another account. The capture set is folded into the model in staging
step C9, not by the runner.
