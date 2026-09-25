# How Codex manages plugins, skills, and MCP servers

| Field | Value |
| --- | --- |
| Status | Research record. No adapter change, no Surface regeneration, no support-ledger change. |
| Date | 2026-09-24 |
| Question | How Codex CLI 0.156.1 discovers, installs, enables, and exposes plugins, skills, and MCP servers, and which of that state follows `CODEX_HOME`. |
| Install | `codex-cli 0.156.1` at `~/.nvm/versions/node/v26.5.0/bin/codex` (darwin-arm64). |
| Surface pin | `codex@0.150.0`, model generated 2026-08-28 from `codex app-server generate-json-schema`. |
| Docs read | ChatGPT Learn pages fetched the same day. `developers.openai.com/codex/...` now redirects there. The app-server page is the protocol reference. |
| Related | RFC 006, `packages/adapter-codex/src/services/profiles.ts`, `packages/surface/vendors/codex/model/codex@0.150.0/events/{plugin,skills,mcpServer,marketplace,app}` |

Puppeteer profiles bind one `CODEX_HOME` per Codex account. RFC 006 already points an extensions service at app-server `plugin/*`, `skills/*`, `marketplace/*`, and `mcpServer/*`, and records `~/.agents/skills` as a shared surface. The profile comment still says skill discovery is repository `.agents/skills`, `~/.agents/skills`, then `/etc/codex/skills`, and that none of those live under `CODEX_HOME`. That list is incomplete on this binary.

## Recommendation

Inventory a profile by talking to `codex app-server` under that profile's `CODEX_HOME`. Use the stdio JSON-RPC session the adapter already opens. Read skills with `skills/list` for the session cwd. Read installed plugins with `plugin/installed`. Read configured MCP servers with `codex mcp list --json` when no thread is loaded, and `mcpServerStatus/list` once a thread exists and a runtime status is required. Persist enablement with `skills/config/write`, `plugin/install`, `plugin/uninstall`, `marketplace/add`, and `codex mcp add` / `remove`. Leave `config.toml`, the plugin cache, and the remote catalog caches as stores the binary owns.

Three roots matter, and a profile only owns the first:

| Root | What follows it |
| --- | --- |
| `$CODEX_HOME` (default `~/.codex`; the directory must already exist) | `config.toml` tables for `mcp_servers`, `plugins`, `marketplaces`, and `skills.config`; installed plugin bytes at `plugins/cache/<marketplace>/<plugin>/<version>/`; bundled system skills materialized at `skills/.system/`; MCP OAuth credential store selection. |
| `$HOME` | User skills at `~/.agents/skills`. The implicit personal marketplace at `~/.agents/plugins/marketplace.json`, whose marketplace root is `$HOME` itself. Every Codex profile on the machine sees both. |
| The trusted workspace | Repo skills under `.agents/skills` from the cwd up to the git root. A repo marketplace at `$REPO/.agents/plugins/marketplace.json`. App-server sees that catalog when `cwds` includes the repo. `codex plugin` does not, until `codex plugin marketplace add <repo-root>` writes a `[marketplaces.<name>]` entry into the profile config. |

`skills/list` is the authority for what a cwd will actually be offered. Plugin skills come back as scope `user` with `pluginId` set to `name@marketplace`, even though their files live under the profile cache. `codex mcp list` is the authority for the effective server list. It includes plugin-bundled servers that have no `[mcp_servers.<name>]` table.

Keep this note out of Surface. The published app-server page still tells clients to avoid `plugin/list`, `plugin/read`, `plugin/install`, and `plugin/uninstall` in production, while the 0.156.1 schema emits those four methods without `--experimental`. Ship an extensions client against a regenerated Surface pin, with the response shape taken from that pin.

RFC 006's line that there is no `CODEX_HOME/skills` is stale for system skills. On 0.156.1 the first app-server process in an empty home copies six bundled skills into `$CODEX_HOME/skills/.system/`. User and repo skills still do not live there. Per-profile control of a shared user skill remains `[[skills.config]]` in that home's `config.toml`.

## What the three objects are

A skill is a directory with a `SKILL.md`. The front matter requires `name` (one line, at most 100 characters) and `description` (one line, at most 500 characters). Codex ignores extra front-matter keys. Optional `agents/openai.yaml` supplies display metadata, `policy.allow_implicit_invocation` (default true), and tool dependencies. The model sees name and description in a catalog whose budget is `skills.max_context_tokens` (default 2% of the model window, hard cap 10,000). The body, `references/`, and `scripts/` load only after the skill is chosen.

