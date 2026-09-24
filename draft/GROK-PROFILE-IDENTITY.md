# Grok profile identity

| Field    | Value                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| Status   | Research complete on 2026-09-23. Not implemented. Not a Surface claim and not a support change. |
| Question | How a profile can learn who is signed in to Grok, and on which plan, without reading a token. |
| Probe    | Installed `grok 1.0.41` (`4220f3b224a6`), stable channel, `~/.grok/downloads/grok-1.0.41-macos-aarch64` |
| Contract | [RFC 006](../docs/rfcs/006-agent-distribution-and-account-profiles.md), `ProfileIdentity` in `packages/core/src/services/profiles.ts` |

Grok profiles already bind `GROK_HOME` and run `grok login`. They still report identity as `none`, so `verify()` returns `unsupported` and the accounts row cannot show an email or a plan. Claude answers this with `claude auth status --json`. Codex answers it with app-server `account/read`. Grok has the same kind of answer on the agent protocol the usage service already speaks.

## Decision

Verify a Grok profile by spawning `grok agent --no-leader stdio` under that profile's `GROK_HOME`, then reading two ACP methods:

1. `_x.ai/auth/info` for who is signed in.
2. `_x.ai/billing`, only after that read says a session is signed in, for the plan label.

Treat the result as `native-protocol` / `experimental`. A missing or unrecognizable document is `unavailable`. A signed-in info document whose billing call fails is still signed in, with no plan.

The host never opens `auth.json`, never calls a method that returns a bearer, and never parses login or logout text.

## What the CLI publishes

