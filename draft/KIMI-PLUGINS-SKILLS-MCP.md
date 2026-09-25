# Kimi plugins, skills, and MCP

| Field | Value |
| --- | --- |
| Status | Research record. No adapter change. No Surface or support-ledger change. |
| Date | 2026-09-24 |
| Question | How Kimi Code installs and runs plugins, skills, and MCP servers, and what a Puppeteer profile can read without launching a second Kimi process. |
| Install probed | Kimi Code 2.0.2 at `~/.kimi-code/bin/kimi`. `kimi --help` has no `plugin` or `mcp` subcommand. That home had no `plugins/`, `skills/`, or `mcp.json`. |
| Source read | [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) `be7d5f5fea7800778e4660cd5f36780ba783bddd` (2026-09-24, docs synced from 2.1.1). The 2.0.2 binary embeds the same manager, skill catalog, and MCP loader described below. |
| Surface pin | `kimi@0.34.0`. That candidate is months behind this behavior. |
| Related | `draft/KIMI-ADAPTATION-PLAN.md`, `draft/KIMI-ACCOUNT-IDENTITY.md` |

## Recommendation

Treat plugins, skills, and MCP as files under the profile home plus the workspace, and as events on the session the user already launched. Read them. Do not install, enable, authorize, or probe them from Puppeteer.

For a profile whose `KIMI_CODE_HOME` is known:

1. Plugin install state is `$KIMI_CODE_HOME/plugins/installed.json` (`version: 1`). The `enabled` flag and `capabilities.mcpServers` are the toggles. The bytes Kimi executes live in `$KIMI_CODE_HOME/plugins/managed/<id>/`, which is a copy made at install time.
2. Kimi-specific user skills are `$KIMI_CODE_HOME/skills/`. They move with the profile. `~/.agents/skills/` does not. Project skills are `<git-root>/.kimi-code/skills/` and `<git-root>/.agents/skills/`.
3. MCP declarations merge three JSON files, then plugin manifests. Same runtime name: the file layer wins. Project files load only after the workspace is trusted.
4. There is no `kimi plugin` or `kimi mcp` command on 2.0.2 or on current `main`. Management is the TUI (`/plugins`, `/mcp`, `/mcp-config`) and the local server (`kimi web`). A verify step that calls `POST /api/v1/plugins` or `/api/v2/mcp/auth:*` mutates the home.
5. On the wire, a connected MCP server is the durable event `mcp.tools_discovered`. A skill or plugin-command invocation is recorded as the origin of the turn (`skill_activation` or `plugin_command`). The bus events `skill.activated` and `plugin_command.activated` are observable and are not marked durable. The 0.34.0 source contract's transient `skill.activate` is the older type name.

Re-census a chosen candidate newer than 0.34.0 before any of this becomes Surface evidence.

## How the three fit together

A skill is a Markdown file. Loading it inserts text into the conversation. It does not run a process.

A plugin is an installed directory with a manifest. While it is enabled it can contribute skills, custom agents, a session-start skill, system-prompt text, slash commands, hook commands, and MCP servers. Skills and slash commands are still text. Hooks and MCP servers are the parts that execute.

An MCP server is an external process or HTTP endpoint. Kimi is the client. Its tools sit beside `Read`, `Bash`, and `Grep`. A server can be declared in `mcp.json` or inside a plugin manifest. Those are two stores and one connection manager.

```text
$KIMI_CODE_HOME/plugins/installed.json
        │
        ▼
plugins/managed/<id>/kimi.plugin.json
        │
        ├── skills/            text, same SKILL.md format as loose skills
        ├── agents/            sub-agent files
        ├── commands/*.md      /<plugin-id>:<command>
        ├── hooks[]            commands, cwd = plugin root
        ├── systemPrompt*      text in the agent prompt
        └── mcpServers         stdio / http / sse
                │
                ▼
        runtime name plugin-<id>:<server>
                │
user mcp.json ──┼── git-root .mcp.json ── cwd .kimi-code/mcp.json
                │         (trusted workspace only for the two project files)
                ▼
        workspace connection manager
                │
                ▼
        tools named mcp__<server>__<tool>
```