A plugin is the installable package. A current package has root `plugin.json` (`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`), skills under `skills/`, and MCP servers in root `mcp.json`. OpenAI-specific presentation, registered-app mappings, and hooks live in `extensions.com.openai`. A legacy `.codex-plugin/plugin.json` still works as a compatibility overlay, and several bundled plugins on this machine are still in that shape (`visualize` declares `"skills": "./skills/"` there). Portable `skills/` and `mcp.json` win over a `skills` or `mcpServers` field in the overlay.

An MCP server is a tool process. User-configured servers are `[mcp_servers.<name>]` tables: stdio (`command`, `args`, `env`, `env_vars`, `cwd`) or streamable HTTP (`url`, bearer env var, static headers, `env_http_headers`, `http_headers_helper`, OAuth). Plugin-bundled servers are launched from the installed plugin. User config can enable them and set tool policy under `plugins."<plugin>".mcp_servers.<server>`, and it does not set their transport command.

Plugins can also carry lifecycle hooks and references to ChatGPT apps (connectors). Hooks are a separate trust domain: installing a plugin does not trust its hooks. Apps are a separate enablement domain (`apps.<id>`, `app/list`, `app/installed`). The IDE extension shares MCP configuration with the CLI and the desktop app. The current plugins page says the IDE extension does not run plugins. Standalone skills do load in the IDE extension. The March 2026 changelog said plugins were in the IDE extension; the current plugins page is the later statement.

ChatGPT on the web uses the same public plugin directory and does not read local `config.toml`. Hosted plugin tools can differ from MCP servers configured on a local Codex host.

## How a session puts them together

Config layers merge, highest precedence first: CLI flags and `-c`, trusted project `.codex/config.toml` from the repo root down to the cwd, the `--profile` file `$CODEX_HOME/<name>.config.toml`, user `$CODEX_HOME/config.toml`, cloud-managed defaults, `/etc/codex/config.toml`, then built-in defaults. An untrusted project skips its `.codex/` layer (config, hooks, and rules). User and system layers still load. Marketplace files under `.agents/` are outside that `.codex/` rule; the isolation probe below saw a repo marketplace with no `trust_level` set.

Feature flags that gate this surface, from `codex features list` on 0.156.1:

| Flag | Stage on this binary | Effective here | Role |
| --- | --- | --- | --- |
| `plugins` | stable | on | Plugin system. Requirements can pin it off. |
| `remote_plugin` | stable | on | Remote / universal catalog. |
| `plugin_sharing` | stable | on | Workspace sharing of locally built plugins. Requirements can set `features.plugin_sharing = false`. |
| `recommended_plugins` | stable | off | Suggested plugins. |
| `skill_mcp_dependency_install` | stable | on | Prompt to install an MCP server declared by a skill. |
| `skill_search` | stable | on | Skill search. |
| `hooks` | stable | on | Lifecycle hooks. `codex_hooks` is a deprecated alias. |
| `apps` | stable | on | Connectors. |
| `tool_call_mcp_elicitation` | stable | on | MCP elicitation during a tool call. |
| `plugin_hooks` | removed | off | Old flag. Plugin hooks now ride `hooks`. |
| `skip_host_skill_discovery` | under development | off | Would skip host skill scan. |
| `mcp_2026_07_28`, `enable_mcp_apps`, `non_prefixed_mcp_tool_names`, `mcp_oauth_refresh_coordination` | under development | off | Unshipped MCP behavior. |

Discovery then builds three catalogs:

1. Skills, for that cwd. Metadata goes into the prompt. The user invokes one with `$name` in the CLI or IDE, or `@` in ChatGPT. `turn/start` should also carry an input item `{ "type": "skill", "name", "path" }` so the server injects the body. A missing item still parses `$name` and looks the skill up, which costs a lookup.
2. Plugins. An enabled plugin contributes its skills, its MCP servers, and its hooks. Hooks stay skipped until the user trusts that exact hook definition (`/hooks` in the CLI). `--dangerously-bypass-hook-trust` is the automation escape.
3. MCP servers. Optional servers get `mcp_optional_startup_grace_ms` (default 1000) while the initial tool catalog is built. Required servers (`required = true`) fail startup on their own `startup_timeout_sec` (default 10). Tool calls default to `tool_timeout_sec` 60. Approval is `auto`, `prompt`, `writes`, or `approve`, with a per-tool override. `writes` prompts for tools that are not marked read-only.

