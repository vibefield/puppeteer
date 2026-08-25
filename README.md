# Chopsticks

Chopsticks hosts coding agents' native terminal interfaces while providing a
provider-neutral TypeScript runtime for lifecycle, observation, prompt control,
workspace isolation, and operational receipts.

The agent owns its terminal UI. Chopsticks owns the process environment around
that UI and derives semantic state from native hooks or structured protocols,
never by scraping terminal text.

## Agent support

<!-- agent-support:start -->
[![Claude Code: legacy verified 2.1.207](https://img.shields.io/badge/Claude_Code-legacy_verified_2.1.207-orange)](packages/surface/vendors/claude/model/claude@2.1.207/manifest.json)
[![Codex: legacy verified 0.147.0](https://img.shields.io/badge/Codex-legacy_verified_0.147.0-orange)](packages/surface/vendors/codex/model/codex@0.147.0/manifest.json)
[![Grok Build: baseline pending 1.0.0](https://img.shields.io/badge/Grok_Build-baseline_pending_1.0.0-lightgrey)](packages/surface/vendors/grok/model/grok@1.0.0/manifest.json)
[![Kimi Code: baseline pending 0.34.0](https://img.shields.io/badge/Kimi_Code-baseline_pending_0.34.0-lightgrey)](packages/surface/vendors/kimi/model/kimi@0.34.0/manifest.json)
[![OpenCode: baseline pending 1.18.16](https://img.shields.io/badge/OpenCode-baseline_pending_1.18.16-lightgrey)](packages/surface/vendors/opencode/model/opencode@1.18.16/manifest.json)
<!-- agent-support:end -->

`verified` means the claim-addressable ASM v2 model and exact artifacts passed the
full platform matrix, with the workflow/commit/model/replay/platform attestation
retained in the ledger. `legacy verified` preserves a previously supported baseline
that predates those gates; its manifest and model digest are frozen, and it cannot
be changed or re-promoted without satisfying the current gates.
`baseline pending` is an executable candidate, not a support claim.

A staged candidate intentionally drives checked adapter projections and its
Imposter persona during review. That lets compatibility code and conformance run
before promotion; it does not change the supported-version badge, which follows
only `currentManifest` after the protected promotion gates pass.

Release detection is read-only. The adaptation workflow follows only allowlisted
redirects, bounds artifact streams before buffering, hashes the bytes, attaches
them to an already traced ASM v2 candidate, runs
exact replay and drift classification, and may open a confined draft PR. A
separate protected workflow reacquires the bytes, runs credential-isolated
pinned-real tests on every required platform, and is the only path allowed to
update the support ledger and these badges.

## Packages

- `@vibecook/chopsticks-runtime` — unified runtime and built-in Claude, Codex,
  ACP, Grok, Kimi, OpenCode, and Hermes integrations.
- `@vibecook/chopsticks-core` — zero-I/O event, state, session, and host
  contracts.
- `@vibecook/chopsticks-workspaces` — direct, exclusive, worktree, and copy
  workspace modes.
- `@vibecook/chopsticks-adapter-{claude,codex,acp,grok,kimi,opencode,hermes}` —
  provider-specific observation and control.
- `@vibecook/chopsticks-record` — append-only records of runtime-owned actions.
- `@vibecook/chopsticks-surface` — promoted vendor evidence models and their
  validation/diff runtime.
- `@vibecook/chopsticks-imposter` — local replacement-agent personas and
  scenario engine.
- `@vibecook/chopsticks-testing` — vendor-neutral fake agent and adapter
  conformance helpers.

The private Electron applications are development tools, not part of the
published package graph. Consumers supply an `AgentHost` backed by their own
terminal service.

## Install

```sh
pnpm add @vibecook/chopsticks-runtime@0.1.8
```

Node.js 22.18 or newer is required.

## Built-in launch options

The selected agent discriminates the available launch options:

```ts
const onApproval = async () => 'denied' as const;

await runtime.createSession({
  agent: 'claude',
  workspace: { mode: 'worktree', path: process.cwd() },
  agentOptions: {
    model: 'sonnet',
    permissionMode: 'plan',
  },
});

await runtime.createSession({
  agent: 'codex',
  agentOptions: {
    model: 'gpt-5.6-sol',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    onApproval,
  },
});

await runtime.createSession({
  agent: 'grok',
  agentOptions: {
    model: 'grok-code-fast',
    permissionMode: 'plan',
    sandbox: 'workspace-write',
    onApproval,
  },
});
```

Generic ACP sessions accept `clientCapabilities`, `onApproval`, and either a
per-session `connector` or the runtime's default `acpConnector`. Codex model and
safety options apply when creating a fresh thread; resumed threads retain their
existing configuration. Approval callbacks are process-lifetime policy seams;
when absent, structured adapters deny approval requests by default.

## Caller-owned terminal adoption

Claude, Codex, Grok, Kimi, OpenCode, and Hermes support split-phase launch for
PATH shims and other callers that already own the terminal pane:

```ts
const prepared = await runtime.prepareSession({
  agent: 'codex',
  cwd: process.cwd(),
  agentOptions: { sandbox: 'workspace-write', onApproval },
});
if ('error' in prepared) throw new Error(prepared.error.message);

// Bind the pane before exec so no initial adapter events can race adoption.
const adopted = await runtime.adoptPrepared(prepared.preparationId, {
  runtimeSessionId: pane.id,
  processId: shimPid,
});
if ('error' in adopted) throw new Error(adopted.error.message);

// The shim now chdirs, merges the env delta, and execs command + args exactly.
await shim.exec(prepared.launch);
```

Preparations use opaque ids, allow one terminal binding with idempotent retries,
and expire after 30 seconds by default (`preparationTtlMs` configures this).
`cancelPrepared` cleans up a failed or abandoned launch and is also idempotent.
The caller must report the
adopted vendor process's exit through `handleProcessExit` because the containing
shell/PTY remains alive. `processId` is correlation metadata for that monitor.
The launch environment can contain session bearer tokens and must not be logged
or persisted.

The configured built-in executable should resolve to the real vendor binary,
not the PATH shim, to avoid recursion. Generic ACP has no universal external
attachment transport and returns `PREPARATION_UNSUPPORTED`. Callers should also
fall through to the untouched command when they cannot safely preserve custom
user arguments. Existing `createSession` behavior is unchanged and now shares
the same adapter preparation primitives.

## Development

```sh
pnpm install
pnpm test
pnpm build
pnpm pack:check
```

To add a new coding agent or adapt a new upstream version, follow the
[end-to-end agent adaptation workflow](draft/ADAPTING-AN-AGENT.md). It covers
native evidence, Surface modeling, Imposter personas and runflows,
normalization, conformance, runtime integration, and protected promotion.

Live adapter probes are opt-in with `CODEX_LIVE=1`, `GROK_LIVE=1`, or
`CHOPSTICKS_REAL_CLAUDE=1`.

## Versioning

All public Chopsticks packages release in lockstep. Internal `workspace:*`
dependencies are rewritten by pnpm to that exact version in published
tarballs. Applications should pin `@vibecook/chopsticks-runtime` exactly and
upgrade it as a deliberate integration event.

The initial `0.1.0` publication is bootstrapped from the tagged release commit:

```sh
pnpm release:publish
pnpm release:trust
```

`release:publish` verifies, builds, and publishes the public packages in
dependency order, skipping versions already present in the registry.
`release:trust` configures each package to trust `vibecook-dev/chopsticks`'s
`release.yml` GitHub Actions workflow for `npm publish`; it requires npm 11.15
or newer, npm account 2FA, and an authenticated interactive npm session.

Afterward, release-please owns release PRs and tags, and the Release workflow
publishes through tokenless npm trusted publishing. To retry a partial
publication, dispatch the workflow from `main` with the existing release tag:

```sh
gh workflow run release.yml --ref main -f tag=v0.1.1
```
