# OpenCode plugins, skills, and MCP servers

Date: 2026-09-24.

Status: research complete. No adapter change, no Surface claim, and no support-ledger change in this note.

Related: [`draft/OPENCODE-ADAPTATION-PLAN.md`](OPENCODE-ADAPTATION-PLAN.md), [`draft/OPENCODE-SUBSCRIPTION-IDENTITY.md`](OPENCODE-SUBSCRIPTION-IDENTITY.md), [`packages/adapter-opencode/src/services/profiles.ts`](../packages/adapter-opencode/src/services/profiles.ts), [`docs/rfcs/006-agent-distribution-and-account-profiles.md`](../docs/rfcs/006-agent-distribution-and-account-profiles.md).

The contract below is OpenCode **1.18.32**, the latest GitHub release and the CLI installed on this machine (`~/.opencode/bin/opencode`). The adapter baseline in `support/agents.json` is still candidate **1.18.16**. A parallel tag line, **v2.0.0** (2026-09-11) through **v2.0.16** (2026-09-24), and an in-tree spec at `specs/v2/config.md`, redesign the same three mechanisms. The public docs at <https://opencode.ai/docs> still describe the 1.18 shape, with a banner that v2 exists. Where the website and the 1.18.32 loader disagree, the loader is the authority. The v2 redesign is recorded at the end and is not a reason to change the adapter.

## Recommendation

Leave plugins, skills, and MCP servers to the OpenCode process Puppeteer already hosts. They are configuration and extension inside that process. They are not a second observation rail, and they are not part of profile identity.

A managed profile binds `XDG_DATA_HOME` and therefore isolates `mcp-auth.json`. It does not isolate plugin code, skill files, MCP server definitions, the npm package cache, or the remote skill cache. Those stay on the XDG config and cache roots. Launching a profile still loads the shared plugins and starts the shared MCP servers. That split is the one RFC 006 already chose for plugins. This note extends it to skills and MCP definitions.

When a product later wants an inventory, read it from the session's own server and keep the secret-bearing fields out:

| Want | Read | Keep | Leave behind |
| --- | --- | --- | --- |
| Skills visible to the process | `GET /skill` | `name`, and `location` if a path is useful | `content` is the full skill body. It is instructions. It does not belong in a log. |
| MCP connection state | `GET /mcp` | server name and `status` (`connected`, `disabled`, `failed`, `needs_auth`, `needs_client_registration`) | `failed.error` is free text from a child process or an HTTP client. `needs_client_registration.error` is a fixed string. Do not persist either. |
| Plugin list | nothing on the wire that is safe to treat as an inventory | | `plugin.added` carries only an `id`. The loader that actually runs plugins does not publish it. |

`opencode debug skill` prints every skill, including `content`, as JSON on stdout. `opencode mcp list` is terminal text, and building that view connects the servers. Neither command is a source.

`POST /mcp`, `POST /mcp/:name/connect`, and `POST /mcp/:name/disconnect` change the running process and do not rewrite `opencode.json`. `opencode mcp add` and `opencode plugin` do rewrite config. A host that wants a session without third-party plugins passes `--pure` (or `OPENCODE_PURE=1`). That flag skips `plugin_origins`. The built-in provider auth plugins still load unless `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`.

Do not point a config reader at the v2 keys `plugins` or `mcp.servers` while the candidate binary is 1.18.

## Three mechanisms

OpenCode keeps three extension mechanisms, plus a fourth (commands) that the v2 spec wants to fold into skills and that 1.18 still stores on its own.

| | Plugin | Skill | MCP server |
| --- | --- | --- | --- |
| What it is | JavaScript or TypeScript that runs inside the OpenCode process | A `SKILL.md` the model loads on demand through the built-in `skill` tool | An external tool server, local stdio or remote HTTP |
| Who executes it | The server, and separately the TUI if the package has a `./tui` entry | The model, after a permission check. The body is returned as tool output | A child process, or a remote endpoint OpenCode connects to with the MCP SDK |
| Declared by | `plugin` in config, and files in a plugin directory | Directories of `SKILL.md`, plus `skills.paths` and `skills.urls` | `mcp` in config, one object per name |
| Installed by | npm at startup, or loaded from a file URL | No install. A URL source is cached under the cache root | No package install. `opencode mcp add` only edits config |
| Tools show up as | Whatever keys the plugin returns from `tool` | One built-in tool, `skill` | `<sanitized server>_<sanitized tool>` |

