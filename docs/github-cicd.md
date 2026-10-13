# GitHub repository and CI/CD

The canonical repository is [vibefield/puppeteer](https://github.com/vibefield/puppeteer).
It is private; public npm packages use the `@vibefield/puppeteer-*` names.
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
GitHub release. The publish job verifies that:

- the tag is a stable `vX.Y.Z` matching the package version;
- the tagged commit is on `main`;
- the exact tagged commit has a successful main-push CI run;
- `NPM_PUBLISH_ENABLED` is `true`.

It packs and validates the entire package train before uploading anything, then
publishes those same tarballs in dependency order. CI and the publisher share the
metadata, entry-point, dependency-version, and package-content checks. Registry
authentication errors and outages stop publication; only an explicit npm 404
means a version is missing. Retries skip published versions, verify registry
visibility before advancing to dependents, and refuse to move `latest` backwards.
The publisher requires a clean checkout at the exact release tag, including after
prepack scripts finish. Release Please owns package versions, the protocol version,
and the README install example; never hand-bump them.

Only the publish job has OIDC permission. It uses Node 22.22.2 to satisfy
npm 12.0.1's engine requirement, while CI tests the library's Node 22.18.0 minimum.
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

The local publisher defaults provenance to false for this private repository.
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

After publication, `pnpm release:verify` installs every package at the release
version in a fresh npm project. It verifies ordinary Node imports, testing
exports under Vitest, the Views browser bundle and CSS, and the Imposter CLI.
The workflow runs this check after every publication; it also runs when a retry
skips packages already present on npm. A verification failure does not unpublish
packages. Diagnose the consumer error before retrying the same release.
Use npm 12 for this check (on Node 22, version 22.22.2 or newer), matching the
release workflow; npm 10 can fail while resolving Vitest's optional peers.

Provenance is disabled for this private source repository. npm requires public
source repositories for provenance, even for public npm packages. The workflow
enables provenance automatically if the source repository later becomes public;
OIDC publishing still works while it is private. Package manifests must not set
`publishConfig.provenance`; the publisher passes the workflow's choice explicitly
on npm's command line, along with the public registry, access level, and dist-tag.

To retry a partial publication, dispatch Release **from main**, using an existing
tag whose exact commit passed main CI:

```sh
gh workflow run release.yml --repo vibefield/puppeteer --ref main -f tag=vX.Y.Z
```

Retries use the original tagged source and release tooling. Tags whose package
metadata still names the old organization must not be retried through the new
publisher; cut a new version with the corrected metadata instead.

## Branch protection and organization plan

As of 2026-09-07, `vibefield` uses GitHub Free. GitHub returns HTTP 403 for branch
protection/rulesets on this private repository. The CI gate is configured but
**GitHub cannot currently require it before a merge or prevent direct pushes**.
Maintainers must wait for green CI and merge through PRs until the organization
has a plan supporting private repository protection.

After an organization owner upgrades to GitHub Team, apply the checked-in
configuration:

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
