# Strict invocation coverage

Started 2026-09-28 against Puppeteer `4e77add` and VibeField `ff71b277`.

The seven remaining vendor adapters already prepare and observe native sessions. Their missing
contract is classification: help and management commands, one-shot runs, and sessions hosted
elsewhere must pass through; an interactive session must either preserve its supported arguments
or name the argument preventing management. The host owns strictness; adapters own grammar.

## Implementation and landing order

1. Capture installed CLI help and version, record parser evidence, and inventory every public
   root option and command. Keep this evidence separate from the support-promotion ledger.
2. Add adapter-owned grammar tables and classification, preserving the existing launch recipes
   and continuation stores. Share only pure argument tokenization through Core. Unsupported
   interactive options receive explicit refusals, never silent omission.
3. Exercise option arity, aliases, inline values, `--`, command boundaries, mode selection,
   native/imposter classification, mapped launch options, and strict gateway behavior. Bind
   each grammar's option/command census to its captured help.
4. Advertise `nativeInvocation.classifies` only after the adapter tests pass. Verify the
   builtin provider composition and both hosts' launcher selection.
5. Commit Puppeteer, deliberately advance VibeField's sibling pin, enable catalog `invoke`,
   regenerate its artifacts and iOS mirrors, and validate the catalog and gateway against
   the actual sibling. Land the two commits without including unrelated working-tree edits.

## Boundaries

The adapters' existing managed launch subsets remain explicit. A new CLI option is refused
until its semantics can be preserved; a help census makes that maintenance visible. An agent's
broader preview/verified status is independent and is not promoted by this work. ACP is a
protocol provider with no native command grammar, so it receives no command launcher.

VibeField remains strict. Puppeteer's standalone Godview remains a permissive reference host
until it implements the terminal inventory and strict-host lifecycle required by the kit guide.
Its adapter behavior is tested through the same provider composition.

Installed grammar evidence: Grok 1.0.41, Kimi 2.0.2, OpenCode 1.18.32, Hermes 0.21.4,
Antigravity 1.2.12, Copilot 1.0.88, Pi 0.87.1. See each adapter's launch fixtures for provenance.

## Managed interactive clauses

Every vendor supports a bare native session. Native aliases for these options
are normalized by the adapter; repeated/conflicting selectors may be refused.
This table describes invocation support, not the broader agent support tier.

| Agent | Additional supported clauses |
| --- | --- |
| Grok | Model, permission mode, sandbox, latest continuation, exact resume |
| Kimi | Exact session, model, agent or agent file, yolo/auto permissions, plan |
| OpenCode | Exact session; `--pure` matches the managed recipe |
| Hermes | Exact resume, yolo; `--tui` and bare `chat` match the managed recipe |
| Antigravity | Exact conversation, model, mode, effort, agent, project, additional directories, sandbox, permission bypass |
| Copilot | Exact resume, model, mode/plan, reasoning effort, agent, name on new sessions, allow-all |
| Pi | Exact session, provider, model, thinking, name, session directory; text mode |

An unsupported initial prompt or configuration clause receives a refusal. Native
non-interactive modes keep their original arguments on passthrough.

### Classification review corrections (2026-09-28)

Three false passthroughs in the initial rollout could launch an unmanaged TUI:
cancelled OpenCode help/version flags, Hermes chat exit/quiet flags without a
guaranteed one-shot route, and Antigravity's invented `--version=true` shortcut.
The reader now supports deferred utility flags and adapter-owned decisions over
arity-resolved options. OpenCode uses final boolean values; Antigravity recognizes
only its native exact entry tokens. Hermes requires nonempty root `-z`, stream-json,
or explicit `chat --cli` with input and an exit/quiet flag; ambient TUI preferences
cannot establish a one-shot. Query files are safe in the forced classic route
because native validation exits on empty or unreadable files.

Regression coverage runs through the actual builtin runtime and strict gateway:
these cases are refused in owned interactive panes, while outside-host and piped
invocations retain fallback. Valid help and proven one-shot routes still bypass
custody. Native parser evidence and dated corrections live beside each grammar.

The correction passed all affected Core, adapter, runtime and builtin-provider
suites, including the native dispatch fixture and strict gateway regressions.
All workspace typechecks, package topology and support-ledger checks passed.
The full root test command still stops at the pre-existing stale Codex
groundtruth map; this review correction does not change that mapping.

## Validation record

- All 25 workspace typechecks and the package topology check passed.
- All package/app suites passed: 338 files, 3,163 tests; 18 opt-in tests skipped.
  The final Grok protocol classification and documented Kimi alias refinements
  then passed 80 focused tests, including the real builtin/runtime gateway composition.
- Native Grok 1.0.0, Kimi 0.34.0, and OpenCode 1.18.16 live lanes passed: actual
  TUI process, adapter observation, one loopback model response, and exact native
  resume. These use archived target binaries and isolated homes, not user credentials.
  They establish existing adapter behavior, not a support promotion for the newer
  installed versions whose command grammars were inspected.
- Support ledger and README validation passed. Repository script tests passed 97/98;
  the sole failure is the existing stale Codex groundtruth map. `pnpm test` also
  stops at that map after passing typechecks/topology. The unchanged original
  checkout reproduces the same mapping failure; this change does not rewrite it.
- VibeField's new eight-test consumer proof passed against this sibling: nine strict
  launchers, preview status retained, ACP excluded, real help classification before
  custody/preparation. Contracts and fieldd typechecks passed. Its broader gateway
  suite passed 86/87, retaining the previously documented row-1 audit assertion
  failure (terminal creation records cwd; that assertion inspects the whole ledger).

The full gates are not recorded as green. Latest installed native sessions for
all seven vendors have not been driven through a real Electron pane by this work;
current grammar evidence and archived-version adapter live proofs are distinct.

## Follow-up scope

- Extend managed recipes for useful currently refused clauses (initial prompts,
  model selection in OpenCode/Hermes, continuation pickers) with observation and
  exact-session proofs before accepting the syntax.
- Advance native version support through Surface evidence and the promotion ledger,
  including live pane coverage for Antigravity, Copilot, and Pi.
- Ship a real Node shim runtime for packaged hosts and add non-zsh/Windows shell
  integration under the existing host contract. Those host gaps are unchanged.
