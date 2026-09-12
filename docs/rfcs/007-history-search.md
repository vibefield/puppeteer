# RFC 007: Finding an Agent by What Was Said

- **Status:** Accepted and implemented (phase 1)
- **Date:** 2026-09-09
- **Owners:** Godview and Runtime maintainers
- **Related:** [`004-layered-agent-runtime.md`](./004-layered-agent-runtime.md), [`003-native-observation-sources.md`](./003-native-observation-sources.md)

## Decision

Godview gains a Find sheet (⌘F) that answers "which of these running agents is the one where I said or read …". The
words come from an **external loopback daemon** that indexes every installed agent's own durable transcripts:
Rosetta's `rosettad`, a sibling product in the same portfolio. Godview joins the daemon's answers to its live runs by
the **provider-native session id** that Core already carries as `NativeSessionRef` on every run and as
`session.nativeSessionId` on every monitor projection. Nothing in Puppeteer parses a transcript for this feature, and
nothing in Godview names a provider.

The sheet has two lanes:

- a **facts lane**, local and instant, that matches the query fuzzily against what the shell already knows about a
  run — its transcript title, folder, branch, model, account, status;
- a **words lane** that asks the daemon for prompts and replies inside the live sessions, one question per keystroke.

The unit of the list is the agent. A hit lands the reader in a terminal, not on a message, so the matched lines are
evidence under the row rather than rows of their own. Choosing a row calls the same `select` action every monitor
view already uses.

## Boundaries

- **Layering.** The integration lives entirely in the product layer: a pure, injectable client in Godview's main
  process (`apps/godview/src/main/history-search.ts`), three IPC channels, and a renderer model plus sheet under
  `apps/godview/src/renderer/find/`. Runtime, Core, and the adapters are unchanged. Search results feed navigation
  only; they never become agent state. If that ever changes, the daemon becomes an observation source under RFC 003.
- **Native evidence, not terminal text.** The daemon reads native logs, which is the same class of evidence the
  adapters' durable observers read. The invariant against terminal-text semantics is untouched.
- **Provider neutrality.** The join key is the native session id, corroborated by cwd where a provider has said one.
  The daemon's runtime kinds pass through as opaque strings. The repository-wide production-source check continues
  to reject provider names under Godview.
- **Process boundary.** The renderer is a `file://` page with `connect-src 'self'`, and the daemon refuses a `null`
  origin, so the client is main-process code. Main validates every renderer-supplied identifier as an opaque label
  and validates the daemon origin as a loopback http URL with no path, credentials, query, or fragment. The daemon
  has no authentication; that validation and the loopback bind are the whole boundary.
- **Ownership of the daemon.** Godview never spawns the daemon. It attaches to one it is told about, in this order:
  the hand-edited `history-search.json` under the user-data directory, the `GODVIEW_HISTORY_DAEMON` environment
  variable, the newest live announcement the daemon leaves under its per-user state directory, and finally the app
  default `http://127.0.0.1:4640`. Without a reachable daemon the sheet still works on the facts lane and says so.

## Protocol

Daemon protocols 17 through 20 are supported. Protocol 18 answers one question for a whole set of sessions
(`sessions=`), widens word fragments (`prefix=true`), resolves native ids directly
(`/api/sessions?native_session_id=`), keeps hits under a consistent snapshot while the index is catching up, and
announces its origin (`serve --announce`). Protocol 17 has none of that, so the same questions are asked the long
way: a time-bounded search filtered in main, and a listing of recent sessions filtered in main. Protocol 19 adds
recorded session activity and protocol 20 adds authored images; both preserve the status, session identity, and
search fields consumed here. The compatibility test uses selected responses from Rosetta's version 20 wire golden,
committed under `apps/godview/src/main/fixtures/rosetta-protocol-20.json` with the source revision and digest. Normal
builds and tests do not require a sibling checkout. Unknown protocol versions remain unsupported until reviewed.

A non-ready answer, failed lookup (including any chunk or delegated child), or malformed response is reported as
unanswered, so the sheet holds what it last showed. Failed facts refreshes preserve existing facts and are retried
on the next request; only successful lookups cache missing sessions. Empty session lists require a ready canonical
projection before they can answer "no matches".

Each operation stays with one daemon and projection. Caches are discarded when the origin, announced process,
reported process start, protocol, or projection epoch changes, and when history is disabled. Late responses from a
previous selection cannot populate the current caches. Settings are read on every operation; only announcement
discovery has a ten-second cache.

## Not in this phase

- Searching closed sessions and resuming one from a hit (Godview persists continuations for its own past runs).
- Revealing a hit whose terminal is mounted in another native tab; `select` mounts it in the calling window today.
- Showing the transcript title on list and swarm rows; the sheet shows it, the views keep their own design passes.
- Sharing one daemon between Godview and the History room inside the vibe-field shell.
