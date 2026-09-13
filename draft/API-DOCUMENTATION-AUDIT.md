# Agent API documentation audit

Date: 2026-09-12. Source baseline: `e32b56b` (`refactor(monitor): remove artifacts and simplify subagent API`).

Status: audit complete; management and aggregation references implemented on 2026-09-13. The findings and counts below describe the original three-page baseline. Remaining recovery and monitor-reference work is tracked at the end.

Current companion references: [`agent-management-api.html`](../docs/agent-management-api.html) and [`agent-aggregation-api.html`](../docs/agent-aggregation-api.html). Management now covers DOC-01, DOC-02 and DOC-05; aggregation covers DOC-03. Godview management/search/usage-persistence sections, profile-bearing DTOs and architecture links also address the relevant portions of DOC-06, DOC-07, DOC-08 and DOC-10.

## Scope and result

Compared [`agent-api.html`](../docs/agent-api.html), [`agent-monitor.html`](../docs/agent-monitor.html), and
[`architecture.html`](../docs/architecture.html) with the current runtime, Core provider contracts, monitor/store/React
exports, and Godview bridge. Followed management and search calls through their implementations and application wiring.

- `AgentRuntime` has **47 methods**. **18 are absent from the Agent API reference**; the other 29 are at least listed,
  but several have incomplete signatures or only a one-line description.
- All **14 distribution and profile methods** are missing as API contracts from all three HTML references.
- The runtime-owned `Agent` has **13 public getters/methods**; all are represented in `agent-api.html`.
- Godview's `PuppeteerBridge` has **36 methods**. `agent-monitor.html` documents its five monitor methods, but there
  is no complete app bridge reference. In particular, its three history/search methods are absent from all three pages.
- The full top-level `AgentMonitorState` in `agent-monitor.html` matches Core's fields. The abbreviated copy in
  `agent-api.html` and several other copied contracts have drifted.

Counts come from source declarations, with HTML text/code inspection and manual verification of the owning layer.
A word appearing in prose is not API coverage: for example, architecture's mentions of “profile” and “attach” do not
document `runtime.profile()` or `runtime.attach()`. These counts exclude package helper exports, constructors, and
provider-native client methods; those need explicit audience classification, not inclusion in the unified API count.

## Findings

| ID     | Priority | Gap                                                                                              | Required correction                                                                                        |
| ------ | -------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| DOC-01 | High     | Installation discovery, releases and updates are shipped but absent.                             | Document the four runtime methods, request/result types, caching and updater semantics.                    |
| DOC-02 | High     | Account profiles are shipped but absent.                                                         | Document the ten runtime methods, profile lifecycle, binding and history observation roots.                |
| DOC-03 | High     | Search is invisible in these references and its application ownership is unclear.                | Document Godview's history bridge and external-daemon dependency; do not invent an `Agent.search()` API.   |
| DOC-04 | High     | Host restart/re-attachment contracts are missing; disposal is described only as finalization.    | Document `attach`, stable ingress, `dispose({ detach: true })` and the provider release contract together. |
| DOC-05 | Medium   | Account usage signatures predate profiles; the push subscription is missing.                     | Document profile-scoped fetch, `onAccountUsage`, and snapshot attribution.                                 |
| DOC-06 | Medium   | Godview documents monitor IPC but omits the rest of its bridge contract.                         | Add a clearly app-owned API inventory, including lifecycle, management and usage-history persistence.      |
| DOC-07 | Medium   | The architecture's provider interface and runtime module map omit management/recovery additions. | Update provider capabilities, ownership diagrams, source map and factory configuration.                    |
| DOC-08 | Medium   | Several copied DTOs, error unions and host method signatures are incomplete.                     | Synchronize the concrete contracts listed below; distinguish excerpts from complete definitions.           |
| DOC-09 | Medium   | Store/transport/React coverage explains behavior without a complete typed integration contract.  | Define source, connection, removal, options and exact method/hook signatures.                              |
| DOC-10 | Medium   | Navigation and synchronization checks do not cover the new API families.                         | Link implemented RFCs and add source-to-reference coverage for public methods and copied contracts.        |

## DOC-01 and DOC-02: agent management

These are existing `AgentRuntime` APIs, inherited by `BuiltinAgentRuntime`. They operate at provider/profile scope,
independently of any one live `Agent`.

