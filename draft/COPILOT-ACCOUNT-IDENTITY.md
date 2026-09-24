# Copilot account identity

Status: research, probed locally. Nothing here is a promoted support claim, and
the adapter still reports `identity: 'none'`.

Probed 2026-09-23 on GitHub Copilot CLI **1.0.88** (`~/.local/bin/copilot`,
darwin-arm64). The public command reference and the Copilot SDK schema used
for the method shapes are `@github/copilot-sdk` go **v1.0.14** (16 September
2026). The adapter comment and RFC 006 still describe 1.0.80, which had no
structured identity document. That is still true of the public subcommands.
1.0.88 adds a JSON-RPC server that can answer the question.

Related:

- [`docs/rfcs/006-agent-distribution-and-account-profiles.md`](../docs/rfcs/006-agent-distribution-and-account-profiles.md)
- [`packages/adapter-copilot/src/services/profiles.ts`](../packages/adapter-copilot/src/services/profiles.ts)
- [`packages/core/src/services/profiles.ts`](../packages/core/src/services/profiles.ts)
- [`draft/research-multiagentsubs.md`](./research-multiagentsubs.md)

## Recommendation

Read who is signed in with `auth.getStatus` on `copilot --server --stdio`,
under the profile's `COPILOT_HOME`, with no token environment variables.

That call returns a credential-free document: whether a login resolved, the
GitHub login, the host, and which credential source won. It does not return an
email, an organization, or a Copilot plan.

Read the plan only after that, and only when the status says the source is
Copilot's own `user` login. The follow-up is `account.getCurrentAuth`, whose
`user` variant keeps the OAuth token in the runtime secret store and attaches
`copilotUser`. If the status says `gh-cli`, `env`, or `token`, stop. Those
variants are specified to carry the secret, and a profile row can show the
login and the method with the plan left blank.

```text
copilot --server --stdio --no-auto-update
        │  Content-Length JSON-RPC, protocolVersion 3
        ├─ ping
        ├─ auth.getStatus                          login, host, authType
        └─ account.getCurrentAuth                  only when authType is user
              └─ copilotUser.copilot_plan          individual | business | enterprise
                 copilotUser.organization_login_list
```

Mark the identity source `{ kind: 'native-protocol', stability: 'experimental' }`.
The server flag is how the official SDK talks to the CLI. It is not in
`copilot --help`, and the SDK types are marked experimental.

## What Claude and Codex already do

`ProfileIdentity` is who the native status surface says is logged in. It never
carries a token. Claude runs `claude auth status --json` and maps `email`,
`orgName`, and `subscriptionType`, with source `native-status` /
`documented`. Codex calls app-server `account/read` and maps `type`, `email`,
and `planType`, with source `native-protocol` / `documented`. Both are one
data root per account: `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.

Copilot profiles already bind `COPILOT_HOME` and log in with interactive
`copilot login`. `verify()` returns `unsupported`. Godview therefore shows
"no identity surface" for every Copilot row.

## Public CLI

`copilot --help` on 1.0.88 has `login` and no `auth`, `status`, `whoami`, or
`logout` subcommand. Account handling inside the TUI is `/user`,
`/user show`, `/user list`, `/user switch`, and `/logout`. An older captured
`/user show` printed a single `gh` login and no email, organization, or plan
([copilot-cli#58](https://github.com/github/copilot-cli/issues/58)).

ACP (`copilot --acp --stdio`) does not advertise `/user`. Informational
commands that are advertised, `/usage` and `/session info`, return session
stats and a working directory. `initialize` advertises a `copilot-login`
terminal-auth method and no account object.

`config.json` records `lastLoggedInUser` and `loggedInUsers` as
`{ host, login }` and can also hold the token when the OS keychain is
unavailable. Surface already marks that file must-not-parse beyond inventory.
A home whose `lastLoggedInUser` was rewritten to a login that has no keychain
item did not make the process that user; the process fell through to `gh`.
The file is a record of who has logged in there, not proof of who the next
process will be.

## `auth.getStatus`

Start the server with the profile binding and a minimal environment (`PATH`,
`HOME`, user, locale, temp). Do not pass `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
or `GITHUB_TOKEN`. Puppeteer's launch allow-list already passes only
`COPILOT_HOME`.

The framing is LSP-style Content-Length, not newline-delimited JSON.
`ping` on this build returned `protocolVersion: 3`. Require that version and
treat any other version as unavailable.

