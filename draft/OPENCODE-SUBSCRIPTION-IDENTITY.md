# OpenCode subscription identity

Date: 2026-09-23.

Status: research complete. No adapter change in this note. The recommendation is ready to implement once the new native facts are captured as Surface claims.

Related: [`docs/rfcs/006-agent-distribution-and-account-profiles.md`](../docs/rfcs/006-agent-distribution-and-account-profiles.md), [`packages/adapter-opencode/src/services/profiles.ts`](../packages/adapter-opencode/src/services/profiles.ts), [`packages/core/src/services/profiles.ts`](../packages/core/src/services/profiles.ts).

## Result

OpenCode can fill the same profile row Claude and Codex fill — signed in, email, organization — for its **Console account**. It cannot fill **plan** on the build probed here. Provider credentials (an OpenCode Go API key, ChatGPT OAuth, any other `auth.json` entry) are a second sign-in in the same data root, and they do not carry an email or a plan.

The reliable read is two layers, in this order:

1. A read-only projection of `account` and `account_state` in `$XDG_DATA_HOME/opencode/opencode.db`. A row means signed in. No database, or a database with no account row, means signed out. The query names `id`, `email`, `url`, `active_account_id`, and `active_org_id`, and never the token columns.
2. `GET /experimental/console/orgs` on a short-lived `opencode serve` bound to that same data root. The active org's `orgName` is the organization, and `accountEmail` confirms the email.

An empty org list is the signed-out document and the document returned when the console host cannot be reached. Verification keeps `loggedIn: true` and the email from the database in that second case, and omits the organization.

## What the profile row asks for

`ProfileIdentity` is one signed-in person: `loggedIn`, `method`, `email`, `organization`, `plan`, `verifiedAt`, and a source of `native-status` or `native-protocol`. Godview prints `email · organization · plan`, and uses `method` when `plan` is absent. Verify stays hidden while a provider reports `identity: 'none'`.

| Provider | How verify learns the person | What the row can show |
| --- | --- | --- |
| Claude Code | `claude auth status --json` | email, `orgName`, `subscriptionType` |
| Codex | app-server `account/read` | email, `planType`, auth mode |
| OpenCode today | `verify()` returns `unsupported` | "NO IDENTITY SURFACE" |

OpenCode profiles already isolate a root. A managed profile binds `XDG_DATA_HOME` to `<dataRoot>/data`, so credentials, history, and logs land in `<dataRoot>/data/opencode` while config, plugins, and cache stay on the shared XDG config and cache roots. The native default is `~/.local/share/opencode`. `credential` is `root`. Login is `opencode auth login`. That command writes a provider credential. It does not create the Console account this report identifies.

## The two sign-ins in one root

Both live under the data directory the profile already binds. They answer different questions.

**Console account.** `opencode console login` runs a device-code flow and stores the account in SQLite. The hidden command group is `opencode console` (`login`, `logout [email]`, `switch`, `orgs`, `open`). It is absent from `opencode --help` because the command is registered with `describe: false`, and `opencode console --help` lists it. The default server is version-sensitive: the 1.18.16 source uses `https://console.opencode.ai`, and the 1.18.32 binary uses `https://opencode.ai/console`. The saved `account.url` is the authority. Verification does not hardcode either host.

The account service, recovered from the 1.18.32 binary and the 1.18.16 source of `packages/opencode/src/cli/cmd/account.ts`:

- `POST {account.url}/auth/device/code` and `POST {account.url}/auth/device/token`, client id `opencode-cli`.
- `GET {account.url}/api/user` decodes `{ id, email }`.
- `GET {account.url}/api/orgs` decodes `{ id, name }[]`.
- `GET {account.url}/api/config` with `x-org-id` returns an untyped OpenCode config document. When it loads, the server process also receives `OPENCODE_CONSOLE_TOKEN`. That variable is a bearer token. A verifier does not read the child environment and does not log serve output.

**Provider credentials.** `opencode auth login` writes `auth.json`. On 1.18.32, `opencode auth list` reads that file and prints `Name` plus `oauth` or `api`. The on-disk union is:

| `type` | Fields beside the secret |
| --- | --- |
| `oauth` | `refresh`, `access`, `expires`, optional `accountId`, optional `enterpriseUrl` |
| `api` | `key`, optional `metadata` string map from the login form |
| `wellknown` | `key`, `token` |

