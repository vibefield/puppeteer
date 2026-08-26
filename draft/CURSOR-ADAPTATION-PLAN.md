# Cursor CLI Adaptation Plan

| Field | Value |
| --- | --- |
| Status | Stage 0 complete from public docs plus a local static probe; Stage 1 not started. Not a support claim. |
| Target | Official Cursor Agent native TUI (`agent`) |
| Local research artifact | `2026.07.23-e383d2b` (`@anysphere/agent-cli-runtime`, darwin-arm64) |
| Proposed first pin | `2026.08.11-e8db854` (current `cursor.com/install` payload, 2026-08-11) |
| Canonical process | [adapting-an-agent.md](../docs/guides/adapting-an-agent.md) |

This document specializes the repository's first-vendor adaptation process for
Cursor CLI. It is a plan, not a Surface model and not a promotion record.
Every preliminary fact below must be recaptured as claim-addressable Surface
evidence before it can support an adapter mapping or a support-ledger change.

Cursor is absent from `support/agents.json`. The generic candidate workflow
cannot bootstrap a new vendor. The first change is an ordinary reviewed PR
that may later receive a `baseline-pending` ledger entry. `currentManifest`,
verification, and public support remain outputs of the protected promotion
transaction only.

The invariant is:

> Surface records native evidence. Adapters normalize it. Imposter simulates
> it. Conformance cross-checks both. Promotion alone declares support.

## 1. Outcome and primary decision

Adapt Cursor Agent as a first-class native-TUI provider. Host the interactive
CLI (`agent`) through `AgentHost` and observe/control it through the same
process tree's structured rails. Do not derive semantics from terminal text.

```text
AgentHost PTY ──► one `agent` interactive process
                    ├─ native Ink/TUI chrome     (visible Cursor terminal)
                    ├─ launch-scoped hooks.json  (primary live-rail candidate)
                    ├─ ~/.cursor/projects/.../agent-transcripts/<id>/<id>.jsonl
                    ├─ ~/.cursor/chats/<md5(cwd)>/<uuid>/store.db
                    └─ optional cli-config statusLine
                              │
                              ▼
                        Cursor rail arbiter
                              │
                              ▼
                     Cursor category normalizers
                              │
                              ▼
                      AdapterEventCandidate
                              │
                              ▼
                    Runtime validation/event bus
```

The first adapter must not:

- launch `agent acp` beside the TUI as a second agent session for the same
  conversation;
- launch `agent -p` / `--print` / `stream-json` to “observe” a TUI session;
- treat `AGENT_CLI_SOCKET_PATH` / `agent worker` / `local-worker` as the TUI
  control plane;
- poll `store.db` as if it were an append-only live event stream;
- rewrite the user's global `~/.cursor` around a live install;
- automate the Cursor desktop / IDE UI, or read `state.vscdb` as the CLI
  session rail;
- claim structured prompt or approval control until a same-session native
  receipt is proven;
- claim verified support before protected promotion against the pinned
  candidate.

`agent acp` remains useful in two later roles:

1. a hermetic survey/conformance oracle for overlapping session/tool/permission
   vocabulary and Cursor ACP extensions;
2. a generic ACP execution mode, composed with `adapter-acp`, for callers who
   do not need the native Cursor terminal.

It is not the control plane of a concurrent native-TUI process. Official docs
say ACP is for custom clients and that normal terminal workflows use
interactive `agent`. There is no documented Grok-style leader that both ACP
and the TUI attach to.

`--print` / `stream-json` remains a survey-only schema oracle. Thinking is
suppressed in print mode, so that surface is not the TUI's event rail.

## 2. Gate 0 — prove the native observation/control seam before adapter code

This gate precedes Surface modeling and adapter scaffolding. Public docs and
the local bundle are leads; the shipped artifact is the authority.

Cursor exposes three programmatic-looking surfaces:

| Surface | Transport | Official consumer | Same process as TUI? |
| --- | --- | --- | --- |
| Interactive CLI | PTY | humans (`agent`) | yes — this is the product |
| Print / stream-json | stdout NDJSON | scripts, CI (`agent -p`) | no — a different launch |
| ACP | JSON-RPC over stdio | editors (`agent acp`, hidden) | no — a different launch |

The TUI's likely live rails, from docs and the installed bundle, are hooks,
durable transcripts, and a SQLite chat store. Gate 0 must answer these with
process evidence against a disposable isolated home:

1. Do `hooks.json` agent hooks fire in interactive `agent` (not only the
   desktop app or `-p`)? Changelog claims `afterAgentThought` /
   `afterAgentResponse` emit in the CLI and that Claude Code-format hook
   responses are accepted.
2. Can those hooks be installed launch-scoped via `CURSOR_CONFIG_DIR` /
   `CURSOR_DATA_DIR`, `--plugin-dir`, or an isolated `HOME`, without mutating
   the user's global `~/.cursor`?
