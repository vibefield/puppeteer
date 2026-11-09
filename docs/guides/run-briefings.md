# Per-run briefings

`runtime.spawn`, `runtime.createSession`, `runtime.prepareSession`, and `runtime.resume` accept three optional, provider-neutral launch fields. They sit beside `modelSelection`; they do not belong in `agentOptions`.

```ts
import type { AgentRunBriefing } from '@vibefield/puppeteer-core';

const briefing = {
  mcpServers: {
    vibefield: {
      command: '/absolute/path/to/sparks-door',
      args: ['--stdio'],
      env: { FIELD_SOCKET: '/path/to/field.sock' },
    },
  },
  allowTools: ['vibefield/*'],
  instructions: 'You are the composer for this spark. Use the VibeField tools to read and update it.',
} satisfies AgentRunBriefing;

const agent = await runtime.spawn({
  agent: 'claude',
  cwd: '/workspace',
  modelSelection: { modelId: selectedModelId },
  ...briefing,
});

// Build a fresh briefing for the resumed process, including current endpoints and credentials.
const resumed = await runtime.resume({
  continuation,
  cwd: '/workspace',
  modelSelection: { modelId: selectedModelId },
  ...freshBriefing,
});
```

`mcpServers` declares stdio MCP processes with a command, optional argument array, and optional string environment map. Servers supplement native configuration. Use distinct server names: Codex refuses a name already present in its effective configuration because its native configuration merge could otherwise inherit an unrelated transport or tool policy. Server names use letters, digits, underscores and hyphens, beginning with a letter or digit.

`allowTools` grants native auto-approval for the named MCP tools. Each selector is `server/tool` or `server/*`, and the server must be declared in the same briefing. Partial globs, native permission expressions, built-in tools and unscoped wildcards are rejected. A server declaration alone grants no approval. The grants are additive; native policy, including managed restrictions and explicit denials, remains authoritative. This is not a tool visibility filter or a sandbox override.

`instructions` supplies the role instructions at native session creation or resume. It does not send a user message or start a model turn. Briefing after compaction, extra directories and plugin installation are outside this API.

## Capability discovery and refusals

Read `runtime.providers()` or `runtime.launchProviders()` before presenting a briefing-dependent action. The optional `briefing` member advertises adapter support:

```ts
{
  mcpServers: true,
  allowTools: true,
  instructions: true,
  mcpServerProcess: 'terminal',
}
```

An absent capability is unsupported. This metadata describes the adapter; the installed executable and native policy can still refuse a launch.

| Provider | MCP servers | Tool allowances | Instructions | MCP process ancestry |
| --- | --- | --- | --- | --- |
| Claude | Yes | Yes | Yes | Terminal |
| Codex | Yes | Yes | Yes | The run's own app-server (`run-helper`) |
| ACP | Yes | No standard field | No standard field | External agent owns it |
| Grok | Yes, through ACP | No standard field | No standard field | The run's own leader (`run-helper`) |
| Other built-ins | Unsupported | Unsupported | Unsupported | — |

Supplying an unsupported field, including an explicit empty value, produces a named `UNSUPPORTED_LAUNCH_FIELD` refusal. Invalid data produces `INVALID_LAUNCH_FIELD`. Conflicting native settings or arguments produce `CONFLICTING_LAUNCH_FIELD`. Runtime returns these as `error.code === 'AGENT_LAUNCH_REFUSED'` with the specific code in `error.refusal.code` and the field in `error.message`. Direct adapter/builtin calls throw `AgentLaunchRefusedError`.

Claude probes the launch flags it needs, including the append-file and prompt-snapshot controls. Codex requires an app-server that identifies itself as 0.147.0 or newer and, for MCP declarations, can read the effective configuration. A Codex resume picker cannot apply these fields before the chosen thread loads, so it refuses them; resume a known continuation instead. The synthetic Imposter routes refuse briefings they cannot execute.

## Typed launches: withhold instead of refuse

`runtime.prepareInvocation` carries the same three fields, for a launch a person typed. A person's own `--mcp-config`, `--allowedTools`, system-prompt flag or `--restricted` must not fail their command because a host wanted to add something, so pass `briefingRefusal: 'withhold'` (also accepted by `runtime.prepareSession`; `refuse` is the default, and `spawn`, `createSession` and `resume` always refuse):

```ts
const prepared = await runtime.prepareInvocation({ ...invocation, ...briefing, briefingRefusal: 'withhold' });
if (!('error' in prepared)) prepared.briefing; // { applied: ['instructions'], withheld: [{ field: 'mcpServers', code: 'CONFLICTING_LAUNCH_FIELD' }, ...] }
```

