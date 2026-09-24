# Pi profile identity

Status: **research, not implemented**
Probed: **2026-09-23**, Pi **0.87.1** (`@earendil-works/pi-coding-agent`, current `main` of [earendil-works/pi](https://github.com/earendil-works/pi))
Question: can a Puppeteer profile say which subscription a Pi root is signed into, the way Claude and Codex already can?

## Outcome

Yes, for the subscription that root will use. No, for an email, an organization, or a named plan.

Pi keeps one credential per provider inside the profile's agent directory. The subscription the TUI will use is `settings.json`'s `defaultProvider` and `defaultModel`. The safe confirmation is `pi auth check --provider <id> --json --no-refresh`, and only when its `authType` matches a row actually stored in that directory. Ambient API keys make the same command report `ready` for a profile that has stored nothing.

Pi's login code persists `access`, `refresh`, and `expires`. It does not persist email, organization, or a plan name. The one exception is ChatGPT-in-Pi, which also persists `accountId`. Decoding the bearer token, or calling a userinfo endpoint with it, is not a status read. The local xAI access token is an `at+jwt` whose payload has a subject, a numeric `tier`, and a `team_id`, and no email claim. Pi never reads those claims, and `tier` has no published map onto "SuperGrok" or "X Premium".

## What the profile system already requires

[RFC 006](../docs/rfcs/006-agent-distribution-and-account-profiles.md) makes a profile a launch selection: one persistent native data root, bound with the provider's own variable, never a machine-wide account switch. Onboarding runs the vendor's own login in a host terminal whose output Puppeteer does not capture. `verify()` then stores a `ProfileIdentity` on the profile.

`ProfileIdentity` in `packages/core/src/services/profiles.ts` is one person:

| Field | Meaning |
| --- | --- |
| `loggedIn` | Signed in or not |
| `method` | Native login method, such as a subscription or an API-key mode |
| `email` | Account email, when the native document has one |
| `organization` | Organization name, when the native document has one |
| `plan` | Native plan or subscription label |
| `source` | `native-status` or `native-protocol`, `documented` or `experimental` |

The document rejects any token field. Godview (`apps/godview/src/renderer/agents-drawer.ts`) draws `SIGNED IN` or `SIGNED OUT`, then joins email, organization, and `plan ?? method`. A provider whose `identity` is `none` draws **NO IDENTITY SURFACE** and offers no verify action.

Claude and Codex are the two providers that fill this today.

| Provider | Identity source | What comes back |
| --- | --- | --- |
| Claude | `claude auth status --json` under `CLAUDE_CONFIG_DIR` | `loggedIn`, `authMethod`, `email`, `orgName`, `subscriptionType`. No token. |
| Codex | app-server `account/read` under `CODEX_HOME`, with token refresh left off | `account: null` when logged out; otherwise `type` (`chatgpt` or `apikey`), `email`, `planType`. No token. |

Both adapters refuse to read the credential store. A missing or unrecognized document is `unavailable`, not a fabricated sign-out.

## Where Pi stands

`packages/adapter-pi/src/services/profiles.ts` already isolates a root. `PI_CODING_AGENT_DIR` is set to `<dataRoot>/agent` for a managed profile and left unset for the native default (`~/.pi/agent`). The profile root itself is the history layout root (`~/.pi` natively). Credentials are `root`: `auth.json` sits in the bound agent directory, so deleting the root removes them. There is no keychain item to sign out separately.

The service reports `identity: 'none'` and `verify()` returns `unsupported`. Its comment, probed 2026-09-06 on Pi 0.84.3, says `pi auth` only offers `print-api-key`, `print-bearer-token`, and `check`, and that those commands emit credentials so a host must never run them. Login therefore opens `pi` itself, and the user authenticates with `/login`.

The credential-printing half of that comment is still right. The check half is not. On 0.87.1, `pi auth check` prints a credential only when `--credentials` is passed.

Provider docs: [packages/coding-agent/docs/providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md). `/login` writes `auth.json`. `/logout` removes one provider's stored credential and does not unset environment variables or revoke the token at the provider. There is no `pi auth login` and no `pi auth logout`.

## What one Pi root contains

`getAgentDir()` resolves `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. That directory holds:

| File | Role for identity |
| --- | --- |
| `auth.json` | One credential per provider id. Mode `0600`. This is the credential store. |
| `settings.json` | `defaultProvider` and `defaultModel`: the subscription and model the TUI will use. Not a credential. |
| `sessions/` | History. Irrelevant to who is signed in. |

`CredentialStore` in `packages/ai/src/auth/types.ts` is explicit. `list()` returns `{ providerId, type }` and must not expose secrets or run configured API-key commands. `read()` is the path that returns the secret. A stored credential is either:

```text
{ type: "api_key", key?, env? }
{ type: "oauth", access, refresh, expires, ...extra }
```

One provider id maps to one credential. Two Claude Max accounts, or two SuperGrok accounts, cannot share a root. The second account is a second Puppeteer profile. That is the model the profile machinery already implements. What is missing is a label for the root.

Several different providers can be signed in inside one root. `ProfileIdentity` cannot list them. The fact the drawer needs first is the selected one.

### Subscription catalog

Pinned from Pi 0.87.1, `isSubscription: true` on the OAuth method:

| Provider id | Login label | Non-secret field Pi persists besides the tokens |
| --- | --- | --- |
| `anthropic` | Anthropic (Claude Pro/Max) | none |
| `openai-codex` | OpenAI (ChatGPT Plus/Pro) | `accountId`, taken from the access token's `https://api.openai.com/auth` → `chatgpt_account_id` |
| `github-copilot` | GitHub Copilot | `enterpriseUrl`, `availableModelIds` |
| `xai` | xAI (Grok/X subscription). Login option: "Sign in with SuperGrok or X Premium" | none |
| `kimi-coding` | Kimi Code (subscription) | none |
| `meta` | Meta (Muse subscription) | none |

OpenRouter and Radius have OAuth and are not marked as subscriptions. API-key providers are not subscriptions. Anthropic, xAI, Kimi, and Meta login functions return only `type`, `access`, `refresh`, and `expires`. Copilot additionally returns the enterprise domain and the model ids it enabled. Codex is the only flow that keeps an account identifier, and it still discards email and plan.

The xAI flow (`packages/ai/src/auth/oauth/xai.ts`) requests scope `openid profile email offline_access grok-cli:access api:access` and then throws away every token-response field except the three token fields. The same client id (`b1a00492-073a-47ea-816f-4c329264a828`) and issuer (`https://auth.x.ai`) are the public Grok CLI OAuth client. Third-party writeups of Grok CLI's own `auth.json` show that the Grok CLI persists `email` and `user_id` beside the tokens. Pi does not.

## The status command

```text
pi auth check --provider <provider> [--model <model>] [--json] [--credentials] [--no-refresh]
```

Help text and `packages/coding-agent/src/cli/auth-command.ts` require `--provider` or `--model`. There is no list mode. Exit codes, from `packages/coding-agent/src/main.ts`:

| Exit | Status |
| --- | --- |
| 0 | `ready` |
| 1 | `not_ready` |
| 2 | bad invocation, or `invalid` |

JSON without `--credentials`:

```json
{ "status": "ready", "provider": "xai", "authType": "oauth" }
```

```json
{ "status": "not_ready", "provider": "anthropic", "reason": "credentials_not_configured" }
```

`reason` is `provider_not_found`, `credentials_not_configured`, `credential_not_available`, or `invalid_state`. Text mode prints the single word `ready` or `not_ready`. That is terminal prose. The JSON document is the one to decode.

`--no-refresh` constructs `ReadOnlyAuthStorage`. Its `modify` and `delete` throw. A check under that flag does not rotate a token. `--credentials` is the flag that puts the bearer token or API key into the JSON under `credentials`. A host must not pass it.

`Models.checkAuth` (`packages/ai/src/models.ts`) prefers a stored OAuth row: if the stored credential is `oauth`, the result is `{ source: "OAuth", type: "oauth" }` without using the token. Otherwise it resolves API-key auth, which includes the process environment. The CLI drops `source` and keeps `authType`. A stored OAuth row therefore wins over an API key in the environment. An environment key with nothing stored is indistinguishable, in the CLI output, from a key saved by `/login`.

## Experiments

Run on this machine against Pi 0.87.1. No `--credentials`. The real `auth.json` was not rewritten: mtime and size were identical before and after every `--no-refresh` check. Empty probe directories were left with no files.

The native root's `auth.json` has one provider, `xai`, type `oauth`. `settings.json` has `defaultProvider: "xai"` and `defaultModel: "grok-4.6"`.

| Probe | Result |
| --- | --- |
| Empty `PI_CODING_AGENT_DIR`, `--provider xai --json --no-refresh` | `not_ready`, `credentials_not_configured`, exit 1 |
| Same empty directory, `XAI_API_KEY` set to a fake value | `ready`, `authType: "api_key"`, exit 0 |
| Same, fake `ANTHROPIC_API_KEY` | `ready`, `authType: "api_key"`, exit 0 |
| `PI_CODING_AGENT_DIR` pointed at `~/.pi/agent`, provider `xai` | `ready`, `authType: "oauth"`, exit 0 |
| That real root plus a fake `ANTHROPIC_API_KEY` | Anthropic reports `ready` / `api_key` although it is not in the file |
| Real root plus a fake `XAI_API_KEY` | Still `oauth`. The stored row wins |
| Unknown provider | `not_ready`, `provider_not_found`, exit 1 |
| `--json --no-refresh` with no provider and no model | error on stderr, exit 2 |
| Real root, `--no-refresh` without `--json` | the word `ready` |

Binding works. The command is profile-scoped. It is not sufficient on its own: a profile with an empty `auth.json` looks signed in whenever the parent process has a provider API key. The Pi profile service already records that leak as a shared surface ("provider API keys supplied through environment variables").

The local xAI access token was decoded only far enough to see claim names, and the token was not printed. Header `typ` is `at+jwt`, issuer `https://auth.x.ai`. Payload claim names: `iss`, `sub`, `aud`, `exp`, `iat`, `scope`, `principal_type`, `principal_id`, `client_id`, `jti`, `tier`, `team_id`. `scope` includes `email`. There is no `email` claim. `tier` is a number. Pi's login code does not store any of these.

## Reliable procedure

A Pi profile is a set of stored provider logins plus one selected provider. `verify()` should describe the selected stored login. It should not describe what the surrounding process can authenticate as.

1. Resolve the agent directory the way launch already does. Managed: `<dataRoot>/agent`. Native default: `~/.pi/agent`.
2. Project `auth.json` the way `CredentialStore.list()` does. Keep `providerId` and `type`. Also keep the non-secret extras Pi already persists: `accountId` and `enterpriseUrl`. Drop `access`, `refresh`, and `key` immediately, and never log the parsed object. A missing file is signed out. Unreadable or invalid JSON is `unavailable` and retryable, the same rule Claude uses for a garbled status document.
3. Read `defaultProvider` and `defaultModel` from `settings.json`. The selected row is the stored credential whose provider id equals `defaultProvider`. If that provider is not stored, use the only subscription OAuth row, then the first stored row.
4. Confirm the selected provider with `pi auth check --provider <id> --json --no-refresh`, with `PI_CODING_AGENT_DIR` set to the agent directory, after removing known provider API-key variables from the probe environment. Accept the check only when `authType` equals the stored `type`. An `api_key` result with no stored row is the ambient environment.
5. Map the selected row onto the existing `ProfileIdentity`:
   - `loggedIn`: the stored inventory is non-empty
   - `method`: `oauth` or `api_key`
   - `plan`: the catalog label, for example `xAI (Grok/X subscription)`
   - `email` and `organization`: omitted
   - `source`: `{ kind: "native-status", stability: "experimental" }` until Pi documents the JSON shape

Godview already renders `plan`, so the drawer becomes **SIGNED IN · xAI (Grok/X subscription)** without a schema change. `accountId` for ChatGPT-in-Pi does not belong in `email`.

`identity` on the provider support record changes from `none` to `native-status`, which is what turns verify on in the drawer. The catalog of subscription labels is a table in the adapter, pinned to a probed Pi version, the same way the Claude adapter pins the field names it saw in `auth status --json`.

Login stays what it is: the login invocation runs `pi` with the binding and no auth arguments, and the user runs `/login`. The credential is inside the root, so there is no `signOut` method. Deleting the root is the sign-out. Do not delete keys out of `auth.json` from Puppeteer.

### Why the file projection is required

`pi auth check` cannot list the root, and with API-key variables present it reports subscriptions the root does not hold. Stripping those variables and probing a hardcoded provider list would avoid opening `auth.json`, and it would still miss a custom provider and would spawn one process per id. Pi's own `list()` is the API designed for this read. It is not exposed as a CLI. Reimplementing its projection — provider id and type, secrets discarded — is the same contract. The check remains the cross-check that the binary agrees, and the proof that verification did not refresh a token.

Opening `auth.json` is the one place this diverges from Claude and Codex, which have a credential-free status document. The divergence is forced by the CLI. The read is limited to the fields `list()` is specified to return, plus the two non-secret extras the login code writes.

## What not to build

- Do not pass `--credentials`, `print-api-key`, or `print-bearer-token`.
- Do not omit `--no-refresh`. The default check refreshes an expired OAuth credential, which is a write to the store. Codex verification leaves `refreshToken` off for the same reason.
- Do not decode access tokens in Puppeteer. The xAI payload's `tier` and `team_id` are undocumented, and the token is the bearer credential.
- Do not call a provider userinfo or billing endpoint with the stored token. That uses the credential, and Pi itself does not.
- Do not treat an `api_key` check result as this profile's subscription when the row is not in its `auth.json`.
- Do not join every signed-in provider into the single `plan` string. The selected provider is the fact that matches "which subscription this profile will use".
- Do not put `accountId` in `email`.

## Follow-ups, in order

1. Implement the procedure above in `createPiProfileService`, with the exec and the file reads injected the way Claude and Codex inject theirs. Correct the file comment: `auth check` emits a credential only with `--credentials`.
2. If the drawer should list every signed-in provider in the root, add an optional `accounts` array to `ProfileIdentity` (`provider`, `method`, `subscription`, optional `accountId`). That is a core schema change and a drawer change. It is not required for the first label.
3. The durable upstream fix is a `pi auth status --json` that, with no `--provider`, lists stored credentials, distinguishes `stored` from `environment`, includes the non-secret fields Pi already keeps, defaults to no refresh, and still requires `--credentials` before it prints a token. When that exists, delete the file projection and decode the command, and move `stability` to `documented`.

## Sources

- `packages/core/src/services/profiles.ts` — `ProfileIdentity`, `ProfileService.verify`
- `packages/adapter-claude/src/services/profiles.ts` — `claude auth status --json`
- `packages/adapter-codex/src/services/profiles.ts` — `account/read`, refresh left off
- `packages/adapter-pi/src/services/profiles.ts` — current `identity: 'none'`
- `apps/godview/src/renderer/agents-drawer.ts` — `identityText`
- `docs/rfcs/006-agent-distribution-and-account-profiles.md`
- Pi 0.87.1 installed at `@earendil-works/pi-coding-agent`, and the same sources on `main`:
  - `packages/coding-agent/src/cli/auth-command.ts`
  - `packages/coding-agent/src/cli/auth-check.ts`
  - `packages/coding-agent/src/main.ts` (check output and exit codes)
  - `packages/coding-agent/src/config.ts` (`getAgentDir`, `getAuthPath`)
  - `packages/ai/src/auth/types.ts` (`CredentialStore.list`)
  - `packages/ai/src/models.ts` (`checkAuth`)
  - `packages/ai/src/auth/oauth/{anthropic,openai-codex,github-copilot,xai,kimi-coding,meta,openrouter,radius}.ts`
  - `packages/coding-agent/docs/providers.md`