`KIMI_CODE_HOME` moves config, sessions, credentials, `mcp.json`, `skills/`, and `plugins/` together. It does not move `~/.agents/skills/` or anything inside a repository. Two profiles that open the same repo share project skills and project MCP. They do not share installed plugins.

## Plugins

### Install record

`PluginManager` reads and writes `$KIMI_CODE_HOME/plugins/installed.json` through a temp file and `rename`. A missing file is an empty catalog. A file whose `plugins` field is not an array throws `PLUGIN_LOAD_FAILED` rather than being treated as empty.

Each record:

| Field | Meaning |
| --- | --- |
| `id` | Manifest `name`, lowercased. Pattern `[a-z0-9][a-z0-9_-]{0,63}`. |
| `root` | Absolute path of the managed copy. |
| `source` | `local-path`, `zip-url`, or `github`. |
| `enabled` | Whole plugin. First install defaults to true. Reinstall keeps the previous value. |
| `installedAt`, `updatedAt` | ISO timestamps. |
| `originalSource` | The path or URL the user gave. |
| `capabilities.mcpServers.<name>.enabled` | Per-server toggle. Absent means the manifest's own `enabled` flag, which defaults to on. |
| `github` | `owner`, `repo`, `ref` (`branch` / `tag` / `sha`), optional `installedSha`. |

`remove` deletes the record and leaves `plugins/managed/<id>/` and the original source on disk. The published plugins page says the same thing. A later `/plugins reload` will not resurrect a plugin that is gone from `installed.json`.

Install always copies the source tree to `plugins/managed/<id>/` and then parses that copy. Editing the directory the user pointed at does nothing until they install again. The copy is staged in a sibling temp directory, the previous managed root is renamed aside, and a failed install tries to put the previous root back.

### Manifest

Either of these files, with `kimi.plugin.json` winning when both exist:

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

Paths inside the manifest (`skills`, `agents`, `commands`, `systemPromptPath`, stdio `command` that starts with `./`, stdio `cwd`) must start with `./`. After `realpath`, the target has to stay inside the plugin root. A path that escapes is a warning diagnostic and that entry is dropped. A stdio `command` that contains a slash and does not start with `./` is dropped the same way. A command that is a bare `PATH` name is allowed.

`tools`, `apps`, `inject`, `configFile`, `config_file`, and `bootstrap` are recorded as informational diagnostics and ignored. Those fields belong to the older `kimi-cli` plugin shape (`plugin.json` plus executable tools). Kimi Code does not run them.

Other fields the parser keeps:

| Field | Effect while the plugin is enabled |
| --- | --- |
| `skills` | Directories to scan. Omitted, and a root `SKILL.md` exists: that one file is the skill, and sibling Markdown such as `CHANGELOG.md` is not. An explicit `"./"` scans the directory. |
| `agents` | Agent-file directories. Omitted, and `agents/` exists: that directory is used. |
| `sessionStart.skill` | On a new or resumed session, that plugin skill's text is loaded into the main agent. It does not execute code. |
| `skillInstructions` | Extra text wrapped around every skill from this plugin when the prompt is rendered. |
| `systemPrompt`, `systemPromptPath` | Inline text, then file text. Each field is dropped above 32 KB UTF-8. The file is read at install or `/plugins reload`. |
| `mcpServers` | Same schema as `mcp.json`. |
| `hooks` | Same fields as a `[[hooks]]` rule: `event`, `matcher`, `command`, `timeout`. |
| `commands` | `./` directories or `.md` files. Each Markdown file becomes `/<plugin-id>:<command>`. |
| `interface` | Labels in `/plugins`: `displayName`, `shortDescription`, `longDescription`, `developerName`, `websiteURL`. |