`accountId` on an OpenAI OAuth entry is a provider account id stored next to the tokens. No status route returns it. `metadata` is form data from login, not a subscription plan. `opencode auth list` did not print secrets in the probe below. It is still terminal text, so it is not an identity source.

`GET /provider` has a `connected: string[]` that names providers without secrets. The rest of the document is not safe to retain: in the probe the Anthropic provider object echoed its API key on `all[].key`. The OpenAI OAuth access token did not appear in that response. The rule for this work is to discard every field except `connected`, and only if a later change needs a provider summary. It is not the subscription identity.

A `credential` table (migration `20260611035744_credential`) and a `control_account` table exist in the 1.18.32 database. `opencode auth list` still reads `auth.json`. Those tables are not the live store on this release.

## Evidence

Probed on this machine on 2026-09-23.

| Fact | Value |
| --- | --- |
| Binary | `~/.opencode/bin/opencode` |
| Reported version | 1.18.32, released 2026-09-21 |
| Adapter baseline | 1.18.16 (`support/agents.json`, ground truth already models the console routes) |
| Real data directory | `~/.local/share/opencode` |
| Real Console accounts | 0 rows in `account` and `account_state` |
| Real `auth.json` | absent |
| Real `opencode auth list` | `0 credentials` |
| Real `opencode console orgs` | `No accounts found` |

The signed-in cases used a scratch `XDG_DATA_HOME` and a local fake console that implemented `GET /api/user`, `GET /api/orgs`, and `GET /api/config`. The scratch tree was deleted after the probe. The real data directory was opened read-only and was not written.

Database columns after `opencode db path` migrated a fresh root:

```text
account(id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
account_state(id, active_account_id, active_org_id)
```

`opencode debug paths` on the installed CLI:

```text
data    ~/.local/share/opencode
config  ~/.config/opencode
cache   ~/.cache/opencode
state   ~/.local/state/opencode
```

### Signed out

`opencode serve --pure` against an empty scratch root, then the loopback API with the adapter's basic-auth environment:

```json
GET /experimental/console
{ "consoleManagedProviders": [], "switchableOrgCount": 0 }

GET /experimental/console/orgs
{ "orgs": [] }
```

`activeOrgName` was absent. `opencode console orgs` printed `No accounts found`. `opencode auth list` printed `0 credentials` and the path of `auth.json`.

### Signed in to Console, console host reachable

One account row, `account_state` pointing at it and at `org_work`, plus an `auth.json` holding a fake OpenAI OAuth entry and a fake Anthropic API key. The fake console returned one org named `Work`.

`opencode auth list` printed:

```text
OpenAI     oauth
Anthropic  api
2 credentials
```

The key and the tokens were not in that output.

`opencode console orgs` printed the active marker, the name `Work`, the email, the account URL, and `org_work`. That output is the same facts as the protocol. The product still does not parse it.

```json
GET /experimental/console
{ "consoleManagedProviders": ["opencode"], "switchableOrgCount": 1 }

GET /experimental/console/orgs
{
  "orgs": [
    {
      "accountID": "usr_probe",
      "accountEmail": "<email>",
      "accountUrl": "http://127.0.0.1:<port>",
      "orgID": "org_work",
      "orgName": "Work",
      "active": true
    }
  ]
}
```

The fake access token was not in either body. The mock recorded `GET /api/orgs` with a bearer token and `GET /api/config` with `x-org-id: org_work`. `consoleManagedProviders` came from the provider ids in that remote config, which is why `opencode` showed up as connected without an `auth.json` entry.

`GET /provider` returned `connected: ["anthropic", "opencode", "openai"]`. Walking the rest of the document found the Anthropic API key at `all[].key`. That response is about 6 MB because it inlines the model catalog. Verification does not store it.

### Signed in to Console, console host down

The same account row, with `account.url` pointed at a closed port:

```json
GET /experimental/console
{ "consoleManagedProviders": [], "switchableOrgCount": 0 }

GET /experimental/console/orgs
{ "orgs": [] }
```

The read-only projection still returned the account id, email, url, and the active org id. The HTTP routes had collapsed to the signed-out document. The cause is in the server: `Account.orgsByAccount` turns a failed org fetch into an empty org list, and `GET /experimental/console/orgs` emits only org rows. A signed-in account with no reachable org disappears.

In `Config.loadInstanceState` the value placed in `activeOrgName` is declared and never assigned, which matches the field being absent in every response above.

