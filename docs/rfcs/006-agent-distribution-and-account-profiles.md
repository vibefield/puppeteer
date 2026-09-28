# RFC 006: Agent Distribution and Account Profiles

- **Status:** Accepted; phase 1 implemented on 2026-09-06 (tracks A1–A3 and B1–B3); C1 built 2026-09-25 for eight agents (Copilot's open); C2's first slice (turning a held server or skill on, off or out) built 2026-09-25, its second (a remote server's sign-in and sign-out) 2026-09-26, its third (a server added to an agent that holds none of it, and a host's launch values) 2026-09-27, its fourth (a skill a host keeps, placed where each agent looks) the same day, its fifth (a plugin an agent holds: turned on or off, updated, removed with or without its data) the same day; the rest of C2 (a plugin installed, a marketplace), C3 and B4's second half open
- **Date:** 2026-09-06
- **Owners:** Core, adapter, runtime, and Godview maintainers
- **Related:** [`002-modular-agent-events-and-services.md`](./002-modular-agent-events-and-services.md),
  [`004-layered-agent-runtime.md`](./004-layered-agent-runtime.md),
  [`../../draft/research-multiagentsubs.md`](../../draft/research-multiagentsubs.md)

## Decision

Puppeteer gains two provider-scoped capability families beside account usage, and a third that builds on both:

1. **Distribution.** An inventory of every installed agent executable (where it is, how it got there, which version,
   which one Puppeteer launches), release awareness per channel, and one-action updates that run the agent's own
   updater.
2. **Profiles.** A first-class account profile: one persistent native data root per account, bound to a process at
   launch through the provider's own root variable. There is no machine-wide "active account". Onboarding runs the
   native login inside that root; identity and usage are read per profile.
3. **Extensions.** Per-profile inventory and management of plugins, marketplaces, skills, and MCP servers through
   native stores and protocols.

All three follow one rule:

> **Native command, native evidence.** Puppeteer never reimplements an installer, updater, login, or plugin manager.
> It runs the agent's own command inside the environment it already controls, shows the output opaquely, and derives
> the outcome by re-observing native evidence: a version probe, an auth-status document, a store file, a protocol
> read.

This is RFC 004's terminal-text invariant applied to operations instead of sessions.

## Why

One development machine now carries nine agents installed five different ways (probed on this machine on
2026-09-06, darwin-arm64):

| Agent        | Installed how                                                                           | Version | Native update      | Root variable          |
| ------------ | --------------------------------------------------------------------------------------- | ------- | ------------------ | ---------------------- |
| Claude Code  | native installer, `~/.local/bin/claude → ~/.local/share/claude/versions/<v>`, self-updating | 2.1.263 | `claude update`    | `CLAUDE_CONFIG_DIR`    |
| Codex        | npm global `@openai/codex` under nvm Node 26.5.0                                        | 0.153.4 | `codex update`     | `CODEX_HOME`           |
| Copilot CLI  | standalone binary `~/.local/bin/copilot`                                                | 1.0.80  | `copilot update`   | `COPILOT_HOME`         |
| Grok         | vendor downloader `~/.grok/downloads/grok-<v>-<platform>`, plus a stale npm copy        | 1.0.13  | `grok update`      | `GROK_HOME`            |
| Kimi Code    | standalone `~/.kimi-code/bin/kimi`                                                      | 0.37.1  | `kimi upgrade`     | `KIMI_CODE_HOME`       |
| OpenCode     | standalone `~/.opencode/bin/opencode`                                                   | 1.18.23 | `opencode upgrade` | none known             |
| Pi           | npm global `@earendil-works/pi-coding-agent`                                            | 0.84.3  | `pi update self`   | `PI_CODING_AGENT_DIR`  |
| Hermes       | source checkout plus uv venv behind the `~/.local/bin/hermes` wrapper                   | 0.20.5  | `hermes update`    | `HERMES_HOME`          |
| Antigravity  | not installed here                                                                      | —       | `agy update`       | adapter-owned          |

Nobody knows which are behind. Every one updates differently. Several auto-update on their own. Checked on
2026-09-06, five of the eight were behind their stable channel: Copilot 1.0.80 → 1.0.83, Kimi 0.37.1 → 0.41.0,
OpenCode 1.18.23 → 1.18.29, Pi 0.84.3 → 0.85.1, Hermes 0.20.5 → 0.21.0. The support ledger
adds a third number: Claude Code is verified at 2.1.207, staged at 2.1.226, and installed at 2.1.263, so the
adapter is already observing a build it has never been promoted against.

Subscriptions are the second pain. Several Claude Max and Codex Pro accounts cannot run at once because the CLIs
default to `~/.claude` and `~/.codex`; switching means logout and login, and every account shares one history,
plugin set, and settings tree.

Puppeteer is already most of the way there:

- Runtime builds a clean child environment (`packages/runtime/src/host/environment.ts`): nothing is inherited except
  PATH, HOME, login identity, locale, and an adapter allow-list. The inherited-credential hazard the research draft
  warns about does not exist on the Puppeteer launch path.
- Every built-in provider already declares its root variable as its allow-list (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `GROK_HOME`, `KIMI_CODE_HOME`, `COPILOT_HOME`, `PI_CODING_AGENT_DIR`, `HERMES_HOME`; Antigravity through the
  adapter-owned `PUPPETEER_ANTIGRAVITY_HOME`; OpenCode none yet), and Claude and Codex continuations already persist
  the root, so resume lands in the right account today.
- Adapters already probe executables and versions (`detection.ts`), Surface already declares release detectors per
  vendor (`upstream.json`), and account usage (RFC 002) is the precedent for a provider-scoped capability composed
  by `builtin-providers`, validated by Core, and rendered by products without provider branching.
- Codex ground truth already contains the whole account and extension protocol: `account/read`,
  `account/login/start`, `account/logout`, `plugin/*`, `skills/*`, `marketplace/*`, `mcpServer/*`. Claude Code ships
  `claude auth status --json` with email, organisation, and subscription type (verified on 2.1.263).

What is missing is contracts, a registry, neutral executors, Surface claims for the new native facts, and a shell
surface in Godview.

## Boundaries that do not move

- Semantics never come from terminal text. Update and login output is displayed and may be kept as an opaque
  transcript; the result of an operation is always a fresh observation.
- Adapters own provider specifics; Runtime never imports a concrete adapter; Godview never branches on a provider
  id. The provider-mechanics gate over Godview production source stays in force: the new panels render capability
  data and call named services.
- Core and Surface stay zero-I/O. Every new native fact (root variable, credential storage, update subcommand, store
  layout, status-document shape, release endpoint) is a Surface claim generated into the adapter and digest-locked
  by `groundtruth-map.json`.
- Bearer tokens are never logged or persisted. Login runs in a terminal pane whose output Puppeteer does not
  capture. Update transcripts live 0600 under the host's data directory and are pruned.
- A profile selects a root for a child process. It is never a global switch, it never copies or moves credentials,
  and it is not a security boundary between accounts; that remains the job of worktrees, sandboxes, or OS users.
- Distribution and profile operations are host operations, not runs. They do not create a `RuntimeRun`;
  interactive ones borrow an `AgentHost` terminal.

## Architecture

### Core contracts

Three new files under `packages/core/src/services/`, strict Zod like `account-usage.ts`. Shapes are sketched, not
final:

```ts
// distribution.ts
type InstallMethod =
  | 'native-installer' | 'vendor-downloader' | 'npm-global' | 'brew' | 'standalone-binary' | 'source-checkout' | 'unknown';
interface InstalledAgent {
  providerId; executable; realPath; version?; method; packageName?; location;
  active: boolean;                                  // the one Puppeteer launches
  autoUpdate?: 'enabled' | 'disabled' | 'unknown';  // native evidence only
  detectedAt; warnings: string[];
}
interface ReleaseSnapshot { providerId; channel: 'stable' | 'preview'; version; publishedAt?; url?; fetchedAt; source }
type UpdateRecipe =
  | { kind: 'native-self-update'; argv: string[] } | { kind: 'npm-global'; package: string }
  | { kind: 'brew'; formula: string } | { kind: 'manual'; instructions: string };
interface UpdateReceipt { status: 'updated' | 'already-current' | 'failed' | 'unsupported'; before?; after?; transcriptPath? }

interface DistributionService {
  readonly provider: AgentProviderDescriptor;
  inspect(): Promise<InstalledAgent[]>;      // every candidate, not just the first on PATH
  releases(): readonly ReleaseDetector[];    // declarative; Runtime executes
  recipeFor(install: InstalledAgent): UpdateRecipe;
}
```

```ts
// profiles.ts
interface AgentProfile { id; providerId; label; kind: 'native-default' | 'managed'; dataRoot; createdAt }
interface ProfileSupport { supported: boolean; sharedSurfaces: string[]; identity: 'native-status' | 'native-protocol' | 'none' }
interface ProfileIdentity { loggedIn: boolean; method?; email?; organization?; plan?; verifiedAt; source }

interface ProfileService {
  readonly provider: AgentProviderDescriptor;
  readonly support: ProfileSupport;
  /** Names are a subset of nativeInvocation.environmentVariables; hosts merge, never inspect. */
  bindingEnvironment(profile: AgentProfile): Record<string, string>;
  /** The native login, run in a host terminal with the binding merged over the clean environment. */
  loginInvocation(profile: AgentProfile): TerminalSpec;
  verify(profile: AgentProfile): Promise<ProfileIdentity | ProfileFailure>;
}
```

```ts
// extensions.ts
interface ExtensionItem {
  id; name; kind: 'plugin' | 'marketplace' | 'skill' | 'mcp-server'; version?; enabled?;
  scope: 'profile' | 'project' | 'shared'; location?; latestVersion?;
}
interface ExtensionInventory { providerId; profileId; items: ExtensionItem[]; fetchedAt; source }
interface ExtensionAction { kind: 'install' | 'uninstall' | 'enable' | 'disable' | 'update'; target; interactive?: boolean }

interface ExtensionService {
  readonly provider: AgentProviderDescriptor;
  inventory(profile: AgentProfile): Promise<ExtensionInventory | ExtensionFailure>;
  invocation(profile: AgentProfile, action: ExtensionAction): TerminalSpec | NativeProtocolRequest;
}
```

Additive changes to existing contracts:

- `AgentProviderSessionOptions.profile?: AgentProfile`; `AgentSessionInfo.profileId?`; the monitor snapshot carries
  `profileId?` so views can treat the account as an identity ground.
- `AccountUsageService.fetch(profile?: AgentProfile)`; `AccountUsageSnapshot.profileId?`.
- Record: `installation-updated`, `profile-created`, `profile-verified`, and `extension-changed` join the own-action
  union.

### Adapters

One capability per file, as RFC 002 requires: `services/distribution.ts`, `services/profiles.ts`,
`services/extensions.ts`. Native facts come from `generated/` modules built from Surface, never hand-written in the
adapter. What each service would rest on, from current evidence and today's probes:

| Provider    | Distribution                                                                                                                                         | Profiles                                                                                                                                                                                                                                       | Extensions                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | fingerprint `~/.local/share/claude/versions/<v>` (native installer; `.last-update-result.json` is native evidence) and npm; `claude update`, `claude install <stable\|latest\|x.y.z>`, `claude doctor` plus `.last-update-result.json` as the native oracle; detectors `downloads.claude.ai` stable/latest and GitHub | `CLAUDE_CONFIG_DIR`; login `claude auth login`; identity `claude auth status --json` (`email`, `orgName`, `subscriptionType`); Keychain service `Claude Code-credentials[-<sha256(root)[:8]>]`, account `$USER`, file fallback `<root>/.credentials.json`; shared: project settings                                       | `<root>/plugins/installed_plugins.json`, `known_marketplaces.json`, `settings.json` `enabledPlugins`, `<root>/skills`; mutations through `claude plugin …` and `claude mcp …`                                                    |
| Codex       | npm global `@openai/codex` or GitHub tarball; `codex update` or the npm recipe; detectors GitHub `rust-v*`                                            | `CODEX_HOME`; login, identity, and logout through the private app-server (`account/login/start`, `account/read`, `account/logout`) over the transport the adapter already owns; `cli_auth_credentials_store` decides file (`<root>/auth.json`) vs keyring (service `Codex Auth`, account `cli\|<sha256(root)[:16]>`); shared `~/.agents/skills` | app-server `plugin/*`, `skills/*`, `marketplace/*`, `mcpServer/*`: protocol-native, no store parsing                                                                                                                       |
| Copilot CLI | standalone binary from npm platform tarballs; `copilot update [channel]`; `autoUpdate` setting                                                       | `COPILOT_HOME`; `copilot login`; identity `auth.getStatus`, then `account.getCurrentAuth` for a `user` login, on `copilot --server --stdio`; credential one keychain item per GitHub login | `copilot plugins`, `copilot skill`, `copilot mcp`; `<root>/{installed-plugins,skills,extensions,mcp-config.json}`                                                                                                        |
| Grok        | vendor downloader `~/.grok/downloads/grok-<v>-<platform>`; `grok update --check --json` is a native oracle, `grok update --version <v>`; detectors `x.ai/cli/{stable,alpha}`                                        | `GROK_HOME`; `grok login`, `grok logout`; identity ACP `_x.ai/auth/info`, then `_x.ai/billing` for the plan | `grok plugin`, `grok mcp`; ACP `PluginsChanged`                                                                                                                                                                         |
| Kimi Code   | standalone `~/.kimi-code/bin/kimi`; `kimi upgrade`                                                                                                   | `KIMI_CODE_HOME`; `kimi login` (device code); identity `GET {base}/me` with the stored access token, read-only | `--skills-dir`; skill and plugin ids in the source contract; directories to capture                                                                                                                                     |
| OpenCode    | standalone `~/.opencode/bin/opencode`; `opencode upgrade [target] --method <curl\| `XDG_DATA_HOME=<root>/data` (holds `auth.json`, `opencode.db`, logs) inside the clean environment; config, plugins, and cache stay shared; sign-ins: Console (`opencode console login`) and providers (`opencode auth login`) |pnpm\|bun\|brew>`; `autoupdate` config                                                              | `XDG_DATA_HOME=<root>/data` (holds `auth.json`, `opencode.db`, logs) inside the clean environment; config, plugins, and cache stay shared                                                                                                                                 | config `plugin[]`, `skills{paths,urls}`, `mcp{}`; `opencode plugin`, `opencode mcp`                                                                                                                                     |
| Pi          | npm global `@earendil-works/pi-coding-agent`; `pi update self`                                                                                       | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`; `/login` inside `pi`; identity: `auth.json` reduced to provider and type, confirmed by `pi auth check --no-refresh` | `pi list/install/remove/update/config`; `<root>/agent/{skills,extensions,prompts,tools}`                                                                                                                                |
| Hermes      | source checkout plus uv venv behind a wrapper script; `hermes update`                                                                                | `HERMES_HOME` (the adapter already redirects HOME for the gateway); `hermes portal`, `hermes auth`; identity through Hermes's own helpers in its venv | `hermes skills`, `hermes plugins`, `hermes mcp`; gateway `plugins.list`, `skills.manage`                                                                                                                                 |
| Antigravity | GitHub `agy_cli_*`; `agy update`; `AGY_CLI_DISABLE_AUTO_UPDATE`                                                                                      | adapter-owned HOME redirection (`PUPPETEER_ANTIGRAVITY_HOME`); login `agy`; identity: the ID token in `antigravity-oauth-token` | `/skills`; to capture                                                                                                                                                                                                   |

Imposter personas gain `--version`, `update`, `auth status --json`, and store layouts so conformance covers these
services without network or real accounts.

### Runtime

Two new modules beside `observation/` and `services/`; nothing here imports an adapter.

`distribution/`

- `inventory.ts` merges every provider's `inspect()` with PATH order and the configured executable, marks the active
  install, and refreshes on demand. Two installs of one agent are normal (Grok on this machine) and are shown, not
  hidden.
- `releases.ts` asks a provider's native update oracle first when one exists, then executes declarative detectors:
  `github-release`, `text`, and `npm-registry`. Network is opt-in,
  cached, and rate-limited using the detector `debounce`; results are Zod-validated. It also compares against
  `support/agents.json` so the UI can say "ahead of Puppeteer's verified baseline, observation may degrade"; the
  detection preflight already reports missing flags as warnings.
- `update.ts` runs a recipe in the clean environment: `native-self-update` (execFile argv), `npm-global` (node plus
  `npm-cli.js`, ported from `scripts/package-manager.mjs`), `brew`. The receipt is `inspect()` before and after; the
  transcript is opaque. Records `installation-updated`.

`profiles/`

- `registry.ts`: `~/.puppeteer/profiles.json`, schema-versioned, atomic 0600 writes, injected through
  `AgentRuntimeOptions` for hosts and tests. Every supported provider has one synthetic `native-default` profile
  pointing at the native root with no variable injected, so the existing account appears without being moved.
- `roots.ts` allocates `~/.puppeteer/profiles/<providerId>/<uuid>/` (0700). Paths are immutable because Codex
  derives its keyring key from the path; labels are metadata. (Since 2026-09-23 a root is allocated inside its
  profile set's folder instead — see "Profile sets".)
- `onboarding.ts`: create the profile, `AgentHost.spawnTerminal(loginInvocation)` with `bindingEnvironment` merged
  over the clean environment, then on pane exit `verify()` and store the identity on the profile. Output of the
  login pane is never captured.
- `runtime.spawn({ profile })` resolves the profile and passes it to `createSession`; `resume` needs nothing new
  because continuations already record the root. `runtime.accountUsage(providerId, profile)` fans out per profile;
  the host's usage monitor polls per (provider, profile).

### Observation roots (2026-09-12)

A sibling product runs an external history indexer (Rosetta's `rosettad`, the daemon RFC 007 queries) that applies
each provider's own on-disk layout to one directory per runtime and reads transcripts from it. Handing that indexer
a profile's `dataRoot` is right for seven of the nine providers and wrong for two, silently: Rosetta's Pi layout
root is `~/.pi` with the transcript glob `agent/sessions/*/*.jsonl`, while the managed binding pointed
`PI_CODING_AGENT_DIR` at `dataRoot` itself; and OpenCode's history lives at `$XDG_DATA_HOME/opencode`, one level
below the `XDG_DATA_HOME=<dataRoot>/data` the managed binding sets. A host that passed `dataRoot` would index the
wrong directory and report an empty history rather than a failure.

The mapping is provider-specific, so it belongs where every other provider-specific rule lives: the adapter.

- Contract: `ProfileService.observationRoot(profile): string` — the directory whose provider-native layout holds
  that profile's durable history. A native-default profile answers with the provider's own layout root; a managed
  profile answers with a path derived from `dataRoot` by the same binding rule `bindingEnvironment` applies. It is
  a plain adapter-owned method, not a schema field a host could fill in, and not always `dataRoot`.
- Runtime: `AgentRuntime.profileObservationRoot(profileId): Promise<string | undefined>`, beside
  `profileBindingEnvironment`. It resolves the profile through the registry and delegates to that provider's
  service, and answers `undefined` when the profile or its provider is unknown. Runtime still imports no adapter.
- Hosts pass the observation root to a history indexer, never `dataRoot`.

| Provider    | Managed                    | Native default              |
| ----------- | -------------------------- | --------------------------- |
| Claude Code | `dataRoot`                 | `~/.claude`                 |
| Codex       | `dataRoot`                 | `~/.codex`                  |
| Copilot CLI | `dataRoot`                 | `~/.copilot`                |
| Grok        | `dataRoot`                 | `~/.grok`                   |
| Kimi Code   | `dataRoot`                 | `~/.kimi-code`              |
| Hermes      | `dataRoot`                 | `~/.hermes`                 |
| Antigravity | `<dataRoot>/.gemini/antigravity-cli` | `~/.gemini/antigravity-cli` |
| OpenCode    | `<dataRoot>/data/opencode` | `~/.local/share/opencode`   |
| Pi          | `dataRoot`                 | `~/.pi`                     |

Pi's managed binding changed with this: `PI_CODING_AGENT_DIR` is now `<dataRoot>/agent`, one `agent` level inside
the profile root, on OpenCode's exact precedent — the binding never collides with the profile's own metadata, and
the profile root becomes the layout root. Pi holds its credentials in `auth.json` under that root rather than
deriving a keyring key from the path the way Codex does, so nothing breaks if the path moves: the change costs a
one-time move of an existing managed root's contents into `<dataRoot>/agent`, and no managed Pi profile existed on
the development machine when the binding changed. The adapter's own observation resolves the same variable, so it
finds sessions under the new binding without a second rule. Antigravity's managed answer follows the HOME
redirection down to `<root>/.gemini/antigravity-cli`; until 2026-09-23 it was nominal, because support was `false` and
no managed root was ever onboarded.

### Profile sets (2026-09-23)

A person does not think in per-provider roots. They think in places — "Work" holds a Claude Code sign-in and a
Codex sign-in; "Personal" holds others — and they want one of those places to be where new sessions start. A host
built that grouping itself for its Settings (VibeField's Agent Profiles), and a second host (Godview's profile tabs)
would have needed the same one; two groupings of one registry would drift. The grouping is an account concept, so
it is the registry's.

- **Contract.** `ProfileSet { id, kind: 'native' | 'managed', label, glyph?, directory?, createdAt }` in Core. A set
  holds at most one account per provider. `AgentProfile` gains `set` (the native set, `native`, for a native
  default) and `retiredAt`. The glyph is an open token the views resolve (`ProfileGlyph` in `packages/views`: eleven
  monoline symbols and the laptop for the native set, filled for the default) — open, so a glyph a newer build draws
  never makes an older build's registry unreadable.
- **The native set is synthetic**: the providers' own roots, never stored, renamed or removed. Every host sees it,
  whatever it named its own sets.
- **Folders.** A managed set owns one directory, `<rootsDirectory>/<id>/`, the id made once from its first name
  (`work`, `client-demo`, `work-2` on a clash; `native` and, since the sign-in contract below, `profiles`
  reserved); a rename never moves it. An account's root is
  `<set directory>/<provider>-<8 hex>/`, created exclusively, 0700, and never handed out twice: Claude Code keys its
  Keychain service and Codex its keyring account on the root's path, so an account signed out and added again must
  land where no credential left behind can answer for it. A host that roots the registry under a user's folder
  (VibeField: `users/<fuid>/agents/profiles/`) thereby keeps every account's config, history, plugins and sign-in
  for one place in one folder under that user.
- **The default.** The registry records one default set. `spawn()` with neither `profile` nor `profileSet` runs
  under the default set's account for the agent, else the provider's own root — which, with no default chosen, is
  what a spawn without a profile has always meant. `spawn({ profileSet })` is a demand: a set without an account for
  the agent is `AGENT_PROFILE_NOT_FOUND`; `native` is satisfiable for every provider, accounts or not. Resume and
  attach never consult the default — nor does a `resume` that arrives through `spawn`: a run continues in the account
  it was born under. `AgentSessionInfo.profileSetId` names the set, `native` included when it was named. The default
  is a preference, so a registry that cannot be read (a newer build's file, a torn write, a permission) leaves a plain
  spawn in the provider's own root, reported through `onError`; a named profile or set is a demand, and fails typed
  with its run terminal. `prewarm(provider)` warms what the next plain spawn will use — the default set's account —
  and never a signed-out one.
- **Sign-out.** `retireProfile(id)` takes an account out of its set and out of new spawns, logins, resumes, prewarms
  and terminal bindings while its sessions run on (attach still accepts it); a host finishes it when they have ended —
  `signOutProfile(id)`, then deletes the root and calls `removeProfile(id)`. `signOutProfile` refuses (`invalid`) an
  account that is not retired or that a run of this runtime still uses, and runs the adapter's optional native
  `signOut(profile)` for a credential kept outside the root (Claude Code: `claude auth logout` under
  `CLAUDE_CONFIG_DIR`, removing the root-keyed Keychain item; strict — a failed logout is a failure whatever it
  printed — and confirmed by the status read afterwards). Without one it answers `{ ran: false, credential }` from the
  adapter's declaration `ProfileSupport.credential`: `root` where the credential is a file inside the root (Codex's
  file store, which managed roots are written with; OpenCode's `auth.json` and `opencode.db` under the bound data
  directory; Hermes; Pi; Grok's `auth.json`; Kimi Code's `credentials/kimi-code.json`; Antigravity's
  `antigravity-oauth-token` in the redirected home), so deleting the root is the sign-out; `unknown` otherwise, so a
  host deletes the root and claims nothing beyond it. Copilot declares `external` — one keychain item per GitHub login,
  shared by every root signed in as that login — and has no `signOut` until `account.logout` is probed on a
  disposable account, so it answers `unknown` too.
- **Registry version 2** (`{ version: 2, defaultSet?, sets, profiles }`). A version 1 file is adopted on read by one
  rule that also repairs a hand-edited document: accounts named alike share a set unless two are of one provider,
  every account names an existing set, and every root stays where it is. A document naming one id twice is corrupt,
  not repaired — keeping either copy would let the next write forget the other's root. Writes run one at a time,
  each to a copy that becomes the state only once the store has saved it, so the file never lags what readers see and
  a failed write changes nothing; onboarding's check-then-act flows (one account per provider per set, one set per
  name) are serialized above that. An adopted set is given its folder on its first new account, named after its own
  id where that folder is free, never on a folder a registered set owns. Nothing needed adopting on the development
  machine.
- **Compatibility.** `createProfile({ providerId, label })` — the per-provider call Godview's drawer makes — joins the
  set of that name that has no account for the provider yet, or makes one, so a host that never heard of sets keeps
  working and its accounts group the way its user named them.

### Sign-ins and the services they bill (2026-09-23)

A profile's root is the agent's folder: its config, history, plugins, and whatever the agent keeps to stay signed in.
What a person pays for is something else — a sign-in to a service, the company whose account the work runs on and is
billed through. `ProfileIdentity` described one sign-in and left its service implied by the agent. That holds for a
vendor agent, whose root holds one sign-in to its own company's service: Claude Code to Anthropic, Codex to OpenAI,
Grok to xAI, Kimi Code to Kimi, Antigravity to Google, Copilot CLI to GitHub. It does not hold for a harness — Pi,
OpenCode, Hermes — whose one root holds sign-ins to several services, mostly other companies', so a row that said
"signed in" could not say to what, or which one a new session would use. The contract now separates the two.

- **Custody never moves.** Every sign-in is the agent's own login, run by the agent in a host terminal under the
  profile's binding, and its credential stays wherever the agent keeps it — a file inside the root or an OS keychain
  item. Puppeteer never copies, moves, or mints a credential, and identity never reads one: who is signed in comes from
  the agent's own status surface, and every shape below is strict, so no field exists for a token to travel in. (Account
  usage, RFC 002, is a separate capability: some usage services read an agent's own credential, read-only, to ask that
  agent's service for usage.)
- **`SignInService { id, label }`** names the service a sign-in is billed through — never the agent. Ids are shared
  across adapters so a host can tell that two agents' sign-ins are to the same service: lowercase ASCII letters and
  digits with `.`, `_` or `-` only between them, at most 64. An adapter maps its native provider ids onto the list below
  (a product line of a listed service, such as a coding plan or a Copilot seat, is that service) and passes an unlisted
  one through, folded to the grammar. The label is the service's own name as a person knows it, not a login-menu
  label; adapters use the listed labels exactly, so one service reads alike under every agent.

  | Id           | Label         | Own service of |
  | ------------ | ------------- | -------------- |
  | `anthropic`  | Anthropic     | Claude Code    |
  | `openai`     | OpenAI        | Codex          |
  | `xai`        | xAI           | Grok           |
  | `kimi`       | Moonshot AI   | Kimi Code      |
  | `google`     | Google        | Antigravity    |
  | `github`     | GitHub        | Copilot CLI    |
  | `nous`       | Nous Research | —              |
  | `opencode`   | OpenCode      | OpenCode       |
  | `openrouter` | OpenRouter    | —              |
  | `meta`       | Meta          | —              |

- **`ProfileSignIn { service, method, subscription?, inUse?, email?, account?, organization?, plan? }`** is one sign-in
  a root holds. `method` is the agent's own label (`oauth`, `api-key`, `free-tier`, …). `subscription` is set when the
  agent's own catalog calls the login a subscription rather than a pay-per-use key. `inUse` marks the one a new session
  uses unless the person picks another. Who and which plan appear only when the agent itself reports them: a harness
  usually keeps no email for a third party's login, and a host never fills one in.
- **`ProfileIdentity.signIns`** lists every sign-in, for an agent whose root holds several; a vendor agent reports no
  list. When present it is the whole answer, and the schema holds it to two rules: `loggedIn` is true exactly when the
  list is non-empty — an empty list is a signed-out harness — and at most one sign-in is in use. The top-level `method`,
  `email`, `account`, `organization` and `plan` repeat the in-use sign-in's, and are absent when none is in use, so a
  view that predates the list still reads the one that matters. The runtime derives them from the list when it
  verifies, whatever the adapter put there, rather than trusting every adapter to keep the two in step (the same way
  `support.signOut` is the runtime's fact, not the adapter's).
- **`account`**, on `ProfileIdentity` and on `ProfileSignIn`: a non-email handle for the account, such as a GitHub
  login. A view shows it before the email.
- **`borrowedFrom`** (2026-09-24), on `ProfileIdentity` and on `ProfileSignIn`: the program whose sign-in the agent
  runs as because its root holds none of its own — Copilot without its own login acts as the GitHub CLI's user;
  Hermes's pool seeds rows from the GitHub CLI, Claude Code and Qwen Code. Such a sign-in is the machine's, not the
  profile's: every root that borrows it answers for one account, so a host must not present it as the profile's
  own. The adapter names the program as a person knows it; the runtime's in-use derivation carries it like the
  other top-level fields.
- **`ProfileSupport.service`**: the service the agent's own sign-in is to (Claude Code declares Anthropic; Codex,
  OpenAI). Absent for an agent with no service of its own.
- **`ProfileSupport.signInRoutes`** `[{ id, label, service? }]`: the ways to add a sign-in to a root, for an agent whose
  root holds several. Each route is the agent's own login, named as a menu item ("Nous Portal", "Another provider…"),
  with its service when it signs in to exactly one; one to sixteen routes, each id unique, and absent means one login.
  A route is an id, never a command: `loginInvocation(profile, { cwd, route? })` builds the terminal spec from it.
- **The route check.** `startProfileLogin({ profileId, cwd?, route? })` refuses a route the adapter did not declare —
  `invalid`, with no terminal opened and the adapter never asked — and an agent that declares no routes refuses every
  route. With no route the adapter is asked for its default login, without a `route` key at all. The runtime checks
  against its own copy of the declaration; `profileProviders()` hands out deep copies, so a host cannot widen it by
  editing what it was given.
- **The reserved set id `profiles`.** Hermes treats a `HERMES_HOME` whose parent directory is named `profiles` as one
  of its own native profiles and takes provider credentials from the grandparent (probed on Hermes 0.21.4;
  `draft/HERMES-SUBSCRIPTION-IDENTITY.md`). A Hermes root is `<rootsDirectory>/<set id>/hermes-<8 hex>`, so a set
  folder named `profiles` would point every Hermes account in it at `<rootsDirectory>` itself — outside every set,
  where deleting an account never reaches. No new set is given the id or the folder `profiles`, as none is given
  `native`: a set named "Profiles" gets `profiles-2`, whether `createProfileSet` makes it, the per-agent
  `createProfile({ label })` does, a version 1 registry is adopted, or an adopted set is given its first folder. A
  rename moves nothing. A registry that already holds a `profiles` set is read as it is; one whose folder is already
  `<rootsDirectory>/profiles` (only a set made on 2026-09-23 before this rule, or a folder a host chose through
  `addSet`) keeps it, and the Hermes adapter guards the rest: its `initializeRoot` refuses a managed root whose parent
  directory is named `profiles`, so such an account fails `unavailable` and nothing is registered.

#### Per agent

Every reading below is `experimental` unless it says otherwise, and each still owes its Surface claim set before
promotion. Identity never reads a credential except where a paragraph says so, and nothing it returns carries one.

- **Claude Code** — service `anthropic`. Unchanged: `claude auth status --json` gives email, organization and plan
  (`native-status`, documented). Credential `external`, removed by `claude auth logout`.
- **Codex** — service `openai`. Unchanged: app-server `account/read` with token refresh off (`native-protocol`,
  documented). Credential `root` in managed roots.
- **Grok** (probed on 1.0.41) — service `xai`, credential `root` (`auth.json` in `GROK_HOME`), no `signOut`.
  `verify()` (`native-protocol`) starts `grok agent --no-leader stdio` through the ACP client account usage shares, in
  an allow-listed environment plus `GROK_HOME` — never `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, `GROK_AUTH` or
  `GROK_AUTH_PATH`. It sends `initialize`, then `_x.ai/auth/info`. A `methodId` of `cached_token` or `xai.api_key` is
  signed in; `null`, `grok.com` and `oidc` are signed out; any other value is `unavailable`. The email comes when
  present, and the organization from `organizationName`, else `teamName`. Only when signed in, `_x.ai/billing` gives
  the plan (`subscription_tier` or `subscriptionTier`); a billing miss keeps the identity without one. It never calls
  `authenticate`, `_x.ai/auth/check_subscription` (which refreshes first) or `_x.ai/auth/getBearerToken`. A build
  without the method (`-32601`) is `unsupported`.
- **Kimi Code** (Kimi Code 2.0.2) — service `kimi`, credential `root` (the only token store is the file), no
  `signOut`. `verify()` (`native-status`, documented) reads the access token Kimi Code keeps in
  `<root>/credentials/kimi-code.json` and makes one `GET {base}/me`. That gives `email`, and `user_level_name` as the
  plan, with method `kimi-code`. `{base}` is `KIMI_CODE_BASE_URL`; else the `managed:kimi-code` provider's `base_url`
  in `config.toml`, when it names `api.kimi.com` or `api.kimi.ai` `/coding/v1`; else the root's `region` marker; else
  mainland. Verify never refreshes and never writes. A missing file or blank tokens is signed out. A lapsed
  15-minute token, a rejected token or a malformed document is `unavailable` and keeps the last identity. The local
  server's `/api/v1/oauth/userinfo` is never used: it refreshes first and blanks the credential when that fails. Usage
  reads `{base}/usages` from the same root: `usages.limit_5h`, `limit_7d`, `limit_month_total`, `limit_month_code` and
  the booster wallet.
- **Antigravity** (agy 1.2.9) — profiles are on. Service `google`, credential `root`, no `signOut`: in-prompt
  `/logout` purges the OS keyring every home shares. The adapter-owned `PUPPETEER_ANTIGRAVITY_HOME` becomes `HOME` for
  the child, both in the driver's launch and in the login terminal a host spawns directly. The login is `agy` itself,
  whose first launch in an empty home opens the browser. `verify()` (`native-status`) reads
  `<store>/antigravity-oauth-token` without touching `token`. It decodes the ID token's payload locally for `email` and
  `hd` (the organization), and takes `auth_method` as the method; there is no plan. A missing file is signed out. An
  unreadable file, or one naming no account, is `unavailable`. A root set to a Gemini API key (`modelProvider:
  "gemini"`), or running where `AGY_ADC_AUTH` is set, reads signed out with that method, never as the consumer account:
  the launch allow-list forwards neither the key nor the switch.
- **Copilot CLI** (1.0.88) — service `github`, credential `external`, no `signOut`. `verify()` (`native-protocol`)
  speaks Content-Length JSON-RPC to the server the official SDK starts (`copilot --server --stdio --no-auto-update`),
  and `ping` must answer protocol version 3. The server runs with only PATH, HOME, user, locale and temp in its
  environment, never `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`. `auth.getStatus` gives `isAuthenticated`,
  `authType` (the method) and `login`, which fills `account`. Only a `user` status is followed by
  `account.getCurrentAuth`. That call's `copilotUser` is allowlisted to `copilot_plan` (the plan) and a single-entry
  `organization_login_list` (the organization), and the whole document is dropped if a token, hmac or key field appears
  anywhere in it. A `gh-cli` status is the truth for a root with no Copilot login of its own: it runs as GitHub CLI's
  user, and the identity says so with `borrowedFrom: "GitHub CLI"`. The credential is one `copilot-cli` keychain item per GitHub login, shared by every root signed in as that
  login, so deleting a root leaves it.
- **Pi** (0.87.1) — a harness with no `service` of its own, no `signInRoutes` (every sign-in is `/login` inside
  `pi`), no `signOut`, and credential `root`. A root keeps one credential per upstream provider in
  `<agent dir>/auth.json`, and `settings.json`'s `defaultProvider` names the one a new session uses. No Pi command lists
  a root's sign-ins, and `pi auth check` reports `ready` for any provider whose key is in the environment. So `verify()`
  (`native-status`) reads `auth.json` the way Pi's own `CredentialStore.list()` does — provider id and type, never
  `access`, `refresh`, `key` or `env` — and returns one `signIns` row per credential. The service is mapped from Pi's
  provider id; the method is `oauth` or `api-key`; `subscription` marks the six OAuth logins Pi flags `isSubscription`.
  Only the selected row — `defaultProvider`'s, else the only subscription login, else the first — is confirmed, with
  `pi auth check --provider <id> --json --no-refresh` under `PI_CODING_AGENT_DIR` and with provider credential variables
  removed. It is marked `inUse` only when the answer is `ready` with the stored type; a failed check leaves the row
  listed, not in use, and is not a sign-out. Pi keeps no email, organization or plan, and a ChatGPT `accountId` is never
  shown as one.
- **OpenCode** (1.18.32) — a harness whose own service is `opencode`, credential `root`. Routes: `provider`
  ("Another provider…", `opencode auth login`, the default) and `console` ("OpenCode Console", `opencode console
  login`, a device-code flow). `verify()` (`native-protocol`) returns one row per Console account in `opencode.db`
  (method `console`, the stored email, and the org name from `GET /experimental/console/orgs` on a short-lived
  `opencode serve` bound to the root, started only when an account exists). It also returns one row per `auth.json`
  entry: the service mapped from the provider id, method `oauth`, `api-key` or `wellknown`, and `subscription` only for
  the catalog's plan logins (ChatGPT, SuperGrok, Copilot). The database is opened read-only and read by named columns,
  never a token column; `auth.json` is reduced to provider id and type as it is parsed. No row is `inUse`: a new
  session's model is chosen in the shared config or the state root's recent-model list. An unreachable console costs
  the org names, not the rows. The org request lets OpenCode refresh a Console token near expiry, as any OpenCode
  start in the root would.
- **Hermes** (read against the 0.21.4 source) — a harness whose own service is `nous`, credential `root`. Routes:
  `portal` ("Nous Portal", `hermes portal`, the default: `hermes auth add nous --type oauth` plus the model and provider
  choice; 0.21.4's `hermes login` only prints that it was removed) and `provider` ("Another provider…", bare
  `hermes auth`, whose first action adds a credential for any provider). `verify()` (`native-protocol`) runs one short
  script in the interpreter the `hermes` wrapper execs, with `-I -B` and only `HERMES_HOME` bound, and reads one
  allowlisted JSON line. The script reads the refresh-free `get_nous_auth_status_local()` snapshot. Only when that
  snapshot holds a Portal login does it call `get_nous_portal_account_info(force_fresh=True)` for email, organisation
  and plan: a 401, or a refresh Hermes itself quarantined, removes the row, and a network failure keeps it without
  details. It reads the stored pool through `read_credential_pool()`, projected to provider and auth type, and never
  calls `load_pool()`, which runs `gh auth token` and writes back. `gh_cli`, `claude_code` and `qwen-cli` rows are
  another program's login, marked by method and by `borrowedFrom` ("GitHub CLI", "Claude Code", "Qwen Code"). The in-use row comes from `model.provider` in the raw config. It never
  calls `get_nous_auth_status()`, which redeems the single-use refresh token. The probe drops every provider credential
  variable (`*_API_KEY`, `*_TOKEN`, …) from the host's environment: a launched session never sees them, and Hermes's
  pool loader would seed and save them. `initializeRoot` refuses a root Hermes would resolve into another root — one
  whose parent directory is named `profiles`, or anywhere inside `~/.hermes` — because such a home falls back to that
  root's store and keeps the Nous login's shared copy outside the profile.

### Plans: what a set runs on (2026-09-24)

A person pays for plans — a Claude Max account, a ChatGPT Pro account — and a set's agents sign in to them. Which
plans a set runs on, whose account each is, and which agents spend it are a reading of the set's identities, never
a record: nothing is stored, matched, or asked of a person. Core's pure `profileSetPlans(sets, providers)` reads
every set at once (so it can say where else an account is used) and answers, per set, `plans` and `holdings`.

- **A holding** is one sign-in a profile holds: a harness's `signIns` rows, or the one sign-in a vendor agent's
  identity describes, to the service its provider declares. `key` marks a pay-per-use key; `planId` names the plan it
  is on; `runsOn` marks the one the agent runs on — the one in use, else its first subscription, else the first that
  names an account, else its first. A profile whose identity is unknown or signed out holds nothing.
- **A plan** is `{ id, service, account?, namedBy?, borrowedFrom?, holders, alsoIn }`. A sign-in is placed by the
  first rule that fits: `api-key`, the method label every adapter gives a raw key, is never a plan; a sign-in that
  names its account (a handle or an email, compared without case) is on that account's plan, read through the
  service's own agent where several name it (`namedBy` — its usage is the plan's); a borrowed sign-in that names no
  account is on the plan of the same program's credential; any other sign-in that names no account is on the plan the
  service's own agent named in the set, else the first another agent named without borrowing, else the service's
  unnamed plan. The third rule is the design's simplification, and a host says it out loud: inside one set a harness's
  sign-in to a company is taken to be the set's account with that company, and its row says the agent does not name
  the account.
- **Ids and order.** Plans come in the order the set's agents first hold them; an id is the service id, then `-2`,
  `-3` … for further plans with the same service. `alsoIn` lists the other sets with a plan for the same account, or
  running on the same borrowed sign-in.
- **Presentation** stays in the views: `ServiceMark` draws a service with its company's mark (LobeHub's, Claude's for
  Anthropic), `serviceProduct` names what the company's plans are sold as ("Claude", "ChatGPT"), and `planTitle` joins
  the two ("Claude Max"; a label that already names the product, such as "SuperGrok Heavy", stands alone; the product
  alone when no plan was reported). Never select behaviour on them.

### Host and Godview

- Composition: `createBuiltinProviders` wires the three services beside `accountUsage`. A persisted per-provider
  "active executable" feeds the existing `executables` option (restart-required in the first cut).
- IPC follows the account-usage pattern: `puppeteer:installs`, `puppeteer:releases`, `puppeteer:update-agent`,
  `puppeteer:profiles`, `puppeteer:create-profile`, `puppeteer:verify-profile`, `puppeteer:extensions`,
  `puppeteer:apply-extension-action`, with push channels for installs, profiles, and the now profile-keyed usage
  batch. `create-agent-session` gains `profile`.
- **The pane is the profile boundary.** A terminal pane opened "as profile P" gets P's `bindingEnvironment` seeded
  through the existing ZDOTDIR and shim path, so `claude`, `claude auth login`, `claude plugin install …`, and the
  spawn-through interception all land in P without any provider knowledge in Godview. Interactive extension actions
  and logins run this way; non-interactive ones use `execFile`.
- Shell surface: an "Agents" drawer with Installs, Accounts, and Extensions. It is shell chrome, not a monitor
  view, so the design system binds it; how a profile appears on a body in the swarm is a design-record question,
  not decided here.
- Aliases: the registry can export `claude-<label>` and `codex-<label>` shell aliases so profiles work in plain
  terminals too.

### Surface

`upstream.json` detectors are generated into adapters instead of being consumed only by repository scripts. Three
analysis kinds join the promotion workflow, `distribution`, `profiles`, and `extensions`, each a claim set with
captures: version output, update subcommands, install fingerprints, root variable and credential storage,
status-document shape, store layouts or protocol methods. `pnpm groundtruth:mapping:check` covers them like any
other native surface.

## Rollout

Three tracks. A and B are independent; C needs B.

| Step | Scope                                                                                                          | Depends on    |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------- |
| A1   | Inventory panel: installs, versions, method, location, active binding, auto-update state. Read-only.            | —             |
| B1   | Profile registry, roots, `spawn({ profile })`, pane seeding, `native-default` profiles.                         | —             |
| B2   | Onboarding: login in a pane, identity verification, labels.                                                    | B1            |
| A2   | Release awareness per channel (opt-in network), baseline comparison.                                            | A1            |
| A3   | One-action update with receipt; choose the active install.                                                     | A2            |
| B3   | Per-profile usage rows (Claude Keychain naming per root captured 2026-09-06).                                   | B2            |
| C1   | Read-only extension inventory (Codex protocol first, then Claude store files).                                  | B1            |
| C2   | Extension actions through native commands and protocol.                                                         | C1            |
| C3   | Apply one profile's extension set to another.                                                                  | C2            |
| B4   | Profile as an identity ground in the swarm and list views.                                                     | design record |

Suggested order: A1, B1, B2, A2, A3, B3, C1, C2, C3, B4.

## Implementation status

Phase 1 landed on 2026-09-06 against the contracts above; the Surface claims for the new native facts are the
next step (see "Resolved questions" for the probes they must capture).

- Core: `packages/core/src/services/distribution.ts` and `profiles.ts`; `AccountUsageService.fetch({ profile })`
  and `AccountUsageSnapshot.profileId`.
- Runtime: `packages/runtime/src/distribution/{inventory,releases,update}.ts` and
  `profiles/{registry,roots,onboarding}.ts`; `AgentRuntime` gained `distributionProviders`, `inspectInstallations`,
  `checkReleases`, `updateInstallation`, `profileProviders`, `profiles`, `profile`, `createProfile`,
  `removeProfile`, `profileBindingEnvironment`, `profileObservationRoot`, `startProfileLogin`, `verifyProfile`, `onProfilesChanged`, and
  `accountUsage(providerId, profileId?)`; `spawn({ profile })`, `resume({ profile })`, and spawn-through attribution
  of `AgentSessionInfo.profileId` from the forwarded environment. Registry `~/.puppeteer/profiles.json` (0600,
  atomic), roots `~/.puppeteer/profiles/<provider>/<uuid>` (0700), transcripts `~/.puppeteer/updates` (0600).
- Adapters: every executable adapter ships `services/distribution.ts` and `services/profiles.ts`. Claude verifies
  through `claude auth status --json` and reads per-profile usage from the digest-suffixed Keychain item or
  `<root>/.credentials.json`; Codex verifies through app-server `account/read` with `CODEX_HOME` and writes
  `cli_auth_credentials_store = "file"` into new roots; Grok implements the native oracle; OpenCode forwards
  `XDG_DATA_HOME` and records it in a version 2 continuation; Pi has no login command (identity none);
  Antigravity declares its binding but reports `supported: false` because 1.1.21 has no login subcommand. (Both
  superseded on 2026-09-23; every adapter's current reading is under "Per agent".)
- Composition: `packages/builtin-providers` wires both services per provider and binds a selected profile through
  each adapter's own native-invocation normalizer; OpenCode's allow-list is `['XDG_DATA_HOME']`.
- Godview: `AgentsDrawer` (Installs, Accounts), the `puppeteer:installations`, `check-releases`,
  `update-installation`, `profiles`, `create-profile`, `start-profile-login`, `verify-profile`, `remove-profile`,
  `profile-defaults`, and `new-terminal-tab` IPC surface, profile-bound terminal tabs, persisted per-provider
  defaults, per-profile usage rows, and account labels on monitored agents.
- Proof: `PUPPETEER_DISTRIBUTION_LIVE=1` runs the read-only inventory and oracle proof against the machine.

Open after phase 1: the extension track (C1–C3), profile marks in the views (B4), Surface claims for the probed
facts, the release-awareness cadence (today network runs only on an explicit check), and Codex auto-update state
(no native switch exists, so it reports `unknown`).

Added 2026-09-23 for VibeField's Agent Profiles (see "Profile sets"): `ProfileSet` and `ProfileGlyph` in Core,
`AgentProfile.set` and `retiredAt`, the optional adapter `ProfileService.signOut` (Claude Code), registry version 2
with version 1 adoption, set folders and per-account roots in `roots.ts`, and `AgentRuntime.profileSets`,
`profileSet`, `createProfileSet`, `updateProfileSet`, `setDefaultProfileSet`, `removeProfileSet`, `retireProfile`,
`signOutProfile`, `createProfile({ set })`, `spawn({ profileSet })` with the default set applied to spawns only, and
`AgentSessionInfo.profileSetId`; `ProfileGlyph` and `suggestProfileGlyph` in the views. Godview's drawer is
unchanged: its per-provider calls land in sets named as its user named them. After review the same day:
`ProfileSupport.credential`, the retire-first and live-run rules on `signOutProfile`, serialized commit-after-save
registry writes, the unreadable-registry fallback for plain spawns, and every profile service built with the
executable its launch uses (a login, an identity read or a sign-out reaches the install the host chose).

Added 2026-09-23 for account rows that say what they hold (see "Sign-ins and the services they bill"): `SignInService`,
`ProfileSignIn` and `ProfileSignInRoute` in Core; `ProfileIdentity.account` and `signIns`; `ProfileSupport.service`
and `signInRoutes`; the optional `route` on `loginInvocation` and `startProfileLogin`, refused unless declared; the
runtime's derivation of an identity's top-level fields from its in-use sign-in; deep copies from `profileProviders()`
and from the registry; the reserved `profiles` set id; and Godview's drawer showing an account handle before the email
and, for a root that lists its sign-ins, the one in use and how many others (every sign-in on hover).

Added 2026-09-24 for profile pages that show what a set runs on (see "Plans: what a set runs on"): Core's pure
`profileSetPlans` with `ProfilePlan`, `ProfileHolding` and `ProfileSetPlans`; `borrowedFrom` on `ProfileIdentity` and
`ProfileSignIn`, carried by the in-use derivation and set by Copilot (`gh-cli`) and Hermes (its borrowed pool rows);
and the views' `ServiceMark`, `serviceProduct` and `planTitle`.

Added 2026-09-24 for Godview's profile tabs (B4's first half, VibeField's T3): the views' `ProfileTabs` — a sliding
segment of All and each set, glyph and name, that a host centres in `InstrumentBar`'s new `centre` slot — and
`MonitorAgent.receded`, host-set presentation the swarm, the list and the rain draw faint (`monitor/recede.ts`: 22 %,
7 % when every row recedes, 240 ms) while keeping the row in the physics and in the list. Which set a run is under
is already `AgentSessionInfo.profileSetId`; a set as an identity ground on the bodies themselves stays open.

Started 2026-09-25, C1's first half, for VibeField's Extensions (its design record, pass 24: skills and MCP servers
kept once per profile, turned on per agent; plugins per agent). Core `services/extensions.ts` settles the sketch
above for reading: four kinds (`plugin`, `marketplace`, `mcp-server`, `skill`) in one item union whose `origin` says
where an item comes from (`own`, `project`, `plugin`, `bundled`, `managed`, `agent`, `borrowed`, with the plugin,
project or lending agent named), `shared` for an item every profile of the agent reads from one place,
`ExtensionInventory` with the kinds a read could not cover (`unread`), per-kind `ExtensionSupport` on the provider
(kept per profile or shared; changed by command, protocol, folder, or only in the app; a kind the agent lacks is
absent), `ExtensionFailure`, and `ExtensionService { provider; inventory(profile) }` — the sketch's `invocation`
waits for C2. An inventory never carries a secret: a server's environment and headers are names, and
`describeMcpUrl` / `describeMcpCommand` drop userinfo and query and mask any argument that could hold a credential,
so two definitions that differ only in a secret read as one server. `parseSkillFrontmatter` reads a `SKILL.md`. The
runtime's `extensions/inventory.ts` adds `AgentRuntime.extensionProviders()` and `extensionInventory(providerId,
profileId?)`: the native default when no profile is named, coalesced per profile, checked against the schema,
including that it names the profile asked for and holds no kind the adapter declares absent. Claude Code is first,
from its store files: `<root>/.claude.json` (the native default's `~/.claude.json`), `settings.json`,
`plugins/installed_plugins.json`, `known_marketplaces*.json`, `plugins/synced/`, each plugin's manifest, `.mcp.json`
and `skills/`, and `skills/` with `skills/synced/`; never `claude mcp list`, which connects to every server it
lists. `createBuiltinProviders({ home })` hangs native-default roots off a given home, so a host's tests never read
the real one. Next, per James's reports (`draft/*-PLUGINS-SKILLS-MCP.md`, probed 2026-09-24): Codex, then Grok,
Kimi, OpenCode, Pi, Hermes and Antigravity, from files where their listings would connect or start a session.

Codex followed the same day, through Codex alone. One private app-server, bound to the profile and started in its
root, answers `skills/list` (the root as the only cwd, so no repository's skills), `plugin/installed`, `config/read`
(its `origins` only, which say which layer set each `mcp_servers.<name>` key) and `plugin/read` per enabled plugin of
a local marketplace (the servers it brings); `codex mcp list --json`, run in the root with the same binding, lists
every server the profile loads. A server is the profile's own when the user layer set it, a managed layer's when
another did, a plugin's when an enabled plugin declares it, and otherwise the host app's or the account's (the
ChatGPT connectors server), read as managed. User skills in `~/.agents/skills` are `shared` and `switchable`; system
skills are `bundled`; a plugin installed by a workspace setting is managed. Marketplaces are declared and not yet
read. The response shapes come from Codex's own source at `rust-v0.150.0`, the Surface pin, whose model carries
these methods' requests but not their results. Two corrections to the reports, from that source: `mcp list` starts
no server and opens no session, but for an enabled HTTP server with no bearer variable, no Authorization header and
no stored sign-in it fetches the server's OAuth metadata, which is how it tells "needs a sign-in" from "has none";
and it prints environment and header *values*, so the adapter keeps names and never repeats its output or its
errors. Its sign-in states are snake case (`not_logged_in`, `o_auth`), not the protocol's camel case.
`plugin/installed` may also refresh the account's remote-installed plugins, as Codex does whenever it starts. Core's
wording follows: reading never starts an MCP server or opens a session with one, though an agent's own listing may
fetch a server's public sign-in metadata.

The other six the same day, each from its own files, since their listings would connect, start a session, install,
or miss what a session loads. Every one takes the `home` the builtin composition is given, and so does every profile
service; under an injected home Codex also pins `HOME` and `CODEX_HOME`, and Kimi and OpenCode stop following the
machine's variables, so a host's tests reach nothing real.
- **Grok**: its root's `config.toml` (a TOML subset read strictly; `[mcp_servers]`, the disabled lists, the
  `[compat.claude]` and `[compat.cursor]` cells), `skills/`, `bundled/skills/`, `installed-plugins/` and `plugins/`.
  What it borrows from the home is `borrowed` and `shared`: Claude Code's skills and `~/.claude.json` servers
  (`lender: 'claude'`), every plugin in Claude's `installed_plugins.json`, and Cursor's skills and servers; a cell
  that is off leaves them listed and off. `~/.agents/skills` is the person's own, shared. Never `grok mcp doctor`.
- **Kimi**: `plugins/installed.json` with each plugin's manifest, servers and skills; `mcp.json`; `skills/` and
  `~/.agents/skills`. Plugins and servers change only in the app: there is no command, and `kimi web` would be a Kimi
  process of its own. `bearerTokenEnvVar` reads as the variable plus an `Authorization` header; whether an OAuth
  server is signed in lives in its credential store, which is not read.
- **OpenCode**: the config documents in OpenCode's merge order, as JSONC. One config serves every profile, so every
  item is `shared`, and servers have no command that turns one off (`changes: 'in-app'`). `{env:NAME}` stays in a
  target as written and NAME joins the server's variables. `mcp-auth.json` is not opened, so no sign-in state; Claude
  Code's skills are borrowed; skills from `skills.urls`, fetched at start, mark the kind unread. Never `opencode mcp
  list`, which connects.
- **Pi**: `settings.json` packages (npm, git, local) and loose extensions are its plugins; skills follow Pi's own
  precedence and filters (its glob subset and exact `+`/`-` entries); a filter outside that subset marks the kind
  unread rather than guessed. No MCP and no marketplace, so neither kind is declared; no skill is switchable, since
  only `pi config` writes the switch. Never a Pi start, which installs missing packages.
- **Hermes**: `config.yaml` (a YAML subset whose errors never quote the document) for servers (`${VAR}` and
  `${env:VAR}` as names), the plugin allow-list and disabled skills; plugins under `plugins/`, with the bundled ones
  the config names listed as `bundled`; skills in Hermes's own words (bundled, hub-installed, agent-created →
  `bundled`, `own`, `agent`). A server's sign-in is whether its token file exists; `.env`, `auth.json` and token
  contents are never read. No `hermes` command, which writes config or starts OAuth.
- **Antigravity**: `.gemini/config/` under the profile's home: plugins by `plugin.json` with `config.json`'s
  switches, their servers and skills; `mcp_config.json`, whose literal secrets are read as names; `skills/`; the
  CLI's builtin skills. `agy plugin list` misses a plugin copied in by hand, so it is not the source; the extra
  folder lists (`skills.json`, `plugins.json`) mark their kind unread until their global place is known.

C2's first slice, the same day: acts on what a profile's agent already holds. Core adds `ExtensionActKind`
(`enable`, `disable`, `remove`), `ExtensionActPlan` — available: what runs (the agent's own command, as argv plus the
variables that point it at the profile, or a call on its protocol) and what it reaches beyond that one item
(`definition`: turning it back on needs it again; `sign-in`: a remote server's stored sign-in goes; `every-profile`;
`shared-folder`); unavailable: `in-app`, `no-command`, `not-own` or `not-held`, in the agent's own words —
`ExtensionActReceipt`, `ExtensionService.plan?(profile, item, act)` (pure) and `perform?` (a protocol plan through the
adapter's own transport), and `EXTENSION_COMMAND_NAME`, which keeps a name that could be read as a flag or a path out
of an argv. The runtime's `extensions/act.ts` answers `planExtensionAct` and `runExtensionAct`: a fresh read finds
the item (`inventory(…, { fresh: true })` never joins a read that began before), the adapter plans, a command runs
through the update runner (no stdin, a process group of its own, the clean environment plus the plan's variables, two
minutes, the agent's own folder as cwd so no project's config joins in), and a second fresh read decides the receipt —
`changed`, `unchanged`, `failed` or `unavailable` — never the output, which is display text only. What each agent
offers, from the reports: Codex turns a server of its user layer on and off through the app-server's
`config/value/write` of `mcp_servers.<name>.enabled` (its sign-in stays), removes one with `codex mcp remove`, and
switches a skill of `~/.agents/skills` for one profile through `skills/config/write` on its `SKILL.md`; Grok `grok mcp
enable|disable` and `grok mcp remove --scope user`; Antigravity `agy mcp enable|disable` under the profile's HOME, for
a name the read found (disabling an unknown one writes a stub), removal not probed and not offered; Claude Code has no
switch for a whole profile (`/mcp` works one project at a time), so `claude mcp remove --scope user`, which reaches
the definition and, for a remote server, its sign-in; Hermes `hermes mcp remove` only; Kimi (inside the app), OpenCode
(no command; one config serves every profile) and Pi (`pi config`) answer unavailable. A plugin's, a project's, the
app's, an organization's or another agent's item changes where it comes from. Settings keys with no command
(`skillOverrides`, `[skills] disabled`, `enabled: false`, `skill: deny`) stay the agent's: no act writes one. Turning
one on for an agent that does not hold it needs its definition and secret kept once, and waits.

C2's second slice, 2026-09-26: a remote server's sign-in and sign-out. `ExtensionActKind` gains `sign-in` and
`sign-out`; a plan's run gains a third kind, `terminal` (argv plus the binding variables, run only in a terminal the
person answers, since the agent's own login opens a browser and may ask for a pasted code); `no-sign-in` says a server
has none of the agent's (it runs on the machine, speaks WebSocket, or sends its own `Authorization`); and a receipt may
be `unconfirmed`, where the agent keeps its sign-ins out of any read. `runExtensionAct` refuses a terminal plan;
`startExtensionAct` plans from a fresh read and opens it through the host's `spawnTerminal` (the profile login's
path), and `settleExtensionAct` — which the host calls when that terminal ends, saying whether the person stopped it —
reads the agent again: a sign-in is done when the agent says signed in. Per agent: Codex `codex mcp login` and `codex
mcp logout` for a streamable HTTP server its `mcp list` says asks or holds one — off Windows Codex keeps the sign-in in
the OS keychain under the server's name and a hash of its address, not its `CODEX_HOME` (`compute_store_key` in
`rmcp-client/src/oauth.rs` at `rust-v0.150.0`; the Direct backend is the default there), so both reach
`every-profile`; Claude Code `claude mcp login` and `claude mcp logout` (the report's shell forms, not probed), kept in
the root's own keychain item, which no read opens, so its receipt is `unconfirmed`; OpenCode `opencode mcp auth` and
`opencode mcp logout` under the `XDG_DATA_HOME` it binds (the server's definition is every profile's; its
`mcp-auth.json` is the profile's); Hermes `hermes mcp login` for a server marked `auth: oauth`, with no command that
signs out; Grok, Antigravity and Kimi sign in only inside their apps (`in-app`). A skill has no sign-in.

C2's third slice, 2026-09-27: a server added to an agent that holds none of it, from a definition a host keeps, with
its keys kept by the host and given at launch. A read's `McpServerItem` gains `definition` (`McpServerDefinition`: a
stdio command line with the NAMES of the variables it reads, or an http/sse address), set by `mcpServerDefinition` only
when the agent's own command line or address needed no masking, names no variable inside itself, and sends no header —
everything another agent needs except the values; adapters add their own exclusions (a working folder, a plugin's
relative paths, a bearer the agent adds itself). `ExtensionActKind` gains `add`; `held` (the agent holds one of its own
by that name, which its add would replace) and `unsupported` (a transport or a variable it cannot take) join the
reasons. The runtime plans an add after a fresh read finds the name unheld, from the server as the agent would hold it
(`origin: 'own'`, `definition` set), and the second read holding it is the receipt; `plans` answers adds for
definitions without a read. Each agent's settings name every variable in its own syntax and never hold a value: Claude
Code `claude mcp add <name> --scope user -e NAME=${NAME:-} -- …` (the empty default because Claude Code refuses a
config naming a variable it has no value for), Grok `grok mcp add --scope user --env NAME=${NAME:-} <name> -- …`,
OpenCode `opencode mcp add <name> --env NAME={env:NAME} -- …` into its one config (every profile), Codex a
`config/value/write` of the whole `mcp_servers.<name>` table with `env_vars` — not `codex mcp add`, which starts an
HTTP server's browser sign-in at once and names no forwarded variable (`run_add`, `cli/src/mcp_cmd.rs` at
`rust-v0.150.0`); Antigravity keeps values only as literals, so a server that reads one is `unsupported` there; Hermes
connects to a server and asks which of its tools to use before it saves (`cmd_mcp_add`, 0.21.4), and Kimi changes
servers only in its app: both `in-app`. The forms are the reports', not probed. A host's values reach the processes
through `AgentRuntimeOptions.launchEnvironment({ providerId, profileSetId, profileId? })`, asked once per spawn and
resume after the account resolved (the native set for the provider's own root): the runtime checks the names (none
the environment or a loader relies on, no `*_HOME`, `*_DIR` or `XDG_*` root), hands them to `createSession` as
`environment`, keeps them out of the continuation it captures, and never keeps, fingerprints or logs them; a prepared
recipe goes back to its caller without them. The built-ins merge them beneath the launch's own variables where the
agent's MCP client runs — the terminal's environment, or the helper's (Codex's app-server, Grok's leader, whose cache
key is now a digest).

C2's fourth slice, the same day: a skill a host keeps once, placed where each agent looks. The rule gains: a skill is
placed where the agent's docs say skills go, as a link to the host's folder — never a settings key, which stays the
agent's. A plan's run gains a fourth kind, `files`: steps (`link {path, target}`, `unlink {path}`, `move {from, to}`)
the runtime performs itself (`extensions/files.ts`) and checks as it goes — a link only where nothing is, to a folder
with a `SKILL.md`; `unlink` only a link, never the folder it points at; a move only of a real folder with a
`SKILL.md`, to where nothing is (a copy that lands whole across disks) — each step said on the act's output, a failed
step undoing the ones before it. A skill's `add` is planned from the skill as the agent would hold it once placed
(`origin: 'own'`, `linkTarget` the host's folder) when the agent holds none of its own by that name, and Core's
`extensionSkillFolderPlan` answers it for an agent with one folder per profile; its `remove` takes a link away, or
moves the agent's own folder to where the host keeps it when the host names one (`plan`'s new `options.keepIn`), else
leaves it (`no-command`). The receipt is the second read, found by name or by where the link went (OpenCode names a
skill by its frontmatter), and a placing the agent turns out not to read — a `SKILL.md` it skips — is taken back, so
nothing blocks the next try. `plans` answers skill adds (`skills`) and the moves to a host's folder (`keep`). Per
agent: Claude Code `<root>/skills/<name>` (`synced` refused; the native default's `~/.claude/skills` reaches
`shared-folder`, since Grok and OpenCode load it too); Codex reads a person's skills only from `~/.agents/skills`, so
its add moves the host's copy there and leaves a link where it was (`shared-folder`), and a skill there is never taken
away, only switched per profile; Grok `$GROK_HOME/skills`, Kimi `$KIMI_CODE_HOME/skills` (a flat skill is never
taken), Pi `<agent dir>/skills` (a loose file never), Antigravity `~/.gemini/config/skills` under the profile's home;
OpenCode its one config folder's `skills/` (`every-profile`); Hermes `$HERMES_HOME/skills`, which it walks with
`followlinks=True`, and whose curator ages only skills recorded as written by the agent (a linked folder is read as the
person's own, and a hub-installed folder is never moved). That Grok, Kimi and Antigravity follow a linked folder is
their adapters' reading, not a probe: the second read is the check.

C2's fifth slice, the same day: a plugin an agent holds, acted on through the agent's own command. `ExtensionActTarget`
gains `plugin`, and `ExtensionActKind` gains `update` (the agent's own update of that one plugin to the newest its
marketplace has) and `purge`: `remove` is the agent's own uninstall keeping the data the plugin stored apart from its
files where the agent can keep it, so installing it again picks up where it left off, and `purge` is the same uninstall
with that data deleted, offered only by an agent whose uninstall can do both. `plan` takes an `ExtensionActItem` (a
server, a skill or a plugin); the runtime plans a held plugin's enable, disable, remove, purge and update, answers a
plugin's `add` (an install, which is the next slice's) and sign-ins itself, and an update's receipt is the version
moving (`updated 1.2.0 → 1.3.0`) or not (`still holds 1.3.0`). `PluginItem` gains `author`, `homepage` (masked as an
address is) and `brings` — the names of its commands and agents and the events its hooks run on, read from its folder
so a person sees what it runs; `ExtensionKindSupport` gains `label`, the agent's own word for a kind (Pi's
"Packages"), and `hostedSkips`, a kind a session this runtime starts does not load (OpenCode's hosted sessions run
`--pure`). `EXTENSION_PLUGIN_NAME` is a plugin key an agent's command takes as one argument (`review@northlight`).
Per agent, from James's reports (the forms not probed as acts): Claude Code `claude plugin enable|disable <id> --scope
user`, `uninstall <id> --scope user --keep-data` (`remove`) or without it (`purge`), `update <id> --scope user` — the
native default's removal and update reach `shared-folder`, since Grok loads Claude Code's installed plugins from This
Mac in every profile whatever Claude's own switch says, and the account's synced plugins are the organization's; Codex
`codex plugin remove <id>` and its switch through the app-server's `config/value/write plugins.<id>.enabled`, with no
update of one plugin (an upgrade of its marketplace is); Grok `grok plugin enable|disable|update <name>` and `uninstall
<name> --confirm --keep-data` or `--confirm`, Claude Code's borrowed ones changing in Claude Code; Antigravity `agy
plugin enable|disable|uninstall <name>`, whose uninstall takes the whole folder and exits 0 for a name it never had (the
second read is the check; it is planned only where the folder bears the plugin's name), with no update; Hermes `hermes plugins disable|remove|update <name>` — a person's plugin
turns on only in a terminal, where Hermes asks consent for what it may do, and a removal keeps `plugin-data/`; Pi `pi
update|remove <source>` (the removal with `PI_OFFLINE=1`, so it installs nothing; a folder's package has no update), its switch
only in `pi config`; Kimi
Code only inside the app (`/plugins`); OpenCode no command that switches, removes or updates one.

Added 2026-09-22 for hosts that put updates in front of a person (VibeField's Agents settings section):

- `updateInstallation({ onOutput })`: an optional observer that receives the vendor updater's output as it arrives,
  beside the 0600 transcript. It is opaque display text under the same rule as the transcript — never parsed; the
  outcome is still the re-inspection — and an observer that throws is reported through `onError` without stopping
  the update.
- `planUpdate({ providerId, executable? })`: what an update would run for an install, without running it — the
  adapter's own `recipeFor`, resolved to argv exactly as the runner resolves it (the npm that owns a global install,
  not the first on PATH), so a host can name the command before anyone presses Update. Manual recipes carry no argv.
- `InstalledAgent.releaseChannel` and `ReleaseCheckResult.available`: `behind` lists every declared channel, which
  cannot say whether a Claude install on its default `latest` line is behind a preview release or merely ahead of
  stable. Which declared channel an install's own updater follows is a provider fact, so the adapter maps it —
  Claude from `autoUpdatesChannel` (`stable`, or the documented default `latest`, which the preview detectors track)
  and from what its npm and cask recipes install; Grok from its version banner's channel (`alpha` is preview) — and
  the runtime answers `available`, the one release that updater would take, through the pure `availableUpdate()`,
  which a host that kept an earlier check can re-run after the install changed. Absent a mapping, `stable`.

## Verification

- Unit: schema tests; install fingerprints against fixture paths copied from real layouts; recipe runner and
  release executors against fakes.
- Conformance: distribution, profile, and extension services against Imposter personas.
- Live, opt-in (`CLAUDE_NATIVE_TUI_LIVE=1`, `CODEX_NATIVE_TUI_LIVE=1`): log into A, log into B, run both, resume
  both, re-authenticate one, and confirm histories, plugins, and usage stay separated. This is the acceptance check
  from the research draft.
- `pnpm godview:smoke` for pane seeding and the drawer.

## Resolved questions

Probed on 2026-09-06 against the installed builds (Claude Code 2.1.263, Codex 0.153.4, OpenCode 1.18.23, Grok 1.0.13,
Copilot 1.0.80, Pi 0.84.3, Hermes 0.20.5) and the vendors' current documentation. Every fact here is
version-sensitive and becomes a Surface claim before an adapter relies on it.

1. **Claude Keychain entry per config dir.** Documented: Claude Code "keys the macOS Keychain entry to that directory
   too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry." The 2.1.263 binary builds the
   service name as `Claude Code-credentials` when no `CLAUDE_CONFIG_DIR` is set and
   `Claude Code-credentials-<sha256(configDir, NFC).hex[0:8]>` otherwise; the account is `$USER`. The undocumented
   `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides the directory the hash derives from and must never be forwarded (it is
   not in the allow-list). The file fallback is `<configDir>/.credentials.json`. Decision: the usage service takes
   the profile root and derives the same service name; B3 no longer waits on anything.
2. **OpenCode profiles.** `auth.json` lives at `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/`)
   beside `opencode.db`, `log/`, and `snapshot/`; `OPENCODE_CONFIG_DIR` only adds a config directory. Redirecting
   `XDG_DATA_HOME` inside the clean environment isolates credentials, history, and logs; a redirected
   `opencode auth list` reports the scratch path and creates its own database. Decision: supported by setting
   `XDG_DATA_HOME=<root>/data` only, so config, plugins, and cache stay shared. Caveat: tools the agent spawns inherit
   the variable; ask upstream for an `OPENCODE_DATA_DIR`.
3. **Codex shared skills and credentials.** Documented discovery: repository `.agents/skills`, user
   `$HOME/.agents/skills`, admin `/etc/codex/skills`, then bundled skills. There is no `CODEX_HOME/skills`. Copilot
   reads `~/.agents/skills` as well (`copilot skill list --json` labels it `personal-agents`); Claude Code 2.1.263
   does not reference it. Decision: document the directory as a shared surface; per-profile control is
   `[[skills.config]] enabled = false` in that profile's `config.toml`, and `skills/extraRoots/set` stays
   session-scoped. Credentials: `cli_auth_credentials_store` is `file | keyring | auto | ephemeral`; file mode writes
   `<CODEX_HOME>/auth.json`; keyring mode uses service `Codex Auth` with account
   `cli|<sha256(canonical CODEX_HOME).hex[0:16]>`, so both modes isolate per root. Managed profiles write the store
   mode explicitly at creation.
4. **Release lookups.** GitHub unauthenticated allows 60 requests per hour, and a `304` from `If-None-Match` still
   counts. Vendor text endpoints (`downloads.claude.ai/claude-code-releases/{stable,latest}`,
   `x.ai/cli/{stable,alpha}`) return a bare version in under 200 ms; `registry.npmjs.org/<pkg>/latest` returns 2 to
   5 KB. Several agents carry their own oracle: `grok update --check --json` returns `currentVersion`,
   `latestVersion`, `updateAvailable`, `channel`, and `autoUpdate`; `claude doctor` reports the channel and the last
   update result, with `~/.claude/.last-update-result.json` as its JSON form; `hermes update --check` exists; Copilot
   and OpenCode check on startup. Decision: prefer native oracles, fall back to declarative detectors, refresh on
   panel open and every six hours with ETag caching, and keep network off until the user enables release awareness.
   Only Kimi, Hermes, and Antigravity need GitHub.
5. **Pinning.** Claude: `claude install <version>` keeps versions side by side under
   `~/.local/share/claude/versions/` and re-points the launcher; `autoUpdatesChannel` (`latest`, `stable`, `rc`),
   `minimumVersion`, `DISABLE_AUTOUPDATER=1` (background only), and `DISABLE_UPDATES` (every path) control updates.
   The legacy `autoUpdates: false` key is ignored for native installs (`autoUpdatesProtectedForNative`), which is
   why this machine reports auto-updates enabled despite carrying that key. Grok: `grok update --version <v>`,
   `--stable`, `--alpha`. OpenCode: `opencode upgrade <version> --method <curl|npm|pnpm|bun|brew|choco|scoop>`.
   Copilot: channel only. Codex: nothing beyond the package manager; `codex update` detects npm, bun, pnpm, brew
   cask, or standalone installs and checks package-root provenance. Decision: "pin for Puppeteer" is the active-install
   binding of A3 (launch one specific versioned binary), never a fight with the vendor updater; offer "install the
   verified version" only where the CLI accepts a version, and say that the vendor updater may move the launcher
   again.
6. **Extension actions.** Structured listings exist almost everywhere: `claude plugin list --json`,
   `claude plugin marketplace list --json`, `codex plugin list --json [--available]`, `codex mcp list --json`,
   `copilot skill list --json`, `copilot mcp list --json`, `grok plugin list --json`, `grok mcp list --json`. Claude
   MCP has no JSON listing (health-checked text), so read `~/.claude.json` and `.mcp.json` instead; Pi and OpenCode
   listings are text, so read `settings.json` and `opencode.json`. Mutations: `claude plugin install|update -y --scope`
   is explicitly non-interactive ("required when stdin or stdout is not a TTY") and `codex plugin add --json` is
   scriptable. Decision: `execFile` for listings and for Claude and Codex mutations; a terminal pane for installs on
   Copilot, Grok, Pi, OpenCode, and Hermes until their prompts are captured. `copilot plugins` reported
   "not available" on 1.0.80.


Found in live use the same evening, when a person ran every update from VibeField:

- **The runner runs unattended.** `updateInstallation` spawns the updater with no stdin (a prompt reads end-of-file
  instead of waiting for nobody), in a session of its own (nothing it starts can prompt on the host's terminal), with
  `PYTHONUNBUFFERED=1` (Hermes's own lines otherwise sat in a pipe buffer for minutes), streaming instead of
  buffering (`execFile`'s 8 MB `maxBuffer` would have killed a chatty updater). A timeout or `signal` ends the whole
  process GROUP — SIGTERM, then SIGKILL — so the git, ssh or curl an updater started goes with it.
  `runUpdateCommand` is that runner, exported.
- **`unchanged` replaces the claim `already-current`.** Kimi 0.37.1's `upgrade` answers a native install with the
  script to run instead and exits 0; the receipt said "already current" while 2.0.2 was on offer. Exit 0 with no
  version change now reads `unchanged` — current, or an updater that declined — and a host that knows of a newer
  release says which. `already-current` stays valid for receipts written before.
- **`installer-script`**, a recipe for an install its own updater will not move: the vendor's documented
  `curl -fsSL <url> | bash`, run as argv with the URL a positional parameter, https only and `pipefail`, with the
  variables the script documents. Kimi's native installer is the first user (`KIMI_INSTALL_DIR` = the install,
  `KIMI_NO_MODIFY_PATH=1`: an update has no business in the shell rc), and the adapter now classifies
  `~/.kimi-code/bin/kimi` as `native-installer`, as Kimi itself does.
- **A recipe may carry its own budget** (`timeoutMs`). Hermes's updater fetched a shallow checkout (~650 MB in five
  minutes) and then drains its gateway "up to 1815s" before restarting it; its adapter declares 45 minutes.

## Non-goals

A credential vault or account switcher; copying tokens between roots; redirecting the user's own `HOME`; sandboxing
one account from another; replacing native installers with Puppeteer-managed downloads (Surface acquisition stays a
repository workflow).