A command (`command` in config, or a markdown file under a config directory) is a user-authored prompt, not a skill. The 1.18 loader still merges commands on their own. The v2 spec says not to port `command` and to treat that kind of workflow as a skill.

## Where the files are

`opencode debug paths` on the installed 1.18.32 CLI:

| Path | This machine |
| --- | --- |
| config | `~/.config/opencode` |
| data | `~/.local/share/opencode` |
| cache | `~/.cache/opencode` |
| state | `~/.local/state/opencode` |

| Piece | Location | Moves with `XDG_DATA_HOME` |
| --- | --- | --- |
| `opencode.json`, `opencode.jsonc`, `config.json` | config root, project directory, `.opencode/`, managed and remote documents | no |
| Plugin source the user wrote | `~/.config/opencode/plugin/` or `plugins/`, and the same two names under each `.opencode/` | no |
| npm plugins | `~/.cache/opencode/packages/<spec>/` | no |
| `@opencode-ai/plugin` for local imports | `node_modules` inside each config directory | no |
| Skills | config `skill/` and `skills/`, `.opencode/skill(s)/`, `~/.claude/skills/`, `~/.agents/skills/`, project copies of the last two, plus `skills.paths` | no |
| Remote skill cache | `~/.cache/opencode/skills/<name>/` | no |
| MCP server definitions | the merged `mcp` object | no |
| MCP OAuth tokens, client registration, PKCE verifier | `~/.local/share/opencode/mcp-auth.json`, mode `0600` | yes |

The global config on this machine is `$schema` plus `"mcp": {}`. There is no `~/.config/opencode/plugins` and no `~/.config/opencode/skills`. `~/.claude/skills` and `~/.agents/skills` both exist. Their contents were not read. The config directory's `package.json` pins `@opencode-ai/plugin` at **1.18.23** while the CLI is **1.18.32**. The installer explains that pin: once `node_modules` exists and the lockfile already names the package, `Npm.install` returns without comparing versions.

## How config is merged

Later documents win. Plugin specs are accumulated and then deduped, rather than replaced as a block. `mcp` is a deep merge, so a later file can set `enabled: false` on a server that an earlier file fully defined and the `type`, `command`, and `url` survive.

Order in `packages/opencode/src/config/config.ts` at tag `v1.18.32`:

1. Each `auth.json` entry of type `wellknown`. OpenCode fetches `{url}/.well-known/opencode`, optionally follows `remote_config`, and merges that document as global. The stored token is placed in an env map for `{env:NAME}` substitution. It is a bearer. A reader does not log it.
2. Global files, in order: `config.json`, then `opencode.json`, then `opencode.jsonc`. A legacy `config` TOML file is imported into `config.json` and deleted.
3. The file named by `OPENCODE_CONFIG`, when set.
4. Project `opencode.json` and `opencode.jsonc`, unless `OPENCODE_DISABLE_PROJECT_CONFIG` is set. `FSUtil.up` walks from the working directory to the worktree, nearest first, and the loader reverses that list before merging, so the file closest to the working directory wins.
5. Every config directory, in this order: the global config root, then each project `.opencode` from the working directory upward, then `~/.opencode`, then `OPENCODE_CONFIG_DIR`. Inside a directory whose path ends in `.opencode`, or inside `OPENCODE_CONFIG_DIR`, `opencode.json` and `opencode.jsonc` are merged. Every directory, including `~/.config/opencode`, also gets command markdown, agent markdown, a plugin-file scan, a `.gitignore` for `node_modules`, and a background install of `@opencode-ai/plugin` at the running CLI version.
6. `OPENCODE_CONFIG_CONTENT`, as a local document.
7. The active Console org, `GET {account.url}/api/config`, merged as global. The same load writes `OPENCODE_CONSOLE_TOKEN` into the process environment. That variable is a bearer.
8. The managed config directory, when it exists.
9. macOS managed preferences (`.mobileconfig`). This branch deep-merges the document and does not update `plugin_origins`. An MDM `plugin` array therefore changes `plugin` and does not change the list the runtime loads. An MDM `mcp` object does take effect, because the MCP service reads `cfg.mcp`.

