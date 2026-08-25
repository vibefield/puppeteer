# Testing package migration

## Next

Adapter handles no longer expose reducer state or a separate monitor callback.
Use `projectAgentSession(session)` in low-level adapter tests to consume the one
normalized event stream and inspect its derived `state`, `states`, `envelopes`,
and `monitorBatches`. Product code should use the runtime-owned `Agent` instead.

Live conformance harnesses that must await startup may attach that projection
themselves and return it as `AgentSessionHarness.projection`; the shared suite
then reuses the same first consumer so buffered bootstrap events are reduced
exactly once.

## 0.2.0

`@vibecook/chopsticks-testing` is now provider-neutral. The following
Claude-specific exports from 0.1.8 are removed:

- `hookFixturesDir`
- `listHookFixtureEvents`
- `loadHookFixtures`
- `fakeClaudeHookPayload`
- `CapturedHookRecord`

Real-vendor captures are repository evidence, not a reusable test-package API.
Chopsticks' canonical sanitized Claude captures now live under
`packages/surface/vendors/claude/captures/`; they are deliberately excluded
from published tarballs. Tests inside this repository should load those files
from Surface, as the Claude adapter's `src/test-support/claude-fixtures.ts`
does. External adapter tests should keep their own sanitized native fixtures
beside their Surface evidence rather than copying them into the general Testing
package.

Synthetic Claude payload construction is adapter-specific. Keep a small local
builder in Claude adapter test support. The provider-neutral `fakeAgentBin` and
the `@vibecook/chopsticks-testing/conformance` export are unchanged.

The `AgentSessionHarness` accepted by that conformance export now includes
`resume()` and `assertNoOrphans()`. Adapter harnesses must exercise their native
resume path and prove that disposal removes their owned processes, transports,
observers, and temporary control resources.

Resume conformance now also requires the resumed handle to expose the prior
assistant reply before a new turn is submitted. Reusing an identifier while
returning a fresh empty session no longer passes. Likewise, `assertNoOrphans()`
must only inspect post-dispose state; destructive fallback cleanup cannot run
before the assertion.
