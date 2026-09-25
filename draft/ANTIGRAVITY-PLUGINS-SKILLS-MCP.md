# Antigravity plugins, skills, and MCP servers

| Field | Value |
| --- | --- |
| Status | Research report. Not a support claim and not Surface evidence. |
| Date | 2026-09-24 |
| Probed build | `agy` 1.2.11 at `~/.local/bin/agy`, darwin-arm64 Mach-O |
| Support ledger | `support/agents.json` candidate `1.1.20`, status `baseline-pending` |
| Related | [ANTIGRAVITY-ACCOUNT-IDENTITY.md](./ANTIGRAVITY-ACCOUNT-IDENTITY.md), [ANTIGRAVITY-ADAPTATION-PLAN.md](./ANTIGRAVITY-ADAPTATION-PLAN.md), adapter `services/profiles.ts` |

This report answers one question: how does Antigravity actually install,
discover, enable, and isolate plugins, skills, and MCP servers, across the
CLI, the IDE, and Antigravity 2.0?

The short version is that those three surfaces share one customization
directory, `~/.gemini/config/`, when they share a home directory. Plugins are
the package. Skills and MCP servers are both things a plugin can contain and
things a user can drop in beside it. The `agy plugin` and `agy mcp` subcommands
manage only the user-level copies. They do not list workspace files, and they
do not list a plugin that was copied into place by hand.

Anything an adapter starts to rely on has to be recaptured as a Surface claim
and digest-locked before promotion. The support candidate is still 1.1.20.
This probe is 1.2.11, and several public pages still describe the layout from
before CLI 1.0.2.

## Recommendation

Keep plugins, skills, and MCP out of the adapter until a Surface pass covers
the 1.2.11 layout. Use the file locations below when that pass is designed.

| Decision | What to rely on |
| --- | --- |
| Customization root | `<home>/.gemini/config/` |
| CLI private store | `<home>/.gemini/antigravity-cli/` holds sessions, `settings.json`, the OAuth file, and the builtin skill cache. It is not where `agy plugin install` writes. |
| Profile boundary | `PUPPETEER_ANTIGRAVITY_HOME` becomes `HOME`. Both directories follow that home. A managed profile does not see plugins or MCP servers installed under the real user home. |
| Inventory command | `agy plugin list` prints `import_manifest.json` only. `agy mcp list` prints the user-level `mcp_config.json` only. Workspace `.agents/` files and hand-copied plugin directories are invisible to both. |
| Commands that write | Do not call `plugin uninstall`, `plugin disable`, or `mcp disable` from a probe. Uninstall exits 0 for an unknown name and deletes `config/plugins/<name>` when that directory exists. `mcp disable` of an unknown name creates a disabled stub with no command. |
| Print mode | `agy -p /mcp` answers without a model turn. On a home with no credential, `agy -p /skills`, `/plugins`, `/hooks`, and `/help` stop in Google OAuth before they list anything. |

A managed profile that should carry the same plugins as Antigravity 2.0 has
to carry `<dataRoot>/.gemini/config`, not only the CLI store the observation
root already names. A profile that should stay isolated can leave that
directory empty. Isolation is a product choice. It is not implied by watching
`antigravity-cli`.

## Three products, one customization root

Google documents three surfaces that load the same kinds of files:

| Surface | Private app data | Shared customizations |
| --- | --- | --- |
| Antigravity 2.0 | `~/.gemini/antigravity/` | `~/.gemini/config/` and `<workspace>/.agents/` |
| Antigravity CLI (`agy`) | `~/.gemini/antigravity-cli/` | same shared roots |
| Antigravity IDE | `~/.gemini/antigravity-ide/` | same shared roots |

The CLI private store on this machine contains the OAuth file, `settings.json`
(`trustedWorkspaces` only), conversations, logs, and `builtin/skills/`. It
does not contain `plugins/`, `skills/`, or `mcp_config.json`.

The shared directory on this machine contains `config.json`, an empty
`mcp_config.json`, and `projects/`. It has no `plugins/`, `skills/`, or
`hooks.json`. `agy plugin list` and `agy mcp list` both report nothing
installed. That matches the files.