3. Does `beforeSubmitPrompt` fire for TUI paste and for an initial argv
   prompt, and does its payload identify the submitted text well enough to
   confirm a `PromptReceipt`?
4. Does `beforeShellExecution` / `preToolUse` actually gate TUI approvals, or
   is the y/n overlay independent? Can a hook return `ask` / `allow` / `deny`
   without racing the TUI?
5. What writes during a live TUI turn: `store.db` blobs, `meta.json`,
   `projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`, both, or
   only at checkpoints?
6. Is `agent-transcripts` append-only JSONL that can be tailed, or a rewrite?
   Changelog says headless transcripts are Claude Code-compatible JSONL;
   interactive persist-to-disk is documented but the live shape is unproven.
7. Is `store.db` a live rail or resume-only? The installed `create-chat`
   implementation is a WAL SQLite blob store (`blobs` + `meta`), not JSONL.
   Tailing it like a journal is forbidden unless census proves an append-only
   contract.
8. Can `agent create-chat` mint a UUID that `--resume` then binds, so identity
   is known before the TUI starts? The local implementation prints an id and
   then `dispose()`s; empty stores with no blobs are deleted on dispose. This
   must be observed, not assumed.
9. Do TUI, `--print`, and `agent acp` share conversation UUIDs so
   `session/load` or `--resume` can join the same native session? Expected
   answer for ACP: no.
10. Is there any same-session attach socket for the TUI? `AGENT_CLI_SOCKET_PATH`
    is used by the hidden `local-worker` / worker-server path, not by
    interactive `agent`. Do not relabel it as a leader.
11. What is the exact process tree of interactive `agent` (wrapper bash,
    bundled Node, `cursor-agent-svc`, sandbox helper, askpass server)?
12. Does `--disable-auto-update` keep the pin still for the life of a census
    and a pinned-real run?

Exit this gate with one of:

| Outcome | Adapter consequence |
| --- | --- |
| Launch-scoped hooks fire in the TUI and carry conversation / generation / tool ids | first adapter is native-TUI + hooks; observation level may reach `native-hooks`; prompt receipts stay honest |
| `agent-transcripts` is a live append-only JSONL for the same process | add a transcript observer as a second rail; `native-log` until hooks also connect |
| A same-session structured attach (not a second `agent acp` / `-p`) is proven | first adapter may become `structured`; still host the TUI as the viewer |
| Neither hook nor transcript rail can be used without mutating the user home or spawning a second agent | stop; do not ship a fake adapter |

Do not write a convenient partial normalizer and present it as full coverage.

## 3. Repository constraints carried into this adapter

- one native session corresponds to one vendor process tree;
- the native TUI remains visible, interactive, and authoritative;
- `AgentHost` owns PTY creation and terminal automation;
- the adapter owns launch recipe, observers, correlation, and cleanup;
- Core remains provider-neutral and performs no I/O;
- every event is stamped once, in ingestion order, before fan-out;
- raw native records survive normalization, including unrecognized records;
- prompt receipts may be `uncertain`; they must never be upgraded from a
  terminal echo or elapsed time;
- semantic turn completion and process exit remain separate facts;
- observation level reflects the strongest rail actually active for that
  session, not the theoretical richness of ACP or `stream-json`;
- Surface, Imposter, adapter, and normalized event graphs remain distinct.

Closest implementation precedents:

- Claude for launch-scoped hooks, guarded paste, status-line composition, and
  honest `uncertain` receipts;
- Kimi for a provisional session identity that becomes a native conversation
  identity after the first authoritative record, plus a durable store that is
  not a live stream;
- Grok / `adapter-acp` only if a later census finds a shared leader that ACP
  and TUI both attach to (none is documented today);
- the first-vendor bootstrap in [`adapting-an-agent.md`](../docs/guides/adapting-an-agent.md), not the
  already-integrated candidate-refresh workflow.

## 4. Stable identities

| Purpose | Name |
| --- | --- |
| Provider/vendor key | `cursor` |
| Display name | Cursor Agent |
| User-facing command | `agent` (primary); `cursor-agent` is the legacy shim |
| TUI launch | `agent` with no subcommand |
| Adapter package | `@vibecook/puppeteer-adapter-cursor` |
| Adapter directory | `packages/adapter-cursor` |
| Surface directory | `packages/surface/vendors/cursor` |
| Imposter persona | `packages/imposter/personas/cursor` |
| Binary override | `PUPPETEER_CURSOR_BIN` |
| Isolated config | `CURSOR_CONFIG_DIR` |
| Isolated data | `CURSOR_DATA_DIR` |
| Live-test opt-in | `CURSOR_LIVE=1` |
| Imposter selector | `ai --cursor` / `AI_PERSONA=cursor` |
| Imposter shims | `agent`, `cursor-agent` |
| Execution mode | `native-tui` |
| Resume key | native chat UUID |

