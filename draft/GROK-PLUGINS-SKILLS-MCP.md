# Grok plugins, skills, and MCP servers

| Field    | Value                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| Status   | Research complete on 2026-09-24. Not implemented. Not a Surface claim and not a support change. |
| Question | How Grok Build 1.0.41 discovers, enables, and isolates plugins, skills, and MCP servers.       |
| Probe    | Installed `grok 1.0.41` (`4220f3b224a6`), stable channel, `~/.grok/bin/grok`                   |
| Docs     | User guide extracted into `~/.grok/docs/user-guide/` by that binary (`07`, `08`, `09`, `05`, `16`, `26`) |
| Contract | Profile roots in [RFC 006](../docs/rfcs/006-agent-distribution-and-account-profiles.md). Grok already binds `GROK_HOME`. |

Grok has three extension mechanisms that share one modal and one inspect document, and they do not share one registry. A skill is a `SKILL.md` prompt package. A plugin is a directory that can carry skills, commands, agents, hooks, MCP servers, and LSP servers. An MCP server is a stdio or HTTP tool process. Plugins are the unit of install and trust. Skills and MCP servers also exist without a plugin.

Puppeteer does not manage any of the three. The Grok adapter does not read `grok inspect`, does not pass `session/new` `mcpServers`, and keeps plugin session updates only as an untyped native event name. This note is the evidence for leaving that alone until a product surface asks for a read-only inventory.

## Decision

Keep plugin install, enable, marketplace update, and `grok mcp add` out of the adapter. Those commands write config, copy plugin trees, and can refresh git caches.

When a product needs an inventory, read `grok inspect --json` under the profile `GROK_HOME` with a private `--leader-socket`. Allow-list names, scopes, enabled flags, source kinds, transports, and command or URL targets. Leave headers, env, and `~/.grok/mcp_credentials.json` unread.

Treat that document as three inventories at once:

| Block in `grok inspect --json` | What it is on 1.0.41 |
| --- | --- |
| `skills[]` | Prompt packages and legacy command markdown that survived priority and compat gates. |
| `plugins[]` | Discovered plugin directories, including Claude installs Grok did not itself install. |
| `mcpServers[]` | Servers admitted to the session catalog. A plugin can count an MCP file and still be absent here. |
| `marketplaces[]` | Empty on this machine. Configured marketplace sources are a different command. |

`GROK_HOME` isolates Grok's own install registry, bundled skill files, and `config.toml`. It does not isolate Claude plugins, Claude skills, `~/.agents/skills`, or the MCP servers those plugins contribute. A second profile on this machine sees the same 15 Claude plugins and the same 4 plugin MCP servers.

## What each command returns

Probed in `/Users/jamesyong/Projects/project100/puppeteer` against the real `~/.grok`, then again with an empty `GROK_HOME` and a private leader socket.

| Command | Real home | Empty `GROK_HOME` |
| --- | --- | --- |
| `grok plugin list --json` | `[]` | `[]` until `plugin install` |
| `grok plugin list --json --available` | 357 marketplace entries, every `status` `available` | Not re-run (it refreshes git caches) |
| `grok plugin marketplace list --json` | 5 git sources | The 4 Claude git sources. The xAI Official source was absent until `config.toml` existed |
| `grok mcp list --json` | `[]`, text `No MCP servers configured.` | `[]` |
| `grok inspect --json` | 92 skills, 15 plugins, 4 MCP servers, 0 marketplaces, 14 hooks | 70 skills, the same 15 plugins, the same 4 MCP servers, 14 hooks. No bundled skills |

`grok mcp list` is the TOML configuration (`[mcp_servers]` in user and project config). `grok inspect` is the merged catalog after plugins, compat files, and policy. `grok plugin list` is `$GROK_HOME/installed-plugins/registry.json`. Claude plugins show up in inspect and stay out of `plugin list`.

`grok plugin list --available` is the marketplace catalog, not the enabled set. On this machine the 357 rows came from four caches: `claude-plugins-official` 314, `xAI Official` 29, `claude-code-plugins` 13, `claude-on-the-go` 1. Fifteen of those catalog rows set `has_mcp`. The command's item fields are `name`, `version`, `description`, `marketplace`, `status`, `skill_count`, `has_hooks`, `has_agents`, `has_mcp`, and `components` (`skills`, `commands`, `agents`, `hooks`, `mcpServers` as `{name, description}` only).