`packages/adapter-antigravity` binds a profile by turning
`PUPPETEER_ANTIGRAVITY_HOME` into `HOME` and reads identity from
`<home>/.gemini/antigravity-cli/antigravity-oauth-token`. The driver does not
mention plugins, skills, or MCP. A disposable `HOME` used for the probes below
received every new plugin and MCP file under that home's `.gemini/config/`.
The real `~/.gemini` mtimes did not change.

## Where each kind of file lives

Paths in the "1.2.11" column were either written by the disposable-home probe
or are present as path strings inside the 1.2.11 binary. The public docs
column is what the site says on 2026-09-24. Several CLI pages still describe
the directory `agy plugin install` used before 1.0.2.

| Kind | Scope | 1.2.11 location | Public docs still also say |
| --- | --- | --- | --- |
| Installed plugin | user | `~/.gemini/config/plugins/<name>/` | `~/.gemini/antigravity-cli/plugins/<name>/` on the CLI plugins and features pages |
| Drop-in plugin | user | same `config/plugins/<name>/`, not recorded in the import manifest | 2.0 and IDE pages already say `~/.gemini/config/plugins/` |
| Drop-in plugin | workspace | `<workspace>/.agents/plugins/<name>/` | same, plus legacy `.agent/plugins/` and `_agents/plugins/` |
| Import ledger | user | `~/.gemini/config/import_manifest.json` | features page puts this file under `antigravity-cli/` |
| Plugin on/off | user | `~/.gemini/config/config.json` key `plugins` | embedded CLI guide, confirmed by `plugin enable` / `plugin disable` |
| Skill | workspace | `<workspace>/.agents/skills/<name>/SKILL.md` | same; `.agent/skills` still accepted |
| Skill | user, shared | `~/.gemini/config/skills/<name>/SKILL.md` | CLI skills page still says `~/.gemini/antigravity-cli/skills/` |
| Skill | shipped with the CLI | `~/.gemini/antigravity-cli/builtin/skills/<name>/SKILL.md` | changelog 1.1.16 calls these builtin in `/skills` JSON |
| Extra skill roots | either | `.agents/skills.json` and the same schema globally | changelog 1.2.10; the schema is embedded in the binary |
| MCP servers | user | `~/.gemini/config/mcp_config.json` | migration and MCP pages agree; an older CLI page still says `antigravity-cli/mcp_config.json` |
| MCP servers | workspace | `<workspace>/.agents/mcp_config.json` | same |
| MCP servers | inside a plugin | `<plugin>/mcp_config.json` | same; `mcp.json` is copied and then ignored |
| Hooks | user | `~/.gemini/config/hooks.json` | changelog 1.0.8 moved `/hooks` off `antigravity-cli/hooks.json` |
| Hooks | workspace | `<workspace>/.agents/hooks.json`, after the folder is trusted | Surface findings for 1.1.12 |
| Hooks | inside a plugin | `<plugin>/hooks.json` | same |
| Rules | user | `~/.gemini/config/rules/*.md`, plus `~/.gemini/AGENTS.md` and `GEMINI.md` | CLI page also lists `antigravity-cli/rules/` |
| Rules | workspace | `AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md` | same |
| Agents | user / workspace / plugin | `~/.gemini/config/agents/`, `.agents/agents/`, `<plugin>/agents/` | subagent docs |

The 1.2.11 binary contains `.gemini/config/plugins/`, `.gemini/config/skills/`,
`.gemini/config/mcp_config.json`, and `.gemini/config/hooks.json`. It does not
contain the strings `antigravity-cli/plugins` or `antigravity-cli/skills`.
Changelog 1.0.2 is the point where `agy plugin` stopped installing into the
private application directory and started installing into `~/.gemini/config/`.

`https://antigravity.google/schemas/v1/plugin.json` returns 404. The schema
printed on the plugins page is stricter than the CLI. The page requires `name`
and rejects extra fields. `agy plugin validate` also requires `name`, and it
accepts `"disabled": true`.

## Plugins

A plugin is a directory whose marker is `plugin.json`. The CLI copies the
whole directory. On 1.2.11 these pieces are recognized:

```text
<plugin>/
├── plugin.json          # required; name matches ^[a-zA-Z0-9-_]+$
├── mcp_config.json      # MCP servers, counted as mcpServers
├── mcp.json             # copied, not counted
├── hooks.json
├── skills/<name>/SKILL.md
├── commands/<name>.md   # reported as "converted to skills"; left in commands/
├── agents/<name>.md
├── rules/<name>.md      # copied; omitted from the import manifest component list
└── sidecars/<id>/sidecar.json   # Antigravity 2.0 background process, separate from MCP
```

`plugin.json` in the embedded CLI guide allows `name` to default to the
directory name and allows `"disabled": true`. A fresh install of a manifest
that sets `disabled: true` leaves `config.json` without a `plugins` entry.
The embedded guide says a missing entry falls back to the manifest, so a
plugin that ships disabled stays off until `agy plugin enable`. An entry that
does exist wins over a later change to the manifest. Changelog 1.1.11 says
enablement is seeded once and is not re-read from `"disabled": true` on
upgrade. This probe saw the seed written by `enable` and `disable`, not by
`install`.

### Commands

`agy --help` lists `plugin` and `plugins` as the same command.

| Command | What 1.2.11 did in a disposable home |
| --- | --- |
| `plugin list` | Prints `{ "imports": [ ... ] }` from `config/import_manifest.json`. With no file and no imports, prints `No imported plugins.` A directory placed by hand under `config/plugins/` does not appear. |
| `plugin validate <dir>` | Read-only. Counts skills, agents, commands, `mcp_config.json` servers, and hooks. Exit 0 on success. Missing `name` fails with `plugin.json missing name`. |
| `plugin install <dir>` | Copies the directory to `config/plugins/<plugin.json name>/`. The directory name on disk follows the manifest name, not the source folder name. Appends an import whose `source` is `antigravity`. Does not write `config.json`. Refuses to install a plugin from its own installed directory (`source and destination are the same directory`). A local git checkout is copied, including `.git`, and the source field stays `antigravity`. |
| `plugin install <url>` and `plugin@marketplace` | Help text and the binary string `Cloning plugin from %s...` describe this. This probe did not clone a remote URL. |
| `plugin enable` / `plugin disable <name>` | Writes `config.json` as `plugins.<name>.enabled` true or false. |
| `plugin uninstall <name>` | Exit 0 even when the name was never installed. Removes `config/plugins/<name>`, the matching import row, and the `config.json` entry. A same-named directory under `antigravity-cli/plugins/` was left in place. |
| `plugin import gemini` | Reads `~/.gemini/extensions/<name>/`. A fixture with `gemini-extension.json` was staged to `config/plugins/gem-ext/` and given a generated `plugin.json`. A Markdown file in `commands/` was parsed as TOML and rejected; the import still exited 0, and the import manifest did not gain a `gem-ext` row. |
| `plugin import claude` | Reads one level of `~/.claude/plugins/<name>/.claude-plugin/plugin.json`. That fixture imported with `source: "claude-code"`. A `plugin.json` sitting directly in the plugin directory was ignored. A plugin nested under `plugins/cache/...` was ignored. |
| `plugin link <marketplace> <target>` | `unknown marketplace: demo-market`. This probe did not find a local file that registers marketplace names. |

There is no `agy plugin` flag for workspace scope. Workspace plugins are
discovered from `.agents/plugins/` when a session starts. Changelog 1.2.11
says a plugin placed directly in `config/plugins/` whose MCP server needs
configuration variables now starts disabled, matching plugins installed
through the interactive `/plugin` panel.

Skill slash commands from a plugin are namespaced. Changelog 1.2.7 fixed a
double prefix (`/<plugin>:<plugin>:<skill>`) when the skill's own frontmatter
name already included the plugin name, and fixed short-name collisions between
plugins. Changelog 1.2.2 namespaces plugin MCP servers as `<plugin>_<server>`
so they do not collide with each other or with `mcp_config.json`.

## Skills

A skill is a directory with a `SKILL.md`. The frontmatter the skills page
documents is:

| Field | Required | Role |
| --- | --- | --- |
| `name` | no | Defaults to the directory name. Lowercase and hyphens. |
| `description` | yes | What the agent sees when deciding whether to load the skill. |
| `metadata.icon` | no | Changelog: emoji shown in `/skills` and in slash-command completion. |