Track separately: vendor artifact version (`2026.08.11-e8db854`), platform
archive SHA-256, bundled Node identity, ASM format version, and Puppeteer
package version. The date-hash string is not semver and is not a Puppeteer
version.

Account/quota reporting is out of scope unless a native, evidence-backed
account surface is found during survey. `agent about --format json` and
`/usage` are leads only. `user_email` appears on hook payloads and must never
be persisted.

## 5. Candidate pin and acquisition policy

### 5.1 Proposed first pin

| Concern | Value |
| --- | --- |
| Product version | `2026.08.11-e8db854` |
| Local research copy | `2026.07.23-e383d2b` still installed at `~/.local/share/cursor-agent/versions/` |
| Upstream | closed-source Anysphere CLI; no public implementation repo |
| License | proprietary Cursor / Anysphere terms |
| Runtime | vendor-bundled Node (`v24.5.0` in the local copy) plus a bash/`cmd` wrapper |
| Install shape | versioned directory under `~/.local/share/cursor-agent/versions/<ver>/` with `agent` / `cursor-agent` symlinks |

Pin the installer version, not “whatever `agent update` pulled.” The CLI
auto-updates by default. Census and pinned-real runs must pass
`--disable-auto-update` (hidden root flag on the local artifact) and must not
run `agent update`.

The local `2026.07.23-e383d2b` copy is useful for offline string/help probes.
It is not the candidate. Stage 1 acquires `2026.08.11-e8db854` into a
disposable directory.

### 5.2 Public artifact URLs observed 2026-08-12

These are installer-script observations, not yet Surface evidence. HEAD
requests returned 200:

| Platform | URL | Format | Size (bytes) |
| --- | --- | --- | --- |
| darwin-arm64 | `https://downloads.cursor.com/lab/${version}/darwin/arm64/agent-cli-package.tar.gz` | tar.gz | 74746275 |
| darwin-x64 | `https://downloads.cursor.com/lab/${version}/darwin/x64/agent-cli-package.tar.gz` | tar.gz | 77650670 |
| linux-x64 | `https://downloads.cursor.com/lab/${version}/linux/x64/agent-cli-package.tar.gz` | tar.gz | 84532310 |
| linux-arm64 | `https://downloads.cursor.com/lab/${version}/linux/arm64/agent-cli-package.tar.gz` | tar.gz | 83117637 |
| windows-x64 | `https://downloads.cursor.com/lab/${version}/windows/x64/agent-cli-package.zip` | zip | 73841982 |
| windows-arm64 | `https://downloads.cursor.com/lab/${version}/windows/arm64/agent-cli-package.zip` | zip | 71739644 |

Unix executable basename after extract: `cursor-agent` (wrapper) plus bundled
`node` and `index.js`. Windows copies `cursor-agent.exe` / `.cmd` / `.ps1` and
aliases them to `agent.*`.

The in-binary `install` fallback uses
`https://anysphere-binaries.s3.amazonaws.com/lab/${version}` (prefix HEAD was
403 without a key). Prefer `downloads.cursor.com` as the allowlisted host.
Do not curl `https://cursor.com/install` as the acquisition strategy; the
script always points at “current latest.”

The usual Puppeteer matrix is `darwin-arm64`, `darwin-x64`, `linux-x64`,
`windows-x64`. Linux arm64 and Windows arm64 exist and should be recorded as
optional extra platforms, not silently dropped, and not invented as required
if promotion runners cannot execute them.

### 5.3 Preliminary `upstream.json` shape

Closed source, so `sourceRelation` is omitted or recorded as unmatched docs
only. Detector options, in preference order:

1. A reviewed, stable text/JSON version endpoint if census finds one
   (`AGENT_CLI_UPDATE_CHECK_URL` is referenced by name in the bundle).
2. Parse the current install script only as a non-authoritative preview
   detector; never as the bytes being promoted.

Draft acquisition (must be revalidated by `pnpm upstream:check`):

```json
{
  "schemaVersion": 1,
  "vendor": "cursor",
  "repository": "https://cursor.com/docs/cli/overview",
  "detectors": [
    {
      "id": "install-script-stable",
      "channel": "stable",
      "kind": "text",
      "url": "https://cursor.com/install",
      "versionPattern": "(20\\d{2}\\.\\d{2}\\.\\d{2}-[0-9a-f]+)",
      "authoritative": false
    }
  ],
  "platforms": ["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"],
  "acquisition": {
    "strategy": "https-template",
    "allowedHosts": ["downloads.cursor.com"],
    "maxBytes": 536870912,
    "artifacts": {
      "darwin-arm64": {
        "urls": ["https://downloads.cursor.com/lab/${version}/darwin/arm64/agent-cli-package.tar.gz"],
        "format": "tar.gz",
        "executableBasenames": ["cursor-agent"]
      }
    }
  },
  "analysis": [
    "binary-flags",
    "hooks",
    "transcript",
    "sqlite-store",
    "acp-survey",
    "print-schema",
    "controlled-census"
  ],
  "debounce": { "polls": 2, "minutes": 30 }
}
```