`skills/changed` fires when watched skill files change. The client re-runs `skills/list`. The adapter already treats that notification, plus `mcpServer/startupStatus/updated` and `mcpServer/oauthLogin/completed`, as ambient.

## Skills

### Where they are read from

Documented scopes, confirmed against the 0.156.1 schema enum `user | repo | system | admin`:

| Scope | Location | What the probe saw |
| --- | --- | --- |
| `repo` | `.agents/skills` at the cwd, then each parent up to the git root. Symlinks are followed. | A skill in `repo/nested/.agents/skills` appeared for cwd `nested` and disappeared when cwd was the repo root. The root skill appeared for both. |
| `user` | `$HOME/.agents/skills` | Follows `HOME`, including when `CODEX_HOME` points somewhere else. |
| `admin` | `/etc/codex/skills` | Documented. This machine has no `/etc/codex`. The probe never returned scope `admin`. |
| `system` | Bundled with the CLI, copied into `$CODEX_HOME/skills/.system/` | Created on the first app-server start in an empty home. Marker file `.codex-system-skills.marker`. |
| plugin skill | Installed plugin's `skills/` | Returned as scope `user`, with `pluginId`. The protocol name is `<plugin>:<skill-folder>`, while `SKILL.md` keeps the short name. |

Same `name` in two scopes is listed twice. The repo copy and the user copy of `shared-name` both came back. Codex does not merge them.

The system set copied into an empty home, and the set already present in the real `~/.codex/skills/.system`, is `imagegen`, `openai-docs`, `plugin-creator`, `review-agent`, `skill-creator`, and `skill-installer`. Curated skills beyond that are installed by invoking `$skill-installer`, which downloads into the user skill locations. That path is for a local experiment. Distribution to other people is a plugin.

Disable without deleting:

```toml
[[skills.config]]
path = "/absolute/path/to/skill/SKILL.md"
enabled = false
```

The configuration reference describes `skills.config[].path` as a folder containing `SKILL.md`. `skills/config/write` on this binary stored the `SKILL.md` file path and the next `skills/list` returned `enabled: false` for that skill. The write response was `{ "effectiveEnabled": false }`. The folder form was not tried.

`skills/extraRoots/set` replaces process-level extra discovery roots and does not persist them. The published app-server page also documents `perCwdExtraUserRoots` on `skills/list`. That field is absent from the 0.150.0 Surface schema and from the 0.156.1 schema generated with `--experimental`.

There is no `codex skills` subcommand. The CLI surface is `$skill`, `/skills`, and the creator skills above.

### Real home, cwd = this repo

`skills/list` with `forceReload: true` returned 15 skills and no errors. This repo has no `.agents/skills`, so nothing was `repo`.

| Scope | Count | Examples |
| --- | --- | --- |
| `user`, no plugin | 2 | `~/.agents/skills/browser-use`, `~/.agents/skills/find-skills` |
| `user`, plugin-owned | 7 | `documents:documents`, `pdf:pdf`, `presentations:Presentations`, `spreadsheets:Spreadsheets`, `spreadsheets:excel-live-control`, `template-creator:template-creator`, `visualize:visualize` |
| `system` | 6 | the bundled set above, paths under `~/.codex/skills/.system/` |

Plugin skill paths point at the cache, for example `~/.codex/plugins/cache/openai-primary-runtime/documents/26.909.12148/skills/documents/SKILL.md`, whose front matter `name` is `documents`.

## Plugins and marketplaces

A plugin id is `plugin-name@marketplace-name`. That string is `PluginSummary.id`, the config table key, and the `pluginId` on a skill.

### Catalogs

A marketplace is a JSON catalog. The file is `.agents/plugins/marketplace.json`, or the Claude-compatible `.claude-plugin/marketplace.json`. Each entry has `name`, `source`, `policy.installation` (`AVAILABLE`, `INSTALLED_BY_DEFAULT`, `NOT_AVAILABLE`), `policy.authentication` (`ON_INSTALL` or `ON_USE`), and `category`. Sources are local path, `url`, `git-subdir`, or `npm` (package, version range, HTTPS registry; the `npm` CLI must exist; lifecycle scripts are not run). A bad entry is skipped. The catalog keeps loading.

`source.path` is relative to the marketplace root, starts with `./`, and stays inside that root. For a personal catalog the root is `$HOME`, so `./personal-plugin` means `$HOME/personal-plugin`, and the documented pattern `./.codex/plugins/<name>` means `$HOME/.codex/plugins/<name>`. For a repo catalog the root is the repository root, so `./plugins/my-plugin` means `$REPO/plugins/my-plugin`. The `.agents/plugins/` directory is where the catalog file lives. It is not the path base.

