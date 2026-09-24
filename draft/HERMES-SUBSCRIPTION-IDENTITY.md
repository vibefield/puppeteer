# Hermes subscription identity

| Field        | Value                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Status       | Research record. No adapter change.                                                            |
| Date         | 2026-09-23                                                                                     |
| Question     | How a Hermes profile can report who is signed in, the way Claude and Codex already do.        |
| Install      | Hermes Agent v0.21.4 (2026.9.21), upstream `c0d72947`, `~/.hermes/hermes-agent`               |
| Surface pin  | `hermes@0.20.0`, tag `v2026.8.3`. The profile comment was probed 2026-09-06 on Hermes 0.20.5. |
| Related      | RFC 006, `packages/adapter-hermes/src/services/profiles.ts`, `draft/research-multiagentsubs.md` |

Puppeteer profiles choose which account a child process signs in as. Identity is
read back after login and shown as signed in or signed out, with email,
organization, and plan. Claude reads `claude auth status --json`. Codex reads
app-server `account/read`. Hermes still declares `identity: 'none'`, and
`verify()` always returns unsupported, so the drawer says `NO IDENTITY SURFACE`.

Hermes can answer the question for a Nous Portal login. It has no documented
command that prints the whole answer as JSON. The reliable read is Hermes's own
account helper, run under the profile's `HERMES_HOME`, projecting only the
fields the drawer needs.

## What "the subscription" is

A Hermes home holds a pool of provider credentials. The subscription account is
one entry in that pool: a completed Nous Portal OAuth login. The refresh token
lives in `$HERMES_HOME/auth.json`. Inference then uses a short-lived JWT minted
from that refresh token.

These are different things, and only the Portal login has an email, an
organization, and a plan name:

| Session                         | Identity it can support                                      |
| ------------------------------- | ------------------------------------------------------------ |
| Nous Portal OAuth               | Signed in, method `oauth`, email, organization, plan        |
| Nous free tier                  | A session with method `free-tier`. No email, org, or plan    |
| Opaque Nous inference key       | Not a Portal login. Account source `inference_key`           |
| Copilot via `gh auth token`     | The user's GitHub CLI login, shared by every Hermes home    |
| Codex, Anthropic, OpenRouter, … | That provider's own quota, when `hermes usage` knows it     |

On this machine the native home is signed out of Nous Portal. `model.provider`
is `auto`. `auth.json` has an empty `providers` object and one Copilot pool row
whose source is `gh_cli`. That row is not a Hermes subscription.

## Surfaces that were checked

Checked against the 0.21.4 tree on this machine, the pinned 0.20.0 surface, and
the tagged sources through v2026.9.21.

| Surface                                      | Result                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `hermes portal`                              | The sign-in. Alias of `hermes auth add nous --type oauth`. Browser OAuth, then the token is stored.        |
| `hermes portal info` (`status` is an alias)  | Human summary: logged in or not, portal URL, whether inference is Nous, Tool Gateway routing. No `--json`. |
| `hermes auth status <provider>`              | One human line, plus expiry metadata. No `--json`, no email, no organization, no plan.                     |
| `hermes status`                              | Human report. `--all` is accepted and does not change the format. `--deep` is the flag that is read.       |
| `hermes login`                               | Still registered. On 0.21.4 it prints that the command was removed and exits 0. It does not sign in.       |
| `hermes usage --json`                        | Structured, since 0.21.4. Quota for `openai-codex`, `anthropic`, and `openrouter`. See below.              |
| Access-token JWT                             | Local and refresh-free. Can carry `sub`, `org_id`, `subscription_tier`, `paid_access`, `account_tier`.     |
| `GET {portal}/api/oauth/account`             | Email, organisation id/slug/name, subscription plan and tier. The identity document.                       |
| Gateway `subscription.state`                 | Plan tier name, org, role. No email. Fail-open, and a cold gateway is the wrong process to spawn for a row. |
| Gateway `billing.state`                      | Balance and payment method. A Link email here is a payment email, not the account email.                   |
| Gateway `setup.status`                       | `{ provider_configured }` only.                                                                             |
| `auth.json`, `.env`, `shared/nous_auth.json` | Credential stores. Tokens in plaintext.                                                                     |

`hermes status` and `hermes portal info` call `get_nous_auth_status_local()`.
That snapshot does not refresh. `get_nous_auth_status()` does refresh, and a
Nous refresh token is single-use, so a verify loop must not call it.

The JWT is not enough for the drawer. Email, organisation name, and
`subscription.plan` are filled only from the account response. Hermes
normalizes that response in `hermes_cli.nous_account.get_nous_portal_account_info`.
The portal's published inference OpenAPI does not document this route; the
evidence is the Hermes client and its unit-test fixture.

### `hermes usage --json`

Added in 0.21.4 (v2026.9.21). Absent in 0.21.3 (v2026.9.14) and in the pinned
0.20.0 surface. The document is stable by the command's own comment:

```text
provider, source, title, plan, fetched_at, windows[], details, unavailable_reason
```

`plan` may be null. There is no logged-in flag, method, email, or organization.
Exit 0 prints the document. Exit 1 prints one stderr line and empty stdout.
That exit covers three cases at once: no credential, no usage endpoint, or the
fetch failed. It cannot be read as signed out.

Ran here:

```text
hermes usage --json
  exit 1, provider 'auto', empty stdout

hermes usage --provider nous --json
  exit 1, empty stdout
```

The built-in fetchers are `openai-codex`, `anthropic`, and `openrouter`. Nous
credits are rendered by the in-session `/usage` view from the same account
object, not by this command. `hermes usage --json` is a later quota readout for
those three providers. It is not who is signed in.

## Experiments