Do not merge a placeholder that lists untested Windows/Linux members until
those URLs and extracted basenames have been acquired once.

### 5.4 Authorization and credentials

Unlike Antigravity, Cursor documents third-party ACP clients (JetBrains, Zed,
Neovim) as an intended integration. Hosting a user's already-licensed `agent`
TUI is the user running their own binary.

Still do not:

- authenticate against the developer's personal Cursor account from a shared
  or CI home;
- persist `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, keychain items, or
  `cli-config.json` permission state;
- send live model prompts until an isolated test account or API key is
  provisioned for `CURSOR_LIVE=1`;
- treat ACP as a ToS loophole for spawning a second session beside the TUI.

Offline work allowed before live credentials:

- download public archives into temporary storage;
- `--version`, `--help`, rejected flags, isolated-home layout;
- static-string / chunk analysis of the acquired artifact;
- design Surface fixtures and Imposter architecture from public facts;
- scaffold code that neither authenticates nor makes service requests.

A local `agent about --format json` on this machine reported
`cliVersion: 2026.07.23-e383d2b` and `isAuthenticated` via `agent status`
keys (`hasAccessToken`, `hasRefreshToken`, `isAuthenticated`, `status`,
`message`) without printing account identifiers into this plan. Isolated
`HOME=... agent create-chat` hung waiting on auth rather than failing fast.
Census must treat that hang as a harness bug to contain.

## 6. Native rails and ownership

| Rail | Planned role | Authority | Runtime status |
| --- | --- | --- | --- |
| PTY / TUI | Visible native UI and user control | Control provenance only; never semantic | Required |
| Agent hooks | Session / prompt / tool / shell / thought / stop | Authoritative for fields present, if Gate 0 proves TUI fire | Preferred live rail |
| `agent-transcripts` JSONL | Turn history, citation, possible live tail | Authoritative if append-only and same session | Candidate live / replay |
| `chats/<hash>/<uuid>/store.db` | Resume identity, durable blobs | Replay / join only unless proven otherwise | Required for resume |
| `cli-config.json` `statusLine` | Optional usage/footer probe | Derived presentation only | Optional |
| Process lifecycle | PID, exit, crash, child reaping | Authoritative process facts | Required |
| Askpass UDS | sudo password; model must never see it | Do not observe secrets | Out of scope |
| ACP stdio | Separate structured host | Survey oracle / later mode | Forbidden beside the TUI |
| `--print` / `stream-json` | Headless schema oracle | Survey only | Forbidden as TUI observer |
| Worker / `AGENT_CLI_SOCKET_PATH` | Cloud/self-hosted worker | Different product | Out of scope |
| Desktop `state.vscdb` | Cursor IDE composers | Different product | Out of scope |
| Terminal text / OSC 9999 | Human-visible UI / shell integration | Never semantic evidence | Never parsed |

Truth-rail rule: one owner per portable fact. Duplicate native evidence is
retained for diagnostics and must not produce duplicate Core events.

If both a hook and a transcript record describe the same tool call, pick one
owner after census (likely hooks for live start/stop, transcript for resume
hydration). Do not emit two `tool.started` events.

`store.db` observed schema (local `create-chat` chunk, unverified at
runtime):

- WAL SQLite, `PRAGMA user_version = 1`;
- `blobs(id TEXT PRIMARY KEY, data BLOB)`;
- `meta(key TEXT PRIMARY KEY, value TEXT)`;
- in-memory metadata fields: `agentId`, `latestRootBlobId`, `name`,
  `createdAt`, `mode`, `isRunEverything`, `approvalMode`, `lastUsedModel`,
  `lastDebugServerPort`, `currentPlanUri`, `subagentInfo`.

Some blobs are JSON; the Grok resume-session reader already treats others as
binary/protobuf and refuses to invent contents. Surface must do the same.

Documented hook common fields that matter for correlation and privacy:

- `conversation_id`, `generation_id`, `hook_event_name`, `cursor_version`,
  `workspace_roots`, `transcript_path`;
- `user_email` (redact; never persist);
- `session_id` on `sessionStart` / `sessionEnd` (docs say it equals
  `conversation_id`).

Documented TUI-relevant hook events:

`sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`,
`postToolUseFailure`, `subagentStart`, `subagentStop`,
`beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`,
`afterMCPExecution`, `beforeReadFile`, `afterFileEdit`,
`beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`,
`afterAgentThought`.

Tab hooks and `workspaceOpen` are desktop/app lifecycle. Do not model them
as TUI session events unless census shows the CLI emitting them.

## 7. Isolation, credentials, and privacy

Census and runtime sessions use a disposable config/data pair, never the
developer's `~/.cursor`.

Launch-scoped isolation knobs already present on the artifact:

| Knob | Use |
| --- | --- |
| `CURSOR_CONFIG_DIR` | Relocates `cli-config.json` (defaults to `$XDG_CONFIG_HOME/cursor` or `~/.cursor`) |
| `CURSOR_DATA_DIR` | Relocates `projects/` (defaults to `~/.cursor`) |
| `HOME` | Last-resort isolation; some commands hung without auth in a throwaway HOME |
| `AGENT_CLI_CREDENTIAL_STORE=file` | File-backed credentials for sandboxes; skip macOS keychain |
| `--trust` | Skip workspace trust dialog (interactive as of 2026-07-20) |
| `--disable-auto-update` | Keep the pin |
| `--plugin-dir` | Load hooks/skills without writing user marketplaces |
| `CURSOR_API_KEY` / `--api-key` | Live-lane auth only; never logged |

Hook/transcript observation requires a `hooks.json` and/or transcript writes
inside that isolated tree. That is allowed. Swapping the user's global
config and restoring it after spawn is not.

Provider traffic during census should stay on loopback or be skipped until
`CURSOR_LIVE=1` is set with a dedicated key. Team admins can disable
headless mode org-wide; print-mode survey may be blocked in enterprise
accounts even when the TUI works.

Raw captures stay under the gitignored `captures-raw` tree. Tracked
captures must remove prompts, model output, thinking text, account
identifiers, emails, home paths, repository contents, bearer tokens, API
keys, sudo/askpass secrets, and raw authenticated state. Sanitization must
preserve types, identifier formats, and cross-record correlation
(`conversation_id`, `generation_id`, `tool_use_id`, `call_id`).

Launch environments may carry bearer tokens. Never log or persist them.

## 8. CLI surface already observed

Local `agent --help` (2026.07.23-e383d2b) plus official parameter docs.

### 8.1 Visible root flags

`--version`, `--api-key`, `--header`, `--endpoint` (default
`https://api2.cursor.sh`), `--print`, `--output-format text|json|stream-json`,
`--stream-partial-output`, `--mode plan|ask`, `--plan`, `--resume [chatId]`,
`--continue`, `--model`, `--list-models`, `--force` / `--yolo`,
`--auto-review`, `--sandbox enabled|disabled`, `--approve-mcps`, `--trust`,
`--workspace`, `--add-dir`, `--plugin-dir`, `--worktree`, `--worktree-base`,
`--skip-worktree-setup`.