Optional `scripts/`, `examples/`, and `resources/` sit beside `SKILL.md`.
The body is instructions. The agent is supposed to see names and descriptions
first and read the body only when the skill is selected. That is the
progressive-disclosure rule in the embedded CLI guide. This probe did not
watch a model turn load a skill.

There is no `agy skills` subcommand. `agy help skills` returns
`unknown subcommand: skills`. Management is the filesystem, plus the TUI:

| Action | Surface |
| --- | --- |
| Browse | `/skills` in the TUI |
| Reload without restarting | `/skills reload` since 1.2.4 |
| Invoke | `/<skill-name>` in the prompt. Print mode expands that unless `--disable-slash-commands` is set. |
| List as JSON | Changelog 1.1.16 says `agy -p /skills --output-format json` includes a `builtin` flag. On a home with no credential, that command blocks in OAuth and does not print the list. |

Workspace skills live in `.agents/skills/` and are meant to be committed.
Global skills shared by CLI, IDE, and Antigravity 2.0 live in
`~/.gemini/config/skills/`. The migration page still tells Gemini CLI users to
move `~/.gemini/skills/` to `~/.gemini/antigravity-cli/skills/`. That private
path is the pre-move location. The binary's discovery guide points global
discovery at `~/.gemini/config/`.

`skills.json` (and the same shape for `plugins.json`, `rules.json`, and
`agents.json`) registers extra directories. Changelog 1.2.10 changed a
directory entry so it loads only the items directly inside that directory.
Nested items have to be named in `include_only`. The embedded guide gives this
shape:

```json
{
  "inherits": [
    {
      "path": "/path/to/shared/skills.json",
      "include_only": ["linter-skill"],
      "exclude": ["deprecated-skill"]
    }
  ],
  "entries": [
    { "path": "path/to/my/project/skills", "exclude": ["experimental-.*"] },
    { "path": "~/personal-skills" }
  ]
}
```

`path` is absolute, home-relative (`~/`), or workspace-relative. A workspace
`.agents/skills.json` is how a repo points at skills that do not sit in
`.agents/skills/` itself. The embedded precedence, highest first, is:

1. Workspace discovery from the working directory up to the repository root.
2. Workspace `skills.json` / `plugins.json`.
3. `~/.gemini/config/`.
4. Builtin customizations mounted by name.
5. Global declared JSON configs.

That order is the text embedded in 1.2.11. It is not a trace from a session,
because print-mode `/skills` would not answer without a login.

The builtin cache on this machine has five skills: `automation`,
`generative_ui`, `migrate-workflows`, `permissioned-github`, and
`ui-plugin-navigation`. The last one sets `hide-from-slash-commands: true`
and talks about opening UI panes. It is a skill that describes the desktop
UI, not a plugin manager.

Legacy workflows are the predecessor of skills. They are single Markdown files
in `.agents/workflows/` and `~/.gemini/config/workflows/`. The
`migrate-workflows` skill and `/migrate-workflows` convert them to `SKILL.md`
directories. The workflows page is marked Antigravity IDE.

## MCP servers

MCP configuration is one JSON object, `mcpServers`, in a dedicated file.
Antigravity does not nest servers inside `settings.json`. The current MCP
page documents the same file for 2.0, the IDE, and the CLI.

A server entry needs `command` (stdio) or `serverUrl` (Streamable HTTP or
SSE). Optional fields on the public page: `args`, `env`, `cwd`, `headers`,
`authProviderType` (`google_credentials`), `oauth` (`clientId`,
`clientSecret`), `disabled`, and `disabledTools`. Changelog 1.1.x also says
the `/mcp` panel preserves fields it does not recognize, including
`enabledTools`, `timeoutSeconds`, `url`, and `tools.eager`, and that
`mcp_config.json` may contain `//` comments, `/* */` comments, and trailing
commas. This probe did not round-trip those extra fields.

`agy mcp` has existed since 1.1.16. It edits the user-level file only.
From a workspace that had `.agents/mcp_config.json` defining `workspace-only`,
`agy mcp list` did not show that server.