The published page also states a 64 KB cap on the combined system-prompt text injected from all enabled plugins in one prompt build. The manifest parser's constant is the 32 KB per-field limit. A 64 KB constant is not in the plugin package.

Custom agent templates that own their own prompt need `${plugin_sections}` if they want this text. A template that already expands `${base_prompt}` from a default that includes the block should not add it twice. Plugin agents lose name collisions to user, extra, project, and `--agent-file` agents. Replacing a built-in agent still needs `override: true` in that agent file.

### Marketplace and official bundles

Default catalog URL, also what 2.0.2 builds from its CDN base:

```text
${cdnBase}/plugins/marketplace.json
```

The source constant is `https://code.kimi.com/kimi-code/plugins/marketplace.json`. `KIMI_CODE_PLUGIN_MARKETPLACE_URL` replaces it. The `version` field is stored as a string and is not checked against `1` or `2`. The copy in the repo is `"version": "1"`. The docs example uses `"2"`. Both parse. Each entry needs an `id` and a `source`. `tier` is `official` or `curated`.

Repo catalog at this commit:

| id | tier | version | source |
| --- | --- | --- | --- |
| `kimi-datasource` | official | 3.4.0 | `./official/kimi-datasource` |
| `kimi-webbridge` | official | 2.0.11 | `./official/kimi-webbridge` |
| `superpowers` | curated | from GitHub releases when the entry omits one | `https://github.com/obra/superpowers` |
| `vercel-plugin` | curated | same | `https://github.com/vercel/vercel-plugin` |
| `modern-web-guidance` | curated | same | `https://github.com/GoogleChrome/modern-web-guidance` |
| `cloudbase` | curated | 0.2.0 | GitHub release asset `cloudbase-kimi.zip` |

GitHub installs accept the four URL shapes on the plugins page (repo, `/tree/<ref>`, `/releases/tag/<tag>`, `/commit/<sha>`). Latest-release lookup is the redirect from `https://github.com/<owner>/<repo>/releases/latest`, then a zip from `codeload.github.com`. A commit SHA is taken from the first 4 KB of the GitHub Atom feed. `api.github.com` is not called. Update checks compare semver when both sides are valid semver.

`kimi-datasource` declares one stdio server, `data`, with `command: "node"` and `args: ["./bin/kimi-datasource.mjs"]`. On the native `kimi` binary, a plugin stdio server whose command is `node` is rewritten to the `kimi` executable plus the hidden subcommand `__plugin_run_node`, with `cwd` defaulting to the plugin root and `KIMI_CODE_HOME` plus `KIMI_PLUGIN_ROOT` in the environment. Electron uses `ELECTRON_RUN_AS_NODE` instead. The server's runtime name is `plugin-kimi-datasource:data`. Queries bill the Kimi Code account. The plugin is read-only against those data vendors.

`kimi-webbridge` ships skills and no MCP server in its manifest. The browser extension is a separate install (Chrome Web Store, Edge Add-ons, or an unpacked zip). The skill talks to a local daemon, default `http://127.0.0.1:10086`.

Kimi Computer Use is documented as a third official plugin. It is not a row in `plugins/marketplace.json`. The local server adds a capability row for `kimi-cu` / `kimi-cu-win` when the platform supports it and the catalog omitted it. The Windows package documented on the plugins page is `https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip`. macOS asks for Accessibility and Screen Recording. The plugins page tells users not to hand it payments, account changes, or publishing.

### Hooks and slash commands

Plugin hooks are active only while the plugin is enabled. Install does not run them. Each hook's working directory is the plugin root, and the process receives `KIMI_CODE_HOME` and `KIMI_PLUGIN_ROOT`. Exit codes follow the global hook rules.

A command file is optional frontmatter plus a prompt body. The command name defaults to the path under the `commands` directory, without `.md`, with `/` separators. Frontmatter `name` wins. The slash form is `/<plugin-id>:<command> [args]`. `$ARGUMENTS` expands; if the body has no placeholder, the typed tail is appended as `ARGUMENTS: ...`.