An unknown option printed `error: unknown option` and exited 0 on this
artifact. Census must record actual exit codes; do not assume Commander
defaults.

A free extra word is an initial prompt, not a subcommand. `agent notacommand`
attempted to start a session and demanded authentication.

### 8.2 Commands

Visible: `login`, `logout`, `mcp`, `plugin`, `worker`, `status|whoami`,
`models`, `about`, `update`, `create-chat`, `generate-rule|rule`, `agent`,
`ls`, `resume`, `install-shell-integration`, `uninstall-shell-integration`.

Hidden on the local artifact: `acp`, `sandbox`, `record`, `dev`,
`get-channel`, `local-worker`, `repo`, `upgrade`, `worker-server`,
`repaint-debug`. Official docs also hide `acp` and `sandbox`.

`agent acp --help` exists even though it is omitted from root help.

### 8.3 Detection facts for later `detection.json`

- wrapper `cursor-agent` is a bash script that `exec`s bundled `node`
  `index.js`;
- `CURSOR_INVOKED_AS` is set from `basename $0`, so `agent` vs
  `cursor-agent` is observable;
- version output is a single line `YYYY.MM.DD-<7hex>`;
- `--version` / `--help` work in an isolated `HOME`;
- Node compile cache lands in `~/Library/Caches/cursor-compile-cache` on
  Darwin unless `NODE_COMPILE_CACHE` is set.

## 9. Session, prompt, and disposal algorithms to prove

These algorithms are hypotheses until Gate 0 and the census rewrite them.

Native identity leads:

- chat UUID from `create-chat`, `--resume`, hook `conversation_id` /
  `session_id`;
- workspace binding via `md5(absolute cwd)` under `chats/`;
- project tree via encoded cwd under `projects/`
  (`Users-jamesyong-Projects-...` locally);
- `generation_id` changes every user message;
- print-mode `session_id` on every `stream-json` event;
- ACP `session/new` / `session/load` session ids — likely a different
  namespace.

`--continue` is “latest,” including cross-workspace as of 2026-07-06. It is
not the runtime resume API.

