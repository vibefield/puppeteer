**Yes. The best fit is one persistent profile directory per account, selected separately for each CLI process—not a machine-wide account switcher.** Both Claude Code and Codex expose the necessary directory overrides today. You can keep multiple accounts logged in and run their normal interactive terminals simultaneously. ([Claude][1])

For your VibeField/Chopsticks setup, I would build directly on these native mechanisms:

| CLI         | Per-process directory override | Example                                              |
| ----------- | ------------------------------ | ---------------------------------------------------- |
| Claude Code | `CLAUDE_CONFIG_DIR`            | `CLAUDE_CONFIG_DIR=/path/to/claude-account-a claude` |
| Codex       | `CODEX_HOME`                   | `CODEX_HOME=/path/to/codex-account-a codex`          |

The crucial design is **“launch this process using account A’s profile,”** rather than **“make account A the currently active account.”**

## 1. What the setup should look like

I would organize it like this:

```text
~/.agent-profiles/
├── claude/
│   ├── account-a/
│   └── account-b/
└── codex/
    ├── account-a/
    └── account-b/
```

Use the same installed `claude` executable for both Claude profiles, and the same installed `codex` executable for both Codex profiles. What differs is the environment passed to each process.

Claude documents its override as relocating settings, session history, and plugins. Codex documents its home as containing configuration, local history, logs, caches, and file-based credentials when that storage mode is selected. ([Claude][1])

**Keep the directories persistent and separate.** Do not point `~/.claude` or `~/.codex` at a different directory whenever you choose an account, and do not overwrite a shared `auth.json`.

### Credentials are isolated too—but the storage details matter

**Claude Code:** Current official documentation explicitly says that `CLAUDE_CONFIG_DIR` also selects a different macOS Keychain entry. On Linux and Windows, the credentials file lives inside the selected directory. Therefore, multiple profiles do not inherently have to fight over one macOS login. On macOS, however, the folder alone is not a complete portable backup of the account’s credentials. ([Claude][2])

**Codex:** You can choose file storage or the operating system’s credential store:

```toml
cli_auth_credentials_store = "file"
```

With `file`, credentials are stored in that profile’s `$CODEX_HOME/auth.json`. With `keyring`, they are stored in the OS credential store. Codex’s current implementation derives the keyring identifier from the Codex home path, so **file storage is not required for simultaneous accounts**. ([OpenAI Developers][3])

For your “standalone data folders” preference, `file` is the most explicit arrangement. For encrypted OS-managed credential storage, use `keyring` instead. Treat file-based credentials as passwords, not ordinary configuration. ([OpenAI Developers][3])

## 2. A practical setup you can use now

These examples use **Bash/Zsh on macOS, Linux, or WSL**, and assume direct subscription authentication rather than an API gateway or cloud-provider configuration.

### Create the directories

```bash
(
  umask 077
  mkdir -p "$HOME/.agent-profiles"/{claude,codex}/{account-a,account-b}
)
```

Before logging into Codex, put this in **each** account’s `config.toml`:

```text
~/.agent-profiles/codex/account-a/config.toml
~/.agent-profiles/codex/account-b/config.toml
```

```toml
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
```

The second setting restricts authentication to ChatGPT login rather than API-key login. Choose `keyring` instead of `file` before signing in when you prefer OS-managed credentials. ([OpenAI Developers][3])

### Give each account its own launch command

Add these to your shell configuration:

```bash
alias claude-a='CLAUDE_CONFIG_DIR="$HOME/.agent-profiles/claude/account-a" claude'
alias claude-b='CLAUDE_CONFIG_DIR="$HOME/.agent-profiles/claude/account-b" claude'

alias codex-a='CODEX_HOME="$HOME/.agent-profiles/codex/account-a" codex'
alias codex-b='CODEX_HOME="$HOME/.agent-profiles/codex/account-b" codex'
```

**Important:** These minimal aliases assume your shell is not exporting another account’s API key, OAuth token, or credential-directory override. For an application launcher, explicitly sanitize those inherited variables; more on that below.

### Authenticate each profile separately

Run these one at a time, selecting the intended account in each browser login:

```bash
claude-a auth login
claude-b auth login

codex-a login
codex-b login
```

These are the native login commands. For Codex, ordinary `login` uses ChatGPT’s browser authentication flow; it does not require buying API credits. ([Claude][4])

Afterward, run these in four terminal tabs or four PTYs:

```bash
claude-a
claude-b
codex-a
codex-b
```