Implicit and configured sources on the two homes that were probed:

| Marketplace | How it appears | Root |
| --- | --- | --- |
| Personal | Implicit from `$HOME/.agents/plugins/marketplace.json`. No `[marketplaces.*]` entry. | `$HOME` |
| Repo | Visible to `plugin/list` and `plugin/installed` when `cwds` hits the repo. Invisible to `codex plugin marketplace list` until `marketplace add <repo-root>` writes `[marketplaces.<name>]`. Trusting the project did not change the CLI result. | Repository root |
| Configured local or git | `codex plugin marketplace add` writes `source_type`, `source`, optional `ref` and `sparse_paths`. | The added path, or a fetched snapshot |
| Bundled / product | On the real home: `openai-bundled` from `~/.codex/.tmp/bundled-marketplaces/openai-bundled`, `openai-primary-runtime` from `~/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime`. | Product-managed directories |
| Curated snapshot | `openai-curated`, root `~/.codex/.tmp/plugins`, listed with no `marketplaceSource`. | Snapshot directory |
| Remote catalog | `plugin/installed` on the real home also returned `openai-curated-remote`. `codex plugin marketplace list` did not. | Remote; cache under `plugins/cache/openai-curated-remote/` |

`INSTALLED_BY_DEFAULT` is policy metadata. Listing the personal plugin with that policy left `installed: false` and `enabled: false` until `codex plugin add` ran.

Install copies the package to:

```text
$CODEX_HOME/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/
```

`$VERSION` is `local` for a local source. Curated and bundled copies on this machine use content or build versions (`1dc19589`, `26.917.71314`, `0.1.4`, `1.0.39`). The install also writes a small `.codex-plugin/plugin.json` beside a portable manifest. `codex plugin add personal-plugin@probe-personal --json` returned `pluginId`, `version: "local"`, `installedPath`, and `authPolicy`, and appended:

```toml
[plugins."personal-plugin@probe-personal"]
enabled = true
```

After that, `skills/list` included `personal-plugin:personal-skill` at the cache path, scope `user`, `pluginId` `personal-plugin@probe-personal`.

Enablement for a cwd is the merged `plugins."<id>".enabled`. A trusted project's `.codex/config.toml` can override the user home. Marketplace refresh may still update files for a plugin whose `enabled` is false. Workspace-managed plugins keep the workspace's enabled state; a local `enabled = false` does not override it. Remote plugins on the real home were installed and enabled with no matching `[plugins.*]` table, so the absence of a table means "no local override", and the effective bit comes from `plugin/installed`.

Uninstall is `codex plugin remove <plugin@marketplace>`, which deletes the cache entry. Turning a plugin off leaves the cache and sets `enabled = false`.

### CLI

```text
codex plugin add <plugin[@marketplace]> [--marketplace NAME] [--json]
codex plugin list [--marketplace NAME] [--json] [--available]
codex plugin remove <plugin[@marketplace]> [--json]
codex plugin marketplace add <local-path | owner/repo[@ref] | git-url> [--ref] [--sparse PATH] [--json]
codex plugin marketplace list [--json]
codex plugin marketplace upgrade [name] [--json]
codex plugin marketplace remove <name> [--json]
```

`plugin list --json` is `{ "installed": [...], "available": [...] }`. `--available` fills `available`. Selectors are `plugin@marketplace` or `--marketplace`.

In the TUI, `/plugins` opens a browser grouped by marketplace. Space on an installed plugin toggles it. A new session is required before bundled skills and tools show up. That browser was not driven in this probe. `/apps` is the connector picker.

Sharing a local plugin into a ChatGPT workspace is an admin action in the Plugins UI, gated by `features.plugin_sharing`. It does not publish to the public directory. Public publishing goes through the plugin submission flow.

### Real home, `plugin/installed`

Four marketplaces, no load errors. All of these were `installed: true` and `enabled: true`.

| Marketplace | Plugins |
| --- | --- |
| `openai-primary-runtime` | `documents`, `pdf`, `spreadsheets`, `presentations`, `template-creator` |
| `openai-bundled` | `codex-app-tools`, `browser`, `unified-computer-use`, `chrome`, `computer-use`, `visualize` |
| `openai-curated` | `google-calendar`, `slack` |
| `openai-curated-remote` | one hashed app id, `openai-templates`, `finances`, `plugin-management` |

The bundled tree on disk also contains plugins that were not in the installed list (`computer-history`, `latex`, `messages`, `record-and-replay`). Presence in the bundled marketplace directory is the catalog. Presence in `plugin/installed` is the install.