| Command | Probe result |
| --- | --- |
| `mcp list` | Table of `NAME`, `TYPE`, `STATUS`, `COMMAND/URL`. Empty file prints `No MCP servers configured.` |
| `mcp add <name> <command> [args...]` | Stdio. Flags go before the name. `--env KEY=value` is stored. `agy mcp add probe-stdio /usr/bin/true arg1` wrote `command`, `args`, and `disabled: false`. |
| `mcp add <name> https://...` | Detected as http. `--header 'Key: Value'` is stored as `headers`. `--env` on an http server fails: `http server type does not accept --env flags`. |
| `mcp enable` / `mcp disable <name>` | Flips `disabled`. Disabling a name that was never added creates `{ "disabled": true }` with no command and exits 0. |
| `mcp remove <name>` | Help only. Not exercised. |

Help text: `agy mcp add --env GITHUB_TOKEN=xxx gh -- docker run -i ghcr.io/github/mcp`.
The `--` is how a command that itself starts with a dash is passed. An
accidental `--version` after `--` printed the CLI version and did not record
a command.

Interactive management is the `/mcp` overlay: status, reload, logs, and
authentication. `agy -p /mcp --output-format json` does not open that overlay.
On the empty home it returned exit 2, zero tokens, and an empty
`conversation_id`, with the error that `/mcp` is not available in print mode.
That is the right shape for a read-only slash answer. It does not list
servers. The subcommand is the non-interactive list.

Plugin MCP servers stay in the plugin's own `mcp_config.json`. They are not
merged into the user file by `plugin install`. Changelog 1.2.2 says a running
session namespaces them. Relative working directories resolve against the
plugin directory (changelog in the 1.2 series). A plugin upgrade is supposed
to stop MCP processes started from the old install directory.

Authentication, from the MCP page, not from this probe:

| Mode | Where it is configured | Where the secret lives |
| --- | --- | --- |
| Header or env | `headers` / `env` in `mcp_config.json` | In that file. It is not a place to log. |
| Google ADC | `authProviderType: "google_credentials"` | Application Default Credentials, via `gcloud auth application-default login`. |
| OAuth with dynamic client registration | `serverUrl` only | Browser flow. Documented token file: `~/.gemini/antigravity/mcp_oauth_tokens.json`. |
| OAuth with a fixed client | `oauth.clientId` and `oauth.clientSecret` | Same token file. Redirect URI documented as `https://antigravity.google/oauth-callback`. |

The 2.0 settings screen has an MCP Store (add, uninstall, enable, refresh).
The IDE has its own store behind the agent panel's MCP Servers menu and a
"View raw config" path to the same JSON. The codelab for the Google Cloud
Developer plugin notes that 2.0's Installed MCP Servers list can omit a server
that arrived inside a plugin, while the agent can still call it. Plugin MCP
and user MCP are stored separately and the store UI does not always union them.

Permission patterns on the MCP page are `mcp(server/tool)`, `mcp(server/*)`,
and `mcp(*)`. Unconfigured MCP tools default to Ask. `always-proceed` is
documented to auto-approve them.

## How a session is supposed to assemble them

The embedded guide and the changelogs describe one load, which this probe did
not watch end to end:

1. Mount builtin skills by name from the CLI cache.
2. Discover `~/.gemini/config/` plugins, skills, rules, hooks, agents, and
   `mcp_config.json`.
3. Walk from the working directory to the repo root for `.agents/` (and the
   legacy `.agent/`, `_agents/`, `_agent/` names).
4. Apply workspace `skills.json` and `plugins.json`.
5. Skip anything whose `config.json` `plugins` entry is disabled, and skip a
   plugin that ships `"disabled": true` when the user has no entry.
6. Namespace plugin skills and plugin MCP servers.
7. Start user and plugin MCP servers. Interactive sessions load them in the
   background so a hung server does not block the first turn. Headless
   `-p` / `--prompt` waits so the single turn sees the tools. Connection,
   tool listing, and each call have timeouts. Changelog 1.0.x raised the
   connection timeout to 60 seconds and added a configurable launch timeout,
   including `-1` for no timeout.
8. Expose skills as slash commands. `/skills reload` refreshes them.

Rules have their own budget. Changelog 1.2.7 gives user and workspace rules
20,000 tokens so a large rule set does not push skills and MCP tools out.
The rules page also says a single rule file is truncated at 24,000 bytes.
Hooks from a disabled plugin are not supposed to run (changelog in the 1.2
series). Hooks inside an enabled plugin show up in `/hooks`.