```ts
distributionProviders(): readonly DistributionProvider[];
inspectInstallations(options?: InspectInstallationsOptions): Promise<AgentInstallation[]>;
checkReleases(options: CheckReleasesOptions): Promise<ReleaseCheckResult>;
updateInstallation(options: UpdateInstallationOptions): Promise<UpdateReceipt>;

profileProviders(): readonly ProfileProvider[];
profiles(providerId?: string): Promise<AgentProfile[]>;
profile(profileId: string): Promise<AgentProfile | undefined>;
createProfile(options: CreateProfileOptions): Promise<AgentProfile | ProfileFailure>;
removeProfile(profileId: string): Promise<boolean>;
profileBindingEnvironment(profileIds: readonly string[]): Promise<Record<string, string>>;
profileObservationRoot(profileId: string): Promise<string | undefined>;
startProfileLogin(options: StartProfileLoginOptions): Promise<ProfileLoginResult>;
verifyProfile(profileId: string): Promise<ProfileIdentity | ProfileFailure>;
onProfilesChanged(listener: (profiles: AgentProfile[]) => void): () => void;
```

The missing request/result documentation includes:

| Contract                                                                 | Necessary details                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InspectInstallationsOptions`, `AgentInstallation`                       | Optional provider filter and refresh; inventory caching; executable identity, install method, version, origin and active selection.                                                      |
| `CheckReleasesOptions`, `ReleaseCheckResult`                             | Required provider; `network` permits declared outbound release detectors, while native oracles can run regardless; releases, newer channels and failures are separate results.           |
| `UpdateInstallationOptions`, `UpdateReceipt`                             | Select the active or an explicitly named executable; run the native/package-manager recipe; re-inspect to determine outcome.                                                             |
| `AgentProfile`, `ProfileProvider`, `ProfileIdentity`, `ProfileFailure`   | Native-default versus managed roots, capability/support metadata, identity availability, failures and immutable managed root paths. The profile's field is `provider`, not `providerId`. |
| `CreateProfileOptions`, `StartProfileLoginOptions`, `ProfileLoginResult` | Allocation precedes login; native login runs in a host terminal; verification reads and persists native identity.                                                                        |
| `ProfileRuntimeOptions`, `ProfileStore`                                  | Host-injected registry persistence and root allocation; defaults are currently file-backed.                                                                                              |
| `DistributionRuntimeOptions`                                             | Injectable fetch/search path and native updater output directory.                                                                                                                        |

Behavior that a method-name list would still miss:

- `profiles()` includes synthetic native-default profiles. `createProfile()` allocates an initially empty managed
  account root. `removeProfile()` unregisters the managed profile and leaves its directory on disk.
- `profileBindingEnvironment()` merges selected profile bindings, with at most one profile per provider. Selecting
  a profile binds a launch; it does not switch a machine-wide active account.
- **`profileObservationRoot()` is an existing history-integration seam.** It delegates the native layout mapping
  to the adapter. The answer is not always `AgentProfile.dataRoot`: Pi and OpenCode have different binding/layout
  offsets. An app supplying Rosetta with indexing roots needs this distinction.
- `UpdateReceipt.transcriptPath` names opaque **updater command output**. It is separate from agent conversation
  transcripts and from the removed monitor artifact API.

Sources: [`AgentRuntime` and options](../packages/runtime/src/types.ts),
[`runtime implementation`](../packages/runtime/src/runtime.ts),
[`distribution contracts`](../packages/core/src/services/distribution.ts),
[`profile contracts`](../packages/core/src/services/profiles.ts),
[`builtin runtime composition`](../packages/builtin-providers/src/runtime.ts).

Actual application use: [`AgentsDrawer`](../apps/godview/src/renderer/AgentsDrawer.tsx) calls installations,
release checks, updates and account onboarding through the [`preload bridge`](../apps/godview/src/preload/preload.ts)
and [`main-process handlers`](../apps/godview/src/main/main.ts). These are not unused proposals.

## DOC-03: search and discovery boundaries

There is no `Agent.search()`, `AgentRuntime.search()` or unified native-session history listing on `AgentRuntime`.
The implemented search API belongs to Godview:

```ts
historyStatus(): Promise<HistorySearchStatus>;
historyFacts(nativeSessionIds: string[]): Promise<HistorySessionFacts[]>;
historySearch(request: HistorySearchRequest): Promise<HistorySearchResponse>;
```

| Operation                                         | Current owner and meaning                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `runtime.providers()` / capability-provider lists | Composed provider and capability discovery.                                         |
| `runtime.inspectInstallations()`                  | Executable discovery and classification on the host.                                |
| `runtime.agent(id)`                               | Lookup of an already-live runtime Agent by run/terminal identity.                   |
| Godview `listAgentSessions()`                     | App-owned live session inventory.                                                   |
| Godview `historyFacts()`                          | Indexed titles and canonical identities joined through provider-native session IDs. |
| Godview `historySearch()`                         | Transcript text search through an external Rosetta-compatible daemon.               |

The current path is `FindSheet → PuppeteerBridge → main/history-search.ts → external loopback daemon`.
The client reads `/api/status`, `/api/sessions`, `/api/search`, and individual session records for child/root
attribution. It accepts protocol versions 17–20 and selects the daemon from a setting, environment, announcement,
or the loopback default. Godview connects to the daemon; this client does not manage its lifecycle.

The missing reference should cover:

- `HistorySearchRequest`: query, native-session scope, optional time bound, result limit and prefix matching.
- `HistorySearchResponse`: status, `answered`, hits and `clipped`. `answered: false` means no reliable answer;
  the UI retains its previous hits. It does not mean a successful search found nothing.
- `HistorySearchStatus`: reachability, protocol/capabilities, canonical readiness, index readiness/progress and
  diagnostic detail.
- `HistorySessionFacts` and `HistorySearchHit`: native IDs versus daemon canonical IDs, child-to-root attribution,
  timestamps, titles and snippets.
- The bridge accepts an empty native-session scope as “all indexed sessions.” The current Find UI builds and
  navigates rows from live agents, normally supplies their native IDs, and joins results back to those rows.
  This is not an implemented closed-session browser or resume-from-search-hit API.
- Search results do not feed the live monitor's status or usage calculations.

Sources: [`Godview protocol`](../apps/godview/src/protocol.ts),
[`history client`](../apps/godview/src/main/history-search.ts),
[`FindSheet`](../apps/godview/src/renderer/find/FindSheet.tsx),
[`Find model`](../apps/godview/src/renderer/find/find-model.ts).
[`RFC 007`](../docs/rfcs/007-history-search.md) documents the accepted feature, but the three HTML references do not
link it or provide these typed contracts.

Provider-specific session discovery/client exports are another layer again. They do not establish a universal
runtime search contract. An app-provided transcript service remains a design task, not a shipped unified API to
document as already available.

## DOC-04, DOC-05 and DOC-07: lifecycle, usage and provider composition

The missing recovery contract spans several layers:

1. Spawn/resume can receive `HostIngress`; `onBound` reports the actual port/token before launch so the host can
   persist the endpoint.
2. `runtime.dispose({ detach: true })` releases bindings while preserving running processes, terminals,
   workspaces and allocated durable claims. The current docs describe only normal workspace finalization.
3. A returning host calls `runtime.attach(AttachAgentOptions)` with persisted run/creation/epoch/native-session/
   terminal identity and optional ingress/profile/workspace information. The runtime restores the next epoch.
4. The provider supplies optional `attachSession()`. An unsupported provider returns `ATTACH_UNSUPPORTED`, allowing
   the host to choose continuation resume. Binding `dispose({ release: true })` preserves files the surviving
   process still needs.

Both HTML copies of `AgentAdapterBinding.dispose()` omit its options. `HostIngress`, `BoundIngress`,
`AttachAgentOptions`, `DisposeAgentRuntimeOptions` and `AdapterDisposeOptions` need a connected explanation.
`restoreSession()` is already listed but its reconstruction inputs and relationship to `attach()` are not defined.

Account usage also has a broader implemented contract:

```ts
accountUsage(providerId: string, profileId?: string): Promise<AccountUsageFetchResult>;
onAccountUsage(
  listener: (provider: AccountUsageProvider, result: AccountUsageFetchResult) => void,
): () => void;
```

The docs show only `accountUsage(providerId)`. Provider `AccountUsageService.fetch()` actually accepts
`{ profile?: AgentProfile }`; `AccountUsageSnapshot` can carry `profileId` and credits. Push subscription is
provider-scoped and separate from per-run events. Godview already subscribes in its main process.

Architecture's copied `AgentProvider` interface omits `distribution`, `profiles`, `prewarm`, and `attachSession`.
Its runtime directory map omits `distribution/` and `profiles/`. Runtime/factory configuration also needs the
host-injected profile store and distribution options. `createBuiltinAgentRuntime()` forwards these options to the
same runtime; consumers do not need a different factory to access management.

Sources: [`runtime contracts`](../packages/runtime/src/types.ts), [`host ingress`](../packages/core/src/host.ts),
[`adapter binding`](../packages/core/src/adapter/binding.ts),
[`account usage`](../packages/core/src/services/account-usage.ts),
[`runtime exports`](../packages/runtime/src/index.ts).

## DOC-08 and DOC-09: copied contracts and incomplete reference details

| Document / contract                                          | Verified difference or missing detail                                                                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent API: `SpawnAgentOptions`                               | Missing `profile` and `ingress`.                                                                                                                                                                         |
| Agent API: `ResumeAgentOptions`                              | Missing `creationRequestId`, `externalRefs`, `profile` and `ingress`.                                                                                                                                    |
| Agent API: `AgentSessionInfo`                                | Missing `profileId`.                                                                                                                                                                                     |
| Agent API: `AgentSessionErrorCode`                           | Missing `AGENT_PROFILE_NOT_FOUND`, `ATTACH_UNSUPPORTED` and `ATTACH_FAILED`.                                                                                                                             |
| Agent API: `AgentMonitorState`                               | Missing `schemaVersion`, `lastAssistantMessage`, `effort`, `modes`, `omitted` and `session`. The monitor page explicitly identifies this as an older summary; link or label the excerpt at its use site. |
| Agent API: `MonitorMetricFamily` and family table            | Missing `conversation`, which carries bounded assistant-message observations. This retained family does not reinstate the removed `agent.conversation` surface.                                          |
| Architecture: `AgentProvider`                                | Missing `distribution`, `profiles`, `prewarm` and `attachSession`.                                                                                                                                       |
| Architecture: `AccountUsageService` / `AccountUsageSnapshot` | Missing profile fetch options and snapshot `profileId` / `credits`.                                                                                                                                      |
| Agent API and architecture: `AgentAdapterBinding`            | Missing `dispose(options?: AdapterDisposeOptions)`, including release semantics.                                                                                                                         |
| Agent API: preparation/restoration methods                   | Names/results are listed, but full option/result definitions and failure branches are missing, including preparation expiry, adoption identity and reconstruction inputs.                                |
| Agent API: host bookkeeping                                  | Types such as `RuntimeRunInfo`, `AgentWorkspaceFinal` and `ActionRecorderStatus` are referenced without full definitions. `sessionInfo()` is absent entirely.                                            |
| Monitor: store methods                                       | `acceptState(s)` combines two methods with different return types: `boolean` and accepted-count `number`. Several other rows omit parameters and return types.                                           |
| Monitor: transport types                                     | Define `AgentMonitorSource`, `AgentMonitorConnection`, `AgentMonitorRemoval` and store options explicitly. Cover removal's nullable epoch, `ready`, `close`, and `onListenerError`.                      |
| Monitor: React hooks                                         | All four are named and explained, but a complete reference should give their typed arguments/results alongside the existing examples.                                                                    |

The 13 `Agent` members are represented, the monitor page's top-level state fields match Core, and the event catalog
has a source/reference route-name check. These are stronger areas of coverage; this audit does not claim every
nested event or DTO field has a generated equivalence check.

Sources: [`Agent`](../packages/runtime/src/agent.ts), [`monitor types`](../packages/core/src/monitor/types.ts),
[`monitor batch schema`](../packages/core/src/events/monitor.ts), [`store`](../packages/monitor/src/store.ts),
[`React hooks`](../packages/react/src/hooks.ts).

## Complete runtime method inventory

Coverage below means coverage in `agent-api.html`. **Listed** means the method is identified, not that every
argument, result and operational edge case is fully documented. **Incomplete** marks confirmed signature/contract
gaps discussed above. **Missing** means the method is absent as an API entry.

| Method                      | Coverage   | Relevant finding                                                           |
| --------------------------- | ---------- | -------------------------------------------------------------------------- |
| `spawn`                     | Incomplete | DOC-02, DOC-04, DOC-08                                                     |
| `resume`                    | Incomplete | DOC-02, DOC-04, DOC-08                                                     |
| `agent`                     | Listed     | Live lookup, not history search                                            |
| `providers`                 | Listed     | Provider catalog                                                           |
| `accountUsageProviders`     | Listed     | Capability discovery                                                       |
| `accountUsage`              | Incomplete | DOC-05                                                                     |
| `launchProviders`           | Listed     | Launch capability discovery                                                |
| `prewarm`                   | Missing    | Optional provider/profile cache warming; unsupported providers are a no-op |
| `distributionProviders`     | Missing    | DOC-01                                                                     |
| `inspectInstallations`      | Missing    | DOC-01                                                                     |
| `checkReleases`             | Missing    | DOC-01                                                                     |
| `updateInstallation`        | Missing    | DOC-01                                                                     |
| `profileProviders`          | Missing    | DOC-02                                                                     |
| `profiles`                  | Missing    | DOC-02                                                                     |
| `profile`                   | Missing    | DOC-02                                                                     |
| `createProfile`             | Missing    | DOC-02                                                                     |
| `removeProfile`             | Missing    | DOC-02                                                                     |
| `profileBindingEnvironment` | Missing    | DOC-02                                                                     |
| `profileObservationRoot`    | Missing    | DOC-02                                                                     |
| `startProfileLogin`         | Missing    | DOC-02                                                                     |
| `verifyProfile`             | Missing    | DOC-02                                                                     |
| `onProfilesChanged`         | Missing    | DOC-02                                                                     |
| `createSession`             | Listed     | Deprecated compatibility entry                                             |
| `prepareInvocation`         | Incomplete | DOC-08; host SPI                                                           |
| `prepareSession`            | Incomplete | DOC-08; provider composition                                               |
| `adoptPrepared`             | Incomplete | DOC-08                                                                     |
| `restoreSession`            | Incomplete | DOC-04, DOC-08                                                             |
| `attach`                    | Missing    | DOC-04                                                                     |
| `cancelPrepared`            | Incomplete | DOC-08                                                                     |
| `runtimeRunInfo`            | Incomplete | DOC-08                                                                     |
| `monitorState`              | Listed     | Host monitor lookup                                                        |
| `observeMonitor`            | Listed     | Handle documented in monitor reference                                     |
| `onMonitorState`            | Listed     | Host state fan-out                                                         |
| `onMonitorNotification`     | Listed     | Host notification fan-out                                                  |
| `onMonitorRemoved`          | Listed     | Host removal fan-out                                                       |
| `acknowledgeFailureBlocker` | Listed     | Failure acknowledgment                                                     |
| `recordingStatus`           | Incomplete | DOC-08                                                                     |
| `onRecordingStatus`         | Incomplete | DOC-08                                                                     |
| `sessionInfo`               | Missing    | DOC-08; terminal-ID lookup                                                 |
| `sessionState`              | Listed     | Deprecated compatibility entry                                             |
| `observationLevel`          | Listed     | Deprecated compatibility entry                                             |
| `onEvent`                   | Listed     | Deprecated compatibility entry                                             |
| `onAccountUsage`            | Missing    | DOC-05                                                                     |
| `submitPrompt`              | Listed     | Deprecated runtime entry; Agent method is documented                       |
| `workspaceDiff`             | Listed     | Host workspace access                                                      |
| `handleProcessExit`         | Incomplete | DOC-08; host exit/result contract                                          |
| `dispose`                   | Incomplete | DOC-04                                                                     |

## DOC-06: complete Godview bridge inventory by responsibility

The existing monitor IPC table is intentionally narrow. The other methods need app documentation; their absence
does not imply that all 36 should move onto `Agent` or `AgentRuntime`.

| Group                    | Methods                                                                                                                                                                        | Current coverage in the three references                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Sessions/control (8)     | `createAgentSession`, `listAgentSessions`, `rehydratePane`, `onAgentSession`, `onAgentRemoved`, `submitPrompt`, `interruptAgent`, `resumeAgentSession`                         | No complete bridge contract; same-named runtime prompt API is a different signature. |
| Monitor (5)              | `listAgentMonitors`, `onAgentMonitorState`, `onAgentMonitorNotification`, `onAgentMonitorRemoved`, `acknowledgeAgentFailure`                                                   | Dedicated table in `agent-monitor.html`.                                             |
| Workspaces (2)           | `workspaceDiff`, `onWorkspaceFinal`                                                                                                                                            | Runtime diff access is mentioned; app contract is incomplete.                        |
| Account usage (3)        | `accountUsage`, `refreshAccountUsage`, `onAccountUsage`                                                                                                                        | Provider runtime fetch is documented, not the app's batch/cache contract.            |
| Distribution (3)         | `installations`, `checkReleases`, `updateInstallation`                                                                                                                         | Missing.                                                                             |
| Profiles/tab policy (10) | `profileProviders`, `profiles`, `createProfile`, `startProfileLogin`, `verifyProfile`, `removeProfile`, `onProfiles`, `profileDefaults`, `setProfileDefault`, `newTerminalTab` | Missing.                                                                             |
| History/search (3)       | `historyStatus`, `historyFacts`, `historySearch`                                                                                                                               | Missing.                                                                             |
| Usage persistence (2)    | `loadUsageHistory`, `saveUsageHistory`                                                                                                                                         | Missing.                                                                             |

`interruptAgent()` performs the app's native terminal interruption; there is no corresponding `Agent.interrupt()`.
`resumeAgentSession()` and `rehydratePane()` implement app continuation/pane recovery. Profile defaults and new-tab
binding are Godview policy. Usage-history methods persist the UI's held totals/series by provider and native session
ID; this is a Godview cache, not account-quota polling or transcript-derived usage.

Source: [`PuppeteerBridge` and its DTOs](../apps/godview/src/protocol.ts),
[`IPC handlers`](../apps/godview/src/main/main.ts),
[`usage-history store`](../apps/godview/src/main/usage-history-store.ts).

## DOC-10: reference ownership and follow-up

Recommended ownership:

| Reference                              | Responsibility                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-api.html`                       | Complete unified runtime/Agent API inventory, provider management, inputs/results/errors and explicit host/compatibility sections.                          |
| `agent-monitor.html`                   | Monitor contracts, store/transport/React signatures, and a clearly labeled Godview integration section linking app APIs.                                    |
| `architecture.html`                    | Provider-scoped management and run-scoped monitoring ownership; host restart lifecycle; Godview's external history dependency; links to detailed contracts. |
| App API section or companion reference | Godview's bridge, search protocol adapter, persisted UI usage, profile defaults and terminal policy.                                                        |