## Skills

### File shape

Two layouts in a scan root:

```text
skills/
├── review-pr/SKILL.md     # name comes from frontmatter
└── commit.md              # name falls back to the filename
```

Directory form requires `name` and `description`. Flat form may omit both: `name` becomes the filename without `.md`, and `description` becomes the first non-empty body line, cut at 240 characters. When `<name>/SKILL.md` and `<name>.md` share a directory, the directory wins. Loose `.md` files inside a subdirectory are not skills. Scan depth stops at 8.

| Frontmatter | Behavior |
| --- | --- |
| `type` | `prompt` (default), `inline` (same as `prompt`), `flow` (slash only), `reference` (kept, not user-activatable). Anything else is skipped. |
| `whenToUse` | Also `when-to-use` and `when_to_use`. Shown to the model next to the description. |
| `disableModelInvocation` | Also hyphen and underscore spellings. The `Skill` tool rejects the skill. Slash invocation still works. |
| `arguments` | String array or whitespace-separated string. Body placeholders `$<name>`, `$ARGUMENTS`, `$ARGUMENTS[n]`, `$0`, `$1`. Quotes group a token. No placeholder in the body: the raw tail is appended as `ARGUMENTS: ...`. |
| `${KIMI_SKILL_DIR}` | Directory of the skill file. For a flat skill that is the scan root itself. |
| `${KIMI_SESSION_ID}` | Expanded at render time. |

Names are case-insensitive.

### Where they are found, and who wins

Priority numbers in `SKILL_SOURCE_PRIORITY`, low to high. The catalog registers with replace, so the higher number keeps the name:

| Priority | Source | Roots |
| --- | --- | --- |
| 0 | built-in | shipped with the CLI |
| 5 | plugin | enabled plugins' skill dirs. The skill object is tagged `source: "extra"` and also carries `plugin.id`. |
| 10 | extra | `extra_skill_dirs` in `config.toml` |
| 20 | user, and `--skills-dir` | `$KIMI_CODE_HOME/skills/`, then `~/.agents/skills/` under the real OS home |
| 30 | workspace | `<git-root>/.kimi-code/skills/`, then `<git-root>/.agents/skills/` |

Project root is the nearest parent with `.git`, else the working directory. `~` and `~/` in `extra_skill_dirs` expand against the OS home. A relative extra dir resolves from the project root.

`--skills-dir` (repeatable) makes the user and workspace sources return nothing for that process and loads the given directories at user priority. It does not clear built-ins, plugins, or `extra_skill_dirs`.

`merge_all_available_skills` defaults to true. Each brand group currently has one directory, so the flag does not drop a second brand path today. `~/.agents/skills/` is a separate generic root and is still scanned.

`builtin_product_skills` (default true) and `KIMI_CODE_BUILTIN_PRODUCT_SKILLS` hide the built-ins marked product-specific. The env var wins over the file when it parses as a boolean. There is no `disabled_skills` key in this tree. An open issue proposes one. It is not implemented here.

The model listing groups skills as Project, User, Extra, Built-in. Plugin skills show up under Extra because that is the `source` tag. A same-named project or user skill hides the plugin skill from `getSkill`, and `getPluginSkill(pluginId, name)` can still see it. `skillInstructions` are wrapped in `<plugin-instructions plugin="...">` only for the plugin copy that was actually rendered.

Built-in product skills, all with model invocation disabled:

