# Hermes plugins, skills, and MCP

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Status      | Research record. No adapter, Surface, or support-ledger change.                               |
| Date        | 2026-09-24                                                                                     |
| Question    | How Hermes Agent installs, enables, isolates, and loads plugins, skills, and MCP servers.     |
| Install     | Hermes Agent v0.21.4 (2026.9.21), upstream `c0d72947`, `~/.hermes/hermes-agent`               |
| Freshness   | `hermes --version` reported this tree 3246 commits behind upstream.                           |
| Surface pin | `hermes@0.20.0`, tag `v2026.8.3`. This note is the 0.21.4 tree, not a Surface claim.          |
| Related     | `draft/HERMES-ADAPTATION-PLAN.md`, `draft/HERMES-SUBSCRIPTION-IDENTITY.md`, RFC 006           |

Hermes extends one agent process in three different ways. A plugin is Python
that Hermes imports. A skill is a `SKILL.md` the model loads on demand. An MCP
server is another process, or a remote HTTP endpoint, whose tools Hermes
registers beside its own. All three are configured from the same profile home.
None of them is a second coding agent.

The findings below were read from that install: the user-guide and
developer-guide pages shipped in the tree, the CLI help, and the loaders those
pages name. No plugin, skill, or MCP server was installed or enabled on this
machine for the probe.

## Three mechanisms