Custom agents can opt into a subset. Frontmatter may list `skills`, `plugins`,
`mcpServers`, and `inheritMcp`. Changelog text in 1.2.x says agents inherit
ambient skills, rules, and MCP by default, with `inheritCustomizations` as the
single switch. A subagent created with MCP tools enabled is supposed to
inherit the parent server list rather than start from an empty one.

## Adjacent mechanisms that are easy to mix up

These are real Antigravity extension points. They are not the plugin, skill,
or MCP managers above.

| Mechanism | What it is | Where it lives |
| --- | --- | --- |
| Sidecars | Long-running background processes for Antigravity 2.0, including a `schedule` builtin. Disabled until `config.json` `sidecars.<id>.enabled` is true. | `~/.gemini/config/sidecars/<id>/sidecar.json` and `<plugin>/sidecars/<id>/`. Runtime data under `~/.gemini/antigravity/sidecar_data/`. |
| UI panes | Desktop panels. The builtin `ui-plugin-navigation` skill only tells the agent how to offer a button that opens one. | Not a CLI install path. |
| Hooks | Shell commands around tool use and the model loop. Already a Surface observation candidate for the CLI. | `.agents/hooks.json`, `~/.gemini/config/hooks.json`, plugin `hooks.json`. |
| Rules | Always-on or matched instructions. `AGENTS.md` and `GEMINI.md` have no frontmatter. Files in `rules/` need `trigger`. | See the location table. |
| Workflows | Legacy single-file slash commands, being replaced by skills. | `.agents/workflows/`, `~/.gemini/config/workflows/`. |

Gemini CLI extensions are an import source, not a runtime format. Claude Code
plugins are an import source, and only when they use a `.claude-plugin`
marker one directory below `~/.claude/plugins/`.

## What the probe could not see

- Which of two same-named skills actually wins at runtime. Precedence is the
  embedded guide.
- Whether a skill placed only in `~/.gemini/antigravity-cli/skills/` is still
  loaded. The binary has no path string for that directory. Print-mode
  `/skills` would not answer on an empty home.
- A remote `plugin install https://...` or `name@marketplace`, including where
  the marketplace cache is pruned.
- Plugin MCP namespace `<plugin>_<server>` on a live tool list.
- The OAuth token file for MCP. It was not created.
- Merge behavior of `plugin enable` when `config.json` already holds
  `userSettings`. The real file on this machine has `userSettings` and no
  `plugins` key. The disposable home's file was created by the probe and only
  ever contained `plugins`.

Print-mode `/skills` on the empty home printed an authentication URL and
waited. The process was killed at 25 seconds. No login was completed. The
same happened for `/help`, `/hooks`, and `/plugins`. `/mcp` returned the
structured error above without asking for a login.

## Sources

Probed locally on 2026-09-24 against `agy` 1.2.11. Plugin install, enable,
disable, uninstall, validate, import, and `mcp add` / `list` / `disable` ran
with `HOME` set to a directory under `/tmp`, then that directory was removed.
The real `~/.gemini/config/config.json`, `mcp_config.json`, and
`antigravity-cli/settings.json` kept their previous mtimes, and
`config/import_manifest.json` was absent before and after.

- Plugins: <https://antigravity.google/docs/plugins>
- Skills: <https://antigravity.google/docs/skills>
- MCP: <https://antigravity.google/docs/mcp>
- Hooks: <https://antigravity.google/docs/hooks>
- Rules: <https://antigravity.google/docs/rules>
- Sidecars: <https://antigravity.google/docs/sidecars>
- Gemini CLI migration: <https://antigravity.google/docs/cli/gcli-migration>
- Workflows to skills: <https://antigravity.google/docs/migration/workflows-to-skills/>
- CLI features and reference, which still describe `antigravity-cli/plugins`: <https://antigravity.google/docs/cli/features>, <https://antigravity.google/docs/cli/reference>
- Changelog through 1.2.11, from `agy changelog` on the probed binary
- Discovery and `skills.json` / `plugins.json` text extracted from that binary
- Builtin skill names under `~/.gemini/antigravity-cli/builtin/skills/`
- Adapter profile binding: `packages/adapter-antigravity/src/services/profiles.ts`
- Earlier Surface hook notes, still on the 1.1.12 census: `packages/surface/vendors/antigravity/findings.md`
