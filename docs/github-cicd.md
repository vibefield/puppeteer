# GitHub repository and CI/CD

The canonical repository is [vibefield/puppeteer](https://github.com/vibefield/puppeteer).
It is public; npm packages use the `@vibefield/puppeteer-*` names.
The private Electron apps are development tools. CD publishes the public library
packages to npm; it does not distribute signed desktop installers.

## Development and CI

Use Node 22.18.0 (`nvm use`) and pnpm 10.34.5, pinned in `package.json`.
Install with `pnpm install --frozen-lockfile`. Open PRs against `main` and use
Conventional Commit titles, for example `fix(runtime): handle session shutdown`.
The repository uses squash merges with the PR title as the commit title and
deletes merged branches automatically.

The CI workflow runs on PRs, main pushes, merge groups, and manual dispatch.
Linux, Windows, and macOS each run library typechecks, unit/conformance tests,
repository automation tests, builds, and package packing checks. Package tests
use a 15-second per-test budget on hosted runners for real Git and process I/O;
their assertions and internal operation deadlines still apply. The private
apps are typechecked and tested on all three platforms; Linux also checks the
Godview bundle without native prebuilds. Live agent credentials and Electron
smoke tests are not needed for these checks. Existing opt-in live-agent workflows
remain separate.

Spawn-through interception is POSIX-only and disabled by Godview on Windows.
Its real shell, `execve`, `ps`, and owner-only permission tests run on Linux and
macOS; portable protocol, gateway, and process-exit tests also run on Windows.

During the Ghosttea source window, app CI bootstraps the sibling SDK before
installing Puppeteer. `.github/ci/ghosttea.json` pins the public upstream commit
and the digest of `ghosttea-sdk.patch`, which contains the unpublished Frame and
React SDK changes used by this checkout. The patch's source commit is recorded
for review. The bootstrap verifies the patch, checks out that exact upstream
revision, applies the SDK changes, and builds using its frozen npm lockfile.
It never modifies an existing developer checkout and does not build native
desktop binaries. Remove this bootstrap with the local overrides when the
required Ghosttea APIs and fixes are published.

`packages:check` also rejects filenames that Windows cannot check out and path
collisions on case-insensitive filesystems. Surface authoring filenames escape
reserved characters; the native event identities inside the documents remain
unchanged.

`CI required` succeeds only when every package and app matrix job passes.
Actions are pinned to commit hashes in CI and Release. Dependabot proposes weekly
Actions and npm dependency updates; security alerts and automatic security-fix PRs
are enabled. CI tokens have read-only access and checkout does not persist Git
credentials.

## Releases

A successful CI run for a push to the current `main` commit triggers Release.
Release Please opens or updates a release PR. It explicitly dispatches CI for that
bot branch using `GITHUB_TOKEN`, avoiding a long-lived PAT and the bot-PR approval
trigger limitation. Maintainers merge the release PR after its checks pass.

The subsequent successful main CI permits Release Please to create the tag and
GitHub release. When publishing is enabled, it dispatches the same Release
workflow from that tag so GitHub's run identity and npm provenance identify the
actual published source. The publish job verifies that:

- the tag is a stable `vX.Y.Z` matching the package version;
- the tagged commit is on `main`;
- the exact tagged commit has a successful main-push CI run;
- a tag-triggered run's ref and commit match the checked-out release;
- `NPM_PUBLISH_ENABLED` is `true`.

It packs and validates the entire package train before uploading anything, then
publishes those same tarballs in dependency order. CI and the publisher share the
metadata, entry-point, dependency-version, and package-content checks. Registry
authentication errors and outages stop publication; only an explicit npm 404
means a version is missing. Retries skip published versions and refuse to move
`latest` backwards. npm may accept uploads before making them available: the
publisher submits accepted uploads in dependency order, then allows up to ten
minutes for all of them to become visible before declaring success. An ambiguous
publish response must be resolved through registry visibility before any further
uploads; a failed or delayed upload is never blindly submitted twice.
The publisher requires a clean checkout at the exact release tag, including after
prepack scripts finish. Release Please owns package versions, the protocol version,
and the README install example; never hand-bump them.

Only the publish job has OIDC permission. It uses Node 22.22.2 to satisfy
npm 12.0.1's engine requirement, while CI tests the library's Node 22.18.0 minimum.
CI and Release install npm in a temporary tool directory and select its CLI with
`PUPPETEER_NPM_CLI`, avoiding failures when npm 10 replaces itself during an upgrade.
Publication jobs are serialized and are never cancelled by a newer release.

Validate a proposed release locally, after installing dependencies:

```sh
pnpm release:check
```

This builds and checks every public tarball without npm registry requests or
uploads. It works with uncommitted changes and without a tag. `pnpm pack:check`
checks the same artifacts; neither command builds the private Electron apps.

### First publication and npm trust

Keep `NPM_PUBLISH_ENABLED=false` until every package exists on npm and its trust
configuration has been verified. npm cannot configure a trusted publisher for a
package that does not exist. The first release therefore needs a maintainer's
authenticated publication; setting the repository variable alone cannot bootstrap it.

With publishing disabled, merge the release PR only after its CI passes. Wait for
successful main-push CI and the Release Please tag. In a separate clean checkout
of that exact tag, install dependencies and publish the reviewed release using an
npm account with write access to `@vibefield` and 2FA enabled:

```sh
pnpm install --frozen-lockfile --filter './packages/**'
npm login --registry=https://registry.npmjs.org/
pnpm release:publish
```

The local bootstrap publisher disables provenance because it runs outside CI.
Complete npm's browser/2FA prompt when requested. A failed partial publication is
retriable from the same clean tag; do not change package contents under that version.

No npm token is stored in GitHub. With npm 11.15 or later, configure each package
for organization `vibefield`, repository `puppeteer`, workflow `release.yml`, no
environment, and direct publish permission:

```sh
npm login --registry=https://registry.npmjs.org/
pnpm release:trust
pnpm release:trust:check
gh variable set NPM_PUBLISH_ENABLED --repo vibefield/puppeteer --body true
```

`release:trust:check` is read-only. Both commands preflight authentication and
package existence before requesting trust changes. Setup skips matching records,
creates missing ones, verifies the result, and stops if a different trust record
requires review. It never revokes another publisher automatically. Trust operations
may require a separate npm 2FA approval; use the five-minute approval window when
configuring the package train.

New trust must complete a successful OIDC publication within two days or npm
expires it. Configure trust when the next release is ready. Retrying a version
already published locally only skips packages and does not validate the OIDC
exchange. New packages joining the train need the same bootstrap procedure.

Before publication, `pnpm release:verify:packed` builds the tarballs and installs
them into a fresh npm project. Linux CI runs this check after testing the minimum
supported Node version, using the same Node and npm versions as the release job.
After publication, `pnpm release:verify` installs every package at the release
version in a fresh npm project. It verifies ordinary Node imports, testing
exports under Vitest, the Views browser bundle and CSS, and the Imposter CLI.
The workflow runs this check for tags that include it; it also runs when a retry
skips packages already present on npm. Older tags retain their original checks.
A verification failure does not unpublish packages. Diagnose the consumer error
before retrying the same release.
Use npm 12 for this check (on Node 22, version 22.22.2 or newer), matching the
release workflow; npm 10 can fail while resolving Vitest's optional peers.

The public source repository supports npm provenance. The workflow enables it
for publications dispatched from the matching release tag; the publisher rejects
a provenance request if the GitHub run ref or commit differs from that tag.
The initial local bootstrap has no provenance.
If the source repository becomes private, the workflow disables provenance while
retaining OIDC authentication. Package manifests must not set
`publishConfig.provenance`; the publisher passes the workflow's choice explicitly
on npm's command line, along with the public registry, access level, and dist-tag.

To retry a partial publication, dispatch Release **from the release tag** whose
exact commit passed main CI:

```sh
gh workflow run release.yml --repo vibefield/puppeteer --ref vX.Y.Z -f tag=vX.Y.Z
```

For older tags whose workflow only accepts main-branch dispatches, use `--ref main`
with the same tag input. This fallback uses OIDC but explicitly disables provenance
because the workflow's identity describes main rather than the checked-out tag.
Retries use the original tagged source and release tooling. Tags whose package
metadata still names the old organization must not be retried through the new
publisher; cut a new version with the corrected metadata instead.

## Branch protection

Main-branch protection is enabled for this public repository, including for
administrators. The checked-in configuration can be reapplied with:

```sh
gh api --method PUT repos/vibefield/puppeteer/branches/main/protection \
  --input .github/main-protection.json
```

It requires current CI from the GitHub Actions app, PRs, resolved conversations,
and linear history; it blocks force pushes and deletion, including for admins.
The approval count is zero for the current single-maintainer organization. Raise
it to one when a second reviewer is available.

## References

- [npm trusted publishing and private-repository provenance limitations](https://docs.npmjs.com/trusted-publishers/)
- [Release Please token-trigger behavior](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs)
- [GitHub protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