Against a home that had completed `copilot login`, `auth.getStatus` returned:

```json
{
  "isAuthenticated": true,
  "authType": "user",
  "host": "https://github.com",
  "login": "<github-login>",
  "statusMessage": "<github-login>"
}
```

No other keys. The same call is the whole identity read for login, host, and
method.

| `ProfileIdentity` | Copilot |
| --- | --- |
| `loggedIn` | `isAuthenticated` |
| `method` | `authType` (`user`, `gh-cli`, and the env/token variants) |
| `account` | `login` — field does not exist yet; see below |
| `plan` | filled only by the second call |
| `organization` | filled only by the second call |
| `email` | absent; GitHub does not return one here |

`statusMessage` echoed the login on this probe. Decode `login`, not the
message.

## Plan, and where the token lives

SDK `AccountGetCurrentAuthResult.authInfo` is the ingress `AuthInfo` union,
not the credential-free `AuthIdentity`. The variants differ:

| `type` | Secret in the published result | Subscription snapshot |
| --- | --- | --- |
| `user` | no; the OAuth token stays in the runtime secret store | `copilotUser` optional |
| `gh-cli` | yes; `token` is the `gh auth token` | `copilotUser` optional |
| `env`, `token` | yes | `copilotUser` optional |
| `token-provider` | no plaintext token; a registration id | `copilotUser` optional |

`account.getAllUsers` adds an optional `token` beside each entry. Do not call
it.

On this machine the live `user` response had no `token` key. `copilotUser`
carried:

| Field | Observed |
| --- | --- |
| `copilot_plan` | `individual` |
| `access_type_sku` | `monthly_subscriber_quota` |
| `token_based_billing` | `true` |
| `organization_login_list` | `[]` |
| `organization_list` | `[]` |

`copilot_plan` is the family the SDK documents: `individual`, `business`,
`enterprise`. It does not say Pro, Pro+, or Max. The SKU is finer and is not
a stable marketing name, so `plan` should stay `copilot_plan`. Quota snapshots
in the same object are account usage, not the profile label.

An empty `COPILOT_HOME` on the same machine returned `authType: gh-cli` for
the same GitHub login. The published `gh-cli` struct includes the token even
though this 1.0.88 response happened to omit it. Omit is not the contract.
If a `token`, `hmac`, or `apiKey` field appears, discard the message and keep
the `auth.getStatus` result with no plan.

`copilotUser` is defined as the GitHub `/copilot_internal/v2/token` user
payload, trusted verbatim when the runtime already has it. Puppeteer does not
call that URL and does not read the keychain password. The CLI does.

## What one `COPILOT_HOME` isolates

`COPILOT_HOME` replaces the configuration tree: settings, session history,
plugins, permissions, and `config.json`. It does not give the profile a
private credential store.

The OAuth token is one macOS keychain item: service `copilot-cli`, account
`https://<host>:<login>`. The account name is not derived from the home path.
Created and modified dates on this machine were the same, so later homes do
not mint a new item per directory. Linux is libsecret and Windows is
Credential Manager, same service name. When the store is missing, the CLI
prompts to write the token in plaintext under the configuration directory.

Credential order, from the auth how-to:

1. `COPILOT_GITHUB_TOKEN`
2. `GH_TOKEN`
3. `GITHUB_TOKEN`
4. OAuth token in the `copilot-cli` keychain item
5. `gh auth token`

A Codespaces-injected `GITHUB_TOKEN` does not beat a `/login` account. An
explicitly exported token still does. Puppeteer does not forward those
variables, so steps 1–3 stay empty. Steps 4 and 5 still apply, because both
live in the login keychain.

Probed with the same minimal environment:

| Home | Resolved `type` |
| --- | --- |
| `~/.copilot` after `copilot login` | `user` |
| empty directory | `gh-cli` |
| empty directory plus a fake `lastLoggedInUser` | `gh-cli`, not the fake login |

A managed profile that has never completed `copilot login` is signed in
whenever `gh` is. Show `method: gh-cli`. The process will act as that GitHub
user. A profile that has finished `copilot login` inside its own
`COPILOT_HOME` reads back as `user`.

Two homes can record two logins in two keychain items, because the account
attribute includes the login. This probe had only one GitHub account, so
per-home selection of two real Copilot logins is not demonstrated. What is
demonstrated is that a login written into `config.json` without a matching
credential is ignored, and that a fresh home inherits `gh`.