Each field is settled on its own: an unsupported or conflicting field leaves and the launch goes ahead with the rest. Withholding `mcpServers` also withholds `allowTools`, because an allowance names a server of the same briefing. Invalid data is still refused: that is the host's error. The receipt names fields and codes only, never a value, and appears on `PreparedAgentSessionInfo` and `AgentSessionInfo` whenever the launch was asked to carry a briefing, whatever the policy. A launch with no briefing has no receipt.

Codex settles on the one connection it already holds: a preflight refusal starts the thread without those fields, on the same app-server and the same `creationRequestId`. A picker or Imposter launch withholds what it cannot apply.

## Native delivery and lifetime

- Claude receives a private, session-owned MCP file through `--mcp-config`, tool rules through `--allowedTools`, and a private instruction file through `--append-system-prompt-file`. `--system-prompt-snapshot off` makes resumed conversations use the new instructions. MCP environment values are expanded from generated child environment variables and never written into the file or argv. The adapter cleans its files on disposal or failed preparation/spawn.
- Codex receives `developerInstructions` and per-thread `config` on `thread/start` or `thread/resume`, including the legacy history fallback. MCP overrides compose with the selected model and reasoning effort. They never use `config/value/write`, change a profile file, or weaken the thread's sandbox/approval policy. A declared server is not marked required: one that cannot start leaves the run without its tools rather than failing the thread, so `applied` in a receipt says the field was carried, not that the server came up.
- ACP receives `mcpServers` on both `session/new` and `session/load`. Environment entries use the protocol's `{name, value}` representation. Grok carries the same declarations through its ACP control connection before the native viewer joins, on a leader started for that run (`--leader-socket`) and drained when the run ends; a run with no servers stays on the shared leader. That the leader spawns each session's MCP children itself is the adapter's reading and has not been observed live.

Runtime validates and copies the briefing before asynchronous launch work. All three fields participate in creation-request identity, so changing one while reusing a `creationRequestId` is a conflict. Runtime excludes them from continuation codecs and public session metadata. Supply fresh values on each resume. Omitting a field delegates to native behavior; it is not a request to erase earlier native settings. Native agents may retain their own instructions/session data, and a running host must treat terminal recipes and protocol requests as sensitive. Keep credentials in `env`, not commands, arguments or instructions.

## VibeField CP-1d integration

Publishing this upstream change and pinning that release in VibeField are separate steps. VibeField's spark launch route must construct the briefing and carry it on both spawn and every resume-from-record path. A `prepare(): Promise<void>` route that discards the result cannot do this; its result must feed the launch request.

The sparks door authenticates callers by process ancestry. A host using only a terminal pane's PID and birth time must require `briefing.mcpServerProcess === 'terminal'` before enabling that door. `run-helper` is the second safe answer: Codex's MCP child descends from its private app-server, and a briefed Grok run gets a leader of its own, so each run has one helper process, started outside the pane. The adapter names it through `HostIngress.onHelperProcess({ pid, startedAtMs })`, and awaits the host's answer, after the helper runs and before any request that can start an MCP server. If the hook throws, the launch is refused (`RUN_HELPER_UNNAMED`) rather than starting an agent the door cannot name. A host's ingress must be passed on `spawn`, `prepareSession`, `resume`, or `prepareInvocation` for it to hear this. The capability metadata makes this check provider-neutral. Do not substitute a role name, caller-supplied run ID, or secret environment variable for that association.

A plain `helper` or `external` provider remains gated: no trusted association exists for it.

## Verification

The regular suites cover validation, provider capabilities, model-selection coexistence, creation identity, continuation privacy, native argument/configuration conflicts, cleanup, and new/resumed sessions. The native proofs are opt-in:

```sh
PUPPETEER_LIVE_BRIEFING=1 PUPPETEER_CLAUDE_BIN=/absolute/path/to/claude \
  pnpm --filter @vibefield/puppeteer-adapter-claude exec vitest run src/launch/briefing.live.test.ts
PUPPETEER_LIVE_BRIEFING=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex \
  pnpm --filter @vibefield/puppeteer-adapter-codex exec vitest run src/launch/briefing.live.test.ts
```

Both use throwaway profiles and local MCP fixtures. Claude's local Messages API fixture verifies the actual system instructions and advertised MCP tool after startup and resume. Codex makes no model turn and verifies server environment delivery on both runs and unchanged profile configuration. The Codex harness rejects inherited `CODEX_*`/`OPENAI_*` variables it cannot isolate; unset the variables it names before running it. These proofs passed on macOS with Claude 2.1.312 and Codex 0.165.0.

Native references: [Claude resumed system prompts](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations), [Codex MCP configuration at 0.147.0](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/config/src/mcp_types.rs), [Codex tool approval handling](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/mcp_tool_call.rs), and [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup).