| Slash | Role |
| --- | --- |
| `/mcp-config` | Add, edit, delete, and OAuth-login MCP servers. User-invocable only, so another skill must not call it through the `Skill` tool. |
| `/import-from-cc-codex` | Copy instructions, skills, and MCP declarations from Claude Code and Codex into Kimi paths. It refuses `.agents` content, Claude custom commands, credentials, sessions, hooks, and plugins. It does not write `mcp.json` itself; it prepares entries for `/mcp-config`. |
| `/update-config` | Edit `config.toml` and `tui.toml`. |
| `/custom-theme` | Write a theme under the Kimi home. |
| `/check-kimi-code-docs` | Answer product questions from the official docs. |
| `/write-goal` | Goal-mode helper. Not marked product-specific, so `builtin_product_skills = false` leaves it. |
| `/sub-skill`, `/sub-skill.review`, `/sub-skill.consolidate` | Reorganize a local skill tree. Not product-specific. |

Built-ins appear as `/<name>` with no `skill:` prefix. External skills are `/skill:<name>` and also `/<name>` when that name is not a system command. Sub-skills use `/<parent>.<child>`. `flow` skills use `/skill:<name>`. There is no `/flow:` namespace in the current slash-command page. The Help Center page that still says `~/.config/agents/skills/` and `/flow:<name>` describes an older layout.

### Invocation

User slash activation submits a turn whose origin is:

```text
kind: skill_activation
trigger: user-slash
skillName, skillArgs, skillType, skillPath, skillSource, activationId
```

The model calls the built-in `Skill` tool with `{ skill, args }`. That path accepts `prompt` and `inline` only, refuses `disableModelInvocation`, and stops at depth 3 (`MAX_SKILL_QUERY_DEPTH`). Nested activation uses trigger `nested-skill`. `sessionStart.skill` is the third loader and is text only.

User and project skill directories are watched, with a 200 ms debounce. Plugin skills refresh when the plugin service emits reload, which install, enable, disable, remove, MCP toggles, and `/plugins reload` all do.

## MCP

### Three files, then plugins

`resolveMcpJsonPaths`:

| Key | Path | When it loads |
| --- | --- | --- |
| user | `$KIMI_CODE_HOME/mcp.json` | Always |
| projectRoot | `<git-root>/.mcp.json` | Workspace is trusted. Relative stdio `cwd` resolves from the git root. |
| project | `<cwd>/.kimi-code/mcp.json` | Workspace is trusted. This is the working directory, not every nested project root. |

Merge is in that order. A later file replaces an earlier entry of the same name. An untrusted workspace keeps the user file and the plugin servers, and skips both project files. The trust prompt lists each project server's transport and launch target. The default choice is to trust the folder.

The published MCP page describes the user file and `.kimi-code/mcp.json`. The Claude-compatible `<git-root>/.mcp.json` layer is in the loader and in the 2.0.2 binary. The import skill is written to leave that file alone because Kimi already reads it.

A missing file, or a file with no `mcpServers` object, contributes nothing. Invalid JSON throws `CONFIG_INVALID`.

Plugin servers are merged underneath the file map:

```text
{ ...pluginServers, ...fileServers }
```

A file entry with the same runtime name shadows the plugin entry. Plugin runtime names are `plugin-<pluginId>:<serverName>`, so a normal user server name does not collide. The v2 management API says a user-level write is rejected when it collides with a project-layer entry, and is allowed when it only collides with a plugin entry.

### Server shape

`transport` may be omitted. A `command` becomes `stdio`. A `url` becomes `http`. SSE requires `transport: "sse"`.

| Field | Use |
| --- | --- |
| `command`, `args`, `env`, `cwd` | stdio |
| `executor` | `local` or `kaos` |
| `runtime_id` | stdio runtime |
| `url`, `headers`, `bearerTokenEnvVar` | http and sse |
| `auth` | `oauth` on http and sse |
| `enabled` | `false` keeps the entry and does not connect |
| `deferred` | experimental on-demand tools |
| `startupTimeoutMs`, `toolTimeoutMs` | integers from 1 to 2147483647. Default startup is 30000 ms. |
| `enabledTools`, `disabledTools` | allow and block lists |

Global defaults: `[mcp] startup_timeout_ms` and `[mcp] tool_timeout_ms` in `config.toml`, or `KIMI_MCP_STARTUP_TIMEOUT_MS` and `KIMI_MCP_TOOL_TIMEOUT_MS`. Per-server field, then environment, then `config.toml`, then the built-in default.