### 9.1 Fresh session (hooks + known id, if create-chat survives)

1. Create mode-`0700` disposable `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR`.
2. Install launch-scoped hooks that POST stdin JSON to a loopback collector.
   Prefer command hooks with `failClosed: false` except for the specific
   gating experiments.
3. Resolve `PUPPETEER_CURSOR_BIN` then `agent` / `cursor-agent`.
4. If `create-chat` yields a durable UUID, pass `--resume <uuid> --trust
   --disable-auto-update`.
5. Ask `AgentHost` for one interactive `agent` process. No `-p`, no `acp`.
6. Treat the native id as provisional until `sessionStart` or the first
   transcript/store record for this process binds it.
7. Emit derived `session.ready` only after that bind. Do not invent a native
   readiness event if none exists.

### 9.2 Fresh session (id unknown at spawn)

1. Same isolation and hooks.
2. Spawn `agent --trust --disable-auto-update` with no resume.
3. Bind on the first `sessionStart.session_id` / `conversation_id` that
   belongs to this process's hook collector.
4. Multiple matching new sessions are `uncertain`; do not pick by mtime.

### 9.3 Prompt submission

If a same-session structured submit exists (unexpected; not documented for
the TUI):

1. Mint a caller-owned correlation id if the native method accepts one.
2. Submit over that method, not terminal paste.
3. Confirm only when a native user-message / `beforeSubmitPrompt` record
   carries that id.

Hooks-only path:

1. Guarded PTY paste through `AgentHost`.
2. Confirm only an exact `beforeSubmitPrompt.prompt` (or transcript user
   record) attributable to that submission.
3. Terminal echo, elapsed time, or a later `afterAgentResponse` are not
   confirmation.
4. `uncertain` on timeout, disconnect, or a hook payload that lacks the
   text.

Never unify the two paths by pretending paste is deterministic.

### 9.4 Resume

1. Require an explicit chat UUID. Do not use `--continue` or `agent resume`
   as the runtime API.
2. Launch with `--resume <uuid>` in the original cwd / `--workspace`.
3. Require the first identity-bearing record to match the requested id.
4. Replay durable transcript / store history as `replay: true`, then apply
   live hooks without duplicating across the boundary.
5. `/fork` / `/rewind` create or restore native history. Census must say
   whether the UUID stays the same. Do not silently retarget.

### 9.5 Interrupt and disposal

- Interactive interrupt is documented as Enter-to-steer then Enter-again to
  interrupt (2026-08-11), plus ordinary Ctrl+C. Host interrupt is the
  first-slice control. A successful write is not proof the turn stopped.
- Confirm stop only from `stop.status`, `sessionEnd`, or an equivalent
  native record.
- `dispose()` tears down hook collectors, transcript watchers, and temporary
  config/data overlays. It does not kill a host-owned PTY or synthesize
  semantic completion.
- Reap the documented child set: wrapper, bundled Node, askpass server,
  sandbox helper, any `cursor-agent-svc`. A leftover askpass socket is an
  orphan.

## 10. Approvals and control ownership

Documented approval surfaces:

| Surface | Options | Notes |
| --- | --- | --- |
| TUI overlay | y / n; skip-and-tell; allowlist; Run Everything; Auto-review | Default product UX |
| Hooks `beforeShellExecution` / `beforeMCPExecution` | `allow` / `deny` / `ask` | Fail-open unless `failClosed` |
| Hooks `preToolUse` | `allow` / `deny` (`ask` accepted by schema but not enforced) | Matcher by tool type |
| ACP `session/request_permission` | `allow-once` / `allow-always` / `reject-once` | Different process |
| `--force` / `--yolo` | bypass most prompts | Not the first-slice default |
| `--auto-review` | classifier + sandbox + allowlist | Team-gated |

First adapter default: **native TUI owns the decision**. The adapter
observes and normalizes. A future `onApproval` host-controller option may
answer a hook with `allow`/`deny` only after:

- Gate 0 proves the hook actually gates the TUI call;
- presentation switches to `host-ui`;
- the TUI overlay is not also answering the same request.

Do not race the overlay. Do not route sudo/askpass through the adapter.

## 11. ACP and print-mode notes (survey only)

Official ACP flow: `initialize` → `authenticate` (`cursor_login`) →
`session/new` or `session/load` → `session/prompt`, with
`session/update` notifications and `session/request_permission`.

Cursor extension methods (docs, unverified on the pinned artifact):

| Method | Wire type | Product-shaped fact |
| --- | --- | --- |
| `cursor/ask_question` | blocking request | questions |
| `cursor/create_plan` | blocking request | plan approval |
| `cursor/update_todos` | notification | todos |
| `cursor/task` | notification | subagent task |
| `cursor/generate_image` | notification | generated image |