`grok --help` on 1.0.41, the current [CLI reference](https://docs.x.ai/docs/build/cli/reference), and the clap command enum in grok-build all stop at the same auth pair:

| Command       | What it does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `grok login`  | Interactive sign-in. `--oauth` / `--oidc` forces loopback. `--device-auth` is the headless flow. |
| `grok logout` | Clears the cached session. Prints a human line that can name an email.      |

There is no `auth`, `auth status`, `whoami`, or `account` subcommand, and none of them emit JSON. `grok usage <session-id>` prints persisted token counts and cost for one session. `grok models` can banner a login host as terminal text. The 2026-09-06 note in `packages/adapter-grok/src/services/profiles.ts` (no `--json` auth status on 1.0.13) is still true of the CLI. 1.0.14 added `grok usage`; it did not add an identity command.

Login stores the session at `$GROK_HOME/auth.json` (default `~/.grok/auth.json`), owner-only. A second root is a second account. An empty `GROK_HOME` created for this probe advertised only the interactive `grok.com` method and returned a signed-out info document.

## Where the fields actually live

Public grok-build (`xai-org/grok-build`, `crates/codegen/xai-grok-login/src/model.rs`) defines one `GrokAuth` record per scope inside `auth.json`. The same object holds `key` and `refresh_token` beside `email`, `auth_mode`, names, `principal_type`, team, and organization. It has no subscription field. The live tier is `UserInfo.subscription_tier`, returned only by `GET {cli-chat-proxy}/user?include=subscription`. The display string the pager shows ("SuperGrok Heavy", "X Premium", "Free") is copied onto the billing response from `GET {cli-chat-proxy}/settings` (`subscription_tier_display`, else `subscription_tier`).

`extensions/auth.rs` is explicit that the agent is the source of truth for `auth.json`. Two of its methods matter, and they are not the same call:

| Wire method                         | Handler                         | What it returns                                      | Side effect                                      |
| ----------------------------------- | ------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `_x.ai/auth/info`                   | `handle_info`                   | `methodId`, email, names, team, organization, principal. No tier. No bearer. | None. A direct read of `AuthManager`.            |
| `_x.ai/billing`                     | `handle_get_billing`            | Credits config plus the display tier.                | A network read the usage service already makes. |
| `_x.ai/auth/check_subscription`     | `handle_check_subscription`     | `{ authenticated, meta }`, and `meta` can carry email and tier. | Calls `retry_subscription_check()` first, which can refresh the session token. |
| `_x.ai/auth/getBearerToken`         | `handle_get_bearer_token`       | The access token.                                    | Must never be called from a profile verify.     |
| `x.ai/auth/info` (no underscore)    | —                               | JSON-RPC `-32601` on 1.0.41.                         | —                                                |

Custom ACP methods on the build Grok pins (agent-client-protocol 0.10.4) require one leading underscore. The library strips it before dispatch. A later crate stopped stripping; 1.0.41 still requires the underscore, confirmed live.

`initialize` does not list extension methods. The published agent-mode guide names `x.ai/auth/get_url` and `x.ai/auth/submit_code` as examples and says the `x.ai/*` set is non-exhaustive. `auth/info` and billing are source-level, so the profile source stays `experimental` until a Surface claim locks the document shape.

## Live probe

Both calls used `grok agent --no-leader stdio`, `initialize` with protocol version 1, and no `authenticate`. `XAI_API_KEY` was unset. Values below are the shape, with the account's email, name, and ids omitted.

Signed-in native root (`~/.grok`):

```json
{
  "methodId": "cached_token",
  "email": "<present>",
  "organizationName": null,
  "teamName": null,
  "principalType": "User"
}
```

`_x.ai/billing` on that same root:

```json
{
  "config": {
    "creditUsagePercent": 3,
    "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY" }
  },
  "subscription_tier": "SuperGrok Heavy"
}
```

Empty `GROK_HOME`:

- `authMethods` was only `grok.com`. `defaultAuthMethodId` was null.
- `_x.ai/auth/info` returned `methodId: null` and null email, team, and organization. `codingDataRetentionOptOut: true` is the no-credential default, so it is not a signed-out signal.
- `_x.ai/billing` returned `-32000` "Authentication required".
- `_x.ai/auth/check_subscription` returned `{ "authenticated": false, "meta": null }`.

Other files under the native root were inspected only as shapes. `models_cache.json` records `auth_method: "session"` and a hash, not an email or a plan. `settings_cache.json` is a signed opaque payload, not a readable tier document. `config.toml` on this machine holds UI and model preferences, not the account.

## Mapping onto `ProfileIdentity`

| Field           | Rule                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `loggedIn`      | `methodId` is `cached_token` or `xai.api_key`. `null`, `grok.com`, and `oidc` are signed out.             |
| `method`        | That `methodId`.                                                                                          |
| `email`         | `email`, when it is a non-empty string.                                                                   |
| `organization`  | `organizationName`, otherwise `teamName`. Ids stay off the profile. This account had a team id and no display name, so the field stays empty. |
| `plan`          | Billing `subscription_tier`, also accepting `subscriptionTier`.                                           |
| `verifiedAt`    | Probe time.                                                                                               |
| `source`        | `{ kind: "native-protocol", stability: "experimental" }`.                                                 |

Keep only that allow-list. `profileImageUrl` is a `grok-asset://` URL that embeds an account id. `firstName`, principal ids, and privacy flags are not `ProfileIdentity` fields.

`ProfileSupport` for Grok then becomes:

```ts
support: {
  supported: true,
  identity: 'native-protocol',
  sharedSurfaces: [],
  nativeDefaultRoot: /* ~/.grok */,
  credential: 'root',
}
```

`credential: 'root'` replaces the RFC 006 "unknown" for Grok. The session file is inside the root, so deleting a managed root is the sign-out. `signOut()` stays absent: that method is for a credential kept outside the root, which is Claude's Keychain case. `grok logout` remains the native command a person can run inside the profile pane.

The accounts drawer already renders `email`, `organization`, and `plan`, falling back to `method`. A signed-in Grok row on this machine would show the email and `SuperGrok Heavy`.

## Probe environment

The launch allow-list is `GROK_HOME` only (`packages/builtin-providers`). Verify should build the same kind of clean environment the runtime uses for a launch, then set `GROK_HOME` for a managed profile and leave it unset for the native default. In particular it should not inherit:

| Variable                 | Why it is outside the profile                                      |
| ------------------------ | ------------------------------------------------------------------ |
| `XAI_API_KEY`            | API-key auth. Advertised as method id `xai.api_key`.               |
| `GROK_CODE_XAI_API_KEY`  | Legacy name of the same key.                                       |
| `GROK_AUTH`              | A raw auth document injected ahead of the root's `auth.json`.      |
| `GROK_AUTH_PATH`         | Test override that points the reader at a different auth file.     |

When a session and an API key are both visible, grok-build still prefers `cached_token` as `default_auth_method_id`, and it lists `xai.api_key` first in `authMethods`. A probe that inherits a key can therefore describe a different account than the profile root. This machine had no `XAI_API_KEY`, so the `xai.api_key` identity shape (signed in, no email) is from source, not from a live call.

Do not call `authenticate` during verify. `auth/info` answered from the cached session without it. Codex `account/read` is the precedent: verification observes and does not rotate a credential.

## What stays out

- Parsing `auth.json` or `mcp_credentials.json`. Community switchers do this. The bearer sits in the same object as the email.
- `_x.ai/auth/check_subscription` as the verify call. It is a real tier read, and it refreshes first.
- `_x.ai/auth/getBearerToken`, `_x.ai/getApiKey`, and `_x.ai/setApiKey`.
- Calling `cli-chat-proxy.grok.com`, `api.x.ai`, or `accounts.x.ai` with a token the host extracted. `GET /v1/api-key` on `api.x.ai` returns key metadata plus `user_id` and `team_id`, not email, organization, or tier. `accounts.x.ai` is the consent host and the legacy scope `https://accounts.x.ai/sign-in`, not the profile API.
- Terminal text from `grok logout`, `grok models`, or the TUI.

## Version skew to accept on purpose

| Fact                         | 1.0.41, probed live                         | Current grok-build main                          |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------ |
| Billing tier field           | Top-level `subscription_tier`               | Top-level `subscriptionTier`                     |
| Underscore on custom methods | Required. Bare `x.ai/auth/info` is `-32601` | 0.10.4 strips one underscore; a later crate stopped |
| Tier vocabulary              | Display label `SuperGrok Heavy`             | Display label from settings; `/user` uses tokens such as `SuperGrokPro` |

Accept both tier spellings, the same way account usage already accepts both casings of the credits fields. The plan stored on the profile is the display label, which is what the row should show.

The support ledger still candidates Grok at 1.0.0. This probe is 1.0.41. Per RFC 006, the document shape becomes a Surface claim before an adapter treats it as stable. Until that capture exists, the decoder stays tolerant and the source stays `experimental`.

## Implementation sketch

When this is picked up, the change is the Grok profile service plus its unit tests. Runtime, Godview, and Core already render `ProfileIdentity`.

In `packages/adapter-grok/src/services/profiles.ts`:

- Set `identity` to `native-protocol` and `credential` to `root`.
- `verify()` spawns the same `grok agent --no-leader stdio` transport account usage uses, with the profile binding and the stripped environment above.
- Send `initialize`, then `_x.ai/auth/info`. Decode with the table above.
- When `loggedIn` is true, send `_x.ai/billing` and copy the tier onto `plan`. A billing failure leaves `plan` unset and still returns the identity.
- Close the child in `finally`. One process, two reads, no session created.

Tests follow `account-usage.test.ts`: a scripted transport for the signed-in document, the signed-out document, an unrecognized body, a billing miss, and both tier spellings. Assert the serialized result never contains `key`, `refresh_token`, `Bearer`, or `auth.json`. A live test stays opt-in, next to `GROK_ACCOUNT_USAGE_LIVE`.

Imposter's Grok persona should grow an `_x.ai/auth/info` result so conformance can run without a real account. That is a Surface-shaped fixture, not a hand-written special case in the adapter.

RFC 006's Grok row can then name the two methods and `credential: root`. The 2026-09-06 "no structured identity document" sentence gets a dated successor; it should not be deleted as if 1.0.13 had this probe.

## Sources

- Installed CLI: `grok 1.0.41` help and the ACP probe above. 2026-09-23.
- [CLI reference](https://docs.x.ai/docs/build/cli/reference).
- [grok-build authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md).
- [grok-build agent mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md).
- [`GrokAuth` and `UserInfo`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-login/src/model.rs).
- [`extensions/auth.rs`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/auth.rs), including `handle_info` and `handle_check_subscription`.
- [`extensions/billing.rs`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs).
- [`agent/auth_method.rs`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/auth_method.rs) for `cached_token`, `xai.api_key`, `grok.com`, and `oidc`.
- [`subscription_check.rs`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/subscription_check.rs) for `GET /user?include=subscription`.
- Account usage already in tree: `packages/adapter-grok/src/services/account-usage.ts` (`_x.ai/billing`, experimental).