All of these used the install venv (`~/.hermes/hermes-agent/venv/bin/python`)
with `PYTHONPATH` unset. Probes printed an allowlist. Tokens, raw claims, and
raw account bodies were dropped before anything was printed.

**Native home, `~/.hermes`.** `hermes portal info`, `hermes auth status nous`,
`hermes doctor`, and `get_nous_portal_account_info()` agree: Nous Portal is
logged out. The Python read took a few milliseconds and made no portal call.
`shared/nous_auth.json` is absent.

**Empty home outside `~/.hermes`.** Same logged-out answer. It did not see
`~/.hermes/auth.json`.

**Puppeteer's layout.** `HERMES_HOME=…/profiles/hermes/<id>` resolves its
default root to that directory. A marker written in a grandparent `auth.json`
stayed invisible.

**Parent directory named `profiles`.** `HERMES_HOME=/tmp/hermes-trap-root/profiles/work`
resolved the root to `/tmp/hermes-trap-root` and returned a Nous `client_id`
that existed only in the grandparent `auth.json`. The profile directory itself
had no auth file. Hermes does this on purpose for `~/.hermes/profiles/<name>`:
`get_default_hermes_root()` walks up when the parent is `profiles`, and
provider state falls back to `<root>/auth.json`. The shared Nous copy is
`<root>/shared/nous_auth.json`.

**Account normalizer.** Hermes's own `_info_from_account_payload`, fed the
fixture shape from its tests, yields `logged_in`, `user.email`,
`organisation.name`, and `subscription.plan`. No live portal body was captured
on this machine, because this home has no Nous login. The production JSON is
therefore evidenced by the client and the fixture, not by a captured response.

## Isolation

Puppeteer already binds a managed profile with `HERMES_HOME` and leaves `HOME`
alone on the login and attach launches. That is the right binding for this
read. The gateway host does set `HOME` to the profile root; verify should
follow the login binding and set only `HERMES_HOME`.

Keep allocating roots as `profiles/hermes/<id>`. A root whose parent directory
is named `profiles` joins the grandparent's Nous login.

Native Hermes profiles under `~/.hermes/profiles/<name>` share one Portal
login. That is the opposite of one Puppeteer profile per subscription. The
account boundary stays a dedicated `HERMES_HOME`, not `hermes profile`.

Copilot seeded from `gh auth token` follows the user's `gh` login, not the
Hermes home. Reporting it as the profile identity would show the same GitHub
account on every profile.

## Recommended verify

Run the venv Python that the `hermes` wrapper execs. The distribution service
already recovers that path from the wrapper. Set `HERMES_HOME` to the profile
root. Ask Hermes for the refresh-free snapshot, then the account document, and
print one allowlisted JSON object.

| Condition                                                         | Identity                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| No Nous credential, and not the free tier                         | `{ loggedIn: false }`                                                    |
| Free tier                                                         | `{ loggedIn: true, method: "free-tier" }`                                |
| A Nous credential exists                                          | `force_fresh` account info: method `oauth`, email, org name, plan       |
| Credential exists, portal network fails                           | `loggedIn: true`, omit email, organization, and plan                     |
| Portal rejects the session after Hermes's own single token retry  | `{ loggedIn: false }`                                                    |
| Interpreter or import fails                                       | `unavailable`, retryable                                                 |
| Document shape is unrecognized                                    | `unavailable`, not a guessed sign-out                                    |

```ts
{
  loggedIn: boolean,
  method?: "oauth" | "free-tier",
  email?: string,          // user.email
  organization?: string,   // organisation.name
  plan?: string,           // subscription.plan
  verifiedAt,
  source: { kind: "native-protocol", stability: "experimental" }
}
```

`experimental` because Hermes has not shipped a stable JSON status, and the
pinned surface's `billing.state` schema only recovered `ok`, `logged_in`, and
`error`. The fields above are real in 0.21.4 and are the ones the TUI uses.

The projector drops `raw_claims`, `raw_account`, and every token field. The
adapter does not open `auth.json`.

`get_nous_portal_account_info(force_fresh=True)` may refresh an access token
that is inside Hermes's skew window. That is the same call the billing client
makes. Skip it when the refresh-free snapshot says there is nothing to refresh.
Do not call `get_nous_auth_status()` on a timer.

Spawning the TUI gateway just to label a drawer row is the wrong cost. A cold
import can take tens of seconds, `subscription.state` has no email, and its
fail-open path reports network trouble as logged out. If a gateway for that
home is already up, `subscription.state` can confirm plan and org. The account
call is still what supplies email.

## Login has to move with it

`loginInvocation` still runs `hermes login`. On this install that pane exits
immediately and leaves the home signed out, so a correct `verify()` would keep
reporting signed out after onboarding.

The subscription sign-in is `hermes portal`, in a real terminal, under the same
`HERMES_HOME`. Logout of a root-local credential is `hermes auth logout nous`.
The credential file is inside the root on the layout Puppeteer uses, which
matches the adapter's existing `credential: 'root'` note. A home under
`<root>/profiles/<name>` also has the shared store outside that home; deleting
only the profile directory would leave it.

## Implementation outline

1. Point `loginInvocation` at `hermes portal`.
2. Add `verify()` that execs the wrapper's venv Python with `HERMES_HOME` set
   and parses one allowlisted JSON object.
3. Set `support.identity` to `native-protocol`.
4. Fixture tests: signed out, free tier, portal account, network failure,
   rejected session, unrecognized document, missing interpreter.
5. Keep the root layout at `profiles/hermes/<id>`.
6. Leave `hermes usage --json` for a later per-provider quota service. Do not
   use its exit code as the signed-in bit.

A live Nous login on a disposable `HERMES_HOME` is the remaining proof. This
machine's native home has no Portal session, so the account response was proven
through Hermes's normalizer and fixture, not through a captured portal body.