## MCP servers

### User servers

`codex mcp` edits `config.toml`:

```text
codex mcp add <name> -- <stdio command...> [--env KEY=VALUE]
codex mcp add <name> --url <streamable-http-url>
    [--bearer-token-env-var ENV]
    [--oauth-client-id ID]
    [--oauth-client-registration auto|cimd|dcr]
    [--oauth-resource RESOURCE]
codex mcp list [--json]
codex mcp get <name> [--json]
codex mcp remove <name>
codex mcp login <name> [--scopes a,b] [--no-browser] [--oauth-client-registration ...]
codex mcp logout <name>
```

`list --json` is an array of `{ name, enabled, disabled_reason, transport, startup_timeout_sec, tool_timeout_sec, auth_status }`. Transport is `stdio` (`command`, `args`, `env`, `env_vars`, `cwd`) or `streamable_http` (`url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper`). `auth_status` on the CLI matches the protocol enum `unknown | unsupported | notLoggedIn | bearerToken | oAuth`.

HTTP auth order is configured bearer and headers, then `auth` (`oauth` by default, or `chatgpt` for a trusted first-party origin with OAuth as fallback). A header helper's `Authorization` loses to an explicit bearer or OAuth credential. After a same-origin 401 or 403, Codex refreshes helper headers once. An OAuth 403 that means "insufficient scope" does not refresh the helper. If nothing resolves, Codex still connects anonymously; `codex mcp login` is a separate step.

OAuth registration defaults to CIMD when the authorization server advertises it and the callback is a supported loopback URL, otherwise DCR. A configured `client_id` skips registration. `--oauth-client-registration` applies to that login only and is not stored. Callback selection depends on whether the server advertises `authorization_response_iss_parameter_supported` and whether `callback_url` already contains the server-specific callback id derived from the MCP URL. `mcp_oauth_callback_url` and `mcp_oauth_callback_port` are the global overrides; `mcp_servers.<name>.oauth.callback_port` wins for one server. The port inside the callback URL does not choose the listen port. Credentials go to `mcp_oauth_credentials_store` (`auto | file | keyring`). This probe did not read that store. `~/.codex/mcp-oauth-locks/` exists on the real home and was not opened.

Other per-server keys: `enabled`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `tools.<tool>.approval_mode`, `tools.<tool>.output_token_limit`, `scopes`, `oauth_resource`, `experimental_environment = "remote"` for stdio through a remote executor. `env_vars` entries are names, or `{ name, source }` with `source` `local` or `remote`.

`/mcp` in the TUI and in the desktop composer shows connected servers. Desktop settings and the IDE gear menu edit the same `config.toml` and can restart the client. Project-scoped `.codex/config.toml` is loaded only for a trusted project, so a repo can add servers only after trust.

### Plugin servers

`.mcp.json` / `mcp.json` names servers under `mcpServers`. On disk, the bundled `codex-app-tools` plugin ships a stdio server named `codex_app` with `enabled: false`, tool approval overrides, and `env_vars` naming `CODEX_HOME`, `PATH`, and the desktop node. User config can then say:

```toml
[plugins."sample@test".mcp_servers.sample]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["read", "search"]

[plugins."sample@test".mcp_servers.sample.tools.search]
approval_mode = "approve"
```

Plugin HTTP OAuth uses camelCase `clientId`, `callbackUrl`, and `callbackPort` in the manifest. The same callback-id rules apply. A plugin `callbackPort` overrides the global port.

A skill can declare the server it needs in `agents/openai.yaml` (`dependencies.tools[].type = "mcp"`, plus `value`, `transport`, `url`). With `features.skill_mcp_dependency_install` on, Codex may prompt to install that server.

### What `codex mcp list` returned on the real home

Values that look like credentials were not recorded. Names, enabled bit, transport kind, and auth status were:

| Name | Enabled | Transport | In user `config.toml`? |
| --- | --- | --- | --- |
| `openaiDeveloperDocs` | yes | streamable HTTP `https://developers.openai.com/mcp` | yes, `url` only |
| `node_repl` | yes | stdio, command inside `ChatGPT.app` | yes, including `startup_timeout_sec = 120` and an env table |
| `cua_repl` | yes | stdio, `cua-repl.mjs` inside `ChatGPT.app` | no table |
| `computer-use` | no | stdio, Sky client, `args = ["mcp"]` | yes, `enabled = false` |
| `codex_app` | no | stdio, launcher inside `plugins/cache/openai-bundled/codex-app-tools/0.1.4` | no table; this is the plugin `.mcp.json` server |

