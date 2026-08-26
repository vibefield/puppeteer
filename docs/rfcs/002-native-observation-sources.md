# RFC-002: Adapter-Owned Native Observation Sources

- **Status:** Accepted
- **Created:** 2026-08-25
- **Owners:** Core and adapter maintainers
- **Supersedes:** The Spaghetti live-observer, SDK pin, and semantic-plane ownership portions of RFC-001 and the draft design
- **Related:** [`001-evidence-backed-runtime-observation.md`](./001-evidence-backed-runtime-observation.md), [`agent-api.html`](../agent-api.html)

## Decision

Puppeteer adapters own the small live observers required to normalize a provider's native evidence. The live runtime no longer depends on `@vibecook/spaghetti-sdk`.

The stable boundary remains the provider-neutral `AgentEvent` catalog. Each event category owns a strict Core Zod schema and its inferred TypeScript callback type. Adapter wire decoders use tolerant TypeScript guards because provider payloads are versioned external input: they extract only fields a category normalizer understands, then runtime ingress validates the resulting Core event once with Zod.

Public event names remain `category:event-name`.

```text
provider hook / OTLP log / transcript / journal / status
  → adapter-local wire decoder
  → one category normalizer
  → AgentEvent (`category:event-name`)
  → runtime validation, ordering, reducers, and subscribers
```

## Claude source ownership

| Category | Primary live source | Durable or degraded source |
| --- | --- | --- |
| conversation | complete assistant transcript rows | resume replay from the same transcript |
| interaction | permission/question hooks | transcript is not lifecycle truth |
| tools | tool hooks | none required for lifecycle |
| planning | plan/task hooks | journal/transcript evidence may enrich later |
| model | status channel and OTLP request model | transcript assistant model |
| effort | hooks and status channel | configured launch intent |
| mode | hooks and status channel | configured launch intent |
| usage | authenticated OTLP log `api_request` | root and exact-session child transcript `message.usage` using the same request identity |
| compaction | native compact hooks | none; transcript history is re-read after invalidation |
| progress | hooks and child status | provider-specific task evidence |
| delegation | subagent hooks and child status | workflow journals for exact workflow members |
| workflow | OTLP `workflow.run_id` / `workflow.name` | per-run `journal.jsonl` for member ids and completion |

These categories do not require a general semantic database. Search, cross-session history, and analytics can remain a separate data product that indexes provider files without being in the live process dependency graph.

## Usage rules learned from the burn-rate probe

Claude OTLP logs are the primary settled-usage plane. Metrics and traces duplicate the same token facts and are not ingested. `api_request` arrives at request completion; there is no sanctioned intra-response output-token stream.

For each request the adapter retains separate values:

- `totalTokens`: fresh input + output + cache read + cache creation;
- `meterTokens`: fresh input + output, used by the short operational burn meter;
- token buckets and `costUsd`: preserved independently for UI and analytics.

Every request is counted, including workflow/subagent requests. Actor attribution is added only when Claude emits an exact native agent id.

OTLP is enabled only in the spawned process environment. The adapter does not mutate user configuration, does not use the console exporter, and does not overwrite an existing OTLP route. Known versions older than the locally proven Claude `2.1.245` remain on transcript fallback; unknown versions are safely probed. The collector accepts logs on a loopback-only bearer-authenticated endpoint and drops all attributes outside an explicit operational allow-list, including email and account identifiers.

Transcript and OTLP observations share `claude-request:<request_id>`, so the runtime corrects or suppresses the durable duplicate rather than double-counting it.

## Package layout

```text
packages/adapter-claude/src/observation/
  otel/
    wire.ts             # OTLP JSON + PII allow-list
    usage.ts            # usage:tokens-used
    environment.ts      # environment:updated
    workflow.ts         # workflow:updated identity
    capability.ts       # supported-version gate
  transcript/
    wire.ts             # bounded tolerant JSONL rows
    conversation.ts     # conversation:assistant-message + resume history
    usage.ts            # usage fallback
    environment.ts      # durable model fallback
    provider.ts         # polling service
    services/
      jsonl-reader.ts   # append-aware bounded file reader
      session-reader.ts # exact-session root + child sidecars
  workflow/
    journal.ts          # exact workflow membership service
  hook-bridge.ts        # authenticated loopback transport service
```

## Consequences

- Core schemas and route names stay provider-neutral and exhaustive.
- Each adapter file answers one question: which native source is being normalized for which upper-level category or service?
- Hooks remain lifecycle truth; transcript failure cannot end a live process.
- The dependency graph and runtime failure surface are smaller.
- Provider schema drift is now our responsibility, so each wire decoder requires fixtures, tolerant unknown-field behavior, version/capability reporting, and bounded input handling.