`{env:NAME}` anywhere in config text is replaced before parse. A missing variable becomes an empty string. `{file:path}` is replaced with the file's text, relative to the config file. Both are how a config holds a secret without a literal. Resolved config is not safe to log. `opencode debug config` prints it.

Plugin identity for dedupe is the npm package name, or the exact `file://` URL for a path. The last declaration wins. `opencode-openai-codex-auth` and `opencode-copilot-auth` are dropped as deprecated because those auth flows are built in. A file plugin and an npm plugin are never the same identity, even when the names look alike.

## Plugins

### What gets loaded

Two plugin kinds share one loader: `server` (the backend Puppeteer attaches to) and `tui` (the terminal UI). A package selects them with `package.json` `exports`. `./server`, or `main` when `./server` is absent, is the server entry. `./tui` is the TUI entry. An `oc-themes` array makes the package a TUI target even with no code entry. `opencode plugin <module>` writes a server target into `opencode.json` and a TUI target into `tui.json`. `--global` selects the config root. Without it, a git worktree gets `<worktree>/.opencode/`. `--force` replaces an existing spec for the same package. The default is to leave the existing row.

Server plugins the process actually runs, in order:

1. Built-in auth plugins, unless `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`: Codex, GitHub Copilot, Modal, GitLab, Poe, Cloudflare Workers, Cloudflare AI Gateway, Azure, DigitalOcean, Snowflake Cortex, xAI, Cerebras. These are import-time modules, not npm installs. They are why `opencode auth login` can offer "ChatGPT Pro/Plus", "SuperGrok Subscription", and "Login with GitHub Copilot". A third-party plugin can add its own `auth` method. The profile catalog does not know that method's label. The subscription-identity note already treats those three built-ins as the only OAuth logins whose method is a plan name.
2. External plugins from `plugin_origins`, unless `--pure` / `OPENCODE_PURE=1`.

`plugin_origins` is the union of:

- `plugin` arrays from the merge above. Each entry is a string spec or a `[spec, options]` tuple. A spec is an npm package (`name`, `name@version`, `name@tag`), a relative path resolved against the file that declared it, an absolute path, or a `file://` URL.
- Files matched by `{plugin,plugins}/*.{ts,js}` directly inside each config directory. One level, those two extensions. A `.tsx`, `.mjs`, or nested file is not auto-loaded. The docs name only `.opencode/plugins/` and `~/.config/opencode/plugins/`. The loader also scans the singular `plugin/` directory and `~/.opencode/plugin(s)/`.

npm specs are installed on demand with `@npmcli/arborist` into `~/.cache/opencode/packages/<spec>`, `ignoreScripts: true`. The public plugin page says Bun installs them into `~/.cache/opencode/node_modules/`. That is not what 1.18.32 does. File plugins skip the `engines.opencode` check. npm plugins are skipped, with a session error, when `engines.opencode` does not satisfy the running version. Install, entrypoint, and load failures publish `session.error` and the process continues. Resolution of the external set is parallel. Calling each plugin function is sequential, so hook order matches `plugin_origins` after the built-ins.

Each plugin function receives `client` (an SDK client pointed at this server), `project`, `directory`, `worktree`, `serverUrl`, a workspace-adapter register, and Bun's `$` shell when Bun is the runtime. Options from a tuple spec are the second argument.

### Hooks

The callable contract is `Hooks` in `@opencode-ai/plugin` at the same tag. `trigger` walks the loaded hooks in order and passes the same output object to each.