`auth_status` was `unsupported` for all five. Timeouts were 10s / 3600s for `codex_app`, 120s startup for the two repl servers, and null otherwise.

So the effective MCP inventory is user tables plus plugin manifests plus servers injected by the desktop bundle. Reading only `[mcp_servers]` undercounts it.

### Runtime protocol

Stable on 0.156.1:

| Method | Role |
| --- | --- |
| `config/mcpServer/reload` | Reload MCP config from disk and queue a refresh of loaded threads. |
| `mcpServerStatus/list` | Page servers. `detail` is `full` (default) or `toolsAndAuthOnly`. Optional `threadId`. |
| `mcpServer/tool/call` | Call a tool on a thread's server. |
| `mcpServer/resource/read` | Read one resource. |
| `mcpServer/oauth/login` | Returns an authorization URL. Completion is `mcpServer/oauthLogin/completed` (`name`, `threadId`, `success`, `error`). `threadId` may be null for an app-scoped or plugin flow. |
| `mcpServer/elicitation/request` | Server request. `mode` `form`, `openai/form` (only if initialize opted into `mcpServerOpenaiFormElicitation`), or `url`. Reply `accept`, `decline`, or `cancel`. |
| `mcpServer/startupStatus/updated` | Notification: `threadId`, `name`, `status` (`starting`, `ready`, `failed`, `cancelled`), `error`, `failureReason`. `reauthenticationRequired` means stored OAuth could not be refreshed. `threadId` null means app-scoped startup. |

`McpServerStatus` carries `authStatus`, `pluginId`, `runtimeStatus` (`notStarted`, `starting`, `connected`, `authenticationRequired`, `failed`, `cancelled`, `disabled`), `serverInfo`, tools, resources, and `toolsError`. The adapter already routes elicitation through the approval service and normalizes an `mcpToolCall` item as a tool event. Destructive app tools still ask even when the tool also advertises a weaker hint; a decline completes the `mcpToolCall` as an error.

`mcpServer/event/stream/start` and `stop` exist only in the schema generated with `--experimental`.

Requirements can allowlist MCP servers. A server is enabled only when both its name and its identity match. Identity is an exact `command` or `url`, or a matcher on executable and ordered args. Plugin servers have the same matcher shape under `plugins.<plugin>.mcp_servers`. The command-network proxy does not filter MCP traffic. `features.apps = false` and `features.plugins = false` are the switches for those surfaces.

## App-server map

Initialize with the profile environment. The result includes `codexHome`, which on the empty-home probe was the `CODEX_HOME` that was set. Opting into `capabilities.experimentalApi` was enough for every read used here. Stable versus experimental below is `generate-json-schema` with and without `--experimental` on 0.156.1.

### Stable reads and writes

| Area | Methods |
| --- | --- |
| Skills | `skills/list` (`cwds`, `forceReload`), `skills/config/write` (`path` or `name`, `enabled`), `skills/extraRoots/set`, notification `skills/changed` |
| Plugins | `plugin/list`, `plugin/read`, `plugin/installed`, `plugin/install`, `plugin/uninstall`, `plugin/reconcile`, `plugin/skill/read`, `plugin/share/list`, `plugin/share/save`, `plugin/share/checkout`, `plugin/share/delete`, `plugin/share/updateTargets` |
| Marketplaces | `marketplace/add`, `marketplace/remove`, `marketplace/upgrade` |
| MCP | the table in the previous section |
| Connectors | `app/list`, `app/read`, `app/installed` |
| Hooks | `hooks/list` (`cwds`). Sources include `user`, `project`, `plugin`, `system`, `mdm`, cloud requirements, cloud managed config, and legacy managed files. Trust is `managed`, `trusted`, `untrusted`, or `modified`. |
| Import | `externalAgentConfig/detect`, `externalAgentConfig/import`. Item types include `SKILLS`, `PLUGINS`, `MCP_SERVER_CONFIG`, `HOOKS`, `COMMANDS`, `SUBAGENTS`, `AGENTS_MD`, `CONFIG`, `MEMORY`, `SESSIONS`. CLI entry is `/import` from Claude Code or Cursor. |