There is no `grok skill` subcommand. Skill state is files plus inspect.

`grok mcp doctor` connects. This probe did not run it.

## On-disk layout

Default root is `$GROK_HOME`, which is `~/.grok` when unset. Paths below are what 1.0.41 used on this machine.

| Path | Role | This machine |
| --- | --- | --- |
| `$GROK_HOME/config.toml` | User config. `[plugins]`, `[skills]`, `[mcp_servers]`, `[[marketplace.sources]]`, compat cells, policy | 528 bytes. One marketplace source, no plugin or MCP tables |
| `$GROK_HOME/installed-plugins/registry.json` | Grok install registry. `plugin list` reads it | Absent. Only `registry.lock` |
| `$GROK_HOME/installed-plugins/<id>/` | Copy of an installed plugin | Absent until a temp-home install |
| `$GROK_HOME/marketplace-cache/<16-hex>/` | Git checkout of a marketplace source | 5 checkouts. Locks are older than the checkouts |
| `$GROK_HOME/plugins/` | User plugin dirs. The guide says this tree is auto-trusted | Absent |
| `$GROK_HOME/skills/` | User skills | Empty directory |
| `$GROK_HOME/bundled/skills/<name>/SKILL.md` | Skills shipped inside the CLI | 22 `SKILL.md` files under 28 directories |
| `$GROK_HOME/mcp_credentials.json` | OAuth tokens for remote MCP, mode `0600` | Absent |
| `$GROK_HOME/logs/mcp/<server>.stderr.log` | stdio server stderr, truncated each launch | `spaghetti-channel.stderr.log` |
| `.grok/config.toml` | Project MCP, plugins, permission, `[mcp] max_output_bytes` | Absent in this repo |
| `.grok/skills/`, `.grok/plugins/` | Project skills and plugins | Absent |
| `~/.claude/plugins/installed_plugins.json` | Claude install registry, version 2. Grok loads each `installPath` | 19 plugin ids |
| `~/.claude/plugins/known_marketplaces.json` | Claude marketplace registry. Grok imports git sources | 5 entries |
| `~/.claude/settings.json` | `enabledPlugins`, `extraKnownMarketplaces`, hooks | Present, mode `0600` |
| `~/.claude/skills/` | Claude user skills. Grok lists them as user skills | 3 synced skills |
| `~/.agents/skills/` | Extra user skills, scanned beside `.grok` | `browser-use`, `find-skills` |
| `~/.claude.json` | Claude MCP compat file | Top-level `mcpServers` is `{}` |

The public docs page dated 2026-08-11 (`https://docs.x.ai/build/features/skills-plugins-marketplaces`) still says marketplace installs live under `~/.grok/plugins/marketplaces/` and that sources also come from `~/.grok/plugins/known_marketplaces.json`. Neither path exists here. 1.0.41 stores clones in `marketplace-cache` and the install registry in `installed-plugins`. The binary's own compat table names `~/.claude/plugins/known_marketplaces.json` and `~/.claude/plugins/installed_plugins.json`.

`config.toml` on the real home also holds two one-shot flags the field reference does not list:

```toml
[marketplace]
official_marketplace_auto_installed = true
default_skills_installs_purged = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"
```

Binary strings in `xai-grok-shell` describe both flags. Official auto-register writes the xAI marketplace source (`https://github.com/xai-org/plugin-marketplace.git`) once it can lock `config.toml`, and skips itself when a marketplace allowlist blocks it. The legacy default-skills purge removes an older marketplace install set and then sets `default_skills_installs_purged`. An empty home's `plugin marketplace list` did not create `config.toml` and did not show xAI Official. The flags are session-start bookkeeping, not something inspect replays.

`grok inspect` warned that the key `privacy` is unrecognized. `privacy.privacy_banner_acked` is a documented user-file key. The warning is unrelated to extensions.

## Plugins

