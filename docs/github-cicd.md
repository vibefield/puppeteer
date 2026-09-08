# GitHub repository and CI/CD

The canonical repository is [vibefield/puppeteer](https://github.com/vibefield/puppeteer).
It is private; the existing npm package names stay under `@vibecook`.
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
repository automation tests, builds, and package packing checks. The private
apps are typechecked and tested on all three platforms; Linux also checks the
Godview bundle without native prebuilds. Live agent credentials and Electron
smoke tests are not needed for these checks. Existing opt-in live-agent workflows
remain separate.

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

It then rebuilds and checks package tarballs, publishes in dependency order, and
skips versions already present in npm. Only the publish job has OIDC permission.
Publication jobs are serialized and are never cancelled by a newer release.

No npm token is stored in GitHub. Configure each package's npm trusted publisher
with organization `vibefield`, repository `puppeteer`, workflow `release.yml`, and
no environment. With npm 11.15 or later and an authenticated package-maintainer
account, run from the checkout containing this setup:

```sh
npm login --registry=https://registry.npmjs.org/
pnpm release:trust
gh variable set NPM_PUBLISH_ENABLED --repo vibefield/puppeteer --body true
```

Keep that variable unset until trust is configured for every public package.
New packages need their initial publication and trusted publisher configured
before joining the automatic release train.

Provenance is disabled for this private source repository. npm requires public
source repositories for provenance, even for public npm packages. The workflow
enables provenance automatically if the source repository later becomes public;
OIDC publishing still works while it is private.

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
