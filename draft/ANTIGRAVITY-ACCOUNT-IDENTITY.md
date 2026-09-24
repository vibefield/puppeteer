# Antigravity account identity

| Field | Value |
| --- | --- |
| Status | Research report. Not a support claim and not Surface evidence. |
| Date | 2026-09-23 |
| Probed build | `agy` 1.2.9 at `~/.local/bin/agy`, darwin-arm64 |
| Contract | [RFC 006](../docs/rfcs/006-agent-distribution-and-account-profiles.md) `ProfileIdentity` |
| Related | [ANTIGRAVITY-ADAPTATION-PLAN.md](./ANTIGRAVITY-ADAPTATION-PLAN.md), adapter `services/profiles.ts` |

This report answers one question: can an Antigravity profile report who is
signed in, the way Claude Code reports `claude auth status --json` and Codex
reports app-server `account/read`?

The consumer subscription can. Email and auth method come from the CLI's own
credential file inside the profile home. The plan name cannot. No documented
command returns it, and the probes below did not find it in print-mode JSON.

Anything here that an adapter starts to rely on has to be recaptured as a
Surface claim and digest-locked before promotion. The file format is
undocumented.

## Recommendation

Turn Antigravity profile support on for a consumer Google account, with
identity marked experimental.

| Profile field | Value |
| --- | --- |
| `support.supported` | `true` |
| `support.identity` | `native-status` |
| `support.credential` | `root` |
| `support.nativeDefaultRoot` | `~/.gemini/antigravity-cli` (unchanged) |
| Identity `source` | `{ kind: 'native-status', stability: 'experimental' }` |
| `email` | `email` claim in the ID token |
| `method` | `auth_method` from the same file (`consumer` on this machine) |
| `organization` | `hd` claim when the token has one. This consumer token does not. |
| `plan` | omitted |
| Login | `agy` with no arguments, in a real terminal, under the profile home |
| Sign-out | delete the profile home. Do not run `/logout`. |
| Managed observation root | `<dataRoot>/.gemini/antigravity-cli` |

`verify()` reads `<home>/.gemini/antigravity-cli/antigravity-oauth-token`.
It may decode `auth_method` and the ID-token payload. It must not read, log,
copy, or persist `access_token` or `refresh_token`. A missing file is
`loggedIn: false`. An unreadable file, or a token with no email claim, is
`unavailable`.

Two other sign-in modes are not this subscription. When
`~/.gemini/antigravity-cli/settings.json` has `modelProvider: "gemini"`, the
session is a Gemini API key: method `gemini-api-key`, no email, no plan, and
`GEMINI_API_KEY` is never read. When `AGY_ADC_AUTH=true`, the session is
Google Cloud Application Default Credentials: method `adc`, credential at
`$HOME/.config/gcloud/application_default_credentials.json`. Reporting either
of those as the consumer Google account would be wrong.

## Why the current adapter stops short

`packages/adapter-antigravity/src/services/profiles.ts` sets
`supported: false` and `identity: 'none'`. The comment records a 2026-09-06
probe of 1.1.21: `agy help` has no `login` subcommand, and `agy help login`
answers `unknown subcommand: login`. That subcommand gap is still true on
1.2.9. `agy --help` lists `agent`, `agents`, `changelog`, `help`, `install`,
`mcp`, `mic-serve`, `models`, `plugin`, `plugins`, `remote-control`, and
`update`.

The binding is already real. `PUPPETEER_ANTIGRAVITY_HOME` is the adapter-owned
variable the driver turns into `HOME`, and the native store lands at
`<home>/.gemini/antigravity-cli`. RFC 006 already says a managed observation
root would have to follow that redirection. Support stays false, so no managed
root is onboarded today. `loginInvocation` launches `agy` with the binding.
`verify()` returns `unsupported`.

Account usage is a separate capability and already works. `agy -p /usage` and
`agy -p /credits` are the quota oracle. They are not an identity oracle.

## What the vendor documents

