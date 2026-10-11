/**
 * `@vibecook/puppeteer-view-sdk/testing`: what a view's tests (and a host's)
 * may use (L16). Never imported by a view's own code.
 *
 * - Fixtures: deterministic agents, models, themes, stages and inputs; the
 *   record's past (`fixtureHistory`) as a host lends it.
 * - `createFixtureReplica`: a hand-driven replica keeping the identity rules,
 *   its spawn menu included; given the slot's scheduler it batches like the real one.
 * - `checkConformance` / `runConformance`: the suite every view passes (MV-W4).
 * - Instruments: `countCommits` (React commits, through a Profiler),
 *   `countReactEffects` (effect runs and cleanups), `createFrameDriver`
 *   (animation frames by hand, counted), `countingCommands`.
 * - Goldens: `createFixtureClock` for a clock that moves only when told, and
 *   the frame driver stepping it.
 * - `createRecordingView`: a view that records what a host did to it.
 */

export { createFixtureClock, type FixtureClock } from './clock.js';
export {
  checkConformance,
  CONFORMANCE_CHECKS,
  formatConformanceFailures,
  runConformance,
  type ConformanceCheckId,
  type ConformanceFailure,
  type ConformanceOptions,
  type ConformanceReport,
} from './conformance.js';
export {
  countCommits,
  countingCommands,
  countReactEffects,
  type CommitCounter,
  type CountingCommands,
  type CountingCommandsOptions,
  type EffectCounter,
} from './counters.js';
export {
  agentViewFixture,
  agentViewsFixture,
  FIXTURE_EPOCH,
  FIXTURE_STAGES,
  fixtureColour,
  fixtureHistory,
  fixtureInput,
  fixtureModel,
  fixturePalette,
  fixtureSpawnMenu,
  fixtureStage,
  fixtureTheme,
  NO_CAPABILITIES,
  parameterDefaults,
  toAgentView,
  type AgentViewFixturePartial,
  type AgentViewsFixtureOptions,
  type FixtureInputPartial,
  type FixtureScheme,
  type FixtureStageSize,
  type HistoryFixtureOptions,
} from './fixtures.js';
export { createFrameDriver, type FrameDriver, type FrameDriverOptions } from './frames.js';
export { deepFreeze } from './freeze.js';
export { createRecordingView, type RecordingView, type RecordingViewOptions } from './recording-view.js';
export {
  createFixtureReplica,
  type FixtureReplica,
  type FixtureReplicaOptions,
  type FixtureReplicaSnapshot,
  type FixtureReplicaSource,
  type FixtureRow,
} from './replica.js';