| Hook | Role |
| --- | --- |
| `event` | One bus event whose `location.directory` is this instance. The docs page's `session.*`, `message.*`, `file.*`, `permission.*`, `tui.*` names are this payload's `event.type`, not separate hook keys. |
| `config` | Called once with the resolved config after load. |
| `tool` | Map of custom tools. A name that collides with a built-in replaces the built-in. |
| `auth` | Adds a provider login method (`oauth` or `api`) to `opencode auth login`. |
| `provider` | Supplies models for a provider id. |
| `chat.message` | Rewrites the user message and its parts before the turn. |
| `chat.params`, `chat.headers` | Temperature, token limit, provider options, and HTTP headers for the model call. |
| `permission.ask` | Sets `ask`, `deny`, or `allow` on a permission prompt. |
| `command.execute.before` | Rewrites the parts produced for a slash command. |
| `tool.execute.before`, `tool.execute.after` | Rewrites tool arguments, then title, output, and metadata. |
| `shell.env` | Adds environment variables for shell execution. The plugin page's example writes a secret into `output.env`. That value is then in the child environment. |
| `tool.definition` | Rewrites a tool's description and JSON schema before it is sent to the model. |
| `experimental.chat.messages.transform`, `experimental.chat.system.transform` | Rewrites the message list or the system prompt. |
| `experimental.session.compacting` | Appends compaction context, or replaces the compaction prompt when `output.prompt` is set. |
| `experimental.compaction.autocontinue` | `output.enabled = false` skips the synthetic continue turn. |
| `experimental.text.complete` | Rewrites completed assistant text. |
| `experimental.provider.small_model` | Replaces the small model for a provider. |
| `dispose` | Runs when the instance shuts down. |

A plugin is ordinary code in the server process. It can read the project, call the SDK, and register tools. Puppeteer does not sandbox it. `--pure` is the switch that keeps a hosted session on the built-ins.

### What the adapter sees

Surface, on the 1.18.16 capture, records `plugin.added` on `GET /event` with properties `{ id: string }` and confidence from the OpenAPI document plus an abort-stream capture. The 1.18.32 server plugin loader does not publish that event. The adapter already drops it in `FILTERED_INFRASTRUCTURE` inside `packages/adapter-opencode/src/normalization/adapter.ts`. A plugin tool call arrives later as a normal tool part, under the name the plugin chose.

## Skills

### Discovery

`packages/opencode/src/skill/index.ts` builds one map of `{ name, description?, location, content }` per instance. The same map feeds the `skill` tool, `opencode debug skill`, and `GET /skill`.

Scan order. A later hit with the same `name` overwrites, after a warning:

1. The built-in `customize-opencode` skill, shipped in the binary, location `"<built-in>"`. It exists so the model has the real config schema when asked to edit `opencode.json`, `.opencode/`, agents, skills, plugins, MCP, or permissions. Any disk skill of the same name replaces it.
2. External skills, unless `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`. Pattern `skills/**/SKILL.md`, dotfiles included. Global `~/.claude/skills` unless `OPENCODE_DISABLE_CLAUDE_CODE=1` or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`. Global `~/.agents/skills` always, when the broad external flag is off. Then the same two directory names walking from the working directory up to the worktree.
3. Each config directory from the merge, pattern `{skill,skills}/**/SKILL.md`. So both `skill/` and `skills/`, nested, under `~/.config/opencode`, each `.opencode`, `~/.opencode`, and `OPENCODE_CONFIG_DIR`. Because the directory list is nearest-first and this scan does not reverse it, an ancestor `.opencode/skills` entry overwrites a nearer one with the same name.
4. `skills.paths` in the merged config. `~/` expands from the home directory. A relative path is resolved from the working directory. The pattern inside the directory is `**/SKILL.md`. A missing directory is a warning, and the rest still load.
5. `skills.urls`. Each URL must serve `index.json` of `{ skills: [{ name, files, version? }] }`. Entries whose `files` omit `SKILL.md` are skipped. Files are downloaded into `~/.cache/opencode/skills/<name>/`. A matching `.opencode-version` skips the download. A changed version stages into a sibling directory and renames over the cache only after `SKILL.md` is present.

A skill file needs YAML frontmatter that the 1.18.32 loader actually checks: `name` is a string, and `description` is either absent or a string. Other frontmatter keys are ignored. The published skills page requires `name` to match `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 characters, equal to the directory name, and `description` of 1–1024 characters. The loader does not check any of that. `NameMismatchError` is declared in that file and not raised. A skill with no description is stored and is omitted from the model-facing list. `fmt` drops it. `GET /skill` and `opencode debug skill` still return it, because they call `all()`.

The list the model sees is `available(agent)`, sorted by name, minus skills for which this agent's permission rule on key `skill` is `deny`. The tool description then lists name and description. Verbose form:

```xml
<available_skills>
  <skill>
    <name>git-release</name>
    <description>…</description>
    <location>…</location>
  </skill>
</available_skills>
```

### The tool