Probed against the public docs and the changelog through 1.2.9.

**Consumer sign-in.** On a local machine the CLI looks for an OS keyring
token profile (Apple Keychain, Linux Secret Service, Windows Credential
Manager) and signs in silently when it finds one. Otherwise it opens the
default browser. Over SSH it prints an authorization URL; the user signs in
on another machine and pastes the code back. There is no `agy auth login`.

**Logout.** The CLI reference's only account command is in-prompt `/logout`,
which purges authentication tokens from the OS keyring. Changelog 1.2.4 tells
a user whose token lacks scopes to run `/logout` and `/login` inside the
prompt. Print-mode `/help` on 1.2.9 does not list either command. Its catalog
is `agents`, `changelog`, `config`/`settings`, `credits`, `effort`, `help`,
`hooks`, `model`, `permissions`, `skills`, and `usage`/`quota`.

**Plan and email as display.** The status-line payload documents `email` and
`plan_tier`. The published `plan_tier` example is the string `Pro`. The field
list has no logged-in flag, auth method, or organization. Installing a status
line writes `~/.gemini/antigravity-cli/settings.json`. Changelog 1.0.2 adds
`AGY_CLI_HIDE_ACCOUNT_INFO` to hide email and plan from the header. Changelog
1.2.7 shows the Google Cloud project id on the enterprise startup banner,
under the account and plan. Those are display surfaces.

**Print mode.** Changelog 1.1.11 says `/usage`, `/quota`, `/credits`, and
several other read-only slash commands can answer without a turn, a quota
spend, or a leftover conversation. Headless mode uses cached credentials.
With no terminal and no saved session it exits with an authentication error
instead of hanging. The published JSON envelope is a conversation result. It
is not defined as an identity document.

**Gemini API key.** `modelProvider` must be `gemini` in
`~/.gemini/antigravity-cli/settings.json`, and `GEMINI_API_KEY` must be
exported. The variable alone does nothing. The CLI skips the sign-in screen,
the header shows "Gemini API key", and `/logout` has no effect.
`GOOGLE_API_KEY` and `.env` files are ignored. `GOOGLE_GEMINI_BASE_URL`
redirects the endpoint.

**Enterprise.** Browser SSO is Business account, then Continue with Google
Cloud or Advanced Workforce Identity Federation. The license selector runs in
that browser flow, one license per project and location. ADC is CLI-only:
`gcloud auth application-default login --project {GCP_PROJECT}`, credentials
at `~/.config/gcloud/application_default_credentials.json`, enabled with
`AGY_ADC_AUTH=true`. Unsetting `AGY_ADC_AUTH` is the ADC sign-out. The
enterprise page does not name the consumer oauth file.

No install, reference, enterprise, troubleshooting, or changelog page defines
a `HOME` override or a dedicated config directory for a second subscription.
The oauth filename is not documented. Third-party account switchers that write
one token into the system keyring are a global swap, which RFC 006 does not do.

## What is on disk

Under the real home, after redacting token material:

| Path | Role |
| --- | --- |
| `~/.gemini/antigravity-cli/antigravity-oauth-token` | Antigravity credential. Mode `0600`, 1682 bytes. Top-level keys: `token`, `auth_method`, `id_token`. |
| `token` | `access_token`, `token_type`, `refresh_token`, `expiry`. Not an identity source. |
| `auth_method` | `consumer` on this machine. |
| `id_token` | Google ID token. Payload claims include `iss`, `aud`, `azp`, `sub`, `email`, `email_verified`, `name`, `given_name`, `family_name`, `picture`, `iat`, `exp`. No `hd`. No plan. |
| `~/.gemini/antigravity-cli/settings.json` | Preferences only. This machine has `trustedWorkspaces` and no `modelProvider`. |
| `~/.gemini/antigravity-cli/cache/onboarding.json` | `consumerOnboardingComplete: true`, `enterpriseOnboardingComplete: false`. |
| `~/.gemini/oauth_creds.json` | Gemini CLI credential. Different OAuth client. Wrong store. |
| `~/.gemini/google_accounts.json` | Gemini CLI active account. Wrong store. |
| `~/.gemini/settings.json` | Gemini CLI settings, `security.auth.selectedType: oauth-personal`. Wrong store. |