Deferred tools need `tool-select` (`KIMI_CODE_EXPERIMENTAL_TOOL_SELECT=1`, or `[experimental] tool-select = true`, or the master experimental flag) and a model that declares `dynamically_loaded_tools`. Otherwise `deferred` is ignored and the tools are listed inline. The model then sees a manifest and loads definitions through `select_tools`.

### Names, permissions, results

The model-facing tool name is `mcp__<server>__<tool>`. Each part is sanitized to `[A-Za-z0-9_-]`, so the colon in `plugin-kimi-datasource:data` becomes an underscore: `mcp__plugin-kimi-datasource_data__<tool>`. Names longer than 64 characters are cut and suffixed with `_` plus an 8-hex FNV-1a-style hash. Collisions are recorded on `mcp.tools_discovered` as `same_server` or `other_server`.

Permission patterns use `*` and `**`. `mcp__github__*` matches that server. Parameters are not part of the match. In Ask When Needed mode the MCP page says MCP calls are auto-approved.

Tool results keep text `content` and `structuredContent`. The structured copy is omitted only when a text block is already that same JSON value. Embedded images, audio, and video are saved into the session's media store with `kimi-file://` references even when they could have been delivered inline. Resource links are not downloaded automatically.

### OAuth

HTTP and SSE servers use static `headers` or `bearerTokenEnvVar`, or browser OAuth. The TUI command is `/mcp-config login <server-name>`. Tokens are stored through the atomic document store at scope `credentials/mcp`. The data-locations page shows that as `$KIMI_CODE_HOME/credentials/mcp/<key>-<suffix>.json`, mode 0600 under a 0700 directory. The store key is the sanitized server name, a dash, and 24 hex chars of SHA-256 over the server name, a NUL, and the canonical URL.

`kimi mcp auth` and `kimi mcp reset-auth` are the old `kimi-cli` commands. They are not registered in current `apps/kimi-code/src/cli/commands.ts`, and 2.0.2's `--help` does not list them.

### What an open session actually connects

The workspace owns one `McpConnectionManager`. A normal session uses that manager. A session created with ephemeral servers gets an overlay manager; overlay names hide the workspace entry of the same name.

On startup the manager connects every enabled server. After the session handle is ready, `isBaselineServer` freezes the set of names that existed then. The agent registers tools only for names inside that set.

| Change | Connection manager | Agent tools in a session that is already ready |
| --- | --- | --- |
| Delete a server that was in the baseline | Status becomes `removed`. The process is closed. The entry stays. | Tools stay listed. Calls fail with a removal notice. |
| Disable (`enabled: false`) a baseline server | Status `disabled`, tools cleared on the manager. | The agent unregisters the tools. |
| Edit or re-enable a baseline name | `connect` replaces the client. | Tools are registered again. |
| Add a file server, install a plugin, or enable a plugin server the session has never seen | The manager connects it. | `isBaselineServer` is false, so this session does not register the tools. A new session does. |

File watches and plugin reloads both feed that path, with a 200 ms debounce on the JSON files. Plugin install, enable, disable, remove, and per-server toggles emit `onDidReload` before the MCP config service republishes.

That is why the plugins page can say "run `/reload` or `/new` before the current session updates" and the MCP page can say "disabling a plugin server fails calls in open sessions" at the same time. Disable of a server the session already knew is live. First appearance of a server is the next session. `/reload` rebuilds the session from config. `/plugins reload` re-reads manifests and refreshes the skill catalog immediately. On the v2 engine a later prompt rebuild can also pick up new plugin system-prompt sections without a new session. Toggling a plugin MCP server does not change those prompt sections.

Statuses the manager uses: `pending`, `connected`, `failed`, `disabled`, `needs-auth`, `removed`.

## Control surfaces

### TUI

`/plugins` is a four-tab panel: Installed, Official, Curated, Custom.

