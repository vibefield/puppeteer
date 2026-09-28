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