Login-keychain items that match the name, attributes only:

| Service | Account |
| --- | --- |
| `Antigravity Safe Storage` | `Antigravity` |
| `Gemini Safe Storage` | `Gemini Keys` |
| `gemini` | `antigravity` |

The binary contains both stores. `codeassistclient.KeyringTokenStorage` and
`fileTokenStorage` sit behind a chained auth provider. Log lines from this
machine include `ChainedAuth: authenticated via keyring` and, on 2026-09-11,
`Failed to save token to keyring, falling back to file: exit status 45`.
`SaveUserTier` / `tier_display_name` exist in the binary. No tier file was
found under `~/.gemini`. The ID token does not carry a tier. Startup calls
`https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`; that
response is not a document the adapter may fetch with the bearer token.

A native log line after a successful auth reads
`applyAuthResult: email=<address>, authMethod=consumer, quotaProject=`.
`quotaProject` was empty for this consumer session. The log is a corroborating
rail. The credential file is the one `verify()` should read, because it is
present before a CLI process starts and it does not require parsing a log.

## Experiments

All of these used `AGY_CLI_DISABLE_AUTO_UPDATE=1`, no `GEMINI_API_KEY`, a
temporary working directory, and stdin closed. Token files copied into a
temporary home were deleted afterward. `/logout` was not run. `settings.json`
was not modified.

**Print-mode identity.** `agy -p /usage --output-format json` exited 0 in
well under the print timeout. `conversation_id` was empty, `num_turns` was 0,
token usage was 0. `command.data` had `description` and `groups` only:
`gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`, each with
`remaining_fraction` and `reset_time`. The description says the weekly limit
is tied to "your individual tier" and does not name the tier. `/credits`
returned `remaining_credits` and `upgrade_uri` only. `/config` returned the
settings object and no account fields. None of the four payloads contained
email, auth method, organization, or plan.

**Empty home.** `HOME` pointed at an empty temporary directory. A fake `open`
earlier on `PATH` recorded the browser launch and exited. Print-mode `/usage`
did not authenticate. Stderr was `Authentication required` plus a Google
OAuth URL, then `Waiting for authentication`. The log said
`You are not logged into Antigravity`, then `Print mode: silent auth failed`,
then `triggering interactive OAuth`. The keychain items above were present
and did not satisfy this home. The process created
`<home>/.gemini/antigravity-cli/` and did not write an oauth file.

**File is sufficient.** A second temporary home contained only a copy of
`antigravity-oauth-token` at the same relative path, mode `0600`. Print-mode
`/usage` exited 0 in about 5 seconds, with two quota groups and no browser
launch. The log said `keyringAuth: loaded token` with the expiry stored in
that file, `ChainedAuth: authenticated via keyring`, and
`applyAuthResult` with `authMethod=consumer` and the email from the ID token.
No second credential file appeared.

So on 1.2.9 a profile home is necessary and sufficient for the consumer
session. The existing login-keychain items were not. The CLI's own log still
calls that read "keyring" when the only credential in the home is the oauth
file. Official docs describe the keyring as the session and do not mention
the file; the file read stays experimental for that reason.

## Adapter shape

`verify(profile)` resolves the home the same way launch does. A managed
profile uses `profile.dataRoot`. The native default uses the process home,
with `PUPPETEER_ANTIGRAVITY_HOME` removed so an inherited binding cannot
retarget it. The file path is
`<home>/.gemini/antigravity-cli/antigravity-oauth-token`.

Decode the ID token payload locally. Accept `email` only as a normal address
string. Accept `auth_method` only as a short label. If `hd` is present, that
is `organization`. Do not treat `name` as the plan, and do not put `sub` on
the profile.

