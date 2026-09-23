# RFC 006: Agent Distribution and Account Profiles

- **Status:** Accepted; phase 1 implemented on 2026-09-06 (tracks A1–A3 and B1–B3; track C and B4 open)
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
| Copilot CLI | standalone binary from npm platform tarballs; `copilot update [channel]`; `autoUpdate` setting                                                       | `COPILOT_HOME`; `copilot login`                                                                                                                                                                                                                | `copilot plugins`, `copilot skill`, `copilot mcp`; `<root>/{installed-plugins,skills,extensions,mcp-config.json}`                                                                                                        |
| Grok        | vendor downloader `~/.grok/downloads/grok-<v>-<platform>`; `grok update --check --json` is a native oracle, `grok update --version <v>`; detectors `x.ai/cli/{stable,alpha}`                                        | `GROK_HOME`; `grok login`, `grok logout`                                                                                                                                                                                                       | `grok plugin`, `grok mcp`; ACP `PluginsChanged`                                                                                                                                                                         |
| Kimi Code   | standalone `~/.kimi-code/bin/kimi`; `kimi upgrade`                                                                                                   | `KIMI_CODE_HOME`; `kimi login` (device code)                                                                                                                                                                                                   | `--skills-dir`; skill and plugin ids in the source contract; directories to capture                                                                                                                                     |
| OpenCode    | standalone `~/.opencode/bin/opencode`; `opencode upgrade [target] --method <curl\|npm\|pnpm\|bun\|brew>`; `autoupdate` config                                                              | `XDG_DATA_HOME=<root>/data` (holds `auth.json`, `opencode.db`, logs) inside the clean environment; config, plugins, and cache stay shared                                                                                                                                 | config `plugin[]`, `skills{paths,urls}`, `mcp{}`; `opencode plugin`, `opencode mcp`                                                                                                                                     |
| Pi          | npm global `@earendil-works/pi-coding-agent`; `pi update self`                                                                                       | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`; `pi auth`                                                                                                                                                                                | `pi list/install/remove/update/config`; `<root>/agent/{skills,extensions,prompts,tools}`                                                                                                                                |
| Hermes      | source checkout plus uv venv behind a wrapper script; `hermes update`                                                                                | `HERMES_HOME` (the adapter already redirects HOME for the gateway); `hermes login`, `hermes auth`                                                                                                                                              | `hermes skills`, `hermes plugins`, `hermes mcp`; gateway `plugins.list`, `skills.manage`                                                                                                                                 |
| Antigravity | GitHub `agy_cli_*`; `agy update`; `AGY_CLI_DISABLE_AUTO_UPDATE`                                                                                      | adapter-owned HOME redirection (`PUPPETEER_ANTIGRAVITY_HOME`)                                                                                                                                                                                  | `/skills`; to capture                                                                                                                                                                                                   |

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
| Antigravity | `dataRoot`                 | `~/.gemini/antigravity-cli` |
| OpenCode    | `<dataRoot>/data/opencode` | `~/.local/share/opencode`   |
| Pi          | `dataRoot`                 | `~/.pi`                     |

Pi's managed binding changed with this: `PI_CODING_AGENT_DIR` is now `<dataRoot>/agent`, one `agent` level inside
the profile root, on OpenCode's exact precedent — the binding never collides with the profile's own metadata, and
the profile root becomes the layout root. Pi holds its credentials in `auth.json` under that root rather than
deriving a keyring key from the path the way Codex does, so nothing breaks if the path moves: the change costs a
one-time move of an existing managed root's contents into `<dataRoot>/agent`, and no managed Pi profile existed on
the development machine when the binding changed. The adapter's own observation resolves the same variable, so it
finds sessions under the new binding without a second rule. Antigravity's managed answer is nominal: support is
`false`, no managed root is ever onboarded, and were that to change the answer would have to follow the HOME
redirection down to `<root>/.gemini/antigravity-cli`.

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
  (`work`, `client-demo`, `work-2` on a clash; `native` reserved); a rename never moves it. An account's root is
  `<set directory>/<provider>-<8 hex>/`, created exclusively, 0700, and never handed out twice: Claude Code keys its
  Keychain service and Codex its keyring account on the root's path, so an account signed out and added again must
  land where no credential left behind can answer for it. A host that roots the registry under a user's folder
  (VibeField: `users/<fuid>/agents/profiles/`) thereby keeps every account's config, history, plugins and sign-in
  for one place in one folder under that user.
- **The default.** The registry records one default set. `spawn()` with neither `profile` nor `profileSet` runs
  under the default set's account for the agent, else the provider's own root — which, with no default chosen, is
  what a spawn without a profile has always meant. `spawn({ profileSet })` is a demand: a set without an account for
  the agent is `AGENT_PROFILE_NOT_FOUND`. Resume and attach never consult the default: a run continues in the account
  it was born under. `AgentSessionInfo.profileSetId` names the set.
- **Sign-out.** `retireProfile(id)` takes an account out of its set and out of new spawns, logins and resumes while
  its sessions run on (attach still accepts it); a host finishes it when they have ended —
  `signOutProfile(id)`, which runs the adapter's optional native `signOut(profile)` for a credential kept outside
  the root (Claude Code: `claude auth logout` under `CLAUDE_CONFIG_DIR`, removing the root-keyed Keychain item), then
  deletes the root and calls `removeProfile(id)`. Where the credential is a file inside the root (Codex's file store,
  which managed roots are written with; Grok; OpenCode's `auth.json` under the bound data directory; Pi), deleting the
  root is the sign-out and `signOutProfile` answers `{ ran: false }`. Copilot, Kimi and Hermes have not been probed
  for where their credentials live; until they are, no claim is made for them.
- **Registry version 2** (`{ version: 2, defaultSet?, sets, profiles }`). A version 1 file is adopted on read by one
  rule that also repairs a hand-edited document: accounts named alike share a set unless two are of one provider,
  every account names an existing set, and every root stays where it is. Nothing needed adopting on the development
  machine.
- **Compatibility.** `createProfile({ providerId, label })` — the per-provider call Godview's drawer makes — joins the
  set of that name that has no account for the provider yet, or makes one, so a host that never heard of sets keeps
  working and its accounts group the way its user named them.

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
  Antigravity declares its binding but reports `supported: false` because 1.1.21 has no login subcommand.
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
unchanged: its per-provider calls land in sets named as its user named them.

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