A plugin directory may contain `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, and `.lsp.json`. `plugin.json` (or `.claude-plugin/plugin.json`, `.grok-plugin/plugin.json`) is optional metadata. Without it, discovery uses those directory names.

### Install registry

`grok plugin install <source> --trust` copies the tree into `$GROK_HOME/installed-plugins/<generated-id>/` and appends `registry.json`. A directory with no `plugin.json` `name` is stored under `<directory>-<8 hex>`, and that string is the `plugin list` name. The list object is `status`, `name`, `repo_key`, `version`, `path`, `source`, `marketplace`.

Install without `--trust` prints the source and stops, because install activates hooks, MCP, and skills. `uninstall` (aliases `rm`, `remove`) takes `--confirm` and `--keep-data`. `enable` and `disable` take a name. `update` with no name updates every installed plugin. `validate` checks a directory. `tag` creates a git tag from the manifest version.

`[plugins]` in config:

| Key | Effect |
| --- | --- |
| `enabled` | Names or ids (`<scope>/<hash>/<name>`) forced on. Plugins stay off until listed or enabled in the modal |
| `disabled` | Discovered, not loaded |
| `paths` | Extra directories. Project files may set this once the folder is trusted |

`pager.toml` `disable_plugins = true` hides the plugins and hooks UI. It does not delete files.

Discovery order in the shipped guide, highest first: `_meta.pluginDirs` on `session/new` and `session/load` (that session, trusted because the caller supplied the path), `grok agent --plugin-dir` (process-wide, repeatable, ignored in leader mode), `.grok/plugins/` (project, needs trust), `~/.grok/plugins/` (user, auto-trusted), `[plugins].paths`. The binary also loads Claude `installPath` entries and marketplace `installLocation` trees. Same plugin name: higher scope wins. The log line is `plugin name collision resolved by scope precedence`.

### Marketplaces

A marketplace is a git repo or local folder whose index is `.grok-plugin/marketplace.json`. Grok also accepts `.grok-plugin/plugin.json` and the `.claude-plugin/` names. Each plugin `source` is either a local path or a remote `{source: "url", url, sha}`. The xAI catalog pins remote plugins to a full commit sha. `plugin-index.json` is a display catalog; installs work without it.

Sources are declared as `[[marketplace.sources]]` (`name` plus `git` or `path`) or as `extraKnownMarketplaces` in `~/.grok/settings.json` or `~/.claude/settings.json`. `grok plugin marketplace` supports `list --json`, `add`, `remove`, `update`.

On this machine `marketplace list` returned:

| Name | URL | Where it is recorded |
| --- | --- | --- |
| xAI Official | `https://github.com/xai-org/plugin-marketplace.git` | `config.toml` only |
| spaghetti | `https://github.com/jamesyong-42/spaghetti.git` | Claude `known_marketplaces.json` and `extraKnownMarketplaces` |
| claude-plugins-official | `https://github.com/anthropics/claude-plugins-official.git` | Claude registry and `extraKnownMarketplaces` |
| claude-code-plugins | `https://github.com/anthropics/claude-code.git` | Claude `known_marketplaces.json` only |
| claude-on-the-go | `https://github.com/jamesyong-42/p008-claude-on-the-go.git` | Claude `known_marketplaces.json` only |

Claude also has a directory marketplace, `vercel-vercel-plugin`. Grok's list omitted it. The five git URLs match the five `marketplace-cache` remotes. Inspect's `marketplaces` array was `[]` at the same time, so that array is not the source list. Policy output (`managedMarketplaces`, `marketplaceAllowlist`) was also empty. `mcpManagedServersOnly` was `off`.

`marketplace.require_sha` and `GROK_MARKETPLACE_REQUIRE_SHA` only tighten. A remote install or update then needs a full sha. `plugin_auto_update = false` stops the session-start scan. Manual `grok plugin update` still runs.

### Trust and what a plugin may do

Skills, commands, hooks, MCP, and LSP from a plugin stay inactive until the plugin is trusted. Untrusted plugin agents stay listed with frontmatter only. `~/.grok/plugins/` is auto-trusted. Project `.grok/plugins/` is not. Install `--trust` grants trust.