[`RFC 006`](../docs/rfcs/006-agent-distribution-and-account-profiles.md) already records implemented distribution
and profiles, but is missing from the three HTML references and the documentation map. Its earlier design sketches
are not a substitute for current TypeScript: use the implementation status and source contracts. Its extension
inventory/management track is still open and must not be presented as a shipped runtime capability.

[`RFC 007`](../docs/rfcs/007-history-search.md) is in the documentation map but absent from these three references.
Connect it to the architecture and Godview API sections.

Runtime's root also re-exports management helper factories (`createInstallationInventory`, `createProfileRegistry`,
`createFileProfileStore`, and others), identity infrastructure and `AgentMonitorService`. Classify these as supported
host/provider composition APIs or implementation exports before promising a complete flat package API reference.
They were not counted as additional `AgentRuntime` methods.

The existing [`event catalog documentation check`](../packages/core/src/events/catalog.test.ts) compares route
names. It does not check runtime methods, profile/recovery options, bridge contracts or copied DTO members. Broader
declaration-based coverage and checked examples would catch the omissions found here.

- [x] Inventory runtime, Agent, monitor/store/React and Godview entry points.
- [x] Trace shipped management and search wiring; distinguish runtime, provider and app ownership.
- [x] Record missing methods, stale signatures and existing RFC coverage.
- [x] DOC-01 / DOC-02 / DOC-05: document provider management and profile-aware usage.
- [x] DOC-03: document the history/search bridge, client, DTOs, ownership and compatibility.
- [x] DOC-06 (management/search/usage): document app management policy, quota batches and usage persistence.
- [ ] DOC-06 (remaining): document app session/control and workspace bridge contracts.
- [x] DOC-07 (management): update provider capabilities and management/aggregation architecture ownership.
- [ ] DOC-04 / DOC-07 (recovery): document host recovery and the remaining release/disposal contracts.
- [x] DOC-08 (profiles/usage): update spawn/resume profile options, run profile attribution, account usage signatures and remove the stale architecture usage DTO copies.
- [ ] DOC-08 / DOC-09 (remaining): synchronize the other copied DTOs and complete monitor integration signatures.
- [x] DOC-10 (navigation): cross-link all five HTML references, the documentation map and implemented RFCs.
- [ ] DOC-10 (automation): add durable declaration/example synchronization checks.

The follow-up adds the two HTML references and updates relevant companion links/contracts. Runtime implementation and public API behavior remain unchanged.

Follow-up validation: 43 documented method signatures match their source declarations; 71 documented DTO, service
and configuration types pass source assignability and property-key checks. All five HTML references have balanced
structure, unique IDs and valid local links/anchors. The two new pages were inspected in Chrome at desktop and
mobile widths, including light/dark themes, section navigation and browser script errors.