If a later ACP execution mode is added, those extensions stay vendor-owned.
Do not invent Core events just to avoid `adapter.native-event`. Generic
`adapter-acp` can carry the standard methods; Cursor-specific methods need
this vendor adapter or an explicit retained-native policy.

Print `stream-json` event types from official docs: `system/init`, `user`,
`assistant`, `tool_call` started/completed (`readToolCall`, `writeToolCall`,
or `function`), terminal `result`. Thinking is suppressed. Use this as a
schema lead for tool-call shapes, never as the TUI transport.

## 12. Surface census

### 12.1 Offline / identity census

Per acquired archive and platform:

- version string, wrapper hash, `index.js` hash, bundled `node` hash;
- archive SHA-256 and extracted executable basename;
- `agent --version`, `--help`, hidden-command help, rejected option, exit
  codes;
- isolated `CURSOR_CONFIG_DIR` / `CURSOR_DATA_DIR` layout;
- proof that `--disable-auto-update` prevents a version move;
- codesign / authenticode notes where the platform has them.

### 12.2 Process-topology census (Gate 0)

Capture argv, env, pid tree, sockets, and stdio owners for:

- `agent --trust --disable-auto-update` cold start;
- `agent --resume <uuid>`;
- `agent acp` in a separate process, to prove it does not join;
- `agent -p --output-format stream-json` in a separate process, same proof.

### 12.3 Runtime census

Use isolated config/data dirs. Required scenarios, once live credentials
exist:

| Area | Cases |
| --- | --- |
| Startup | isolated dirs, missing credentials, trust dialog, `--trust` |
| Turn | no-tool reply, streamed text, thinking blocks if hooks expose them |
| Prompt control | guarded paste; initial argv prompt; busy steer/interrupt |
| Tools | read, write, shell success, shell deny, repeated name, late complete |
| Permission | TUI allow/deny; hook allow/deny/ask; `--force` contrast only |
| Interrupt | during model work, tool work, approval, idle |
| Session | new id, create-chat, explicit resume, latest-in-dir, fork/rewind |
| Ordering | duplicate, reorder, disconnect, late after exit |
| Context | `/context`, `/summarize`/`/compact`, `preCompact` |
| Work graph | subagent start/stop, background tasks, `/goal` if enabled |
| Hooks | every TUI-fired event plus Claude-format response compatibility |
| Transcript | JSONL shape, append vs rewrite, identity join to hooks |
| Shutdown | clean exit, crash, host kill, observer-first failure |

Do not spawn a shadow `-p` or `acp` process to generate “the same” events as
the TUI.

### 12.4 Evidence handling

For every scenario retain:

- raw private capture with origin, command, exact archive digest, platform,
  timestamp, and scenario inputs;
- sanitized tracked capture;
- sanitization audit result;
- a finding that describes observed facts without proposing normalization;
- claim-to-evidence references precise enough to identify the record and
  field.

The sanitizer must be deterministic, fail closed on unknown secret-shaped
fields (especially `user_email`, tokens, askpass, file contents in
`beforeReadFile` / `afterFileEdit`), preserve referential identity, and have
positive and negative tests.

## 13. Candidate normalization map

This table is a hypothesis backlog. No row becomes adapter behavior until
the Surface model cites evidence for its carrier, identity, ordering, and
variants.

| Native evidence candidate | Core event / disposition | Rule |
| --- | --- | --- |
| First bound `conversation_id` / chat UUID | `session.started` | Bind once; reject conflicting ids |
| Proven prompt-ready state | `session.ready` or derived runtime ready | Never infer from TUI chrome |
| `beforeSubmitPrompt` + matching paste | `turn.started`; may confirm receipt | Exact text join; else `uncertain` |
| `afterAgentResponse.text` | `assistant.message` | Final text only; do not invent deltas |
| `afterAgentThought` | reasoning events | Public aggregated text only |
| `preToolUse` / transcript tool start | `tool.started` | Native `tool_use_id` / `call_id` |
| `postToolUse` | `tool.completed` | Correlate by native id |
| `postToolUseFailure` | `tool.failed` | Preserve `failure_type` |
| TUI/hook permission decision | `permission.requested` / `resolved` | Presentation remains `native-tui` unless a lease exists |
| `stop.status` | turn completed / cancelled / failed | Hook name `stop` is not completion by itself |
| `preCompact` | retain or context update only if product-useful | Observational; cannot block; not proof compaction finished |
| `subagentStart` / `subagentStop` | subagent events | Keep parent conversation, subagent, and tool ids independent |
| `cursor/update_todos` (ACP later) | task events or retain | Do not invent tasks from TUI chrome |
| Process spawn/exit | process events | Separate from session/turn completion |
| Unmapped native record | `adapter.native-event` | Retain raw payload and native type |

Observation level:

- `structured` only while a same-session protocol rail is connected and
  producing valid events for that session (not merely because `agent acp`
  exists on PATH);