`plugin/list` parameters are `cwds`, `forceRefetch`, and `marketplaceKinds` (`local`, `vertical`, `workspace-directory`, `shared-with-me`, `created-by-me-remote`). Omitting kinds queries local marketplaces plus the default remote catalog when `remote_plugin` is on. The response is marketplaces, featured plugin ids, and load errors. Each summary has install policy, auth policy, availability (`AVAILABLE` or `DISABLED_BY_ADMIN`), `disabledReason` (`disabled_by_admin`, `plan_not_eligible`, `required_app_unavailable`, `unknown`), `installed`, `enabled`, and a `source` of `local`, `git`, `npm`, or `remote`.

`plugin/read` returns the summary plus skills, MCP server names, apps, hooks, an optional onboarding skill, and a remote `shareUrl`. `plugin/installed` is the smaller "what is installed for these cwds" call. On an empty home, before any install, it returned no marketplaces while `plugin/list` still returned the personal and repo catalogs as not installed.

`plugin/reconcile` is in the 0.156.1 stable schema and is absent from the 0.150.0 Surface tree. Its response lists bundle and enablement changes since the previous cached snapshot (`hasSkills`, `hasMcps`, `hasHooks`, `hasApps` on each changed id), plus remote plugin ids whose bundle update failed. It is a diff of declarations, not a readiness check. It was not invoked.

`plugin/search` is experimental only. Search scopes are `global`, `workspace`, and `personal`.

The published app-server page, fetched the same day, still says `plugin/list`, `plugin/read`, `plugin/install`, and `plugin/uninstall` are under development and should not be called from production clients. The schema on this binary includes them in the stable document. Treat the prose as a stability warning and the schema as the wire shape, and pin the shape with Surface before an adapter decodes it.

`config/read` returns the merged config. It can echo MCP env values. An inventory client does not need it. `config/value/write` and `config/batchWrite` edit the user `config.toml`.

### Delta from the pinned Surface

`codex@0.150.0` already has `plugin/list`, `plugin/read`, `plugin/install`, `plugin/uninstall`, `plugin/installed`, `plugin/search`, `plugin/skill/read`, the `plugin/share/*` set, `skills/list`, `skills/config/write`, `skills/extraRoots/set`, `skills/changed`, `marketplace/add|remove|upgrade`, `mcpServerStatus/list`, OAuth login, elicitation, startup status, resource read, and tool call. New in the 0.156.1 schema relative to that tree: `plugin/reconcile`, and the external-agent import history methods `externalAgentConfig/import/readHistories` and `externalAgentConfig/import/recordHistory`. `skills/list` did not grow `perCwdExtraUserRoots`.

## Hooks that ride along with plugins

Hooks are commands or MCP tool calls on `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `Stop`, and `Interrupt`. The protocol spells those names in camel case starting with a lowercase letter.

Discovery walks every active config layer and loads both `hooks.json` and inline `[hooks]`, warning if a layer has both. Higher-precedence layers do not replace lower ones. Enabled plugins add their hooks. The default file is `hooks/hooks.json` in the plugin root. `extensions.com.openai.hooks` (a path, a path list, or inline objects) replaces that default. Commands receive `PLUGIN_ROOT` and `PLUGIN_DATA`, and also `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`. Hook scripts have to exist in the execution environment. Installing a plugin in ChatGPT on the web does not deploy them.

Managed hooks from `requirements.toml` are trusted by policy and cannot be disabled in the user browser. `allow_managed_hooks_only = true` drops user, project, session, and plugin hooks and keeps the managed set. `hooks.managed_dir` (Unix) or `hooks.windows_managed_dir` must be absolute and must exist. The scripts are installed by MDM, not by Codex.

`hooks/list` for this repo returned an empty hook list. The hermetic home was not given hooks.

## Admin constraints

`requirements.toml` is enforced. Locations, low to high: `/etc/codex/requirements.toml` (Windows: `%ProgramData%\OpenAI\Codex\requirements.toml`), the cloud config bundle, legacy `managed_config.toml` fields reinterpreted as requirements, then macOS MDM `com.openai.codex:requirements_toml_base64`.

The keys that hit this surface are the MCP and plugin-MCP identity allowlists, `marketplaces.restrict_to_allowed_sources` plus `marketplaces.allowed_sources.<name>` (`source` of `git`, `host_pattern`, or `local`, optional git ref), pinned `features.plugins`, `features.remote_plugin`, `features.plugin_sharing`, and `features.hooks`, and managed `[hooks]`. Cloud-managed and system `config.toml` can also define marketplace defaults and plugin enabled bits. Those are defaults. Requirements are the constraints. Workspace GitHub import (Admin, Plugins, Import marketplace, daily sync) is a third path and ignores the catalog's own installation and authentication policies.

This machine has no `/etc/codex`, so none of that layer was observed locally.

## Isolation probe

A throwaway `HOME` and `CODEX_HOME` under `/tmp/codex-ext-probe`, with `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, and `OPENAI_API_KEY` unset. The repo was `git init`'d and contained `.agents/skills` at the root and in `nested/`, plus `.agents/plugins/marketplace.json` pointing at `./plugins/repo-plugin`. The fake home contained `~/.agents/skills` and `~/.agents/plugins/marketplace.json`.

