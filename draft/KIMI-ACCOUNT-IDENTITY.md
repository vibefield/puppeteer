# Kimi subscription identity

Date: 2026-09-23.

Status: research complete. No adapter change in this note. The recommendation is a read-only `GET /me` during profile verify, using the access token Kimi Code already stored.

This is the account-identity half of RFC 006 for Kimi Code. Claude and Codex already fill `ProfileIdentity` (`email`, `organization`, `plan`). Kimi profiles bind `KIMI_CODE_HOME` and can read usage, and `verify()` still returns `unsupported` with `identity: 'none'`.

## Recommendation

Read `GET {base}/me` with the access token in the profile root's `credentials/kimi-code.json`. That is the profile document the official CLI parses. Map `email` and `user_level_name` into `ProfileIdentity`. Leave the credential file alone.

Do not call the local server route `GET /api/v1/oauth/userinfo` from verify. It is the same document, but the server refreshes the grant first and writes the credential file. On this machine that write logged the account out. See "Live probe".

Do not scrape `kimi login` output. There is no `kimi auth status`. The access-token JWT does not carry email or plan.

## Where the document lives

Installed CLI: Kimi Code **2.0.2** at `~/.kimi-code/bin/kimi` (probed 2026-09-23). Surface and the support ledger are still on candidate **0.34.0**. The identity contract below is from current upstream source and from the 2.0.2 binary, which embeds the same parser.

Two URLs, one payload:

| Surface | URL | Shape |
| --- | --- | --- |
| Cloud, what the CLI fetches | `GET {base}/me` | snake_case |
| Local server, documented product API | `GET /api/v1/oauth/userinfo` | camelCase `{ kind: "ok", userInfo }` or `{ kind: "error", message, status? }`, inside the usual `{ code, msg, data, request_id }` envelope |

`{base}` is `https://api.kimi.com/coding/v1` (mainland) or `https://api.kimi.ai/coding/v1` (global), overridable with `KIMI_CODE_BASE_URL`. The CLI comment in `managed-userinfo.ts` says the cloud path stays `/me` and only the local name moved to `userinfo`.

Headers on the cloud call, asserted by the CLI's own test: `Authorization: Bearer <access token>` and `Accept: application/json`. No `User-Agent`. No `X-Msh-Platform`. A 401 means the access token was rejected. A body without a string `user_id` is malformed, not a signed-out account.

Sources:

- [`packages/oauth/src/managed-userinfo.ts`](https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/src/managed-userinfo.ts) and [`packages/oauth/test/managed-userinfo.test.ts`](https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/test/managed-userinfo.test.ts)
- [Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html), `GET /api/v1/oauth/userinfo`
- The same functions embedded in the local 2.0.2 binary (`kimiCodeUserInfoUrl`, `parseManagedUserInfoPayload`, `KimiOAuthToolkit.getManagedUserInfo`)

`getManagedUserInfo` always calls `ensureFresh` before `fetchManagedUserInfo`. That is the CLI's refresh. Puppeteer does not own it.

## Payload

Required, always serialized (missing strings become empty, missing integers become 0):

| Wire | Domain | Use |
| --- | --- | --- |
| `user_id` | `userId` | Presence means this is a profile. |
| `nickname` | `nickname` | Display name. Not an email. |
| `status` | `status` | Account status, e.g. `USER_STATUS_NORMAL`. |
| `region` | `region` | e.g. `REGION_CN`. |
| `user_level` | `userLevel` | Integer tier. |
| `user_level_name` | `userLevelName` | Plan label. The published fixture uses `Vivace`. This is what the CLI sidebar prints. |
| `domain` | `domain` | Integer. |
| `domain_name` | `domainName` | Always present. The fixture value is `DOMAIN_EXAMPLE`, an internal code. |

Optional: `global_id`, `bio`, `avatar`, `username`, `email`, `phone` (`country_code`, `number`; the fixture is already masked), `created_time`, `last_login_time`, `goods_version` (integer in current source).

The sidebar treats one `userLevel` as free and any other as member, and treats HTTP 402 from the profile fetch as free. The level constant is minified in the binary. The stable label for `ProfileIdentity.plan` is `user_level_name`, not that boolean and not `goods_version`.

## What the token is not

`credentials/kimi-code.json` is mode 0600 and holds `access_token`, `refresh_token`, `expires_at`, `expires_in`, `scope`, `token_type`. Observed scope `kimi-code`, token type `Bearer`, `expires_in` 900. The access token is a three-part ES256 JWT. Claims seen: `client_id`, `device_id`, `exp`, `iat`, `iss` (`kimi-auth`), `jti`, `nbf`, `scope`, `sub`, `token_id`, `type`, `user_id`. `sub` equals `user_id`. No email, no plan, no organization.

`config.toml` for a managed login looks like this:

```toml
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
```

The oauth key path `oauth/kimi-code` was an empty file. The tokens live in `credentials/kimi-code.json`, which is already what `fetchKimiAccountUsage` reads. A `region` file in the root held `cn`.

## Live probe

Probed 2026-09-23 against the native default root `~/.kimi-code`, Kimi Code 2.0.2. No token was printed or written into this note.