A temp `GROK_HOME/plugins/<name>` directory was visible to inspect as an enabled user plugin and its `provides.mcpServers` count was 1, and neither its skill nor its server entered the skill list or the MCP catalog. The same trees, installed with `plugin install --trust` into `$GROK_HOME/installed-plugins`, did contribute servers. Dropping a folder on disk is not the same as trusting an install.

Plugin agents cannot declare `mcpServers` or hooks, and cannot set `permissionMode: bypassPermissions`. The binary logs `ignoring mcpServers on plugin agent`. Plugin `.mcp.json` servers attach to the parent session. Children inherit the parent's connected servers. Frontmatter `mcpInheritance` is `all` (default), `none`, `named`, or `except`.

Hooks from a plugin receive `GROK_PLUGIN_ROOT` and `GROK_PLUGIN_DATA`, and the `CLAUDE_PLUGIN_*` aliases. Grok overwrites any same-named hook env.

### Org policy

`requirements.toml` and macOS MDM bind every marketplace and every MCP server. Claude `managed-settings.json` is advisory and binds foreign subjects (project files, imported Claude config, CLI overrides, client-injected servers). Adding a marketplace or installing a new source counts as foreign, so an advisory strict list still refuses an unlisted `marketplace add` or `plugin install`. User-writable `~/.grok` copies of requirements are self-imposed. Layers combine strictest-wins.

`strict_known_marketplaces` present and empty refuses every add. Local-path adds fail closed unless an admin pin names that path. `allowed_mcp_servers` present and empty blocks every server that file binds. A bad policy value locks that file down (`locked down by policy`) instead of failing open. `allow_managed_mcp_servers_only` requires an allow match. `enable_all_project_mcp_servers = false` drops project MCP unless an allow entry matches. Inspect prints the merged lists and `off` / `advisory` / `enforced`.

This machine had no `/etc/grok`, no `requirements.toml`, and `managed-settings.json` was absent at `/Library/Application Support/ClaudeCode/managed-settings.json`.

## Skills

A skill is a directory with `SKILL.md`. YAML frontmatter `name` and `description` matter. `name` is lowercase letters, digits, and hyphens, at most 64 characters; spaces and underscores become hyphens. Omitted `name` uses the directory name. Omitted `description` uses the first paragraph. `when-to-use` feeds automatic invocation. `user-invocable: false` hides the slash command. `disable-model-invocation: true` keeps the slash command and stops the model from selecting the skill. The body is inlined up to the first 25,000 tokens, the same cap as `read_file`.

The guide's scan order, highest first:

| Location | Scope |
| --- | --- |
| `./.grok/skills/`, `./.grok/commands/`, and `.agents/skills/` at that tier | Local |
| Every directory from the cwd up to the git root, same names | Repo |
| `~/.grok/skills/`, `~/.grok/commands/` | User |
| `~/.claude/skills/`, `~/.claude/commands/` | User, Claude compat |
| `~/.cursor/skills/` and project `.cursor/skills/` | Cursor compat |
| `~/.claude/skills` project counterparts, `.claude/commands/` | Local or repo |
| `$GROK_HOME/bundled/skills/` | Bundled |
| A plugin `skills/` or `commands/` directory | Plugin |

Flat `commands/*.md` becomes a slash command whose name is the filename stem. Inspect still lists those files in `skills[]`. On this machine `code-review` and `feature-dev` are `commands/*.md`, and the plugin's `provides.skills` is 0 while the Skills section still names them.

Discovery ignores `.gitignore` under `.grok/`, `.agents/`, `.claude/`, and `.cursor/`. Hide a skill with `[skills] ignore` (a path) or `[skills] disabled` (a name that stays listed and stays out of the prompt). `[paths] extra_skill_dirs` is written by `/import-claude` and does not inject skills.

Dedup is by bare name. A higher-priority location replaces a lower one. A plugin skill does not replace a native skill of the same name; it stays invocable as `<plugin>:<name>`. A collision with a built-in keeps the bare name for the built-in. Live inspect qualified names included `user:docs`, `bundled:code-review`, `bundled:imagine`, and `code-review:code-review`. The JSON adds `collidesWith` and `invocableAs` on those six rows. Source objects are `{type, path}` plus `plugin_name` for plugins. Types seen: `user`, `bundled`, `plugin`. Claude rows also carry `vendor: "claude"` and `compatibilityStatus`.

