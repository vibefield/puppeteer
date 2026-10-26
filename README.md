# Puppeteer

[![CI](https://github.com/vibefield/puppeteer/actions/workflows/ci.yml/badge.svg)](https://github.com/vibefield/puppeteer/actions/workflows/ci.yml)

Repository setup, required checks, publishing, and recovery are documented in
[GitHub CI/CD](docs/github-cicd.md).

Puppeteer hosts coding agents' native terminal interfaces while providing a
provider-neutral TypeScript runtime for lifecycle, observation, prompt control,
workspace isolation, and operational receipts.

The agent owns its terminal UI. Puppeteer owns the process environment around
that UI and derives semantic state from native hooks or structured protocols,
never by scraping terminal text.

Todos, task progress, and plan contents belong to the native agent or a separate
task-management product. Puppeteer observes agent execution, subagents, provider
modes, and generic tool activity without maintaining a task or plan model.

See the [layered runtime RFC](docs/rfcs/004-layered-agent-runtime.md) for the
current architecture and the [documentation map](docs/README.md) for active
specifications versus historical material.

## Agent support

<!-- agent-support:start -->
[![Antigravity: baseline pending 1.1.20](https://img.shields.io/badge/Antigravity-baseline_pending_1.1.20-lightgrey)](packages/surface/vendors/antigravity/groundtruth.json)
[![Claude Code: verified 2.1.308](https://img.shields.io/badge/Claude_Code-verified_2.1.308-blue)](packages/surface/vendors/claude/groundtruth.json)
[![Codex: verified 0.164.0](https://img.shields.io/badge/Codex-verified_0.164.0-blue)](packages/surface/vendors/codex/groundtruth.json)
[![GitHub Copilot CLI: baseline pending 1.0.80](https://img.shields.io/badge/GitHub_Copilot_CLI-baseline_pending_1.0.80-lightgrey)](packages/surface/vendors/copilot/groundtruth.json)
[![Grok Build: verified 1.0.70](https://img.shields.io/badge/Grok_Build-verified_1.0.70-blue)](packages/surface/vendors/grok/groundtruth.json)
[![Hermes Agent: baseline pending 0.20.0](https://img.shields.io/badge/Hermes_Agent-baseline_pending_0.20.0-lightgrey)](packages/surface/vendors/hermes/groundtruth.json)
[![Kimi Code: baseline pending 0.34.0](https://img.shields.io/badge/Kimi_Code-baseline_pending_0.34.0-lightgrey)](packages/surface/vendors/kimi/groundtruth.json)
[![OpenCode: baseline pending 1.18.16](https://img.shields.io/badge/OpenCode-baseline_pending_1.18.16-lightgrey)](packages/surface/vendors/opencode/groundtruth.json)
[![Pi: baseline pending 0.84.3](https://img.shields.io/badge/Pi-baseline_pending_0.84.3-lightgrey)](packages/surface/vendors/pi/groundtruth.json)
<!-- agent-support:end -->

`verified` means the claim-addressable ASM v2+ model and exact artifacts passed the
full platform matrix, with the workflow/commit/model/replay/platform attestation
retained in the ledger. `legacy verified` preserves a previously supported baseline
that predates those gates; its versioned authoring model and digest are frozen, and it cannot
be changed or re-promoted without satisfying the current gates.
`baseline pending` is an executable candidate, not a support claim.

A staged candidate intentionally drives checked adapter projections and its
Imposter persona during review. That lets compatibility code and conformance run
before promotion; it does not change the supported-version badge, which follows
only `currentVersion` after the protected promotion gates pass.

Each badge links to the agent's stable runtime authority at its vendor root:
`groundtruth.json`. During review that document may already describe the staged
`candidateVersion` while the badge still reports the promoted `currentVersion`.
Versioned capture-derived documents remain authoring inputs, Git retains every
change to the canonical file, and
`pnpm surface:groundtruth:write` deterministically rebuilds both the canonical JSON
and a self-contained `groundtruth.html` explorer beside it.

Release detection is read-only. The adaptation workflow follows only allowlisted
redirects, bounds artifact streams before buffering, hashes the bytes, attaches
them to an already traced ASM v2+ candidate, runs fidelity-aware native replay
(byte-exact digesting, with schema validation only for type-preserving captures)
and drift classification, and may open a confined draft PR. A
separate protected workflow reacquires the bytes, runs credential-isolated
pinned-real tests on every required platform, and is the only path allowed to
update the support ledger and these badges.

## Packages

- `@vibefield/puppeteer-runtime` — provider-neutral Agent lifecycle, ingress,
  projections, and private per-Agent event bus.
- `@vibefield/puppeteer-builtin-providers` — optional composition root for the
  official Antigravity, Claude, Codex, GitHub Copilot CLI, ACP, Grok, Hermes,
  Kimi, OpenCode, and Pi adapters.
- `@vibefield/puppeteer-core` — zero-I/O event, state, session, and host
  contracts.
- `@vibefield/puppeteer-workspaces` — direct, exclusive, worktree, and copy
  workspace modes.
- `@vibefield/puppeteer-adapter-{antigravity,claude,codex,copilot,acp,grok,hermes,kimi,opencode,pi}`
  — provider-specific observation and control.
- `@vibefield/puppeteer-native-observation` — bounded append-only JSONL
  observation shared by durable-session adapters.
- `@vibefield/puppeteer-record` — append-only records of runtime-owned actions.
- `@vibefield/puppeteer-surface` — promoted vendor evidence models and their
  validation/diff runtime.
- `@vibefield/puppeteer-imposter` — local replacement-agent personas and
  scenario engine.
- `@vibefield/puppeteer-testing` — vendor-neutral fake agent and adapter
  conformance helpers.
- `@vibefield/puppeteer-monitor` — transport-neutral monitor external store.
- `@vibefield/puppeteer-react` — React monitor hooks and portable view contract.

The private Electron applications are development tools, not part of the
published package graph. Consumers supply an `AgentHost` backed by their own
terminal service.

## Install

<!-- x-release-please-start-version -->

```sh
pnpm add @vibefield/puppeteer-runtime@0.2.3 \
  @vibefield/puppeteer-builtin-providers@0.2.3
```

<!-- x-release-please-end -->

Node.js 22.18 or newer is required.

## Built-in launch options

`runtime.spawn()` creates one runtime-owned `Agent` for each provider spawn.
State, context-window, conversation, usage, environment, workspace, process,
notification, monitor, and adapter events share that agent's typed event bus:

```ts
import { createBuiltinAgentRuntime } from '@vibefield/puppeteer-builtin-providers';

const runtime = createBuiltinAgentRuntime({ host, defaultCwd: process.cwd() });
const onApproval = async () => 'denied' as const;

// Open provider catalog for generic pickers and monitoring UIs.
for (const provider of runtime.providers()) console.log(provider.id, provider.label);

const claude = await runtime.spawn({
  agent: 'claude',
  workspace: { mode: 'worktree', path: process.cwd() },
  agentOptions: {
    model: 'sonnet',
    permissionMode: 'plan',
  },
});
if ('error' in claude) throw new Error(claude.error.message);

claude.on('turn:*', ({ type }) => console.log(type));
claude.on('context-window:updated', ({ event }) => {
  console.log(`${event.usedTokens}/${event.capacityTokens}`);
});
claude.on('conversation:*', ({ event }) => console.log(event.text));
await claude.submitPrompt({ text: 'Review this repository' });

// Persist this envelope unchanged. Provider-specific state remains opaque.
const resumedClaude = await runtime.resume({ continuation: claude.info.continuation });
if ('error' in resumedClaude) throw new Error(resumedClaude.error.message);

const codex = await runtime.spawn({
  agent: 'codex',
  agentOptions: {
    model: 'gpt-5.6-sol',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    onApproval,
  },
});
if ('error' in codex) throw new Error(codex.error.message);

const grok = await runtime.spawn({
  agent: 'grok',
  agentOptions: {
    model: 'grok-code-fast',
    permissionMode: 'plan',
    sandbox: 'workspace-write',
    onApproval,
  },
});
if ('error' in grok) throw new Error(grok.error.message);
```

Public envelope routes are namespaced (`turn:started`,
`context-window:updated`, `conversation:assistant-message`, `monitor:batch`,
and so on). The nested `event` is the normalized provider-neutral payload.
Adapters expose only this normalized stream and control operations; reducers
and projections live on the runtime-owned `Agent`.

Generic ACP sessions accept `clientCapabilities`, `onApproval`, and either a
per-session `connector` or the runtime's default `acpConnector`. Codex model and
safety options apply when creating a fresh thread; resumed threads retain their
existing configuration. Approval callbacks are process-lifetime policy seams;
when absent, structured adapters deny approval requests by default.

## Caller-owned terminal adoption

Terminal hosts discover adapter-declared commands with `launchProviders()`, then
submit provider-neutral shell intent. The selected adapter alone parses native
argv and environment semantics and authors the split-phase launch recipe:

```ts
const provider = runtime
  .launchProviders()
  .find((candidate) => candidate.nativeInvocation?.commands.some((command) => command.name === invokedAs));
if (!provider?.nativeInvocation) throw new Error('unsupported native invocation');

const environment = Object.fromEntries(
  provider.nativeInvocation.environmentVariables.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]!]],
  ),
);
const prepared = await runtime.prepareInvocation({
  providerId: provider.id,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  environment,
  implementation: { kind: 'native' },
});
if ('error' in prepared) throw new Error(prepared.error.message);

// Bind the pane before exec so no initial adapter events can race adoption.
const adopted = await runtime.adoptPrepared(prepared.preparationId, {
  runtimeSessionId: pane.id,
  processId: shimPid,
});
if ('error' in adopted) throw new Error(adopted.error.message);

const agent = runtime.agent(adopted.terminalSessionId)!;
agent.on('session:*', ({ type }) => console.log(type));

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
attachment transport and does not advertise native invocation. Callers should
fall through to the untouched command when the adapter rejects custom user
arguments. `createSession`, `prepareSession`, `sessionState`, and runtime-wide
`onEvent` remain low-level compatibility/composition surfaces; applications use
`spawn()`, `resume()`, and the returned `Agent`.

## Development

```sh
pnpm install
pnpm test
pnpm build
pnpm pack:check
```

To add a new coding agent or adapt a new upstream version, follow the
[end-to-end agent adaptation workflow](docs/guides/adapting-an-agent.md). It covers
native evidence, Surface modeling, Imposter personas and runflows,
normalization, conformance, runtime integration, and protected promotion.

Live adapter proofs are opt-in with `CLAUDE_NATIVE_TUI_LIVE=1`,
`CODEX_NATIVE_TUI_LIVE=1`, `GROK_LIVE=1`, `HERMES_LIVE=1`, `KIMI_LIVE=1`, or
`OPENCODE_LIVE=1`.

## Versioning

All public Puppeteer packages release in lockstep. Internal `workspace:*`
dependencies are rewritten by pnpm to that exact version in published
tarballs. Applications should pin `@vibefield/puppeteer-runtime` exactly and
upgrade it as a deliberate integration event.

The initial `0.1.0` publication is bootstrapped from the tagged release commit:

```sh
pnpm release:publish
pnpm release:trust
```

`release:publish` verifies, builds, and publishes the public packages in
dependency order, skipping versions already present in the registry.
`release:trust` configures each package to trust `vibefield/puppeteer`'s
`release.yml` GitHub Actions workflow for `npm publish`; it requires npm 11.15
or newer, npm account 2FA, and an authenticated interactive npm session.

After configuring trust for `vibefield/puppeteer`, set the repository variable
`NPM_PUBLISH_ENABLED=true`. Release Please owns release PRs and tags, and the
Release workflow publishes through tokenless npm trusted publishing after CI
passes on the exact main commit. Provenance requires a public source repository
and is disabled while this repository is private. To retry a partial
publication, dispatch the workflow from `main` with the existing release tag:

```sh
gh workflow run release.yml --repo vibefield/puppeteer --ref main -f tag=vX.Y.Z
```