## What stays unsupported

- **Plan.** User is `{ id, email }`. Org is `{ id, name }`. The org decoder would drop an extra plan field if the console sent one. No billing or subscription route is called by this CLI. `plan` stays unset. Godview then has no plan to print.
- **Provider-only profiles.** An `auth.json` full of API keys and OAuth tokens, and an empty `account` table, is signed out of this identity. ChatGPT Plus/Pro connected through `opencode auth login` does not become an email or a `planType`. Codex exposes that through `account/read`. OpenCode does not.
- **Reading `auth.json` or token columns.** Both files are credential stores. The identity projection never opens them.
- **Parsing `opencode console orgs` or `opencode auth list`.** Both print the facts. Both are terminal text.
- **Treating `GET /provider` objects as identity.** `connected` is a provider-id list. The objects can contain the API key.
- **OpenCode v2's `opencode auth list --format json`.** The v2 docs describe credentials in SQLite and a JSON auth list. 1.18.32 has the `credential` table and still reads `auth.json`. Re-probe when the support baseline leaves 1.18. Do not implement that path against this CLI.

## Recommendation

Implement this in `packages/adapter-opencode/src/services/profiles.ts`, after the Surface claims below exist. Runtime and Godview already render a `native-protocol` identity. They do not need a provider branch.

1. Keep the `XDG_DATA_HOME=<dataRoot>/data` binding for managed profiles, and inject nothing for the native default.
2. Change `loginInvocation` to `opencode console login`. It stays a host terminal. Puppeteer does not capture the device code or the URL.
3. Set `identity` to `native-protocol` and `credential` remains `root`. Deleting the root removes the database, which holds the tokens. `opencode console logout <email>` can wait. It is not required for an external credential.
4. `verify(profile)`:
   - Resolve the database at `<data home>/opencode/opencode.db` with the profile binding applied and the ambient `XDG_DATA_HOME` removed for a native-default profile, the same way Claude strips an inherited config dir.
   - Open it `file:<path>?mode=ro`. Missing file or zero `account` rows returns `{ loggedIn: false, source: { kind: 'native-protocol', stability: 'experimental' } }`.
   - A database that does not have `account` and `account_state` returns `unavailable`. An older binary is an unrecognized shape, not a signed-out account.
   - When a row exists, start the adapter's existing short-lived `opencode serve` under the binding. `GET /experimental/console/orgs`. Choose the org with `active: true`. Email comes from `accountEmail` when the document has it, otherwise from the database. Organization is `orgName`. `method` is `console`.
   - A failed request, a non-JSON body, or `{ "orgs": [] }` keeps `loggedIn: true` and the database email, and omits organization.
   - A document that is not the known org list is `unavailable`, not signed out.
5. Leave `plan` unset. Do not decode JWTs, do not read `auth.json`, and do not persist `GET /provider`.

Godview then shows **SIGNED IN · email · org** for a Console account, and **SIGNED OUT** for a fresh root. A profile that only completed `opencode auth login` stays signed out of this identity, which is the honest result until OpenCode publishes a provider status document.

### Surface claims to capture first

RFC 006 requires these facts to be claims, digest-locked by `groundtruth-map.json`, before the adapter relies on them. The routes are already in the 1.18.16 ground truth with confidence `unverified`.

- Signed-out and signed-in bodies of `GET /experimental/console` and `GET /experimental/console/orgs`, including the absent `activeOrgName` on 1.18.32.
- The `account` / `account_state` projection, with the token columns named as out of bounds.
- The login argv `console login`, and the note that `auth login` remains the provider-credential command.
- The default console URL change between 1.18.16 and 1.18.32, recorded as a version fact so nobody hardcodes it.
- A negative claim: `GET /provider` provider objects may contain `key`. Identity code reads `connected` only, and this change does not read it at all.

### Tests

Follow the Claude profile service: inject the database reader and the HTTP call. Unit-test the decoder and the offline case (account row present, org route empty or failed). A live `opencode serve` does not belong in the default suite. An opt-in proof can wait for `OPENCODE_LIVE=1` and a real Console login.

### Later, only if a host asks for provider connectivity

`connected: string[]` can become a separate capability. It is a poor fit for `method`: a Console org can inject `opencode` into `connected` without an `auth.json` entry, and a joined provider list would be mistaken for a subscription plan. Keep it out of `ProfileIdentity` until the contract grows a field for it.