`[compat.claude] skills = false` or `GROK_CLAUDE_SKILLS_ENABLED=false` does not remove those rows. A fresh home with the env set flipped the inspect cell to `enabled: false`, `source: "env"`, tagged 68 Claude skills `compatibilityStatus: "disabled"`, and left the two `~/.agents/skills` entries active with no compat field. The guide says a disabled skill stays listed and is left out of the prompt and out of invocation. This probe checked the tag, not a live prompt.

Bundled skills follow `GROK_HOME`. The real home has 22. An empty home's inspect extracted `docs/user-guide/` into that home and listed zero bundled skills. A profile that has never had the bundle extracted will under-count skills relative to an interactive home.

`/create-skill` writes `<repo>/.grok/skills/<name>/` or `~/.grok/skills/<name>/`. Grok reloads skills when those files change.

There is no plan field and no email in any of this. Skills are not an identity surface.

## MCP servers

### Configuration

User and project TOML:

```toml
[mcp_servers.<name>]
command = "..."          # stdio
args = []
env = {}
url = "https://..."      # http or sse
headers = {}
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 6000
tool_timeouts = {}
```

`grok mcp add` writes that table. `--scope user` is `~/.grok/config.toml`. `--scope project` is `./.grok/config.toml`. Transport defaults to stdio, or http when the positional argument is an `http(s)` URL. `--env` is one `KEY=value` per flag. Names are letters, digits, hyphens, and underscores. `enable` and `disable` persist to the user file (`disabled_mcp_servers`, and `enabled` on an existing table). Disable does not rewrite a project file. Remove searches both scopes and exits 1 when the name is in both and `--scope` is omitted.

Same name at two scopes: the project table replaces the user table. Fields are not merged. Walk order for project files is cwd, then each parent up to the git root, and the deepest file wins over `~/.grok/config.toml`.

Other sources, in the guide's merge order: `config.toml`, Claude `~/.claude.json` when `[compat.claude] mcps` is on, Cursor `mcp.json` when `[compat.cursor] mcps` is on, then project `.mcp.json` unless the Claude import marker is set. `GROK_CLAUDE_MCPS_ENABLED` and `GROK_CURSOR_MCPS_ENABLED` override the cells. This machine's user `.claude.json` `mcpServers` is empty, so compat MCP did not add a fifth server.

Startup timeout: per-server `startup_timeout_sec`, else `GROK_MCP_STARTUP_TIMEOUT_SECS`, else `MCP_TIMEOUT` in milliseconds, else 30 seconds. Tool results cap at 20_000 bytes unless `GROK_MAX_MCP_OUTPUT_BYTES`, `MAX_MCP_OUTPUT_BYTES`, or `[mcp] max_output_bytes` says otherwise. Precedence for that cap: requirements, env, repo `.grok/config.toml`, user config, default. The overflow is spilled under the session `mcp/` folder.

String fields (`url`, `command`, `args`, `env` values, `headers` values) expand `${VAR}` and `${VAR:-default}` at load. OAuth tokens land in `mcp_credentials.json`. A header `User-Agent` overrides the default `grok-cli/<version>`, except Figma hosts, which send bare `grok-cli` unless config sets one.

`features.mcp_auto_restart` restarts stdio servers after a transport failure. The leader (`cli.use_leader`, default on) watches config and MCP. `features.mcp_recursive_config_watch` watches `<cwd>/` and `<cwd>/.grok/` and the watch is not recursive despite the name.

### Admission

Catalog key is `server__tool`, at most 256 characters. Server name must start with a letter or underscore. Tool name is `[A-Za-z0-9_-]` and may start with a digit. A second `__`, or a server name ending in `_`, is skipped (`InvalidOrAmbiguousQualifiedName`). The model calls `search_tool` and `use_tool` with the qualified key. The 64-character limit applies to those two meta-tool names, not to catalog keys.

`use_tool` on the Rust shell accepts inline `tool_input`, `tool_input_file`, or an invocation `file`. Files are UTF-8 JSON objects up to 8 MiB. A batch allows 16 MiB of source and 32 MiB of serialized calls. ACP client filesystems reject file mode.