`skill` takes `{ name }`. It asks permission `skill` on that name, reads the body, lists up to ten other files in the skill directory, and returns them inside `<skill_content>`. Relative paths in the body are relative to that directory. The tool does not execute those files. A plugin that wants to run skill scripts is a separate program. OpenCode's own tool does not.

`GET /skill` on the 1.18.16 OpenAPI (`app.skills`) returns the array of `{ name, location, content, description? }`. `GET /api/skill` (`v2.skill.list`) is also in that document. The service this note describes is the one the CLI command and the `skill` tool import.

There is a second implementation, `packages/core/src/skill.ts` (`SkillV2`), already inside the 1.18.32 tree. It accepts `name` optional when the file sits directly in the source directory (the file basename is then the name), and it understands a `slash` frontmatter flag. The running `skill` tool does not call it. The v2 section below is where that loader belongs.

## MCP servers

### Config

`mcp` is a map. Each value is either a full server or `{ enabled: boolean }`. A value with no `type` is ignored at connect time and logged. A `{ enabled: false }` overlay works because the deep merge keeps `type` from the earlier document.

Local, `type: "local"`:

| Field | Required | Behavior in 1.18.32 |
| --- | --- | --- |
| `command` | yes | Array. `command[0]` is the executable, the rest are arguments. The child inherits `process.env`, then `environment`. When the executable is `opencode`, the child also gets `BUN_BE_BUN=1`. |
| `cwd` | | Relative to the instance directory. |
| `environment` | | String map. These are secrets when the server's own docs say they are. |
| `enabled` | | `false` records status `disabled` and does not spawn. |
| `timeout` | | Milliseconds. Used as the connect timeout and as the tool-call timeout for this server. |

Remote, `type: "remote"`:

| Field | Required | Behavior in 1.18.32 |
| --- | --- | --- |
| `url` | yes | Invalid URL becomes status `failed`. |
| `headers` | | Sent on both transports. `{env:NAME}` has already been substituted. |
| `oauth` | | An object supplies `clientId`, `clientSecret`, `scope`, `callbackPort` (1–65535, default 19876), `redirectUri` (default `http://127.0.0.1:19876/mcp/oauth/callback`). `false` disables OAuth. Omitting the field leaves OAuth on. |
| `enabled`, `timeout` | | Same as local. |

The schema comment and the docs say `timeout` defaults to 5000. The connect path uses `mcp.timeout ?? 30_000`. Tool calls use the server's `timeout`, then `experimental.mcp_timeout`, and otherwise pass no timeout.

### Connection

Startup connects every configured server with `enabled !== false`, in parallel. Remote tries the MCP SDK's Streamable HTTP transport first and SSE second. An OAuth failure stops the fallback. The status enum is:

| `status` | Meaning |
| --- | --- |
| `connected` | Handshake succeeded and, when the server advertises tools, `tools/list` returned. |
| `disabled` | `enabled: false`, or `disconnect` ran in this process. |
| `failed` | `error` is the thrown message, or `"Connection closed"` after the socket drops. |
| `needs_auth` | Remote returned 401. A toast tells the user to run `opencode mcp auth <name>`. |
| `needs_client_registration` | Dynamic client registration failed. The error string tells the user to set `clientId`. |

`tools/list` is paginated, capped at 1000 pages, and retried once with a schema that drops `outputSchema` when the server's schema has unresolvable references. A `notifications/tools/list_changed`, and a dropped connection, publish `mcp.tools.changed` with `{ server }`. Surface records that event from the 1.18.16 OpenAPI only. Confidence there is `unverified`. The 1.18.32 publisher matches that payload.

Each tool is registered under `sanitize(server) + "_" + sanitize(toolName)`, where `sanitize` replaces every character outside `[A-Za-z0-9_-]` with `_`. The docs' glob `mymcpservername_*` matches that. The adapter's tool presentation marks a tool as MCP when the tool name contains the letters `mcp`. A server named `sentry` with a tool named `list_issues` is presented as `other`. The native name is the join above. Fixing that classification is a separate, small change. This note does not make it.

Resources and prompts are listed when the server advertises them. They are not given the same tool names. Instructions from `getInstructions()` are kept for connected servers and sorted by server name.

On shutdown the server closes each client. For a stdio transport on anything but Windows it also `SIGTERM`s the child's descendants, found with `pgrep -P`.

