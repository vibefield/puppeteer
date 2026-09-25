# Claude Code plugins, skills, and MCP

| Field       | Value                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Status      | Research record. No adapter change. Not a Surface claim and not a support-ledger change.                                             |
| Date        | 2026-09-24                                                                                                                            |
| Question    | How Claude Code discovers, installs, enables, and loads plugins, skills, and MCP servers, and which of that a profile root isolates. |
| Install     | Claude Code 2.1.282, native arm64 Mach-O at `~/.local/bin/claude`. Probed on this machine the same day.                              |
| Docs        | [code.claude.com/docs](https://code.claude.com/docs/en/overview.md), index last generated 2026-09-25 03:24 UTC. Pages cited below.   |
| Related     | `packages/adapter-claude/src/services/profiles.ts`, [research-multiagentsubs.md](research-multiagentsubs.md)                          |

Claude Code has three extension mechanisms that meet in one session. A skill is a `SKILL.md` instruction file. An MCP server is a tool connection. A plugin is a directory that packages skills, subagents, hooks, MCP servers, and a few other component types, usually fetched from a marketplace catalog. Each has its own files, its own enablement record, and its own precedence. They are not three views of one registry.

Puppeteer already binds a Claude profile by launching the same `claude` binary with `CLAUDE_CONFIG_DIR` set to a persistent root (`packages/adapter-claude/src/services/profiles.ts`). That root is the user-scope boundary for all three mechanisms. Repository files, managed policy, and flags passed on a single launch sit outside it.

## What one session loads

At startup Claude Code assembles the session from several roots. A later edit to settings or to the plugin cache reaches the running session when `/reload-plugins` runs, or on the next launch. `claude plugin update` ends by telling you to restart.

| Piece                         | Where it comes from                                                                                          | When it enters the conversation                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Personal and project skills   | `~/.claude/skills/`, `.claude/skills/`, parent directories up to the repo root, `--add-dir`                 | Name and description on every turn. Full body when invoked.                                     |
| Plugin skills, agents, hooks  | Enabled plugins, loaded from the cache or in place                                                          | Same as standalone skills, namespaced as `/plugin-name:skill-name`. Hooks fire on their events. |
| MCP tools                     | User, local, and project config, plugin `.mcp.json`, claude.ai connectors, managed policy, `--mcp-config`   | Server connects at startup. With tool search on, tool schemas load when a tool is needed.      |
| Always-on instructions        | `CLAUDE.md`, `.claude/rules/`                                                                                | Full text every turn. Separate from skills.                                                    |

Context cost follows that split. Skill and agent descriptions are in the prompt even when nothing from that plugin runs. The body loads on use and then stays for the conversation. Hooks add nothing unless they return text. MCP tool search is on by default, so an idle server contributes tool names rather than every JSON schema. A custom `ANTHROPIC_BASE_URL` turns tool search off unless `ENABLE_TOOL_SEARCH=true`. Official-marketplace plugins can show a **Context cost** estimate before install. `claude plugin details <name>` prints the same kind of footprint after install.

Two launch modes strip the set down:

- `--safe-mode` (`CLAUDE_CODE_SAFE_MODE=1`) starts with customizations disabled: `CLAUDE.md`, skills, installed plugins, hooks, MCP servers, custom commands and agents, output styles, workflows, themes, and keybindings. Managed policy still applies. Built-in tools and bundled skills stay.
- `--bare` (`CLAUDE_CODE_SIMPLE=1`) skips settings hooks, plugin hooks, LSP, plugin sync, auto-memory, and `CLAUDE.md` discovery. Skills still resolve through `/skill-name`. MCP and plugins come only from the flags you pass: `--mcp-config`, `--plugin-dir`, `--settings`, `--agents`.

`--strict-mcp-config` keeps only the servers in `--mcp-config`. `--setting-sources user,project,local` chooses which settings files load. `--restricted` ignores user, project, and local settings; managed settings and `--settings` still apply.

## Plugins

A plugin is one directory of components, installed and enabled as one unit. The manifest is `.claude-plugin/plugin.json`. It is optional: with it omitted, Claude Code discovers components from the default layout. The manifest's `name` is what components are namespaced under. A marketplace entry can use a different name, and that entry name is the install key.

```text
my-plugin/
├── .claude-plugin/plugin.json
├── skills/<name>/SKILL.md
├── commands/<name>.md          # older single-file skills
├── agents/<name>.md
├── hooks/hooks.json
├── .mcp.json
└── package.json + lockfile     # optional; installed into the cache copy
```

Commands and skills are the same mechanism. New plugins use `skills/`. A `commands/*.md` file still creates a slash command. A folder under a skills directory that itself contains `.claude-plugin/plugin.json` loads as a plugin named `<name>@skills-dir`, in place, with no marketplace install. `claude plugin init <name>` scaffolds that under `~/.claude/skills/<name>/`.

Other component types the manifest and component docs allow include LSP servers, output styles, themes, background monitors, and a `userConfig` schema. `claude plugin install --config key=value` writes those options the same way `/plugin` **Configure** does. Component paths that resolve outside the plugin directory are rejected, including `../` and a symlink that leaves the plugin. On macOS and Linux a path containing a backslash is rejected even when it stays inside the directory.

### Marketplace, then install, then enable

A marketplace is a catalog: a git repository, a local directory, or a hosted JSON file containing `.claude-plugin/marketplace.json`. It is not the website at claude.com/marketplace. You add the catalog once, then install plugins by `<name>@<marketplace>`.

Claude Code adds `claude-plugins-official` the first time an interactive terminal session starts, unless managed policy blocks it. It does not add Anthropic's community or demo marketplaces on its own. The official and community marketplace names are accepted only when the source is a `github.com/anthropics/` repository. Every other catalog is third-party. Whatever the tier, an installed plugin runs as the user.

Add sources, from `/plugin marketplace add` or `claude plugin marketplace add`:

| Source              | Form                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| GitHub              | `owner/repo`, optional `#ref`                                        |
| Any git host        | Clone URL, optional `#ref`. A bare host/path is read as GitHub.     |
| Local               | `./` or `../` path to a directory or to `marketplace.json`           |
| Hosted catalog      | `https://` URL of `marketplace.json`                                 |
| claude.ai library   | `claude plugin marketplace add --claudeai <name>`, v2.1.273 or later |

`owner/repo` clones over SSH when a key authenticates to github.com, otherwise over HTTPS. `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` forces HTTPS. Private clones use the git credentials already on the machine and do not prompt.

Install scopes write `enabledPlugins` in different files:

| Scope   | Who it is for                          | File                         |
| ------- | -------------------------------------- | ---------------------------- |
| `user`  | You, every project on this machine     | `~/.claude/settings.json`    |
| `project` | Everyone who clones the repository   | `.claude/settings.json`      |
| `local` | You, this repository only              | `.claude/settings.local.json` |

`claude plugin install` defaults to user scope. Inside a session, `/plugin install <name>@<marketplace>` opens the details pane so you can review components and pick a scope. The shell command installs immediately. A marketplace `command` source shows the command and waits for acceptance; a script passes `--yes` or `--accept-command <sha256>`.

`enabledPlugins` merges key by key. For each plugin id, the highest source that mentions it wins:

| Precedence | Source                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Highest    | Managed settings. `true` force-enables. `false` blocks.               |
|            | `--settings` for this launch                                           |
|            | `.claude/settings.local.json`                                          |
|            | `.claude/settings.json`                                                |
|            | `~/.claude/settings.json`                                              |
| Lowest     | `.claude/settings.json` in a directory passed with `--add-dir`. Only `true` has an effect. |

A plugin enabled only in the committed project file is not fetched onto a machine that has never installed it, unless the marketplace entry is a relative path or a seed directory already holds it. The session then reports that the plugin is enabled in project settings and is not installed here. Relative-path plugins load from the marketplace checkout and need no install record.

`defaultEnabled: false` in the manifest installs the plugin and leaves it off until `claude plugin enable`.

When the same manifest name is enabled from more than one origin, load order is: a managed `enabledPlugins` id, then a session `--plugin-dir` / `--plugin-url` / `CLAUDE_CODE_PLUGIN_DIRS` plugin, then an installed marketplace plugin, then a skills-directory plugin (the copy under `~/.claude/skills/` wins over the project's), then a claude.ai synced plugin. A session-only plugin replaces a same-named marketplace plugin silently. `claude plugin list` still shows the marketplace row as enabled, because that row is the settings record. `"<name>@inline": false` keeps the session copy from loading.

### Three stages, and the files under `~/.claude/plugins`

An enabled plugin passes through three stages. Settings declare it. Disk holds the fetch. The running session loaded whatever was current at startup or at the last `/reload-plugins`.

| Path, under the plugins root                         | What it holds                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `installed_plugins.json`                              | Install records: scope, install path, version, timestamps                     |
| `known_marketplaces.json`                             | Fetched marketplaces: source, install location, last updated, auto-update    |
| `known_marketplaces_claudeai.json`                    | Marketplaces added from claude.ai                                             |
| `cache/<marketplace>/<entry-name>/<version>/`        | Copied plugin files. `${CLAUDE_PLUGIN_ROOT}` points here.                     |
| `data/<plugin-id>/`                                   | Persistent data, `${CLAUDE_PLUGIN_DATA}`. Survives updates. Removed on uninstall from the last scope unless `--keep-data`. |
| `marketplaces/<name>/`                                | Clone of a git or URL marketplace. A local file or directory source is not copied. |
| `synced/`                                             | Plugins downloaded from the claude.ai account. No install record.            |
| `.trash/`                                             | Synced plugins removed by a later sync                                        |
| `flagged-plugins.json`                                | Plugins uninstalled because their marketplace delisted them                  |

The plugins root is `~/.claude/plugins` unless `CLAUDE_CODE_PLUGIN_CACHE_DIR` is set. That variable replaces the whole root, including marketplaces, not only `cache/`.

Plugins load at session start from `installed_plugins.json` and the cache, without a network round trip. After startup, Claude Code refreshes declared marketplaces in the background. A marketplace that settings name and `known_marketplaces.json` lacks is cloned, and missing enabled plugins are downloaded. A source change shows `Plugins changed. Run /reload-plugins to activate.`

Some plugins are never copied:

- `--plugin-dir` and skills-directory plugins load in place. A `.zip` or `--plugin-url` archive is extracted into a session temp directory.
- A relative path inside a marketplace that was added from a local directory loads in place. Edits apply at the next session or `/reload-plugins` without a version bump.
- A `command` source in link mode loads the directory the command printed, through links in the cache entry.

Everything else is copied into `cache/<marketplace>/<plugin>/<version>/` at install. Files outside the plugin directory are not copied.

When the copy contains both `package.json` and a supported lockfile, Claude Code installs Node dependencies inside that version directory: `bun install --frozen-lockfile --ignore-scripts` for `bun.lock` or `bun.lockb`, otherwise `npm ci --ignore-scripts` for `npm-shrinkwrap.json` or `package-lock.json`. Yarn and pnpm lockfiles are skipped. The install is frozen, ignores lifecycle scripts, and times out at 60 seconds. Failure does not block the plugin. There is no setting that turns the install off. Relative-path plugins that load in place do not get this install.

### Versions and updates

Claude Code computes a version and uses it as the cache directory name and as the update check. `claude plugin update` and background auto-update skip a plugin whose computed version still matches `installed_plugins.json`.

For every marketplace source type except `command`:

1. `version` in the plugin manifest
2. `version` on the marketplace entry
3. Otherwise a source digest: 12-character commit SHA for git, URL, and git-subdir sources; 12-character SHA-256 for an archive; `unknown` for a local directory that is not a git repo and for npm

A manifest that pins `"version": "1.0.0"` stays on that cached copy until the string changes, however many commits land on the branch. Leaving `version` off both the manifest and the entry makes the commit SHA the version, so updates follow the branch.

A `command` source ignores the marketplace entry's version. Its version is a hash of what the command produced, prefixed with the manifest version when one is set. Claude Code re-runs that command on install, on update, and once per session for each enabled command-sourced plugin.

Auto-update, in an interactive session, waits until the first message and then a random delay of up to ten minutes. It refreshes marketplaces that have auto-update on and updates their installed plugins on disk. The running session keeps the loaded copies until `/reload-plugins` or the next launch. Defaults: on for Anthropic's official marketplaces other than `knowledge-work-plugins` and `first-party-plugins`, on for marketplaces added from claude.ai, off for every other catalog. `DISABLE_UPDATES=1`, `DISABLE_AUTOUPDATER=1`, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` skips the pass unless `FORCE_AUTOUPDATE_PLUGINS=1`.

An update writes `.orphaned_at` into the previous version directory and deletes it about 14 days later, so a session that already loaded the old path can keep running. The sweep runs only while `installed_plugins.json` still records at least one install.

### claude.ai sync, dependencies, and organization policy

A plugin turned on for the claude.ai account, or required by the organization there, loads as `<name>@synced`. In the terminal this needs v2.1.273 or later and a claude.ai sign-in. Sync runs once in the background each startup. It is one-way: marketplace installs on the machine are not uploaded. API-key, Bedrock, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` sessions do not sync. `syncClaudeAiPlugins: false` stops the download and moves already-synced plugins to `plugins/.trash/` on the next start. A plugin the organization marks required cannot be disabled locally.

A plugin can declare dependencies. Install enables them at the same scope. Disable refuses while another enabled plugin still needs the one you named. Uninstall leaves auto-installed dependencies until `claude plugin prune`.

Managed settings can register marketplaces with `extraKnownMarketplaces` and force-enable or block plugins with `enabledPlugins`. A managed `true` loads even if user or project settings say `false`. Cloud sessions, including claude.ai/code, do not load the plugins in your local settings or the ones a repository's `extraKnownMarketplaces` would add. `CLAUDE_CODE_PLUGIN_SEED_DIR` points at a read-only pre-populated plugins directory for a container image. `CLAUDE_CODE_PLUGIN_DIRS` (v2.1.280 or later) loads extra directories for one session, the same way as `--plugin-dir`, and skips relative paths.

The shell surface is `claude plugin` with `install`, `uninstall`, `enable`, `disable`, `update`, `list`, `details`, `validate`, `eval`, `prune`, and `marketplace`. `list --json` and `install --json` are the machine-readable forms. Inside a session the same actions are `/plugin` and `/reload-plugins`. `claude plugin list` reflects settings. It can show a marketplace plugin as enabled while a `--plugin-dir` copy of the same manifest name is the one actually loaded.

## Skills

A skill is a directory with `SKILL.md`: YAML frontmatter, then markdown instructions. Claude Code follows the [Agent Skills](https://agentskills.io) standard and adds invocation control, forked execution, and dynamic context injection. The directory name is the command for a personal or project skill. The frontmatter `name` is only the display label there. In a plugin, `name` sets the last segment and the plugin prefix stays: `/plugin-name:skill-name`.

A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy`. If both exist, the skill wins. New work goes in `skills/` because a skill directory can hold reference files and scripts next to `SKILL.md`.

### Where skills are discovered

| Location     | Path                                                                 | Who gets it                                                                 |
| ------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Enterprise   | `.claude/skills/` inside the managed settings directory             | Every user on machines that receive the policy                             |
| Personal     | `~/.claude/skills/<name>/SKILL.md`                                   | Every project on this machine. Cowork and cloud sessions do not read it.   |
| Project      | `.claude/skills/<name>/SKILL.md`                                     | Sessions in this repository                                                 |
| Nested       | `<subdir>/.claude/skills/<name>/SKILL.md`                            | A session started in or below `<subdir>`. A session started above loads it the first time Claude reads or edits a file there. |
| `--add-dir`  | `<dir>/.claude/skills/`                                              | That session. `permissions.additionalDirectories` grants file access only and loads no skills. |
| Plugin       | `<plugin>/skills/<name>/SKILL.md`                                    | Wherever the plugin is enabled                                              |
| claude.ai    | Skills enabled on the account, downloaded to `~/.claude/skills/synced/` | Cowork, cloud, and terminal sessions signed in with that account         |

Project skills load from the start directory and every parent up to the repository root. In a linked worktree the walk stops at the worktree root; on v2.1.277 or later, a worktree with no root `.claude/skills` loads the main checkout's project skills instead. A skills-directory *plugin* does not walk parents. It loads only from the session's primary working directory, and only after the workspace trust dialog. Launching from a subdirectory leaves a plugin at the repo root unloaded.

`~/.claude/skills/synced` is reserved. A skill you author at that name is skipped in the enterprise, personal, and project locations. Symlinked skill folders in those three locations are read from the target and loaded once.

Live discovery does not include `~/.agents/skills` or `~/.cursor/skills`. Those paths appear in 2.1.282 as inputs to `claude import cursor`, which copies Cursor user config into the Claude config root. The same scanner reads `~/.cursor/mcp.json`, `~/.cursor/commands`, `~/.cursor/rules`, and `~/.cursor/hooks.json`. It skips the user-scope half when `CLAUDE_CONFIG_DIR` is set or the home resolves away from the real home directory. `claude import cursor --dry-run` is the preview. `--yes` requires a digest from that preview, so a headless confirm is bound to a scan the operator already saw.

When two skills share a command name, enterprise wins over personal, and personal wins over project. A user or project skill replaces a bundled skill's primary name and leaves the bundled aliases alone. Plugin skills stay available under their namespace, so they do not collide with `/deploy`. A synced skill's short name loses to any local command, bundled skill, plugin skill, or MCP prompt of the same name; it remains available as `/anthropic-skills:<name>`. Nested skills with the same name both load: `/deploy` is the root one, and `/apps/web:deploy` is the nested one.

Claude Code watches `~/.claude/skills/`, the project `.claude/skills/`, and `--add-dir` skill directories, except in bare mode. Edits to `SKILL.md` apply in the current session. Hooks, `.mcp.json`, agents, and output styles inside a skills-directory plugin need `/reload-plugins`.

### What the frontmatter controls

Only `description` is recommended. Claude matches tasks against it. The listing truncates `description` plus `when_to_use` at 1,536 characters. Unknown fields are ignored. The opening `---` has to be the first line; otherwise the whole file is body text.

Fields that change behavior in Claude Code, beyond the Agent Skills set (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`):

| Field                      | Effect                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `disable-model-invocation` | Hidden from automatic use. You invoke it with `/name`. Also kept out of subagent preloads.     |
| `user-invocable`           | `false` hides it from the `/` menu. Claude can still invoke it.                                |
| `allowed-tools`            | Tools that skip a permission prompt for the rest of the turn that invoked the skill.           |
| `disallowed-tools`         | Tools removed from the pool while the skill is active.                                         |
| `context: fork`            | Runs in a forked subagent. `agent` picks the type. `background` defaults to true on v2.1.218+. |
| `paths`                    | Globs. Automatic invocation only while Claude is working on a matching file.                   |
| `hooks`                    | Registered when the skill is invoked and kept for the rest of the session.                     |
| `model`, `effort`          | Override for the rest of the turn, then the session values return.                             |
| `shell`                    | `bash` or `powershell` for inline shell in that skill.                                         |

`skillOverrides` in settings can force the same visibility choices without editing the file. `disableBundledSkills` turns off bundled skills such as `/debug` and `/code-review`. `/doctor` stays typable unless `DISABLE_DOCTOR_COMMAND` or a `skillOverrides` entry of `"doctor": "off"` hides it (v2.1.205 or later).

A line of the form `` !`command` `` runs in the shell and its output replaces the line before Claude sees the skill. That injection is stripped for synced skills in a local terminal session (v2.1.228 or later) and replaced with a placeholder in Cowork when `disableSkillShellExecution` is on. Cloud sessions keep it, because the session is already in a container.

Subagents fully preload the skills named in their `skills:` field. They can still discover other project, user, and plugin skills through the Skill tool.

### claude.ai skill sync

Terminal sync of account skills needs v2.1.273 or later, a `/login` claude.ai session, and feature-flag fetch. Skills download into `~/.claude/skills/synced/` in the background. The startup does not wait, except when `CLAUDE_CODE_SYNC_SKILLS=1`, which makes a non-interactive run download and wait. While a session runs, Claude Code rechecks about every ten minutes and applies adds, edits, and removals without a restart. The sync never uploads local edits. `syncClaudeAiSkills: false` stops it and moves the downloaded tree to `~/.claude/skills/.trash/` on the next start.

`/skills` lists the downloaded set under `claude.ai sync`.

## MCP servers

An MCP server gives Claude tools, prompts, and resources from another process or from a remote endpoint. Claude Code connects at session start through one of two client runtimes. Sessions that fetch feature flags use the v2 runtime (MCP TypeScript SDK 2.x, protocol revision 2026-07-28) on v2.1.232 or later. `MCP_SDK_GENERATION=v1|v2` and `MCP_PROTOCOL_NEGOTIATION=auto|legacy` override that.

### Where a server is stored

`claude mcp add` writes a server. The default scope is `local`.

| Scope   | Loads in                         | Shared        | Stored in                                              |
| ------- | -------------------------------- | ------------- | ------------------------------------------------------ |
| Local   | This project only                | No            | `~/.claude.json`, under `projects[<path>].mcpServers`  |
| Project | This project only                | Yes, if committed | `.mcp.json` at the project root                    |
| User    | Every project                    | No            | `~/.claude.json`, top-level `mcpServers`               |

Local MCP scope is not the same file as local settings. Local settings are `.claude/settings.local.json`. Local MCP entries live in the home app-state file, keyed by project path.

Transports:

| Transport | How you add it                                                                 |
| --------- | ------------------------------------------------------------------------------ |
| HTTP      | `claude mcp add --transport http <name> <url>`. Preferred for remote servers. `type: "streamable-http"` is an alias in JSON. |
| SSE       | Deprecated. On v2.1.265 or later, `--transport http` tries HTTP and falls back to SSE. `--transport sse` forces it. |
| stdio     | `claude mcp add <name> -- <command> [args...]`. `--env` sets the child environment. `CLAUDE_PROJECT_DIR` is injected into that child. |
| WebSocket | JSON only: `claude mcp add-json` with `"type": "ws"`. Header auth. No OAuth. WebSocket servers are omitted from `claude mcp list`; `claude mcp get` and `/mcp` show them. |

A JSON entry with `url` and no `type` is skipped. Claude Code reads a missing `type` as stdio. `${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url`, and `headers`. In a remote `url` or `headers`, credential names such as `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `AWS_BEARER_TOKEN_BEDROCK` expand to empty, so a project `.mcp.json` cannot forward the Claude credential by naming it. A name you choose, such as `API_KEY`, still expands.

Server names are letters, numbers, hyphens, and underscores. Built-in names are reserved, including `workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, and `Claude Browser`.

### Approval, disable, and precedence

A project `.mcp.json` server stays pending until an interactive session in a trusted workspace approves it. `claude mcp list` shows `⏸ Pending approval` and does not connect. `enabledMcpjsonServers` or `enableAllProjectMcpServers` committed inside the repository is ignored until that trust exists. Approvals in user settings, managed settings, `--settings`, and an untracked `.claude/settings.local.json` in an already-trusted folder still apply. `disabledMcpjsonServers` rejects a server from any settings file. `claude mcp reset-project-choices` clears the approvals and rejections for the current project.

`claude -p`, the Agent SDK, and cloud sessions cannot show the approval prompt, so they load project servers without asking. `--strict-mcp-config` skips them. `disabledMcpjsonServers` still blocks a server in every permission mode.

Turning a server off in `/mcp` keeps the configuration and records the choice per project in `~/.claude.json`:

- `disabledMcpServers` opts out of user servers, plugin servers, managed-provided servers, claude.ai connectors, and built-ins that default on.
- `enabledMcpServers` opts in to built-ins that default off, such as `computer-use`.

Those two lists are unrelated to `enabledMcpjsonServers` and `disabledMcpjsonServers`.

When the same name is defined in more than one place, one whole entry wins. Fields are not merged.

| Precedence | Source                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Highest    | `managedMcpServers` in managed settings (v2.1.259 or later)            |
|            | Local scope                                                            |
|            | Project scope                                                          |
|            | User scope                                                             |
|            | Plugin servers, matched to the ones above by endpoint rather than by name |
| Lowest     | claude.ai connectors, also matched by endpoint                         |

A duplicate plugin or connector that points at the same URL or command as a higher entry is dropped.

### Plugin servers and claude.ai connectors

A plugin declares servers in `.mcp.json` at the plugin root, or inline in `plugin.json`. The top-level object may be `mcpServers` or the server map itself. Enabling the plugin connects them. You remove them by disabling or uninstalling the plugin. `/mcp` can still toggle one off for the current project.

The server's display name is `plugin:<plugin-name>:<server-key>`. A tool's callable name is `mcp__plugin_<plugin-name>_<server-key>__<tool-name>`, with characters outside `A-Za-z0-9_-` replaced by `_`. Permission rules, `allowed-tools`, subagent tool lists, and hook matchers need that full name. A matcher on the bare server key does not fire. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${CLAUDE_PROJECT_DIR}` expand in the plugin's server config. On `/reload-plugins`, connections whose configuration did not change stay up. A non-interactive session does not connect or disconnect plugin servers on reload; that waits for the next session.

Connectors you enable on claude.ai are fetched into terminal sessions signed in with that account. `claude mcp list` labels them `claude.ai <Connector>`. Removing a remote server also deletes the OAuth tokens and client registration stored for it. `claude mcp login <name>` and `claude mcp logout <name>` are the shell forms. A 401 on an already-signed-in server refreshes once and retries. A server whose `Authorization` header you set yourself is reported as failed on 401, because the credential to fix is the header, not an OAuth flow.

### Tool search, health, and limits

`claude mcp list` health-checks configured servers unless they are pending, rejected, or disabled. Statuses include connected, needs authentication, and failed. A failed line can include the HTTP status and server text with credential-like strings redacted, and it does not print the expanded URL. From v2.1.221 a remote server can show `cached` and connect on the first tool call. `MCP_DISCOVERY_CACHE=1` forces that cache on; `0` forces it off. Before v2.1.238 the cache defaulted on.

Remote servers that drop are reconnected with exponential backoff, up to five attempts. A transient failure of the first HTTP or SSE connection is retried up to three times. stdio processes are not reconnected. `tools/list` failures keep the previous tool list (v2.1.214 or later).

Tool-call limits: a per-server `timeout` in milliseconds, else `MCP_TOOL_TIMEOUT` (default on the order of 28 hours). An idle timeout aborts a call with no progress: five minutes for HTTP, SSE, WebSocket, and connectors, 30 minutes for stdio, overridable with `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`. Output warns above 10,000 tokens and truncates at 25,000 unless `MAX_MCP_OUTPUT_TOKENS` is set. A main-conversation call still running after two minutes becomes a background task (v2.1.212 or later). `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` turns that off. Subagent calls and non-interactive runs stay in the foreground unless `CLAUDE_AUTO_BACKGROUND_TASKS=1`.

MCP prompts show up as commands. They participate in the skill name collision rules above.

### Organization control

Managed MCP is a separate layer from plugins. The patterns on [Control MCP server access](https://code.claude.com/docs/en/managed-mcp.md):

| Pattern              | Mechanism                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| Disable MCP          | `managed-mcp.json` with an empty server map. In-process SDK servers can remain. |
| Fixed set            | `managed-mcp.json` listing the only servers that load. Plugin servers and `--mcp-config` are suppressed. On a workstation, `--mcp-config` makes Claude Code exit. |
| Provided servers     | `managedMcpServers` in managed settings. Users keep their own servers.   |
| Approved catalog     | `allowedMcpServers` plus `allowManagedMcpServersOnly: true`               |
| Plugin servers only  | `strictPluginOnlyCustomization` including `mcp`. User and project files cannot add servers. |
| Soft allowlist       | `allowedMcpServers` without the managed-only flag                         |
| Denylist             | `deniedMcpServers`. Applies to managed servers too. A user's own denylist entry can block a managed server for that user. |

On macOS the exclusive file is `/Library/Application Support/ClaudeCode/managed-mcp.json`. It cannot be delivered through server-managed settings. `allowAllClaudeAiMcps` in a managed policy source lets claude.ai connectors load beside that file. Users cannot set that key themselves.

`strictPluginOnlyCustomization` can also lock the skills surface to plugin sources, which stops personal and project skills and stops skill sync when the user setting source is excluded.

## What a profile root isolates

`CLAUDE_CONFIG_DIR` replaces the user configuration directory for that process. Puppeteer profiles already set it and strip the undocumented `CLAUDE_SECURESTORAGE_CONFIG_DIR`, which would otherwise retarget the Keychain service name independently of the root. On macOS the account credential is a login-Keychain item: `Claude Code-credentials` for the native home, and `Claude Code-credentials-<sha256(root)[:8]>` when the variable is set. That is documented in `packages/adapter-claude/src/services/account-usage.ts` from a 2.1.263 probe and is unchanged by this note.

For plugins, skills, and MCP, the root moves the user-scope files and leaves the workspace and the machine policy where they are.

| Follows `CLAUDE_CONFIG_DIR`                                      | Stays outside it                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `settings.json`, including `enabledPlugins` and `extraKnownMarketplaces` | The workspace's `.claude/settings.json`, `.claude/settings.local.json`, `.claude/skills/`, `.claude/commands/` |
| `plugins/` cache, marketplaces, install records, `data/`, `synced/` | `.mcp.json` at the project root                                                  |
| Personal skills, including `skills/synced/`                      | Managed settings and `/Library/Application Support/ClaudeCode/managed-mcp.json`  |
| The app-state file, as `<root>/.claude.json` rather than a sibling of the root. User MCP servers and per-project local MCP entries live here. | Session flags: `--plugin-dir`, `--plugin-url`, `--mcp-config`, `--strict-mcp-config` |
| claude.ai plugin sync, skill sync, and connector fetch, for the account signed in under that root | `claude import cursor`'s user-scope scan, which refuses to read `~/.agents/skills` when the variable is set |

An empty root does not inherit the native home. A repository the process is launched in still contributes its project skills, project plugin enables, and `.mcp.json`, subject to workspace trust and MCP approval.

## What this machine showed

Probes used Claude Code 2.1.282. They printed shapes and statuses. Token files, header values, and Keychain items were not read. The native `~/.claude.json`, `~/.claude/settings.json`, and `installed_plugins.json` mtimes were the same before and after the empty-root probe.

**Native layout.** `~/.claude/settings.json` holds `enabledPlugins` and `extraKnownMarketplaces`. `~/.claude/plugins/installed_plugins.json` is `{ version, plugins }`. Each plugin id maps to a list of records with `scope`, `version`, `installPath`, `gitCommitSha`, `installedAt`, and `lastUpdated`. Cache paths look like `plugins/cache/<marketplace>/<entry>/<version>/`. Versions on disk are both semver (`1.1.0`, `0.4.1`) and 12-character hashes, which matches the version rule above. Several hash directories for one plugin were still present, which matches the delayed orphan cleanup.

`known_marketplaces.json` maps a marketplace name to `installLocation`, `lastUpdated`, and `source`. Sources observed were GitHub `{ source: "github", repo }` and a local directory. Marketplace manifests were `{ name, owner, plugins, ... }`. One catalog's plugin `source` was a string, the relative-path form that loads in place.

Sample manifests in the cache were small: `name`, `version`, `description`, `author`, sometimes `repository`, `homepage`, `license`, `keywords`. A plugin `.mcp.json` was `{ mcpServers: { <key>: { type: "http", url, headers } } }`. Header values were not printed.

`claude plugin list --json` returned one object per install with `id`, `version`, `scope`, `enabled`, and, for marketplace installs, `installPath`, `installedAt`, and `lastUpdated`. One row was `<name>@synced` with `scope: "synced"` and no install-path fields. `plugins/synced/` held account-scoped downloads plus a `.marketplaces.json`. `plugins/.trash/` held a removed synced plugin. `claude plugin marketplace list` agreed with `known_marketplaces.json`.

`~/.claude.json` is the app-state file: UI flags, per-project trust and metrics, top-level `mcpServers` (empty on this machine), and `pluginUsage` / `skillUsage` maps. Project entries that mention MCP carry `mcpServers`, `mcpContextUris`, `enabledMcpjsonServers`, and `disabledMcpjsonServers`. Personal skills on disk were only `~/.claude/skills/synced/`. `~/.agents/skills/` exists and holds other agents' skills. The skills page does not list it as a live Claude Code root; the 2.1.282 binary reads it from `claude import cursor`.

`claude mcp list` in the native home reported `claude.ai <Connector>` rows and `plugin:<plugin>:<server>` rows, with connected, failed, and needs-authentication statuses. This machine has no `managed-mcp.json` and no `managed-settings.json` under `/Library/Application Support/ClaudeCode` or `/etc/claude-code`, so exclusive MCP policy is not in effect here. `plugins/blocklist.json` is present and is not one of the files in the loading reference. Its two rows are `{ plugin, reason, text, added_at }` and read as local test entries. Delisted plugins in the documented model go to `flagged-plugins.json`.

**Empty `CLAUDE_CONFIG_DIR`.** A fresh directory was passed as `CLAUDE_CONFIG_DIR`, with `CLAUDE_SECURESTORAGE_CONFIG_DIR` unset. `claude plugin list --json` printed `[]`. `claude plugin marketplace list` printed `No marketplaces configured`. `claude mcp list` printed `No MCP servers configured`. The process created `<root>/.claude.json` and `<root>/backups/`, and did not create `plugins/` or `skills/`. The fresh app-state file held startup bookkeeping (`firstStartTime`, `machineID`, `migrationVersion`, and similar) and no `mcpServers` or `projects`. The native home was not modified.

**Project MCP outside the root.** From a temporary project whose only Claude file was `.mcp.json` with one HTTP server, the same empty root's `claude mcp list` showed that server as `⏸ Pending approval` and did not add a `projects` entry to the fresh `.claude.json`. The project file is visible without a populated user home, and approval is not persisted by a non-interactive list.

## Recommendation

Keep `CLAUDE_CONFIG_DIR` as the only profile boundary for Claude plugins, skills, and MCP. A managed profile already gets its own user settings, plugin cache, personal skills, claude.ai sync, and `<root>/.claude.json` MCP entries by launching the stock binary under that variable. Do not add a Puppeteer installer, a second enablement file, or a copy of marketplace contents into the adapter.

Treat the workspace as a second, shared scope. A profile launched in a repository still sees that repository's `.claude/skills/`, `.claude/settings.json` `enabledPlugins`, and `.mcp.json`, after trust and MCP approval. That sharing is the product's project scope. Isolating it would mean a separate working directory, not a different config root.

Leave managed policy outside the profile. `managed-mcp.json` and managed `enabledPlugins` apply to every Claude Code process on the machine, including one with `CLAUDE_CONFIG_DIR` set. This machine has neither file deployed.

If a product surface later needs an inventory, read it under the profile binding and do not parse terminal text:

- `claude plugin list --json` for id, version, scope, and enabled. A `@synced` row has no install record.
- `claude plugin marketplace list` for catalogs. `known_marketplaces.json` is the on-disk form.
- `claude mcp list` for configured servers and health, remembering it connects to approved servers. Pending `.mcp.json` servers are labeled and not connected. WebSocket servers are absent from that list.
- The workspace `.mcp.json` and `.claude/settings.json` for the project half, as files, separate from the profile root.

Do not run `claude import`, `claude plugin install`, or `claude mcp add` as part of profile setup. Import writes another agent's skills and MCP config into the active root, and the cursor importer skips its user-scope scan when `CLAUDE_CONFIG_DIR` is set. Plugin and MCP mutations belong to the person, through Claude Code's own commands.

Session flags are the right escape hatches for a host that must narrow one launch: `--safe-mode` drops installed plugins, skills, and MCP; `--strict-mcp-config` with `--mcp-config` replaces the MCP set; `--plugin-dir` adds a plugin for that process only. They do not change the profile's stored inventory.

This note does not change the adapter, Surface, or `support/agents.json`. Re-probe when the support baseline moves off the CLI generation exercised here, especially the synced-plugin minimum of v2.1.273, `CLAUDE_CODE_PLUGIN_DIRS` at v2.1.280, and `managedMcpServers` at v2.1.259.

## Sources

Official docs, fetched 2026-09-24:

- [Extend Claude Code](https://code.claude.com/docs/en/features-overview.md)
- [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory.md)
- [Plugins overview](https://code.claude.com/docs/en/plugins/overview.md)
- [Install and manage plugins](https://code.claude.com/docs/en/plugins/install.md)
- [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading.md)
- [Manage plugins for your organization](https://code.claude.com/docs/en/plugins/org.md)
- [Extend Claude with skills](https://code.claude.com/docs/en/skills.md)
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp.md)
- [Connect to MCP servers](https://code.claude.com/docs/en/mcp-quickstart.md)
- [Control MCP server access](https://code.claude.com/docs/en/managed-mcp.md)
- [Environment variables](https://code.claude.com/docs/en/env-vars.md)
- [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins.md)

Local evidence, Claude Code 2.1.282, 2026-09-24:

- `claude plugin --help`, `plugin list --json`, `plugin marketplace list`, `mcp --help`, `mcp list`, `import --help`
- `~/.claude/settings.json` keys, `~/.claude/plugins/` tree, `installed_plugins.json` and `known_marketplaces.json` field names, cache `plugin.json` and `.mcp.json` shapes
- Empty `CLAUDE_CONFIG_DIR` probe under `/tmp`, and a temporary project `.mcp.json` listed from that root
- Strings in the 2.1.282 binary for the `claude import cursor` user-scope scan, including `~/.agents/skills` and the `CLAUDE_CONFIG_DIR` skip