`.mcp.json` has two shapes. The wrapped form is what the catalog admits:

```json
{ "mcpServers": { "wrapped": { "type": "http", "url": "https://example.invalid/wrapped" } } }
```

A top-level server map is counted on the plugin and omitted from `mcpServers[]`:

```json
{ "mapkey": { "type": "http", "url": "https://example.invalid/map" } }
```

Both were installed with `--trust` into an empty `GROK_HOME`. Inspect then listed `wrapped` and a third server whose header was `Authorization = "Bearer ${PROBE_TOKEN}"`. It did not list `mapkey`. The GitHub Claude plugin on this machine is the top-level form (`{"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer ${...}"}}}`) at `external_plugins/github/.mcp.json`. Inspect gives that plugin `provides.mcpServers: 1` and leaves `github` out of the four admitted servers. Context7, Figma, Vercel, and spaghetti-channel use the `mcpServers` wrapper and are admitted. The binary log for the agent-frontmatter parser is `ACP wire format parse failed, trying map-keyed`. Plugin `.mcp.json` admission is stricter than that fallback: the wrapper is required.

Admitted servers on the real home:

| Name | Transport | Target | Plugin path |
| --- | --- | --- | --- |
| figma | http | `https://mcp.figma.com/mcp` | Claude cache `figma/2.2.120` |
| vercel | http | `https://mcp.vercel.com` | Claude cache `vercel/0.50.0` |
| context7 | http | `https://mcp.context7.com/mcp?client=claude-code-plugin` | Claude marketplace `external_plugins/context7` |
| spaghetti-channel | stdio | `bun` | Claude cache `spaghetti-channel/1.0.0` |

`GROK_CLAUDE_MCPS_ENABLED=false` left those four in place. The cell covers `~/.claude.json` and project `.mcp.json`. Plugin MCP is a plugin component, not that scanner.

ACP `session/new` and `session/load` also take a client `mcpServers` array (stdio, and http/sse when the agent advertises `mcpCapabilities`). The Grok adapter does not send one. A client list is a third source, overlaid by the active agent's frontmatter, and agent.md headers win over TOML on the same name. Subagents inherit servers the parent has already connected.

Gateway connectors (`managed_gateway:…`) stay in the TUI. `grok mcp enable` does not toggle them.

### Tool call path inside a session

The model does not see raw MCP tool names. It calls `search_tool`, then `use_tool` with `server__tool`. Large arguments go through a JSON file. Results over the byte cap are truncated inline. OAuth for a remote server is a browser flow started from `/mcps` (`i`) or the first call. Stdio stderr is the per-server log under `logs/mcp/`.

## What inspect showed on the real home

`grokVersion` `1.0.41`, channel `stable`, project trusted, one config layer (`~/.grok/config.toml`), no project `.grok/config.toml`.

Skills, 92:

| Source | Count | Roots |
| --- | --- | --- |
| plugin | 65 | `~/.claude/plugins/...` |
| bundled | 22 | `~/.grok/bundled/skills/*/SKILL.md` |
| user | 3 | `~/.claude/skills/synced/...` |
| user | 2 | `~/.agents/skills/` |

Plugins, 15, every `scope` `user` and `enabled` true. Claude `settings.json` `enabledPlugins` has `superpowers@claude-plugins-official` set false. Inspect still lists `superpowers` enabled, with 15 skills and hooks. Grok's Claude loader follows `installed_plugins.json` `installPath` and does not apply Claude's enabled map.

Claude's registry has 19 ids. The three LSP plugins (`typescript-lsp`, `swift-lsp`, `rust-analyzer-lsp`) are missing from inspect. Their cache version directories contain `.in_use/<pid>` files and no `plugin.json`, `.lsp.json`, or skills. `lspServers` in inspect is `[]`. A second `frontend-design` install (`claude-code-plugins`) is shadowed by the official marketplace checkout of the same name.

Hooks, 14: 10 `vendor: claude` commands from `~/.claude` settings, plus 4 plugin file hooks (vercel, spaghetti-hooks, claude-code-on-the-go, superpowers). With `GROK_CLAUDE_HOOKS_ENABLED=false` the 10 Claude rows became `compatibilityStatus: "disabled"` and the 4 plugin hooks stayed untagged. The hooks cell does not gate plugin hooks.