| Check | Result |
| --- | --- |
| `initialize.codexHome` | The empty `CODEX_HOME`, after it had been created. Codex refuses a `CODEX_HOME` that does not exist. |
| First app-server start | Wrote `skills/.system/` with the six bundled skills. |
| `skills/list` at `nested/` | `nested-skill`, `root-skill`, both `shared-name` copies, `user-skill`, six system skills. |
| `skills/list` at the repo root | The nested skill was gone. The root skill remained. |
| Personal marketplace before install | `plugin/list` showed `personal-plugin@probe-personal`, not installed. CLI `marketplace list` showed it with root = `$HOME`. |
| `codex plugin add` of the personal plugin | Cache at `$CODEX_HOME/plugins/cache/probe-personal/personal-plugin/local`, config `enabled = true`, skill visible as `personal-plugin:personal-skill`. |
| Repo marketplace before `marketplace add` | `plugin/list` with `cwds` saw `probe-repo`. CLI `plugin list` and `marketplace list`, including after `trust_level = "trusted"`, did not. |
| `plugin/install` of `repo-plugin` by marketplace path | Wrote `[plugins."repo-plugin@probe-repo"] enabled = true` and a cache directory. `plugin/installed` then listed both marketplaces. |
| `codex plugin marketplace add <repo>` | Wrote `[marketplaces.probe-repo] source_type = "local"`. CLI list then showed the repo plugin as installed. |
| `skills/config/write` on the user skill file | Persisted `[[skills.config]]` with the `SKILL.md` path and `enabled = false`. The following `skills/list` reported that skill disabled and left the others enabled. |

The real `~/.codex` was only read. `auth.json`, MCP env values, OAuth stores, and session logs were not printed.

## What the adapter does today

`createCodexProfileService` reports `sharedSurfaces: ['~/.agents/skills']`. That remains right for user skills, and it is silent about the personal marketplace, which is the other `$HOME` leak. It is also silent about system skills, which now do live under the profile home.

MCP tool items normalize in `normalization/tool.ts`. Elicitation is in the approval allow-list. `skills/changed` and the two MCP lifecycle notifications are ambient in `normalization/adapter.ts`. There is no extensions service yet. RFC 006 reserves `services/extensions.ts` and says the implementation should be protocol-native, with no store parsing. The probe agrees with that: `plugin/installed`, `skills/list`, and `codex mcp list --json` each returned servers or plugins that a scan of `[mcp_servers]` and `[plugins]` would have missed or mis-scoped.

## Sources

- Installed CLI help and the probes above, Codex CLI 0.156.1, 2026-09-24.
- `codex app-server generate-json-schema` with and without `--experimental`, same binary.
- [Plugins](https://learn.chatgpt.com/codex/plugins), [Build skills](https://learn.chatgpt.com/codex/build-skills), [Skills and plugins](https://learn.chatgpt.com/codex/skills-and-plugins), [Customization](https://learn.chatgpt.com/codex/customization/overview), [MCP](https://learn.chatgpt.com/codex/extend/mcp), [Package your plugin](https://developers.openai.com/plugins/build/plugins), [Config basics](https://learn.chatgpt.com/codex/config-file/config-basic), [Config reference](https://learn.chatgpt.com/codex/config-file/config-reference), [Environment variables](https://learn.chatgpt.com/codex/config-file/environment-variables), [App server](https://learn.chatgpt.com/codex/app-server), [Hooks](https://learn.chatgpt.com/codex/hooks), [Slash commands](https://learn.chatgpt.com/codex/reference/slash-commands), [Managed configuration](https://learn.chatgpt.com/codex/enterprise/managed-configuration), [Plugin management](https://learn.chatgpt.com/codex/enterprise/plugin-management), [Plugin controls](https://learn.chatgpt.com/codex/enterprise/apps-and-connectors), [Skill controls](https://learn.chatgpt.com/codex/enterprise/skills), [Import](https://learn.chatgpt.com/codex/import).
- Surface model `packages/surface/vendors/codex/model/codex@0.150.0`.
- RFC 006, "Codex shared skills and credentials".