| Key or command | Action |
| --- | --- |
| Space / `D` / `M` / `R` / `I` | Enable or disable, remove, MCP toggles, reload `installed.json`, details |
| `/plugins install <path-or-url>` | Local directory, zip URL, or GitHub URL |
| `/plugins marketplace [source]` | Default catalog, or another JSON path or URL |
| `/plugins enable\|disable\|remove\|info\|list\|reload` | Record mutations |
| `/plugins mcp enable\|disable <id> <server>` | `capabilities.mcpServers` |
| `/mcp` | Connection status for the current session |
| `/mcp-config` | Built-in skill that edits the user-level file and runs OAuth |

### CLI

Public commands on 2.0.2 and on current `commands.ts` do not include `mcp` or `plugin`. The flags that do exist are `--skills-dir` and `--agent-file`. `__plugin_run_node` is a hidden subcommand used to execute plugin `node` programs inside the native binary.

`kimi doctor` validates `config.toml` and `tui.toml`. It does not validate `mcp.json` or plugin manifests.

### Local server

`kimi web` exposes the management plane. These routes are in the server API page and in `packages/kap-server`:

| Route | Effect |
| --- | --- |
| `GET /api/v1/plugins` | Installed summaries |
| `POST /api/v1/plugins` | Install from a path or URL |
| `GET /api/v1/plugins/marketplace` | Catalog merged with install state and update flags |
| `POST /api/v1/plugins/{id}:enable\|disable\|remove` | Mutates `installed.json` |
| `GET /api/v1/sessions/{session_id}/skills` | Skills visible to an activated session |
| `GET /api/v1/workspaces/{workspace_id}/skills` | Workspace catalog without a session |
| `POST /api/v1/sessions/{session_id}/skills/{name}:activate` | Starts a turn. The tail must be `{name}:activate`. |
| `GET /api/v1/mcp/servers` | Servers of the effective agent |
| `POST /api/v1/mcp/servers/{id}:restart` | Reconnect one server |
| `GET\|POST\|PUT\|DELETE /api/v2/mcp/servers` | User-level `mcp.json` CRUD. Plugin and project entries are read-only. Read-only configs come back redacted (`envKeys`, `headerKeys`). |
| `POST /api/v2/mcp/servers:test` | Real connection probe. Writes nothing. |
| `POST /api/v2/mcp/servers:inspect` | Locator catalog plus an OAuth probe. A probe can refresh or invalidate stored credentials. |
| `POST /api/v2/mcp/auth:begin\|complete\|cancel\|reset` | Browser OAuth against a locator `{ source: "global", name }` or `{ source: "plugin", pluginId, serverName }` |

Optional `cwd` pulls in the project layers when that workspace is trusted. Wire ids are `global:<name>` and `plugin:<pluginId>:<serverName>`.

Puppeteer should not call the mutating routes to discover state. `GET` of plugins, skills, and `/api/v2/mcp/servers` is read-only. `servers:inspect` and `auth-statuses?verify=true` are not: they open connections and can rewrite OAuth files.

## What the session journal records

From current agent-core-v2, confirmed as strings inside the 2.0.2 binary:

| Event | Durable? | Payload that matters |
| --- | --- | --- |
| `mcp.tools_discovered` | yes | `serverName`, `hash`, `tools`, `enabledNames`, optional `collisions` |
| `skill.activated` | observable, not marked durable | `activationId`, `skillName`, `skillArgs`, `trigger` (`user-slash`, `model-tool`, `nested-skill`), `skillPath`, `skillSource` |
| `plugin_command.activated` | observable, not marked durable | `activationId`, `pluginId`, `commandName`, `commandArgs`, `trigger: user-slash` |