OAuth state for every server lives in one JSON object at `mcp-auth.json`: tokens (`accessToken`, optional `refreshToken`, `expiresAt`, `scope`), dynamic-client registration, the PKCE verifier, and `serverUrl`. A token row is reused only when `serverUrl` matches. The file mode is `0600`. `opencode mcp logout` deletes the row. The HTTP pair is `DELETE /mcp/:name/auth`.

### Commands and HTTP

| Action | CLI | HTTP on the instance | Writes config |
| --- | --- | --- | --- |
| List and connect status | `opencode mcp list` | `GET /mcp` | no |
| Add a server | `opencode mcp add` | `POST /mcp` with `{ name, config }` | CLI yes, HTTP no |
| Start OAuth, return URL | `opencode mcp auth <name>` opens a browser | `POST /mcp/:name/auth` returns `{ authorizationUrl, oauthState }` | no |
| Complete OAuth | the local callback, or the CLI waits | `POST /mcp/:name/auth/callback` with `{ code }`, or `POST /mcp/:name/auth/authenticate` which waits | tokens only |
| Forget tokens | `opencode mcp logout` | `DELETE /mcp/:name/auth` | no |
| Connect / disconnect this process | | `POST /mcp/:name/connect`, `POST /mcp/:name/disconnect` | no |
| OAuth diagnosis | `opencode mcp debug <name>` | | no |

Non-interactive `opencode mcp add <name>` always writes the global config (`--url` for remote, arguments after `--` for local, `--env KEY=VALUE`, `--header KEY=VALUE`). It refuses to mix `--env` with a remote server or `--header` with a local one. Interactive add, in a git project, asks whether to write the project file or the global file. Answering "no" to its OAuth question still omits `oauth`, and omitted `oauth` means OAuth stays on. Setting `oauth: false` is a config edit, not a result of that prompt.

`POST /mcp` stores the server on the instance and connects it. A restart drops it unless a config file also has it. `connect` forces `enabled: true` for that call. `disconnect` closes the client and sets status `disabled` in memory. Neither rewrites the file, so the next process start follows `enabled` from disk again.

Per-agent enablement is the `tools` map, not a second MCP list. Tool names are the sanitized `server_tool` form, and the glob language is `*` and `?` only. `"tools": { "sentry_*": false }` turns that server's tools off for the default agent. An agent can set the same glob back to true. Disabling the tool does not stop the child process. `enabled: false` does.

## v2, recorded so it is not implemented early

`specs/v2/config.md` in the 1.18.32 tree, and the `v2.0.16` tag, change the three keys:

| 1.18.32, what the installed CLI loads | v2 spec |
| --- | --- |
| `plugin`: string or `[string, options]` | `plugins`: string or `{ package, options? }`. File paths and `file://` specs are dropped from this field. Directory discovery stays. |
| `skills`: `{ paths?, urls? }` | `skills`: one array of directory paths and `http(s)` URLs |
| `mcp`: map of servers, `enabled`, one `timeout` number | `mcp.servers`, `disabled` instead of `enabled`, `mcp.timeout.startup` and `mcp.timeout.request`, per-server overrides. OAuth fields become snake_case (`client_id`, `callback_port`, `redirect_uri`). |
| `command` | Removed. The spec says those workflows are skills. |
| `experimental.mcp_timeout` | `mcp.timeout.request` |

`packages/core/src/config/plugin/mcp.ts` on `v2.0.16` already reads `mcp.servers` and merges a document-level timeout into each server. `SkillV2` globs `{*.md,**/SKILL.md}`, so a markdown file sitting directly in a skill directory counts, and a missing `name` falls back to the filename. The 1.18.32 `opencode` binary contains `opencode debug v2`, and it contains this core code. The commands that manage the feature today (`mcp`, `plugin`, `debug skill`) and the config schema they write are the 1.18 shapes. GitHub's latest release is still `v1.18.32`.

Implement against 1.18 until a v2 binary is the candidate. A reader that accepts both shapes will mis-handle `enabled` versus `disabled` and will look up servers in the wrong place.

## Where the public docs disagree with 1.18.32

Checked against <https://opencode.ai/docs/plugins/>, <https://opencode.ai/docs/skills/>, and <https://opencode.ai/docs/mcp-servers/> on 2026-09-24, and against tag `v1.18.32`.