`loginInvocation` stays `agy` with an empty argv and the binding in `env`.
First launch of an empty home opens the browser, or prints a URL when there
is no local browser. The host runs that in a terminal and does not capture
the output. After the pane exits, `verify()` reads the file the CLI wrote.

`observationRoot` for a managed profile becomes
`<dataRoot>/.gemini/antigravity-cli`. The native default stays
`~/.gemini/antigravity-cli`. History, `settings.json`, and the oauth file all
live there. Returning `dataRoot` itself would make an indexer look at the
wrong directory. RFC 006 already records this correction and withholds it
while support is false.

`credential: 'root'` matches the experiment: another home cannot see the
file, and deleting the home removes it. `/logout` is the wrong sign-out. The
docs say it purges the OS keyring, and the binary will try that keyring
before the file. A keyring wipe started from one profile can hit a session
that profile does not own. There is no `signOut()` method until a logout is
shown to be home-scoped.

`ProfileSupport.sharedSurfaces` can stay empty for the consumer file. Global
hooks at `~/.gemini/config/hooks.json` move with `HOME`. Project hooks under
the workspace do not, same as Claude's project settings. ADC is the
exception: its file is `$HOME/.config/gcloud/`, which follows the same home
binding and is outside the Antigravity data root. A profile that enables
`AGY_ADC_AUTH` is using that second store. This report did not run an ADC
session.

Account usage keeps calling `agy -p /usage` and `agy -p /credits` under the
same home. It does not learn the email from that JSON. The profile identity
and the usage snapshot stay separate capabilities, joined by `profileId`.

## What this report does not adopt

- Parsing the TUI header, or turning `AGY_CLI_HIDE_ACCOUNT_INFO` off to read it.
- Writing `statusLine` into the user's `settings.json` to harvest `plan_tier`.
- Calling `loadCodeAssist` or any other Google API with the access token.
- Reading `~/.gemini/oauth_creds.json` or `google_accounts.json`.
- Treating a Gemini API key or `AGY_ADC_AUTH` as the consumer subscription.
- Running `/logout` as profile sign-out.
- Copying tokens between homes. The copy in the experiment existed only to
  learn whether the file was sufficient, and it was deleted.

## Open

1. Plan name. Still no non-interactive source on 1.2.9. Revisit when a print
   command or a status document grows `plan_tier` without a settings write.
2. Enterprise and WIF. `auth_method` values beyond `consumer`, the `hd`
   claim, and a non-empty `quotaProject` were not exercised. The license
   selector is a browser step during `agy` launch, which the login pane
   already covers.
3. ADC. Confirm that a managed home with `AGY_ADC_AUTH=true` reads
   `<dataRoot>/.config/gcloud/application_default_credentials.json` and does
   not also require the oauth file.
4. Keyring scope after a real login. This machine's existing keychain items
   did not sign in an empty home. A future build that successfully saves the
   new login to the login keychain could still leave a credential outside the
   home. Re-probe before adding `signOut`.
5. Surface. The oauth filename, the ID-token claim set, `auth_method`, and
   the empty-home versus file-only results need a claim set under
   `packages/surface/vendors/antigravity/` before the adapter hard-codes them.
   Captures must keep the token and the email out of git.

## Sources

- Installation and auth: <https://antigravity.google/docs/cli/install>
- CLI reference: <https://antigravity.google/docs/cli/reference>
- Headless mode: <https://antigravity.google/docs/cli/headless/>
- Status line: <https://antigravity.google/docs/cli/statusline>
- Model quotas: <https://antigravity.google/docs/cli/commands/usage>
- Enterprise, WIF, and ADC: <https://antigravity.google/docs/enterprise/>
- Changelog through 1.2.9: <https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md>
- RFC 006 profile contract and the 2026-09-06 Antigravity row
- Local probes on 2026-09-23 against `agy` 1.2.9, recorded above. The oauth
  file, keychain labels, and CLI logs were inspected for shape only.