Sign-out is not specified yet. `account.logout` exists on the server. The
secret is outside the home, so deleting a managed root leaves the keychain
item. Logging out removes that shared item for every home using the same
login. Do not wire `signOut` until that is probed on a disposable account.
`credential` should be `external`.

## Methods that do not answer this

| Surface | Result on 1.0.88 |
| --- | --- |
| `copilot login` / `/login` | interactive OAuth; success text names the login and is not a document |
| `/user show` | TUI only; ACP does not advertise it |
| ACP `session/new`, `/usage`, `/session info` | no login and no plan |
| `config.json` `lastLoggedInUser` | can diverge from the process, and may contain the token |
| keychain password, `gh auth status`, `api.github.com/copilot_internal/*` | either reads a bearer token or describes a different credential |
| `account.getAllUsers` | optional `token` on each user |
| `session.gitHubAuth.getCurrentAuthInfo` | credential-free `AuthIdentity`, marked internal |
| `session.gitHubAuth.getStatus` | token-free, and the schema adds `copilotPlan` (`individual_pro`, `business`); needs a session id |

`session.gitHubAuth.getStatus` is the one call that would put login and plan
in a struct with no secret field. Opening a session and calling it on this
build returned JSON-RPC `-32603`. It is the method to retry when the server
protocol moves, not the method to ship now. `auth.getStatus` is the call that
succeeded with no session and no secret.

## Schema gap

Godview prints `email · organization · plan`. Copilot's handle is a GitHub
login, and `ProfileIdentity` has no field for it. Putting the login in
`email` would show the right text and store a lie.

Add an optional `account` string to `ProfileIdentity`. Copilot sets it to
`login`. Claude and Codex leave it empty. Print `account` first in the
account row. Until that field exists, a Copilot row that only has `plan`
shows `individual` and hides which GitHub account it is.

## Implementation

1. `verify()` spawns `copilot --server --stdio --no-auto-update` with the
   profile binding, speaks Content-Length JSON-RPC, requires `ping` protocol
   version 3, then calls `auth.getStatus`. Unknown shapes are `unavailable`,
   the same rule Claude uses for a missing `loggedIn` boolean.
2. When `authType` is `user`, call `account.getCurrentAuth` and allowlist
   `copilot_plan` and `organization_login_list`. Any `token`, `hmac`, or
   `apiKey` field discards that second document.
3. Set `support.identity` to `native-protocol` and `support.credential` to
   `external`. Keep `copilot login` as the interactive onboarding command.
4. Add optional `account` and show it in the Godview row.
5. Leave `signOut` absent until logout is probed on a disposable account.
6. Keep `plan` as `copilot_plan`. Revisit Pro / Pro+ / Max only if GitHub
   publishes a field for the marketing tier. `access_type_sku` is too
   unstable to show raw.

A new managed profile whose status is `gh-cli` is telling the truth: that
root has no Copilot login, and the process will use GitHub CLI. The row
should say so.

## Sources

- Authenticating GitHub Copilot CLI, including credential order, the
  `copilot-cli` keychain service, and `/user`:
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli>
- Configuration directory, `COPILOT_HOME`, and `loggedInUsers`:
  <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference>
- CLI command reference (`login`, slash commands, no status subcommand):
  <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
- ACP server (public preview; slash commands that are not advertised go to
  the model):
  <https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server>
- SDK schema go v1.0.14: `AuthIdentity`, `UserAuthInfo`, `GhCLIAuthInfo`,
  `AccountGetCurrentAuthResult`, `SessionAuthStatus`, `auth` is not a wire
  name in that file; `auth.getStatus` was confirmed on the 1.0.88 binary:
  <https://github.com/github/copilot-sdk/blob/go/v1.0.14/go/rpc/zrpc.go>
- `/user show` captured without a plan:
  <https://github.com/github/copilot-cli/issues/58>

## Not shown by this probe

- Two real Copilot logins selected by two `COPILOT_HOME` directories.
- The `gh-cli` response actually containing `token` on some build. The schema
  requires it; 1.0.88 omitted it here.
- `session.gitHubAuth.getStatus` returning `copilotPlan` after a successful
  `sessions.open`.
- `account.logout` and whether it removes only the Copilot keychain item.
- Email. No method returned one.
- A stable Pro / Pro+ / Max label. This account's family was `individual`
  and its SKU was `monthly_subscriber_quota`.