| Docs | Loader |
| --- | --- |
| npm plugins install with Bun into `~/.cache/opencode/node_modules/` | `@npmcli/arborist` into `~/.cache/opencode/packages/<spec>`, `ignoreScripts: true` |
| Plugin directories are `.opencode/plugins/` and `~/.config/opencode/plugins/` | Also `plugin/` (singular) and `~/.opencode/plugin(s)/`. Extensions `ts` and `js` only, one level deep. |
| Skill `name` must match the directory and the hyphenated lowercase regex. `description` is required. | `name` is any string. `description` is optional. No directory check. Undescribed skills stay out of the prompt and stay in `GET /skill`. |
| Skill search paths listed on the page omit `skills.paths` and `skills.urls` | Both are loaded. URLs need an `index.json`. |
| MCP `timeout` defaults to 5000 ms | Connect uses 30000 ms when `timeout` is omitted. `experimental.mcp_timeout` is a separate tool-call fallback. |
| `opencode mcp add` is described as config | Non-interactive add writes the global file only. `POST /mcp` does not write a file. |
| OAuth tokens in `~/.local/share/opencode/mcp-auth.json` | Matches the code, mode `0600`, keyed by server name, reused only when `serverUrl` matches. |

The docs are right about the shape a person should write: `plugin` array, `mcp` map of `local` and `remote`, `SKILL.md` under the six well-known directories, OAuth on by default, `oauth: false` for a header token, and tool globs for per-agent MCP enablement.

## Evidence

| Fact | Value |
| --- | --- |
| Installed CLI | `~/.opencode/bin/opencode`, reports `1.18.32` |
| GitHub latest release | `v1.18.32`, published 2026-09-21 |
| Adapter candidate | `1.18.16` in `support/agents.json`, `baseline-pending` |
| v2 tags | `v2.0.0` (2026-09-11) through `v2.0.16` (2026-09-24). Not the GitHub latest release. |
| Source read | tag `v1.18.32` for the loader, tag `v2.0.16` for `packages/core/src/config/plugin/mcp.ts` and `packages/core/src/plugin/hooks.ts` |
| Local config opened | `~/.config/opencode/opencode.json` (empty `mcp` map) and `package.json` (`@opencode-ai/plugin` 1.18.23). No skill or plugin directory there. |
| Commands not run | `opencode debug skill` (prints skill bodies), `opencode mcp list` (connects servers), `opencode debug config` (prints resolved config, including substituted secrets) |

Primary files at `v1.18.32`:

- Plugin runtime: [`packages/opencode/src/plugin/index.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/plugin/index.ts), [`loader.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/plugin/loader.ts), [`install.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/plugin/install.ts), [`shared.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/plugin/shared.ts)
- Plugin types: [`packages/plugin/src/index.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/plugin/src/index.ts)
- Config merge and schema: [`packages/opencode/src/config/config.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/config.ts), [`paths.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/paths.ts), [`packages/core/src/v1/config/config.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/v1/config/config.ts), [`mcp.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/v1/config/mcp.ts), [`plugin.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/v1/config/plugin.ts), [`skills.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/v1/config/skills.ts)
- npm install: [`packages/core/src/npm.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/core/src/npm.ts)
- Skills: [`packages/opencode/src/skill/index.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/skill/index.ts), [`discovery.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/skill/discovery.ts), [`tool/skill.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/tool/skill.ts)
- MCP: [`packages/opencode/src/mcp/index.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/mcp/index.ts), [`auth.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/mcp/auth.ts), [`catalog.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/mcp/catalog.ts), [`cli/cmd/mcp.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/cli/cmd/mcp.ts), [HTTP handlers](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts)
- Flags: [`packages/opencode/src/effect/runtime-flags.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/effect/runtime-flags.ts)
- v2 spec, present in the 1.18.32 tree: [`specs/v2/config.md`](https://github.com/anomalyco/opencode/blob/v1.18.32/specs/v2/config.md)

Surface already models `GET /skill`, `GET /api/skill`, the MCP HTTP group, `plugin.added`, and `mcp.tools.changed` for 1.18.16. Those records stay as they are. Promoting them, or retargeting the candidate at 1.18.32, is a separate transaction.