There is no logout/login cycle between them. Each invocation receives its own directory setting.

For login diagnostics:

```bash
claude-a auth status
claude-b auth status

codex-a login status
codex-b login status
```

Claude’s command reports authentication status; Codex’s command reports the authentication mode and whether credentials are present. **Do not treat a successful Codex status exit code alone as proof that you selected the intended person’s account**—also verify the account during onboarding. ([Claude][4])

## 3. The important pitfalls

### Inherited environment variables can override your profile

A separate data directory is not enough when the process also inherits credentials from somewhere else.

For Claude, an approved `ANTHROPIC_API_KEY` can take precedence over subscription authentication, and `CLAUDE_CODE_OAUTH_TOKEN` takes precedence over Keychain credentials. An application that blindly forwards its entire environment can therefore launch the right folder with the wrong authentication. ([Claude][2])

For a direct-subscription launcher, I would explicitly remove unrelated inherited authentication and routing overrides before injecting the chosen profile. In particular, audit:

```text
Claude:
  ANTHROPIC_API_KEY
  ANTHROPIC_AUTH_TOKEN
  CLAUDE_CODE_OAUTH_TOKEN
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  CLAUDE_SECURESTORAGE_CONFIG_DIR
  API-endpoint and cloud-provider overrides

Codex:
  OPENAI_API_KEY
  CODEX_API_KEY
  CODEX_ACCESS_TOKEN
  Custom provider/endpoint configuration
```

One especially subtle Claude detail: an issue in Anthropic’s repository documents the currently undocumented `CLAUDE_SECURESTORAGE_CONFIG_DIR` override, which can select credentials independently of `CLAUDE_CONFIG_DIR`. The report describes stale inherited values causing one profile’s login to overwrite another’s. **For the native-directory approach, clear an inherited value rather than casually setting it to an empty string.** Treat this as a version-sensitive implementation detail and include it in your adapter tests. ([GitHub][5])

### Codex `--profile` is not an account-isolation mechanism

These two things are different:

```bash
codex --profile review
```

```bash
CODEX_HOME=/path/to/account-b codex
```

Codex’s built-in `--profile` selects a named **configuration layer**. It is useful for model choices and other settings, but it is not, by itself, a separate authentication and data home. Use `CODEX_HOME` for the separation you are asking for. ([OpenAI Developers][6])

### Do not clone live OAuth credentials into multiple homes

My recommendation is to authenticate every new account profile through the CLI, rather than initialize it by copying another live profile’s credential files.

There are documented Codex reports of copied credentials becoming invalid when another instance refreshes the same OAuth token family. That is a different situation from independently logging in to separate accounts. ([GitHub][7])

For your manager, I would use **one persistent root per account**, with that account’s agent sessions sharing the root—not a fresh credential copy for every spawned agent.

### Account isolation is not complete environment isolation

There are three separate requirements here:

| Requirement                                                          | Appropriate mechanism                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Separate subscriptions, account settings, and local session stores   | Per-account `CLAUDE_CONFIG_DIR` / `CODEX_HOME`                   |
| Prevent agents from editing the same working files                   | Separate worktrees or checkouts                                  |
| Prevent one agent from accessing another account’s files and secrets | An enforced sandbox, container, VM, or separate OS-user boundary |

The last two are architectural recommendations, not properties provided by the directory variables.

Even configuration discovery is not entirely confined to these roots. Repository-local settings still apply, and Codex explicitly discovers user-wide skills from **`$HOME/.agents/skills`**, outside `CODEX_HOME`. System/admin configuration can also remain shared. ([Claude][8])

Consequently:

**Separate account folders:** use the native variables.

**Completely independent user environments:** add a carefully designed per-profile home/environment or OS isolation. Merely changing `HOME` is still not a security boundary.

I would not start by replacing `HOME` for your normal local development workflow. Keeping the real home avoids unnecessarily disturbing Git, SSH, language-toolchain, and package-manager configuration. CAAM’s documentation illustrates how much passthrough machinery becomes necessary once a launcher redirects the whole home. ([GitHub][9])

## 4. What about existing account managers?

Two current projects are worth distinguishing:

| Tool                                    | Relevant capability                                                                                                              | Fit for your requirements                                                                                                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ducksss/codex-profiles**              | Named `CODEX_HOME` directories, independent login, direct CLI launching, and project-to-profile bindings without copying tokens. | A close fit for the Codex half. Its documentation also explicitly acknowledges shared user/repository skill locations. ([GitHub][10])                                                                                                                                          |
| **CAAM — Coding Agent Account Manager** | Supports multiple providers and has an isolated-profile `caam exec` mode for parallel sessions.                                  | Inspect the mode carefully: its vault mode swaps credentials, shallow profiles deliberately share history, and even isolated profiles share some Claude assets through symlinks. It is not automatically equivalent to your “standalone everything” requirement. ([GitHub][9]) |

**My recommendation is the native-directory approach, with a small launcher on top.** These tools are useful references or conveniences, but you do not need another credential-management system merely to run both vendors concurrently. I have reviewed their documented approaches here, not security-audited their implementations.

The selection criterion is simple:

> A suitable launcher selects a private profile for the child process. An unsuitable switcher rewrites one shared “active account.”

## 5. How I would implement this in VibeField/Chopsticks

For your product, I would make an **account profile** a first-class object, separate from both a project and an agent session:

```ts
type AgentProfile = {
  id: string;                 // Stable internal ID
  provider: "claude" | "codex";
  label: string;              // User-facing name
  dataRoot: string;           // Stable absolute directory
};

type AgentRun = {
  id: string;
  profileId: string;
  workspacePath: string;
};
```

The profile contains a reference to CLI-managed authentication, not a copy of its tokens.

### Bind the profile when spawning the real TUI

Conceptually:

```text
Spawn request
  → resolve account profile
  → construct a fresh child environment
  → inject that profile's native directory variable
  → spawn the real CLI in its PTY
  → record profileId on the run
```

No headless mode, JSON-mode replacement, or credential proxy is needed for this design. Your terminal-custody architecture remains intact.

I would enforce four rules:

1. **No global active account.** A UI default can choose the profile for the *next* spawn, but must not alter existing runs.
2. **No mutation of the host’s global environment to launch a profile.** Build a separate environment object for every child process.
3. **All lifecycle operations use the same profile.** Login, diagnostics, logout, launch, and resume must resolve the same root. Any authentication-caching helper or daemon should also have an explicit profile boundary.
4. **Transcript discovery knows about every registered root.** Index sessions with their profile identity, rather than scanning only `~/.claude` and `~/.codex`.

For onboarding, I would create an empty profile, launch the official login flow in that profile, verify the identity, then save a display label. For paths, use immutable IDs internally rather than an email address or editable label, because credential-store selection can depend on the path. Codex’s path-derived Keychain key is directly visible in its implementation. ([GitHub][11])

Before rolling this into production, test the actual installed CLI versions with a small acceptance check: log into A, log into B, reopen A, run both concurrently, and verify that authentication and session histories remain correctly separated. Also test reauthentication and resume—not just first launch.

**Bottom line: use persistent per-account native data roots, independently authenticated, passed through per-process environments. Add profile selection to your existing PTY launcher; do not build around shared credential swapping.**

[1]: https://code.claude.com/docs/en/env-vars "Environment variables - Claude Code Docs"
[2]: https://code.claude.com/docs/en/authentication "Authentication - Claude Code Docs"
[3]: https://developers.openai.com/codex/auth/ "Authentication | ChatGPT Learn"
[4]: https://code.claude.com/docs/en/cli-reference "CLI reference - Claude Code Docs"
[5]: https://github.com/anthropics/claude-code/issues/79223 "[DOCS] Document CLAUDE_SECURESTORAGE_CONFIG_DIR (credential-store location override — widely used by ecosystem tooling, currently undocumented) · Issue #79223 · anthropics/claude-code · GitHub"
[6]: https://developers.openai.com/codex/config-advanced/ "Advanced Configuration | ChatGPT Learn"
[7]: https://github.com/openai/codex/issues/15410?utm_source=chatgpt.com "Issue #15410 · openai/codex"
[8]: https://code.claude.com/docs/en/settings "Claude Code settings - Claude Code Docs"
[9]: https://github.com/Dicklesworthstone/coding_agent_account_manager "GitHub - Dicklesworthstone/coding_agent_account_manager: Sub-100ms auth switching for AI coding CLIs (Claude Code, Codex, Gemini): swap subscription accounts instantly when you hit usage limits · GitHub"
[10]: https://github.com/Ducksss/codex-profiles "GitHub - Ducksss/codex-profiles: Named CODEX_HOME profiles and ChatGPT Desktop windows with separate local state, without copying tokens · GitHub"
[11]: https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs "codex/codex-rs/login/src/auth/storage.rs at main · openai/codex · GitHub"