1. The stored access token was already expired (`expires_at` about 35 days before the probe). Direct `GET https://api.kimi.com/coding/v1/me` and `GET .../usages` both returned **401** with `invalid_authentication_error`: "The API Key appears to be invalid or may have expired."
2. `kimi web --no-open --dangerous-bypass-auth` on 127.0.0.1 came up. `GET /api/v1/auth` returned `managed_provider.status: "authenticated"` and `models_ready: true`. That flag means a credential slot exists. It does not mean the grant still works.
3. `GET /api/v1/oauth/userinfo` returned HTTP 200 with `data.kind: "error"` and message "The provided authorization grant is invalid". `GET /api/v1/oauth/usage` failed the same way. `GET /api/v1/oauth/region` returned `mainland-cn` from local resolution, with no network probe.
4. The CLI's refresh then rewrote the credential file: `access_token` and `refresh_token` became empty strings, `expires_at` and `expires_in` became 0. It also cleared the `api_key` fields on the managed provider and on `services.moonshot_search` / `services.moonshot_fetch`. Models, `base_url`, and the oauth storage block remained.
5. The probe deleted the `server.token` file that `kimi web` created on first boot (`<root>/server.token`, mode 0600). No `kimi web` process was left running.

The refresh grant was already invalid before that rewrite, so the session could not have been renewed. The rewrite is still the CLI's reaction to a failed `ensureFresh`, and a verify implementation must not trigger it. Restoring this account is `kimi login` in that root.

## Verify behavior

Match the usage service: read the credential file, never write it, never rotate a refresh token.

`ProfileIdentity.source` is `{ kind: "native-status", stability: "documented" }`. Support `identity` becomes `native-status`. The cloud URL is the CLI's status document; the field list is published both in that source and on the server API page. `native-protocol` would mean spawning `kimi web`, which is the path that writes credentials.

| Situation | Result |
| --- | --- |
| `/me` returns a `user_id` | `loggedIn: true`. `email` from `email` when it is a non-empty string. `plan` from `user_level_name` when non-empty. `method` is `kimi-code` (the oauth scope). `organization` stays unset. |
| Credential file missing, or token fields blank | `loggedIn: false`. This is a real signed-out read, the same shape Codex uses for `account: null`. |
| Access token past `expires_at` (15 minutes), refresh token still present | `unavailable`, retryable. Do not call the network. Do not refresh. |
| 401, or any other HTTP failure, on a token the file still considers fresh | `unavailable`, retryable. Do not treat 401 as signed out: the refresh token may still be good, and only Kimi Code may use it. |
| 200 without a string `user_id` | `unavailable`, not signed out. |

Runtime already records an identity only when `verify()` returns a `ProfileIdentity`. A `ProfileFailure` leaves the last stored identity in place, and the drawer shows the failure as an error. That is the right pairing: the verify that runs when the login pane exits sees a fresh access token and stores email and plan; a later Verify, after the 15-minute token has lapsed, fails without erasing them. Opening Kimi lets the CLI refresh; the next Verify can read `/me` again.

Resolve `{base}` from the profile root, in order:

1. `KIMI_CODE_BASE_URL` in the probe environment.
2. `providers."managed:kimi-code".base_url` in that root's `config.toml`, when it is one of the managed Kimi Code origins.
3. The root's `region` file: `cn` → `https://api.kimi.com/coding/v1`, `global` → `https://api.kimi.ai/coding/v1`.
4. `https://api.kimi.com/coding/v1`.

The credential path stays `<root>/credentials/kimi-code.json`, which `credentialOptionsForProfile` already selects for a managed profile. A native-default profile uses `KIMI_CODE_HOME` or `~/.kimi-code`.

Phone, avatar, bio, and both tokens stay out of `ProfileIdentity`. The schema is strict and already rejects an `accessToken` field.

## Related: usage document drift

`normalizeKimiAccountUsage` still expects the older document: top-level `usage` (`used`, `limit`, `resetTime`), `limits[]` with `window` / `detail`, and `boosterWallet.balance.amountLeft`. Current `managed-usage.ts` (and the 2.0.2 binary) parse a different document from the same `GET {base}/usages` call:

- `usages.limit_5h`, `usages.limit_7d`, `usages.limit_month_total`, `usages.limit_month_code`
- each entry is `used_ratio` plus `reset_time`
- `boosterWallet.balance.type == "BOOSTER"`, with `amount` / `amountLeft` as fixed-point (divide by 1_000_000 for cents) and `monthlyChargeLimit.priceInCents`

The local server then re-exposes that as camelCase `quota.usages` (`limit5h`, `limit7d`, `monthTotal`, `monthCode` with `usedRatio` / `resetAt`) and `extraUsage`. Account usage should keep the read-only token rule and follow the current wire. This probe could not confirm a live 200, because the grant was already rejected.

## Out of scope

- Spawning `kimi web`, `kimi acp`, or a TUI to mirror a session. Verify is a host read, and the server path writes credentials.
- Implementing OAuth refresh, device login, or copying the CLI's client id. Login stays `kimi login` in a host terminal.
- Putting `domain_name` in `organization` until a real payload shows a human organization name.
- API-key providers configured by hand. This document is the managed OAuth subscription (`managed:kimi-code`). An `api_key` on that provider is a slot the CLI fills and clears with the oauth credential; it is not a second identity source.