| | Plugin | Skill | MCP server |
| --- | --- | --- | --- |
| What it is | In-process Python, or a portable `plugin.json` package | An [agentskills.io](https://agentskills.io/specification) document, plus optional support files | An external tool server |
| Where the code runs | Inside the Hermes process | It does not run. The model reads it. Scripts inside it run only if the model executes them | A stdio child, or an HTTP peer |
| How it is turned on | `plugins.enabled` in `config.yaml`, with exceptions below | Present on disk and absent from `skills.disabled` | An entry under `mcp_servers` whose `enabled` is not `false` |
| What the model sees | Tools, hooks, slash commands, sometimes a namespaced skill | A one-line index, then the full file via `skill_view` | Tools named `mcp__<server>__<tool>` |
| Trust step | Enable, then a separate capability grant | Hub scan at install; project dirs need `hermes skills trust` | Catalog install or a hand-written config entry |

They compose. A native plugin may call `ctx.register_skill()`. A portable
package may ship `skills/*/SKILL.md` and a root `mcp.json`, and Hermes merges
those MCP servers into the same `mcp_servers` set. A skill may declare
`requires_toolsets` so it appears only when a tool, including an MCP tool, is
available.

Two neighboring surfaces are easy to fold into "plugins" and are gated
separately:

| Surface | Location | Gate |
| --- | --- | --- |
| Gateway event hooks | `$HERMES_HOME/hooks/<name>/` with `HOOK.yaml` and `handler.py` | Placement. `plugins.enabled` does not apply. |
| Shell hooks | `hooks:` in `config.yaml` | First-seen command consent, stored in `$HERMES_HOME/shell-hooks-allowlist.json` |
| Outbound webhooks | `hooks.outbound` in `config.yaml` | Same hook event set, push only |

`agent/shell_hooks.py` and `agent/outbound_webhooks.py` both skip registration
when `HERMES_SAFE_MODE` is set. Gateway hooks are imported because the
directory exists.

## Where a profile keeps them

`get_hermes_home()` is the context override, then `HERMES_HOME`, then
`~/.hermes` (`hermes_constants.py`). `config.yaml`, `.env`, and the three
stores hang off that directory.

| Piece | Path |
| --- | --- |
| Enablement, MCP definitions, skill policy | `$HERMES_HOME/config.yaml` |
| Secrets plugins and MCP interpolate | `$HERMES_HOME/.env` |
| User and catalog plugins | `$HERMES_HOME/plugins/<name>/` |
| Install provenance | `$HERMES_HOME/plugins/.install-metadata.json` |
| Plugin scratch data | `$HERMES_HOME/plugin-data/<namespace>/` |
| Compat report Desktop reads | `$HERMES_HOME/.plugin-compat-report.json` |
| Installed skills | `$HERMES_HOME/skills/` |
| Bundled-skill ledger | `$HERMES_HOME/skills/.bundled_manifest` |
| Stop seeding bundled skills | `$HERMES_HOME/.no-bundled-skills` |
| Hub lock, quarantine, audit | `$HERMES_HOME/skills/.hub/` |
| Org-mirrored skills | `$HERMES_HOME/skills/_org/<org-id>/`, and `_org/.active_org` |
| Skill bundles | `$HERMES_HOME/skill-bundles/*.yaml` |
| Staged `skill_manage` writes | `$HERMES_HOME/pending/skills/` |
| Curator ledger | `$HERMES_HOME/skills/.curator_ledger.jsonl` |
| MCP OAuth tokens | `$HERMES_HOME/mcp-tokens/<server>.json` (mode `0600`) |
| Lazy MCP schema cache | `$HERMES_HOME/cache/mcp_schema_cache.json` (mode `0600`) |
| Project-skill scan cache | `$HERMES_HOME/cache/project_skill_scans/` |

Bundled plugin *code* does not move into the profile. Discovery reads
`<install>/plugins/` from the git checkout (`get_bundled_plugins_dir()`).
Every home on one install shares that tree. What the profile owns is the
allow-list and any copy the user installed under its own `plugins/`.

Bundled skills are different. On a fresh profile Hermes copies them into
`$HERMES_HOME/skills/`. Later `hermes update` adds newly bundled skills unless
`.no-bundled-skills` is present (`hermes skills opt-out`, or
`hermes profile create <name> --no-skills`). Official optional skills stay in
the checkout's `optional-skills/` until `hermes skills install official/...`
copies one in.

`mcp-tokens/`, `pairing/`, and `vault/` are on Hermes's protected-path list
(`agent/file_safety.py`). A profile read that opens `mcp-tokens/` or `.env`
is reading credentials.

### The profile-root trap still applies

`get_default_hermes_root()` returns `~/.hermes` whenever `HERMES_HOME` is
inside it. Outside `~/.hermes`, a home whose parent directory is named
`profiles` resolves the root to the grandparent. That rule is how native
`hermes profile` homes (`<root>/profiles/<name>`) find the shared root.

Plugins, skills, and `mcp_servers` are read from `get_hermes_home()`, so a
dedicated home still has its own copies of those directories. The shared root
is where `active_profile`, the Nous shared store, and `hermes profile list`
live. `draft/HERMES-SUBSCRIPTION-IDENTITY.md` already records that a home
under a directory named `profiles` joins that root's sign-in. The same layout
is the wrong place for a Puppeteer profile's plugins and skills, because the
process is no longer "just this directory."

Puppeteer's adapter already refuses a managed root that Hermes would fold
into another one (`packages/adapter-hermes/src/services/profiles.ts`,
`joinsAnotherRoot`). Keep allocating `profiles/hermes/<id>`.

Native `hermes profile create` bootstraps `skills/` inside the new home and
can clone `config.yaml` and `.env`. `hermes -p <name>` is that feature.
Puppeteer profiles stay a `HERMES_HOME` the adapter sets, not a native
profile name.

### Project copies follow the workspace, not the home

| | Looked up from | Opt-in |
| --- | --- | --- |
| Project skills | `<git-root>/.hermes/skills/` and `<git-root>/.agents/skills/` | `skills.project_discovery` (default on) and the root listed in `skills.trusted_project_dirs` |
| Project plugins | `Path.cwd() / ".hermes" / "plugins"` | `HERMES_ENABLE_PROJECT_PLUGINS` |

The git root for skills is `find_project_root()` in `agent/skill_utils.py`.
It walks from the session workspace (`resolve_agent_cwd`: session cwd, then
`TERMINAL_CWD`, then the process cwd) and ignores a checkout that *is* the
user's home directory. Trust is one repo, stored in the profile's
`config.yaml`. A cron job or ACP session in that repo inherits the trust
decision and does not prompt. Each project `SKILL.md` is scanned again on
content change; a `dangerous` verdict is left out of the index. The scan
cache stays under the profile, not in the repo. A scanner crash quarantines
the skill.

Project plugins use the process cwd, not that session-workspace walk
(`hermes_cli/plugins_discovery.py`, `collect_directory_manifests`). A TUI
that keeps one process cwd and several session workspaces can load one
repo's plugins and another repo's skills in the same process.

## Plugins

### Discovery order

`collect_directory_manifests()` scans, in order:

1. Bundled top-level `<install>/plugins/`, skipping `memory`, `context_engine`, `model-providers`, and `cron_providers` (those have their own loaders).
2. The same tree's category directories, including `platforms/<name>/`.
3. `$HERMES_HOME/plugins/`.
4. `./.hermes/plugins/` when `HERMES_ENABLE_PROJECT_PLUGINS` is set.

A directory is a plugin when it contains `plugin.yaml`, `plugin.yml`, or a
portable `plugin.json`. One level of category nesting is walked
(`web/firecrawl`, `platforms/discord`). Foreign harness manifests
(`.claude-plugin`, `.codex-plugin`, `.cursor-plugin`, `.devin-plugin`,
`.kimi-plugin`) are skipped. Pip packages enter through the
`hermes_agent.plugins` entry-point group, after the directory scan. A
directory install with the same key keeps the name; the entry point is
dropped. That is narrower than the user-guide sentence that later sources
always override earlier ones. Directory sources do override in scan order
(project, then user, then bundled). An entry point fills a name no directory
claimed.

A user or project manifest that reuses a bundled key from a differently named
directory is rejected as an impostor (`resolve_manifest_winners`). Overriding
`kanban` means a directory actually named `kanban`.

### What loads without an allow-list

`gate_manifest()` in `hermes_cli/plugins_discovery.py` decides. `plugins.disabled`
wins over everything it names, including a bundled backend. After that:

| Kind | Source | What happens |
| --- | --- | --- |
| `backend` (image gen, web search, and the other built-in backends) | bundled | Loaded. The active one is `<category>.provider` in config. |
| `platform` (Discord, Telegram, …) | bundled | Registered lazily and imported on first use. The channel itself is `gateway.platforms.<name>.enabled`. |
| `exclusive` (memory) | any | Not loaded here. `memory.provider` picks one. Bundled wins a name clash over a user memory plugin. |
| `model-provider` | any | Not loaded here. `providers/` registers them. A user copy of the same name overrides the bundled profile. |
| general / user platform / user backend / portable package | user, project, or pip | Loaded only when `plugins.enabled` contains the path key or the manifest name. |

A missing or malformed `plugins.enabled` means nothing in that last row loads.
`hermes plugins list` shows three states: enabled, disabled, and not enabled.
The default after install is not enabled. Config schema v21 grandfathered
user plugins that were already on disk into `plugins.enabled`. Bundled
general plugins were not grandfathered.

`hermes plugins enable` writes the allow-list. `hermes plugins disable`
removes it from the allow-list and adds `plugins.disabled`. Removing a plugin
also drops it from both lists and clears `memory.provider` when that plugin
was the live provider.

### Capabilities are consent, not a sandbox

`plugin.yaml` may declare capability ids (`tools.override`,
`llm.model_override`, `gateway.platform_actions`, and the other `llm.*`
overrides). Install and enable prompt once. A yes stores the grant on
`plugins.entries.<id>.granted_capabilities` with a consent hash. A no leaves
the plugin enabled and the capability off. A non-interactive install does not
grant. An update that adds a capability asks again and leaves the new one off
until then.

The loader still imports and runs the plugin as ordinary Python. The
user guide states this directly: a malicious plugin can ignore the gates.
Granting a capability records trust in the author. It is not a review of the
code, including for a catalog entry. Catalog admission reviews metadata and
declared capabilities. The catalog lives in the checkout's `plugin-catalog/`
and pins a full 40-character commit. `hermes plugins install <name>` checks
out that pin. `owner/repo` and a git URL are custom sources and stay disabled
unless `--enable` is passed. `hermes plugins update` refuses to move a pinned
install until a new full SHA is given.

`hermes plugins install` and `update` scan the tree with the same threat
patterns as the skills guard. `safe` proceeds. `caution` asks, and `--force`
overrides. `dangerous` blocks, and `--force` does not override. A dangerous
update disables the plugin until it is re-enabled. `plugins.scan_on_install:
false` turns the scan off.

Plugin packs (`hermes-pack.yaml`, `hermes plugins pack install`) are a list of
those same pinned installs. They do not bulk-grant capabilities, they reject
secret-shaped config seeds, and they have no `--yes`. The pack's `skills:`
list is shown and not installed.

Portable Agent Plugins v1 (`plugin.json`, `skills/`, `mcp.json`) install
through the same command and stay disabled until enabled. Hermes validates
the manifest, skill frontmatter, and `mcp.json` locally. Skills from the
package are read-only and namespaced `agent-plugin-<slug>-<hash>`. MCP
entries from `mcp.json` are stdio or streamable HTTP. A `config.yaml` server
of the same name wins; the package server is skipped with a warning. Legacy
SSE entries are reported and skipped. `PLUGIN_DATA` is the profile
`plugin-data/` directory. Values in the package `env` block are package data,
not a secret store.

### Hooks the plugin may register

`VALID_HOOKS` is the accepted set (the user guide counted 27 when this page
was written). Observers include `on_session_start`, `on_session_end`,
`pre_tool_call`, `post_tool_call`, and the stream and subagent hooks. A
`pre_tool_call` callback that exceeds `plugins.hook_callback_timeout`
(default 30 seconds) fails closed and blocks the tool. Import plus
`register()` has its own deadline, `plugins.load_timeout_seconds` (default
10). The stuck thread is abandoned and the rest of the plugins still load.

Puppeteer's Hermes surface already records the in-process plugin callback
kwargs as the `plugin-hook` channel. That channel is evidence of hooks that
fired. It is not the plugin install or the allow-list.

### CLI

```text
hermes plugins
  install | search | browse | validate | update | remove
  list | enable | disable | capabilities | doctor | compat | pack | show
```

`hermes plugins` with no subcommand is the interactive toggle.
`/plugins` inside a session lists what that process actually loaded.

## Skills

A skill is a directory with `SKILL.md`. Frontmatter carries `name`,
`description`, optional `platforms`, `required_environment_variables`, and a
`metadata.hermes` block (tags, category, `fallback_for_toolsets`,
`requires_toolsets`, non-secret `config` prompts). The body is the procedure.
Support files live in `references/`, `templates/`, `scripts/`, `assets/`, and
`examples/`. Those directories are not separate skills.

Loading is tiered, to keep the prompt small:

| Level | Call | What the model receives |
| --- | --- | --- |
| 0 | index in the system prompt, or `skills_list()` | name, description, category |
| 1 | `skill_view(name)` or `/<skill>` | the `SKILL.md` body |
| 2 | `skill_view(name, path)` | one support file |

Every installed skill name is also a slash command, on the CLI, the TUI, and
gateway platforms. Up to five leading `/skill` tokens stack. `skills.auto_load`
pins names into every new session's prompt (CLI, TUI, gateway, cron, API).
`--ignore-rules` and `HERMES_IGNORE_RULES` skip that list together with
`AGENTS.md`, `SOUL.md`, and memory. An explicit `-s` still loads.

### Precedence

The prompt builder (`agent/prompt_builder.py`) walks, first match wins:

1. Trusted project dirs.
2. `$HERMES_HOME/skills/`.
3. `skills.create_dir`, when set and present.
4. `skills.external_dirs`.

`skills.create_dir` is where new `skill_manage` creates go. Existing skills
are patched where they were found, including an external directory the
process can write. External dirs are not a write-protection boundary.

`tools/skills_tool.py` `_skill_search_dirs()`, which backs `skills_list`,
walks project, profile, and `external_dirs`. It does not add `create_dir`.
`skill_manage` lookup uses `get_all_skills_dirs()`, which does. A skill that
exists only under `create_dir` can show in the system prompt and still be
absent from `skills_list` on this tree.

Disabled names live in `skills.disabled`, plus `skills.platform_disabled.<platform>`
for one messaging platform. The `hermes-agent` skill is essential and is
removed from any disable list (`ESSENTIAL_SKILLS` in `agent/skill_utils.py`).
`hermes skills config` is the interactive editor. Platform, toolset, and
`metadata.hermes` conditions hide skills from the index without deleting them.
A hidden skill can still be loaded by name when the caller bypasses the
offer-time gate.

Org mirrors under `skills/_org/<org-id>/` load only when
`skills/_org/.active_org` names that org. The marker is how the org sync
client records a verified token. No marker means those directories are not
walked. Already-synced files stay on disk.

### Hub, trust, and agent writes

`hermes skills` talks to several registries. Official optional skills come
from the checkout. The others are `skills.sh`, well-known
`/.well-known/skills/index.json` endpoints, a raw `SKILL.md` URL, GitHub
taps, ClawHub, LobeHub, and browse.sh. `hermes skills tap add owner/repo`
adds a GitHub source. Installs copy `SKILL.md` and the support files it
references, then record the source URL and content hash in
`skills/.hub/lock.json`.

The built-in scanner runs on every hub install. `--force` overrides a
caution-level block. A `dangerous` verdict stays blocked. Official optional
skills skip the third-party warning. `openai/skills`, `anthropics/skills`,
`huggingface/skills`, and `NVIDIA/skills` are the `trusted` tier. Everything
else in the hub is `community`. An optional NVIDIA SkillEvaluator Tier 1 pass
is advisory (`skills.tier1_advisory`, default on) and does nothing unless
the binaries are on `PATH`.

`hermes skills update` skips a hub skill whose bytes no longer match the lock
hash, so a local edit is kept. `--force` replaces it. `hermes skills reset`
clears the user-modified mark on a bundled skill. `--restore` also puts the
stock file back.

The agent writes skills with `skill_manage` (`create`, `patch`, `delete`,
`write_file`, `remove_file`). That is the procedural-memory loop. With
`skills.write_approval: true` (default false) those writes are staged under
`pending/skills/` and applied with `/skills approve`. `skills.guard_agent_created`
(default false) is a content scan of agent writes, separate from the approval
gate. Hub installs are scanned either way. `skills.inline_shell` (default
false) would execute `` !`cmd` `` snippets inside `SKILL.md` on load.

The curator (`curator.enabled`, default on) ages agent-created skills, moves
them to `skills/.archive/`, and does not touch hub-installed skills. Bundled
skills are pruned only when `curator.prune_builtins` is set.

Skill bundles (`hermes bundles`, files in `skill-bundles/`) are a slash-command
alias that loads several skills into one user message. A bundle name wins over
a skill of the same slug. The bundle does not install anything.

### CLI

```text
hermes skills
  trust | untrust | browse | search | install | inspect | list
  check | update | audit | uninstall | reset | list-modified | diff
  opt-out | opt-in | repair-official | publish | snapshot | tap | config
```

## MCP

Hermes is an MCP client and, separately, an MCP server. `hermes mcp add` and
`mcp_servers` in `config.yaml` attach servers to the agent. `hermes mcp serve`
exposes Hermes conversations to some other client. The second command is not
how a profile gains tools.

### Config

`tools/mcp_tool_config.py` `_load_mcp_config()` reads `mcp_servers` from
`load_config()`, interpolates `${VAR}` from the environment and
`$HERMES_HOME/.env`, drops entries `validate_mcp_server_entry()` flags, then
merges portable-plugin servers whose names are still free. `HERMES_SAFE_MODE`
returns an empty map before any of that.

A server is either stdio (`command`, `args`, `env`, optional `cwd`) or HTTP
(`url`, `headers`). `auth: oauth` turns on OAuth 2.1: discovery, client id
metadata or dynamic client registration, PKCE, refresh. Tokens land in
`mcp-tokens/<server>.json`. The refresh token is bound to the issuer that
minted it. A changed issuer drops the refresh token and keeps the access
token until it expires. Headless login is paste-back, device code
(`hermes mcp login <name> --flow device`), an SSH port forward, or
`oauth.redirect_uri`. The gateway does not open a browser. A dead refresh
parks the server until `hermes mcp login`.

`enabled: false` skips the server with no connection. `tools.include` and
`tools.exclude` take exact names or globs. When both match, `include` wins.
`tools.prompts` and `tools.resources` turn the extra list/read wrappers off.
Selecting every tool writes no filter. Catalog entries with huge surfaces
(the docs use Cloudflare, about 3300 tools) can ship `tools.default_excluded`
and skip the checklist.

`lazy: true` registers tools from the schema cache and starts the server on
the first call. The first successful live connect fills the cache, so a new
server is eager once. `idle_timeout_seconds` and `max_lifetime_seconds`
recycle a stdio child and keep the tools registered. Discovery connects at
most `mcp.discovery_concurrency` servers at once (default 4; 0 is unlimited).
A `notifications/tools/list_changed` from the server refreshes that server's
tools without `/reload-mcp`. Prompt and resource change notifications are
received and not applied yet.

`/reload-mcp` rebuilds the set from config. A running gateway also watches
`config.yaml` and reconciles within about a minute. The tool list is
otherwise frozen for the session, so a credential that appears mid-session
shows up on `/reload-mcp`, `/new`, or compaction. Each server that
contributes a tool also creates a toolset named `mcp-<server>`.

The first agent build waits `mcp_discovery_timeout` (default 1.5 seconds) and
then snapshots. Servers that miss the window join on the next turn. One-shot
`hermes -q` / `-z` waits up to `mcp_single_query_discovery_timeout` (default
15 seconds), because there is no later turn.

Stdio children do not inherit the full shell environment. They receive the
configured `env` plus a safe baseline. HTTP servers honor the usual proxy
variables and the OS proxy, with `NO_PROXY`.

### Tool names

The user guide's MCP page still shows `mcp_<server>_<tool>` with single
underscores. The registrar does not. `tools/mcp_tool_schema.py` sets
`MCP_TOOL_NAME_PREFIX = "mcp__"` and builds `mcp__<server>__<tool>`, with
characters outside `[A-Za-z0-9_]` replaced by `_`. Names longer than 64
characters, which provider APIs reject, are clamped with a hash suffix. The
handler still calls the original MCP tool name. Portable `mcp.json` servers
use the same prefix. The comment in that file says the double underscore
matches Claude Code, Codex, OpenCode, and the Anthropic OAuth wire form.

### Catalog and the narrow spawn filter

`optional-mcps/<name>/manifest.yaml` in the checkout is the Nous catalog.
Presence there means the manifest was merged. There is no community tier.
`hermes mcp` with no subcommand opens the picker. `hermes mcp catalog`,
`install`, `configure`, `login`, `reauth`, `test`, `list`, `remove`, and
`serve` are the scriptable forms. Installing can clone a repo and run the
manifest's `bootstrap` commands (`pip install`, `npm install`). MCPs are not
auto-updated. Reinstall refreshes a changed manifest.

`hermes_cli/mcp_security.py` refuses three shapes, at save time and again
before spawn. Other commands, including `npx` and `uvx`, stay legal.

1. A known June 2026 `hermes-0day` indicator in `command`, `args`, or `env` values.
2. A shell interpreter (`bash`, `sh`, `zsh`, `powershell`, …) whose inline args contain `curl`, `wget`, `nc`, or the other egress tools.
3. That same shell writing an OS persistence path (`authorized_keys`, `~/.ssh`, PAM, sudoers, cron, shell rc).

A refused server is skipped with a warning. The filter is not a review of a
normal stdio server.

`identity_header` on an HTTP server can send a static value or the Hermes
profile name. It does not override a header the user already set.

### CLI

```text
hermes mcp [--accept-hooks]
  serve | add | remove | list | test | configure
  login | reauth | picker | catalog | install
```

In chat, the agent can ask for a catalog server through `manage_connections`.
The setup card (desktop dialog, TUI callout, CLI panel) collects fields,
runs OAuth, and saves config plus tokens only after the first connection
accepts the token. Messaging platforms have no card. The agent prints the
CLI instead.

## Safe mode, and what it actually switches off

`--safe-mode` sets three environment variables
(`hermes_cli/main.py`, `_apply_safe_mode`):

| Variable | Effect on these three |
| --- | --- |
| `HERMES_SAFE_MODE=1` | Plugin discovery returns immediately. `_load_mcp_config()` returns `{}`. Shell hooks and `hooks.outbound` are not registered. |
| `HERMES_IGNORE_USER_CONFIG=1` | `load_cli_config()` skips the profile `config.yaml` (`.env` still loads). `load_config()`, which plugin gates, skill disable lists, and MCP readers use, still merges that file. The MCP empty result comes from `HERMES_SAFE_MODE`, not from this flag. |
| `HERMES_IGNORE_RULES=1` | Skips context files, memory, and `skills.auto_load`. |

The skills directory is still scanned. A profile full of skills still puts
them in the index under safe mode, minus whatever `skills.disabled` says,
because that list is read through `load_config()`. Safe mode is the off
switch for plugins, shell hooks, and MCP. It is not a blank skill catalog.

`--ignore-user-config` alone does not set `HERMES_SAFE_MODE`, so plugins and
MCP servers named in `config.yaml` still load.

## What Puppeteer already assumes

The Hermes adapter launches one `hermes --tui` and observes it. Plugin-hook
payloads are already a surface channel for that process. `skill_manage` path
resolution is explicitly unsupported in
`packages/adapter-hermes/src/normalization/workspace.ts`. The launch flag
table in the generated detection file knows `--safe-mode` and
`--ignore-rules`. The adapter does not pass them on a normal session, and it
does not inventory plugins, skills, or MCP servers.

A profile's `HERMES_HOME` is the directory those stores belong to, provided
the path is not one Hermes treats as `<root>/profiles/<name>`. The adapter
already enforces that for sign-in. The same check is what keeps this
profile's plugins, skills, and `mcp_servers` off the user's `~/.hermes`.

MCP stdio servers are children of that Hermes process. They are not another
`RuntimeRun` and not a shadow print agent. `hermes mcp serve` would be a
second server, which the adaptation plan already rules out beside the TUI.

## Recommendation

Leave the adapter, Surface, and the support ledger as they are. This tree is
newer than `hermes@0.20.0` and far behind current upstream. Implement against
a re-probe, not against this note alone.

When a product surface needs to show what a profile has installed:

1. Read the profile home. Plugins are `$HERMES_HOME/plugins/` plus
   `plugins.enabled`, `plugins.disabled`, and `plugins.entries` in
   `config.yaml`. Skills are `$HERMES_HOME/skills/` plus `skills.disabled`
   and `skills/.hub/lock.json`. MCP servers are the `mcp_servers` mapping in
   that same file. Bundled plugin code is in the install tree, so a home
   with an empty `plugins/` can still load bundled backends.
2. Treat `mcp-tokens/`, `.env`, and `auth.json` as credentials. A listing of
   server names does not need those files. OAuth state is "a token file
   exists," not the token.
3. Do the read in the host, or with a short-lived helper under that
   `HERMES_HOME`. Do not spawn `hermes plugins`, `hermes skills`, or
   `hermes mcp` next to a live TUI to mirror it. Those commands write
   config, clone git repos, and start OAuth.
4. Session-scoped additions are the workspace's trusted project skills, and
   project plugins only when `HERMES_ENABLE_PROJECT_PLUGINS` is set and the
   process cwd has `.hermes/plugins`. A drawer that only reads the profile
   home will miss them.
5. `--safe-mode` is the supported way to run a session with plugins, shell
   hooks, and MCP disconnected. Skills already on disk still load. Passing
   it is a product choice about that session, not a way to clear the profile.
6. If tool names are ever matched, match `mcp__<server>__<tool>` from
   `tools/mcp_tool_schema.py`. The single-underscore form in the user guide
   is stale on this install.
7. An enabled third-party plugin runs inside the agent process Puppeteer
   hosts, with the process's privileges. Capability grants do not contain it.
   A managed profile that enables one has accepted that.

Re-probe when the support baseline leaves 0.20.0, or before any of the reads
above are implemented. The useful check is the same trio of loaders:
`gate_manifest`, `_skill_search_dirs` / `build_skills_system_prompt`, and
`_load_mcp_config`, plus the tool-name prefix.

## Sources

All of these are the v0.21.4 tree at `c0d72947` unless noted.

| Topic | Locator |
| --- | --- |
| Plugin user guide | `website/docs/user-guide/features/plugins.md` |
| Portable packages | `website/docs/developer-guide/plugins/index.md` |
| Skills user guide | `website/docs/user-guide/features/skills.md` |
| MCP user guide | `website/docs/user-guide/features/mcp.md` |
| MCP config reference | `website/docs/reference/mcp-config-reference.md` |
| Home, config, skills dir | `hermes_constants.py` `get_hermes_home`, `get_default_hermes_root`, `get_skills_dir` |
| Discovery and gate | `hermes_cli/plugins_discovery.py` |
| Load sweep, safe mode | `hermes_cli/plugins.py` `discover_and_load` |
| Enable, metadata path | `hermes_cli/plugins_cmd.py` |
| Skill dirs and project trust | `agent/skill_utils.py` |
| Skill index tool | `tools/skills_tool.py` |
| Prompt index | `agent/prompt_builder.py` `build_skills_system_prompt` |
| Skill disable list | `hermes_cli/skills_config.py` |
| MCP load and safe mode | `tools/mcp_tool_config.py` `_load_mcp_config` |
| MCP tool names | `tools/mcp_tool_schema.py` |
| MCP spawn filter | `hermes_cli/mcp_security.py` |
| OAuth token dir | `tools/mcp_oauth.py` `_get_token_dir` |
| Schema cache | `tools/mcp_schema_cache.py` |
| Safe-mode flags | `hermes_cli/main.py` `_apply_safe_mode` |
| Native profiles | `hermes_cli/profiles.py` |
| Defaults | `hermes_cli/config_defaults.py` `skills`, `plugins`, `mcp` |
| Puppeteer home binding | `packages/adapter-hermes/src/services/profiles.ts` |
| Puppeteer flag names | `packages/adapter-hermes/src/generated/detection.ts` |
