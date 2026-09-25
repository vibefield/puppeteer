# Pi plugins, skills, and MCP servers

| Field | Value |
| --- | --- |
| Status | Research, not a Surface claim and not a support-ledger change |
| Probed | **2026-09-24**, installed Pi **0.87.1** (`@earendil-works/pi-coding-agent`, npm package dated 2026-09-22) |
| Upstream | [earendil-works/pi](https://github.com/earendil-works/pi), package directory `packages/coding-agent` |
| Question | How does the Pi coding agent manage plugins, skills, and MCP servers, and what should Puppeteer treat as native behavior? |

## Outcome

Pi 0.87.1 has one stable customization loader and no MCP client.

The word **plugin** is not a type in the published CLI. What people install with `pi install` is a **package**. A package is a directory that can contain four resource kinds: **extensions**, **skills**, **prompt templates**, and **themes**. An extension is TypeScript or JavaScript that runs inside the Pi process. A skill is a Markdown instruction file. Prompt templates and themes travel through the same loader and are only mentioned here where they share its rules.

MCP servers are not discovered, spawned, or named by Pi itself. On 2026-01-29 the maintainer closed the in-tree MCP example ([earendil-works/pi#563](https://github.com/earendil-works/pi/issues/563)) because the third-party package `pi-mcp-adapter` already connects Pi to MCP. A second package, `pi-mcp-extension`, does the same job by registering one Pi tool per MCP tool. Either package is an ordinary extension. Its config files, child processes, and `/mcp` command are that extension's, and a Puppeteer profile that only sets `PI_CODING_AGENT_DIR` does not automatically contain them.

A second, experimental meaning of "plugin" exists in the source tree: Chord facets (`session` and `tui`) selected with `PI_EXPERIMENTAL=1` and `./pi-test.sh`. That runtime was removed from the npm package after 0.85.0. It is not what `pi install` manages.

Puppeteer's Pi adapter should keep hosting the native TUI with the user's extensions and skills loaded. It should keep reading the session JSONL as the event rail. Extension and MCP lifecycle are not a second rail.

## What the published CLI actually loads

`DefaultResourceLoader.reload()` asks `DefaultPackageManager.resolve()` for extensions, skills, prompts, and themes, then loads extensions with jiti and skills with `loadSkills()`. The same reload runs at startup and again on `/reload`.

```text
PI_CODING_AGENT_DIR/settings.json     user packages and extra paths
<cwd>/.pi/settings.json               project packages and extra paths
        │
        ▼
package manager
  npm:   <agent>/npm/node_modules/<name>     or <cwd>/.pi/npm/...
  git:   <agent>/git/<host>/<path>           or <cwd>/.pi/git/...
  local: path relative to the settings file
        │
        ▼
auto-discovered directories (after project trust)
  <agent>/extensions|skills|prompts|themes
  ~/.agents/skills
  <cwd>/.pi/extensions|skills|prompts|themes
  <cwd> and ancestors /.agents/skills     stop at the git root
        │
        ▼
one extension runtime (in-process) + one skill list in the system prompt
```

`PI_CODING_AGENT_DIR` replaces `~/.pi/agent`. Puppeteer already sets it to `<profile>/agent`. Project files stay in the working directory. `~/.agents/skills` is resolved from `HOME`, not from the agent directory.

`--extension` / `-e` and `--skill` add paths for one process. `--no-extensions` / `-ne` and `--no-skills` / `-ns` drop discovered and settings-listed resources. Explicit `-e` and `--skill` paths still load. The Surface farm already uses those switches. The hosted TUI does not, which is the right split: a farm capture should be hermetic, a user's Pi session should be that user's Pi.

`pi config` edits the same settings arrays. Enable and disable are glob filters (`!pattern`, `+path`, `-path`), not a separate registry.

## Packages, which are the installable unit

Documented in `docs/packages.md`. Implemented in `dist/core/package-manager.js`.

| Command | Effect |
| --- | --- |
| `pi install <source>` | Install and append `settings.json` `packages` |
| `pi install <source> -l` | Same, into `<cwd>/.pi/settings.json` |
| `pi list` | Print configured package sources |
| `pi remove <source>` | Remove the settings entry |
| `pi update --extensions` | Reconcile installed packages |
| `pi update <source>` | Reconcile one package |
| `pi -e npm:@example/pi-tools` | Load for this process only |

`pi --help` still says "Install extension source". The settings key and the docs say package. One settings entry can contribute any mix of the four resource kinds.

### Source identity

| Source form | Identity used to dedupe | Where it lives |
| --- | --- | --- |
| `npm:@scope/name@1.2.3` | `npm:@scope/name` (version ignored) | `<scope>/npm/node_modules/@scope/name` |
| `git:github.com/owner/repo@v1`, or a GitHub URL | `git:<host>/<path>` (ref ignored; SSH and HTTPS match) | `<scope>/git/<host>/<path>` |
| `./local-package` or a file | absolute path, resolved from the settings file's directory | not copied |

`<scope>` is the agent directory, or `<cwd>/.pi` for a project install. A user-scoped npm package that is missing from the managed directory is still accepted from the legacy global npm root (`npm root -g`, or Bun's global install root) when that legacy directory exists. New installs go to the managed directory.

A project entry replaces the user entry of the same identity. `autoload: false` on the project entry is a filter delta over the user package, and both entries are kept. Versioned npm specs are pinned to a semver range. Git tags and commits are pinned. `pi update` reconciles the checkout and does not move a configured ref.

Missing npm and git packages are installed during `resolve()` unless `PI_OFFLINE=1` or `--offline` is set. The startup path calls `resolve()` with no skip callback, so opening Pi in a trusted project can run npm or git. `startup-ui.js` calls `resolve(async () => "skip")` only for the progress UI. A host that wants a listing must not call `resolve()` and must not shell out to `pi` in a way that reaches it.

Project package storage throws `Project is not trusted; refusing to access project package storage` until trust is granted. Managed paths are resolved under the install root and rejected if they escape it. The temporary directory for one-shot `-e npm:` / `-e git:` sources is `<agent>/tmp/extensions`, created mode `0700`.

### What a package may contain

Without a `pi` key, Pi reads conventional directories:

```text
my-pi-package/
├── package.json
├── extensions/     .ts / .js, or a subdirectory with index.ts / index.js
├── skills/         SKILL.md trees, plus loose .md only at this directory's root
├── prompts/        loose .md, not recursive
└── themes/         loose .json, not recursive
```

An explicit manifest replaces those conventions for the kinds it lists:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

The `pi-package` keyword is the gallery flag for [pi.dev/packages](https://pi.dev/packages). A settings object can narrow a package (`extensions`, `skills`, `prompts`, `themes`). Omitting a key loads that kind. `[]` loads none of that kind. Filters cannot reveal files the package did not declare.

Extensions import `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` from the host. The loader aliases those specifiers, including the old `@mariozechner/*` names, onto the running Pi. A package lists them as `peerDependencies` with `"*"`. Other dependencies belong in `dependencies` and are installed into that package's own `node_modules`. Two packages do not share one dependency instance.

`settings.npmCommand` replaces the npm binary used for install and update. The default is `npm`.

## Extensions, which are the executable customization

Documented in `docs/extensions.md`. Loaded by `dist/core/extensions/loader.js` through jiti, so a local `.ts` file needs no build step.

An extension is a module whose default export is a factory `(pi: ExtensionAPI) => void | Promise<void>`. Pi waits for an async factory before startup continues. The factory may register tools, commands, shortcuts, flags, providers, and renderers, and subscribe to lifecycle events. It must not start processes or sockets in the factory. Long-lived resources start in `session_start` and close in `session_shutdown`.

Discovery, from `collectAutoExtensionEntries`:

- A directory with `package.json` whose `pi.extensions` lists existing files loads those files.
- Otherwise `index.ts`, then `index.js`.
- A plain extensions directory loads each top-level `.ts` / `.js` file, and each subdirectory that itself resolves as above.
- Dot names and `node_modules` are skipped. `.gitignore`, `.ignore`, and `.fdignore` apply. Symlinks are followed.

User extensions live in `<agent>/extensions/`. Project extensions live in `<cwd>/.pi/extensions/` and load only after project trust. CLI `-e` paths load even under `--no-extensions`.

### What an extension is allowed to add

| API | Effect |
| --- | --- |
| `pi.on(event, handler)` | Observe or transform a lifecycle point. Returns an unsubscribe function. |
| `pi.registerTool(tool)` | A model-callable tool. TypeBox object parameters are required. `execute()` returns `{ content, details }`. |
| `pi.registerCommand(name, …)` | A `/` command. Command context can reload, switch sessions, and wait until idle. Lifecycle handlers cannot. |
| `pi.registerShortcut` / `pi.registerFlag` | A key or a CLI flag. Flags show up in `pi --help`. |
| `pi.registerProvider` | A model provider. |
| `pi.setActiveTools(names)` | Replace the active tool set. Unknown names are ignored. |
| `pi.appendEntry(type, data)` | A session journal entry that is not model context. |
| `pi.sendMessage` / `pi.sendUserMessage` | Content that can enter the conversation. |
| `ctx.ui` | Dialogs, notifications, widgets. Full UI in the TUI. A subset over RPC extension UI. None in JSON and print mode. |

The event list on `ExtensionAPI` in 0.87.1 is: `project_trust`, `resources_discover`, `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_compact_failed`, `session_shutdown`, `session_before_tree`, `session_tree`, `context`, `context_with_system`, `cache_warming_decision`, `before_provider_request`, `before_provider_headers`, `after_provider_response`, `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `ui_prompt_start`, `ui_prompt_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `model_select`, `thinking_level_select`, `tool_call`, `tool_result`, `user_bash`, `input`.

Handlers run in extension load order. A `tool_call` handler can change arguments or block the call. A handler error on `tool_call` blocks the tool. Other handler errors are reported and the run continues. `resources_discover` may return extra `skillPaths`, `promptPaths`, and `themePaths`. Those paths are appended after the loader's own list. `project_trust` is special: only user and CLI extensions are loaded for that event, and the first yes or no wins, before project extensions exist.

Tool names: the first extension to register a name keeps it (`getAllRegisteredTools`). That extension tool then replaces a built-in tool of the same name. An SDK `customTools` entry replaces both. Duplicate commands keep the first command's bare name; later ones are invoked as `name:2`, `name:3`. Duplicate flags keep the first. Duplicate shortcuts keep the last. Conflicts are diagnostics. Pi still loads every extension.

Extension tools start active unless `--tools`, `--exclude-tools`, `--no-tools`, or `--no-builtin-tools` says otherwise. `--no-builtin-tools` keeps extension tools. `--no-tools` disables both. `defaultTools` in settings lists built-ins only (`read`, `bash`, `edit`, `write` by default, from the larger set `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`).

An extension runs as the Pi user. It can read the prompt, tool calls, files, credentials, and session history. Pi does not sandbox it. `docs/security.md` says project trust is not that sandbox.

## Skills, which are instructions

Documented in `docs/skills.md`. Implemented in `dist/core/skills.js` and `formatSkillsForPrompt`. Pi follows the [Agent Skills](https://agentskills.io/specification) layout: a directory whose `SKILL.md` has YAML frontmatter and a Markdown body. Most invalid fields warn. Startup continues.

### Where a skill is found

| Location | Scope | Trust |
| --- | --- | --- |
| `<agent>/skills/**` | user | always |
| `~/.agents/skills/**` | user, shared with other agents | always, even when the agent directory is a Puppeteer profile |
| `<cwd>/.pi/skills/**` | project | project trust |
| `<cwd>` and ancestors `/.agents/skills/**`, stopping at the git root | project | project trust |
| `settings.json` `skills` array, user or project | path, resolved from the agent dir or from `.pi/` | project entries need trust |
| `--skill <path>` | this process | the path itself |
| paths returned from `resources_discover` | the extension that returned them | that extension must already be loaded |

`loadSkills()` is called with `includeDefaults: false`. The package manager has already turned default directories into explicit paths, so the skill loader does not scan them a second time.

Inside a Pi skill directory (`mode: "pi"`):

- A directory that contains `SKILL.md` is one skill. Children are not scanned.
- Loose `*.md` files count only as direct children of the scanned root, and only when frontmatter has a description.
- Dot directories and `node_modules` are skipped. Ignore files apply. Symlinks are followed.

Inside `~/.agents/skills` and project `.agents/skills` (`mode: "agents"`), `SKILL.md` behaves the same way. Loose Markdown is taken from subdirectories, not from the `skills` directory itself.

The skill `name` is frontmatter `name`, or the parent directory name. Pi warns when the name breaks the spec (lowercase, digits, hyphens, at most 64 characters, no leading, trailing, or doubled hyphen) and still loads the skill. A missing or empty description drops it. A name longer than 1024 characters in the description warns and still loads. Pi does not require the name to match the directory. `disable-model-invocation: true` is honored only as a boolean `true`.

`license`, `compatibility`, `metadata`, and `allowed-tools` are parsed as unknown frontmatter and then ignored. Pi does not pre-approve tools from a skill.

### How a skill reaches the model

At startup the system prompt gains a `<skills>` section, and only when `read` or `bash` is an active tool. The section lists name, description, and file location for skills that are not `disable-model-invocation`. The body stays on disk. The prompt tells the model to `read` that file (or to use `bash` when `read` is off) and to resolve relative paths against the skill directory.

`/skill:<name> [args]` is expanded by `AgentSession._expandSkillCommand` before the user message is sent. The expansion is the Markdown body, frontmatter removed, wrapped in `<skill name="…" location="…">`, with any arguments appended. `enableSkillCommands` (default `true`) only controls whether those commands appear in `/` autocomplete. A typed `/skill:name` still expands when the setting is false. An unknown name is left as typed text. `/reload` picks up edits.

Name collisions keep the first skill in this order:

1. Skills that came in through `--extension` (a package passed with `-e`).
2. Enabled resources sorted by precedence: project settings paths, then project auto-discovery (`.pi/skills`, then `.agents/skills` from the working directory upward), then user settings paths, then user auto-discovery (`<agent>/skills`, then `~/.agents/skills`), then package resources.
3. `--skill` paths.
4. Paths added later by `resources_discover`.

Same file through two symlinks is skipped. A second name produces a collision diagnostic and is not loaded. So `--skill` adds a skill whose name is free, and loses when the name is already taken. `--no-skills` removes the discovered set, and `--skill` still loses to a skill that arrived via `--extension`.

Skills are not executables. A skill can tell the model to run `scripts/` next to `SKILL.md`. Those commands go through the normal `bash` tool, as the Pi user, after trust has already decided the skill may be shown.

## Project trust, the only gate

Documented in `docs/security.md`. Implemented in `dist/core/trust-manager.js` and `SettingsManager.loadFromStorage`.

Trust is required when the working directory has any of `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, or a `.agents/skills` directory in the working directory or an ancestor. `~/.agents/skills` does not count, including when the working directory is the home directory. An empty `.pi` directory does not count.

The decision order is `--approve` / `--no-approve`, then a `project_trust` handler on a user or CLI extension, then the nearest saved answer in `<agent>/trust.json`, then global `defaultProjectTrust` (`ask` by default; the key is ignored in project settings). Interactive mode can prompt. Print, JSON, and RPC cannot: `ask` and `never` skip project resources, `always` loads them.

While trust is false, project settings load as `{}`. Project packages are not installed or read. Project `.pi` resources and ancestor `.agents/skills` are not discovered. User resources and `~/.agents/skills` still load. `AGENTS.md`, `AGENTS.override.md`, and `CLAUDE.md` still load from the agent directory and from ancestors. `sessionDir` is read before the trust decision so Pi can find the session file. Declining trust does not undo that read.

Trust does not restrict `bash`, `edit`, or an extension tool. It decides which project code and instructions are loaded into the process.

## MCP, which Pi does not manage

Searched the 0.87.1 package `docs/`, `dist/*.d.ts`, and `dist/core` for an MCP client, an `mcp.json` loader, or an `mcpServers` setting. There is none. `pi --help` has no MCP flag. The system prompt's "read the docs" section lists extensions, skills, packages, themes, and providers. It does not list MCP.

Issue [#563](https://github.com/earendil-works/pi/issues/563) (opened 2026-01-08, closed completed 2026-01-29 by @badlogic) specified an official example that would read `~/.pi/agent/mcp.json` and `<cwd>/.pi/mcp.json`, connect with the MCP TypeScript SDK, and register tools named `mcp_<server>_<tool>`. The closing comment points at [npm:pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter) and says an in-tree example is unnecessary. Comments on that issue also point at CLI bridges (`mcp-cli`, `mcporter`) as alternatives to putting MCP in the harness.

Two installed shapes matter if a user says "Pi's MCP":

### `pi-mcp-adapter` (the package the maintainer pointed at)

Installed with `pi install npm:pi-mcp-adapter`. It is an extension. It registers a small proxy tool, `mcp`, instead of one tool per server, specifically so server catalogs do not occupy the context window. The model calls `mcp({ search })` and then `mcp({ tool, args })`. Servers are lazy unless `lifecycle` is `eager`, `keep-alive`, or `lazy-keep-alive`. `directTools` can promote selected MCP tools to real `registerTool` entries. `/mcp` is the extension's own command.

Config precedence in its README, later entries winning:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `$PI_CODING_AGENT_DIR/mcp.json` (default `~/.pi/agent/mcp.json`)
5. `<cwd>/.mcp.json`
6. `<cwd>/.pi/mcp.json`

The Pi-owned files are overrides and adapter settings. The shared files are the ones other agents already use. Host configs (Claude, Cursor, Codex, and others) are not loaded unless `settings.hostConfigDiscovery` is `"on"` or the user imports them with `/mcp setup`. Disable flags for a server are written to `<cwd>/.pi/mcp.json`, not back into the shared file.

The same extension can also pull MCP servers from a Pi package's `pi.mcp` manifest, from an explicit local Claude plugin directory (`claudePlugins`, which can also contribute `SKILL.md` files through Pi's `resources_discover`), and from another extension that emits `pi-mcp-adapter:runtime-register:v1` on the shared event bus. OAuth tokens go to the OS credential store, keyed by server name and bound to the server URL. Stdio servers inherit the host environment unless `inheritEnv: false`. That flag is not a sandbox.

None of this is Pi core. A future adapter release can change the file list. Puppeteer cannot treat those paths as a Pi surface.

### `pi-mcp-extension` (the direct-tool bridge)

Installed with `pi install npm:pi-mcp-extension` (1.5.0 on npm as of this probe). It registers each MCP tool on the Pi agent. Its own README uses `~/.pi/agent/mcp.json` and `<cwd>/.pi/mcp.json`, with the project file replacing a same-named server. The published `src/config.ts` joins `homedir()` with `.pi/agent/mcp.json`. It does not read `PI_CODING_AGENT_DIR`. Under a Puppeteer profile that extension would still open the real home directory's `mcp.json`.

Tool names default to an `mcp_<server>_<tool>` prefix. That is this package's convention, the same shape issue #563 sketched, and it is not a protocol Pi parses. A tool call still lands in the session journal as an ordinary extension tool execution.

### Other directions that are not "Pi managing MCP"

| Thing | What it is |
| --- | --- |
| `pi-mcp-export` | Serves a Pi extension as an MCP server for other clients |
| `pi-mcp-server` | Serves the Pi agent itself as an MCP tool |
| `@spences10/pi-mcp` | Another third-party Pi package that adds MCP |
| Agent Plugins / Claude plugin bundles | Formats `pi-mcp-adapter` can be told to read. Pi's loader does not read `plugin.json` |

## The experimental Chord plugin, which is not installed Pi

`examples/plugins/pi-example-plugin/` ships inside the 0.87.1 npm tarball as an example. Its README says Pi asks Chord to build `src/session.ts` and `src/tui.ts` into a server-owned plugin cache. `package.json` may override that with a `chord.facets` map. Selection is `PI_EXPERIMENTAL=1 ./pi-test.sh server -e <package>` or the same flag on `pi-test.sh client`. The chosen facets are stored with one Session. `/reload` rebuilds them. The server profile defaults to `~/.pi/server` (`PI_SERVER_DIR`).

Changelog 0.85.1 (2026-09-05), fixing a 0.85.0 publish mistake: the `client` and `experimental/plugin` subpaths and the server/client commands are source-only. The supported SDK and stdio RPC API are unchanged. The experimental service table (`packages/coding-agent/src/experimental/services/README.md` on `main`) describes `PresentationPlugins`, `SessionPlugins`, and a facet host. It is a different runtime from `DefaultResourceLoader`. Puppeteer should not record it as Pi's plugin manager until it is part of the published `pi` binary.

## What a Puppeteer profile isolates

`PI_CODING_AGENT_DIR=<profile>/agent` moves the user half of the loader:

| Follows the profile | Stays outside it |
| --- | --- |
| `<agent>/settings.json` packages, extension paths, skill paths | `~/.agents/skills` |
| `<agent>/extensions`, `skills`, `prompts`, `themes` | `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json` |
| `<agent>/npm`, `<agent>/git`, `<agent>/tmp/extensions` | project `.pi/**`, `.mcp.json`, ancestor `.agents/skills` |
| `<agent>/trust.json`, `auth.json`, `models.json` | `AGENTS.md` / `CLAUDE.md` in the working tree |
| Pi-owned `mcp.json` when an extension honors `PI_CODING_AGENT_DIR` | `pi-mcp-extension`'s hardcoded `~/.pi/agent/mcp.json` |
| | OS credential-store entries used by `pi-mcp-adapter` OAuth |

Project trust is stored in the profile's `trust.json` and is keyed by canonical working-directory path. Two profiles can disagree about the same checkout. A saved `true` loads that checkout's extensions the next time that profile runs there. `--no-approve` is the one-process override. The adapter's native TUI launch does not pass it.

Context files are instructions, not skills, and they load without trust. They are the wrong place to look for the skill list.

## What Puppeteer should do with this

The 0.84.3 ground truth already records `agent/extensions/**` and `agent/skills/**` as artifacts, and the findings file already says the adapter does not treat extensions or package trees as event rails. That boundary still matches 0.87.1. Extension-defined `custom` and `custom_message` journal entries remain writer-backed records of whatever an extension chose to append. An MCP tool call, when an extension registered it with `registerTool`, is already a normal tool event. The name prefix is not evidence of MCP.

Concrete rules for later work:

1. Keep the hosted TUI on the user's real resource loader. Do not pass `--no-extensions` or `--no-skills` on an interactive profile session. Do keep those switches on hermetic farm captures.
2. Do not add a plugin, skill, or MCP observation source. There is no native event for "extension loaded" or "MCP server connected". Scraping `/mcp` or the system prompt would be terminal text.
3. Do not shell out to `pi list`, `pi install`, or a normal `pi` startup to inventory a profile. Startup `resolve()` installs missing npm and git packages unless the process is offline. Read `settings.json` and the conventional directories if a future inventory is required, and label it as a file listing, not as the post-trust runtime set.
4. Do not teach the profile service about MCP. The stable profile fact is still the subscription in `auth.json` plus `defaultProvider`. MCP config is extension-owned, split across shared files and the agent directory, and one of the popular extensions ignores `PI_CODING_AGENT_DIR`.
5. Do not model Chord facets, `PI_EXPERIMENTAL`, or `~/.pi/server` as the plugin system. They are not in the 0.87.1 CLI.
6. If profile isolation is tightened later, the gap is `~/.agents/skills` and the shared MCP files, which are resolved from the home directory on purpose. Closing that gap means a Pi change or a private `HOME`, not a second Puppeteer loader.
7. Treat extension and skill content as code the Pi user will run. Project trust is the vendor's gate. Puppeteer should not grant it by writing `trust.json` or passing `--approve` unless the user is taking that decision in the Pi UI.

## Sources

Installed `@earendil-works/pi-coding-agent@0.87.1`:

- `docs/extensions.md`, `docs/skills.md`, `docs/packages.md`, `docs/settings.md`, `docs/configuration.md`, `docs/security.md`, `docs/cli.md`, `docs/slash-commands.md`, `docs/how-pi-works.md`, `docs/environment-variables.md`, `docs/index.md`
- `examples/plugins/pi-example-plugin/README.md`, `examples/README.md`
- `dist/core/skills.js`, `dist/core/system-prompt.js`, `dist/core/resource-loader.js`, `dist/core/package-manager.js`, `dist/core/pi-manifest.d.ts`
- `dist/core/extensions/loader.js`, `dist/core/extensions/runner.js`, `dist/core/extensions/types.d.ts`
- `dist/core/agent-session.js` (`_expandSkillCommand`, `_refreshToolRegistry`, `extendResourcesFromExtensions`)
- `dist/core/settings-manager.js`, `dist/core/trust-manager.js`, `dist/config.js` (`getAgentDir`)
- `dist/main.js` (CLI paths and trust)
- `CHANGELOG.md` 0.85.0 / 0.85.1 (experimental plugin subpath removed from npm)
- `pi --help` on this machine

Upstream:

- [earendil-works/pi#563](https://github.com/earendil-works/pi/issues/563) and the 2026-01-29 closing comment naming `pi-mcp-adapter`
- [packages/coding-agent/src/experimental/services/README.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/experimental/services/README.md) on `main`
- [pi-mcp-adapter README](https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md), fetched 2026-09-24
- [pi-mcp-extension README](https://github.com/irahardianto/pi-mcp-extension/blob/main/README.md) and `src/config.ts` (`homedir()` + `.pi/agent/mcp.json`)
- [Agent Skills specification](https://agentskills.io/specification), as cited by Pi's `docs/skills.md`

This repository:

- `packages/surface/vendors/pi/findings.md` — extensions and skills are artifacts, not event rails; farm uses `--no-extensions` and `--no-skills`
- `packages/adapter-pi/src/services/profiles.ts` — `PI_CODING_AGENT_DIR` binds `<profile>/agent`
- `draft/PI-PROFILE-IDENTITY.md` — the same profile root, for credentials rather than resources