- `native-hooks` when launch-scoped hooks are live;
- `native-log` if only durable transcript/store replay is available, then
  upgrade when a live rail connects;
- never `terminal-only` presented as if it were hooks.

Core's current event union is sufficient for the first slice. Do not add
portable events for skills, plugins, MCP login, cloud handoff, rewind, or
Cursor billing.

## 14. Imposter and adapter implications

Imposter must reproduce the native TUI contract the adapter will consume,
not the ACP editor contract, unless a later ACP mode is explicitly added.

Likely Imposter work after the ASM exists:

- `personas/cursor/` pointing at the Surface model;
- `ops.json` bindings onto exact hook / transcript event names;
- `nativeStore` for `chats/<hash>/<uuid>/store.db` and/or
  `projects/<encoded>/agent-transcripts/<uuid>/<uuid>.jsonl`;
- hook-forward HTTP or command channel if Imposter does not yet have that
  delivery kind — extend `OpChannel` deliberately rather than relabeling;
- scenarios for happy turn, allow/deny, unknown event, flood, crash,
  disconnect, resume;
- do not author ACP `session/update` traffic and pretend it is TUI evidence.

Likely adapter shape after Gate 0:

```text
packages/adapter-cursor/
  src/
    detection.ts          # generated from Surface
    driver.ts
    normalization/        # one Core event category per file
    services/             # event source and prompt capability
    launch/               # isolated dirs, hooks.json, argv
    observation/          # hook collector, transcript tail, store snapshot
    transport/            # only for a proven structured native rail
    conformance.test.ts
    cursor.live.test.ts
```

Surface may be a development dependency for generators/tests. It must not
be a production dependency.

## 15. Stage plan

| Stage | Exit | Next blocked item |
| --- | --- | --- |
| 0. Scope | this document | Gate 0 process evidence |
| 1. Survey | `upstream.json`, census harness, raw+sanitized captures, `findings.md` | live isolated TUI turns |
| 2. Model | ASM v2 + `surface:audit:cursor` | evidence digests after captures freeze |
| 3. Emulate | persona, scenarios, exact replay | new channel implementation if needed |
| 4. Adapt | adapter + focused tests + honest devkit projection | no fake full coverage |
| 5. Integrate | conformance, Imposter E2E, runtime provider, packaging | Godview only after E2E |
| 6. Promote | `baseline-pending` then protected four-platform attestation | do not hand-edit `currentManifest` |

Do these in order. Never derive Surface from adapter code. Never derive the
adapter from authored Imposter scenarios.

## 16. File touch map (first-vendor PR)

Surface and evidence:

- `packages/surface/vendors/cursor/upstream.json`
- `packages/surface/vendors/cursor/findings.md`
- census/probe harnesses and optional model generator
- paired sanitizer and privacy detector tests
- sanitized captures under the versioned capture directory
- ASM v2 manifest, evidence, detection, channels, events, behavior
- vendor `audit.mjs` and `surface:audit:cursor`

Imposter and native devkit:

- `packages/imposter/personas/cursor/`
- persona/scenario tests and later adapter-against-Imposter conformance
- `SpawnablePersona` and isolated env handling in `apps/imposter-control`

Adapter and runtime:

- `packages/adapter-cursor/` public package
- `packages/runtime` provider + types + tests
- `scripts/public-packages.mjs`, `release-please-config.json`, lockfile
- `support/agents.json` candidate only, via `pnpm support:write`

Automation, after the seam exists:

- `.github/workflows/agent-adaptation.yml` vendor choice
- `.github/workflows/agent-surface-promotion.yml` vendor choice + pinned-real
- `.github/workflows/agent-live.yml` `CURSOR_LIVE`

## 17. Known unknowns

- Whether interactive hooks actually fire on `2026.08.11-e8db854`.
- Whether `agent-transcripts` is live-tailable during a TUI turn.
- Whether `create-chat` leaves a resume-able empty store or deletes it.
- Whether TUI and ACP session ids are joinable.
- Whether `beforeSubmitPrompt` sees guarded-paste submissions.
- Whether hook `permission: deny` races or replaces the TUI overlay.
- How protobuf/binary `store.db` blobs are shaped, and whether they are
  needed for resume hydration.
- Windows extracted basename (`cursor-agent.exe` vs `agent.exe`).
- A stable version detector that is not “parse the install script.”
- Team-disabled headless / MDM sign-in effects on census.
- Whether linux-arm64 / windows-arm64 should join the required promotion
  matrix.

## 18. Definition of not-done

The adaptation is not started merely because this plan exists. It is not
adapted because `agent` launches in Godview. It is not verified because
Imposter can emit hook-shaped JSON.

Stop and re-scope if Gate 0 fails. An offline research model must not be
listed as a supported agent.
