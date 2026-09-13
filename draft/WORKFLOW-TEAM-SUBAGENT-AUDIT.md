# Subagent API cleanup and source audit

- Baseline audit: 2026-09-12, Puppeteer `a94b5f4`, after removal of `agent.conversation`.
- Decision: remove monitor artifacts and provider-specific team/workflow APIs; retain only unified child metrics and activity.
- Implementation and local validation: complete.
- Scope: nine built-in providers, generic ACP, Core, Runtime, Godview, recorder, and API references.
- Related: [transcript service needs](TRANSCRIPT-SERVICE-NEEDS.md), [Claude transcript tracker](CLAUDE-TRANSCRIPT-DEPENDENCIES.md).

## Public contract

Monitor schema **3** exposes `subagentCount` and these child rows:

```ts
interface MonitorSubagentState {
  id: string;
  working: boolean;
  activity?: string;
  modelId?: string;
  effort?: string;
  cumulativeTokens?: number;
  burnRatePerMin?: number;
}
```

`subagentCount` counts known distinct children in the current run, including completed children, before the 256-row display limit. It is not a claim that every native child has been discovered. Missing model, effort or usage remains unavailable. `working: false` means no current work is observed, not proof that a child terminated.

Any working child keeps the main agent `working`, including while a different participant needs input. A blocked child does not count as working. Idle/stopped evidence closes stale child activity; host process exit ends working activity. Completed children retain their usage totals. A stopped child's unresolved permission/question no longer blocks the parent.

Usage is aggregated in Core, once per canonical contribution or independent actor counter. The UI does not add displayed children to the run total again. Actorless provider aggregate counters already cover a run and are not added to their child counters. Codex's per-thread counters are explicitly actor-attributed so root and child usage both contribute. Historical/bootstrap totals never manufacture a live burn spike.

Claude child status token counts are context occupancy, not token consumption. They no longer produce usage samples or burn. Claude settled usage comes solely from observed OTLP requests, including child requests; exact child attribution requires a native agent ID. Claude's operational meter continues to use fresh input + output, while cumulative work includes cache buckets.

## Completed decisions

| ID    | Cleanup                                                                                                                   | Status   |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| WTS01 | Replace ambiguous child `active` with observed `working`; retain only model/effort, usage and activity.                   | Complete |
| WTS02 | Count only proven child identities; unjoined status tasks and derived OTLP groups cannot invent extra children.           | Complete |
| WTS03 | Keep name-only team/teammate hints in native evidence; remove provisional membership inference.                           | Complete |
| WTS04 | Remove team DTOs, membership joins, cross-run team aggregates, UI and notifications.                                      | Complete |
| WTS05 | Remove workflow events/family/DTOs, producer mappings, UI and notifications.                                              | Complete |
| WTS06 | Remove artifacts end to end: public service/handle/runtime methods, adapter binding, recorder action, IPC/preload and UI. | Complete |
| WTS07 | Remove child context projection and duplicate session-state child map. Keep supported child metrics in the monitor only.  | Complete |
| WTS08 | Fold child activity into main status and child usage into run totals once; remove child lifecycle notice noise.           | Complete |
| WTS09 | Update all adapter capability matrices, conformance checks and public API documentation.                                  | Complete |

The portable `delegation:subagent-started`/`stopped` observation events remain inputs for child identity/activity. They do not create lifecycle notifications. Provider-native actor attribution remains internal monitor evidence for deduplication and grouping. `ExternalRef.kind: 'workflow'` remains opaque caller metadata, independent of the removed provider workflow feature.

## Sources retained by provider

| Provider                       | Source of retained child facts                                                                            | Transcript/journal dependency                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude Code                    | `SubagentStart`/`SubagentStop`, exact-joined child status model/effort/activity, OTLP request model/usage | None for these facts. Separate root assistant reader remains.                                        |
| Codex                          | App-server child-thread/collaboration notifications, settings, token counters and native API bootstrap    | None for child facts. Separate root rollout-context fallback remains.                                |
| OpenCode                       | HTTP child/status/message snapshots and SSE session/message/tool events                                   | None; native APIs also return historical messages.                                                   |
| Hermes                         | Gateway `subagent.*` identity/activity/model/completion counters                                          | None; child event family remains source-backed, not pinned-runtime verified.                         |
| Kimi                           | Root and child `agents/*/wire.jsonl`, task lifecycle and actor-tagged metrics                             | Yes, including child journal discovery/read.                                                         |
| Copilot                        | `events.jsonl` subagent lifecycle and actor-tagged metrics                                                | Yes. Autopilot objective/task metadata now remains native evidence.                                  |
| Grok                           | `updates.jsonl` subagent events or Grok-specific ACP extensions                                           | Yes on journal path; protocol coverage is not proven equivalent. Child context does not become burn. |
| Pi / Antigravity / generic ACP | No supported child producer                                                                               | No child feature to preserve.                                                                        |

All seven delegation-capable providers retain degraded capability declarations where evidence is partial. Absence of a native signal does not produce guessed model, effort, usage, membership or completion. No path above calls Rosetta.

## What was removed

The baseline had one name-only team producer (Claude), two workflow identity producers (Claude OTLP and Copilot autopilot journals), and zero built-in producers of readable monitor artifact references. Generic team/member/artifact fields had no complete built-in producer. The workflow and team paths did not justify separate shared APIs.

Claude workflow IDs/names and teammate hints remain in native evidence; they cannot establish a child by themselves. When actual child identity and operational evidence exists, it enters the same unified child projection as any other subagent. No team/workflow journal scanner or transcript-derived usage/model reader was introduced.

The three HTML references are [Agent API](../docs/agent-api.html), [monitor](../docs/agent-monitor.html) and [architecture](../docs/architecture.html). Implementation lives in [Core projection](../packages/core/src/monitor/project.ts), [usage ledger](../packages/core/src/monitor/rate.ts), [public types](../packages/core/src/monitor/types.ts), [Runtime monitor service](../packages/runtime/src/services/monitor-service.ts) and [Godview inspector](../apps/godview/src/renderer/AgentMonitorInspector.tsx).

## Validation

Regression coverage includes parent-turn completion with active children, root gates while another child works, stale child activity after idle, stopped-child gates, host exit, exact identity counting, bounded counts, usage corrections and deduplication, independent Codex thread counters, bootstrap rate suppression, and native evidence preservation. Local results:

- Vitest: **1,529 passed**, 15 skipped (211 passing files; 14 skipped files). Covers Core, Runtime, all adapters, recorder, monitor/React/testing, Godview and the devkit. Loopback-server tests ran outside the filesystem/network sandbox.
- TypeScript: all **21 packages and 2 apps** pass full checks.
- Clean package builds: **21 pass**; Godview bundles successfully.
- Ground-truth mappings, package layout and support ledger checks pass; related script regressions: **9 pass**.
- Three HTML references pass structure, local-link and anchor checks; the API event-catalog synchronization test passes.
- Removed artifact/team/workflow symbols are absent from live source and rebuilt public declarations. Native ground truth and unrelated build/CI artifacts remain intact.

Provider live tests remain opt-in and were not launched. These checks verify the local implementation, not new upstream coverage claims.