The turn itself carries the durable origin. `turn.prompt` / `turn.steer` meta `origin.kind` is `skill_activation` or `plugin_command`, with the ids above. A prompt that bundles several skills uses `origin.kind: "user"` plus `skillActivations`. The 0.34.0 Surface model already has those two origin kinds on `turn.prompt`. Its transient operation list still says `skill.activate`, owned by `src/agent/skill/skillOps.ts`. Current source names that event `skill.activated` and lives under `packages/agent-core-v2/src/features/skill/skillOps.ts`.

The Kimi adapter already classifies tool names that start with `mcp__` or `mcp_` as MCP tools. It does not read `installed.json`, skill roots, or `mcp.json`.

## Places the published pages and the loader disagree

These are worth knowing before copying a docs sentence into an adapter:

- The MCP page's configuration section names two files. The loader reads three, and the third is `<git-root>/.mcp.json`.
- The MCP page says a server added mid-session by editing `mcp.json` or installing a plugin joins only later sessions, and also says enabling a plugin server connects it in open sessions immediately. The code does both, split by whether the runtime name was already in the session baseline.
- The plugins page says the current session does not update until `/reload` or `/new`. The v2 skill catalog updates on plugin reload without that. System-prompt sections can arrive on a later prompt rebuild. MCP tools follow the baseline rule above.
- The plugins page's custom marketplace example uses `"version": "2"`. The parser accepts any string. The repo file is `"version": "1"`.
- `kimi --help` on 2.0.2 prints `https://moonshotai.github.io/kimi-code/`. The product docs used for this note are the repo's `docs/en/**` pages, which `www.kimi.com/code/docs` publishes. The Help Center skill article still describes `~/.config/agents/skills/` and `/flow:`.
- `kimi mcp` in older Moonshot docs is `kimi-cli`, with `~/.kimi/mcp.json` and `--mcp-config`. Kimi Code 2.x uses `$KIMI_CODE_HOME/mcp.json` and slash commands.

## Sources

Source commit `be7d5f5fea7800778e4660cd5f36780ba783bddd`:

- `docs/en/customization/plugins.md`, `skills.md`, `mcp.md`
- `docs/en/configuration/data-locations.md`, `config-files.md`, `env-vars.md`, `overrides.md`
- `docs/en/reference/slash-commands.md`, `server-api.md`, `tools.md`
- `packages/agent-core-v2/src/app/plugin/manager.ts`, `store.ts`, `manifest.ts`, `marketplace.ts`, `github-resolver.ts`, `types.ts`
- `packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts`, `skillSource.ts`, `registry.ts`, `fileSkillDiscovery.ts`, `builtin/builtin.ts`
- `packages/agent-core-v2/src/features/skill/skillOps.ts`, `skillService.ts`, `tools/skill.ts`
- `packages/agent-core-v2/src/mcpCore/config-schema.ts`, `tool-naming.ts`, `connection-manager.ts`
- `packages/agent-core-v2/src/app/mcpConfig/configLoader.ts`, `oauthStore.ts`
- `packages/agent-core-v2/src/workspace/workspaceMcp/workspaceMcpService.ts`
- `packages/agent-core-v2/src/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`
- `packages/agent-core-v2/src/agent/mcp/mcpService.ts`, `mcpDiscoveryOps.ts`
- `packages/agent-core-v2/src/agent/pluginCommand/pluginCommand.ts`
- `packages/kap-server/src/routes/plugins.ts`, `skills.ts`, `v2/mcp.ts`
- `plugins/marketplace.json`, `plugins/official/kimi-datasource/kimi.plugin.json`, `plugins/official/kimi-webbridge/kimi.plugin.json`

Published pages:

- [Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
- [Agent Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)
- [Model Context Protocol](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)
- [Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)

Local check, 2026-09-24: `~/.kimi-code/bin/kimi` version 2.0.2. `strings` on that binary contains `pluginMcpRuntimeName`, `skill.activated`, `mcp.tools_discovered`, `isBaselineServer`, `credentials/mcp`, `installed.json`, `__plugin_run_node`, and `kimiCodePluginMarketplaceUrl`. No token or credential file was read for this note.