Agents, 10: built-ins `general-purpose`, `explore`, `plan`, plus qualified plugin agents such as `feature-dev:code-architect` and `plugin-dev:agent-creator`.

Compat cells for Cursor and Claude skills, rules, agents, mcps, hooks, and sessions were all `enabled: true`, `source: "default"`. Codex only exposes `sessions`, also default on. There is no `GROK_CLAUDE_PLUGINS_ENABLED`. Plugin discovery has no compat cell.

## Session protocol Puppeteer already records

Surface for Grok 1.0.0, which is behind this binary:

| Event | Where | Evidence in Surface | Adapter today |
| --- | --- | --- | --- |
| `_x.ai/mcp/servers_updated` | JSON-RPC notification, `params.servers[]` | `verified-headless`, fixture servers `[]` | Not a `session/update`. The update normalizer ignores the method. The live control path's `onExtensionNotification` keeps the method name and drops `servers` |
| `_x.ai/mcp/init_progress` | `params.completed`, `params.total` | Same fixture, both 0 | Same |
| `plugins_changed` | `session/update`, `plugins: Vec<PluginInfo>` | Public-source structural, unverified. `PluginInfo` fields are not projected | Durable normalizer does not list it in `GROK_EXTENSION_UPDATES`, so replay falls through to ACP `adapter:native-event` with `nativeType: "plugins_changed"`. Live `grokExtensionEvents` tags `adapter: "grok"` and still keeps only the name |
| `plugin_updates_installed` | `updates: Vec<(String, String, String)>` | Same unverified structural evidence | Same treatment |

`packages/surface/vendors/grok/captures/grok@1.0.0/handshake.jsonl` records the two MCP notifications with empty arrays. It does not record a plugin payload. Nothing here is ready to promote.

## Profile isolation

Launch allow-list for a Grok profile is `GROK_HOME`. That is the right binding for `auth.json`, sessions, the install registry, bundled skills, and user `config.toml`.

It is the wrong boundary for the extension set a session actually runs:

- Empty `GROK_HOME`, private `--leader-socket`, no `XAI_API_KEY`: inspect still listed the same 15 Claude plugins and the same 4 MCP servers.
- Marketplace list on that home still returned the four Claude git sources, read from `~/.claude/plugins/known_marketplaces.json`.
- `GROK_CLAUDE_SKILLS_ENABLED=false` and the matching hooks, agents, rules, and mcps variables flip inspect cells to `source: "env"`. Claude skill and Claude settings-hook rows stay in the document tagged `disabled`. Plugin skills, plugin hooks, and plugin MCP stay active.
- `~/.agents/skills` is outside both homes and stays active with the Claude cells off.

A managed profile that should not inherit this machine's Claude plugins needs the session started where those files are invisible (a private `HOME` is a bigger hammer than Grok's contract, and this probe did not try it), or the product must show them as shared machine state. Copying `GROK_HOME` does not copy or hide them.

`grok agent --no-leader stdio` is the identity probe from [GROK-PROFILE-IDENTITY.md](./GROK-PROFILE-IDENTITY.md). Extension inventory does not need that process. `grok inspect` is a separate short process. Point `--leader-socket` at a profile-private path so the command does not attach to the user's `~/.grok/leader.sock`.

## Probe side effects

`grok plugin list --available` against the real home updated the mtime of `marketplace-cache/11f3bbe6ef2f799d` (the `anthropics/claude-code` checkout). The other four cache directories were days to weeks older. This note does not claim the git commit changed.

Temp homes under `/tmp/grok-ext-probe-*` were deleted, including three `plugin install --trust` copies. The real `installed-plugins` directory was left as `registry.lock` only. `grok mcp doctor` was not run. No MCP process was started for Figma, Vercel, Context7, or spaghetti-channel.

## What to re-check

Re-run `grok inspect --json` and `grok plugin marketplace list --json` when the support baseline leaves 1.0.41. The August 2026 public docs and this binary already disagree about marketplace paths. The next release can move the install registry again without changing the slash commands.
