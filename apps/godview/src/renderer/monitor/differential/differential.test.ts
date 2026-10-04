import { describe, expect, it } from 'vitest';
import { classify, compareFrame } from './compare.js';
import { runDifferential, type DifferentialScenario } from './harness.js';
import {
  churnScenario,
  launcherRaceScenario,
  lifecycleScenario,
  projectsScenario,
  promotionScenario,
  terminalsScenario,
} from './scenarios.js';

/**
 * THE MV-2 DIFFERENTIAL GATE. The same runtime monitor states, host records and
 * window facts drive the OLD seam (puppeteer 1afaff7, frozen in this folder)
 * and the NEW path (backend -> replica -> shim); every frame's rows must read
 * the same through `viewReadProjection`, paired by identity. A difference is
 * either fixed or explained by a named cause in `compare.ts`; anything else
 * fails here.
 */

function report(scenario: DifferentialScenario) {
  const frames = runDifferential(scenario);
  const explained = new Map<string, number>();
  const unexplained: string[] = [];
  const membership: string[] = [];
  let rows = 0;
  for (const frame of frames) {
    const comparison = compareFrame(frame);
    rows += frame.next.length;
    for (const key of comparison.onlyOld) membership.push(`+${frame.at - scenario.start}ms only OLD: ${key}`);
    for (const key of comparison.onlyNew) membership.push(`+${frame.at - scenario.start}ms only NEW: ${key}`);
    const verdict = classify(comparison, frame);
    for (const [cause, count] of verdict.explained) explained.set(cause, (explained.get(cause) ?? 0) + count);
    for (const difference of verdict.unexplained) {
      unexplained.push(
        `+${difference.at - scenario.start}ms ${difference.id} ${difference.path}: OLD ${JSON.stringify(difference.old)} NEW ${JSON.stringify(difference.next)}`,
      );
    }
  }
  return { frames: frames.length, rows, explained, unexplained, membership, traffic: frames.traffic };
}

describe('MV-2 differential: the old seam and the backend read the same, frame by frame', () => {
  for (const scenario of [
    lifecycleScenario(),
    launcherRaceScenario(),
    terminalsScenario(),
    promotionScenario(),
    projectsScenario(),
    churnScenario(10, 7),
    churnScenario(20, 11),
    churnScenario(20, 2026),
  ]) {
    it(scenario.name, () => {
      const result = report(scenario);
      console.log(
        `[differential] ${scenario.name}: ${result.frames} frames, ${result.rows} rows compared; explained ${JSON.stringify(Object.fromEntries(result.explained))}`,
      );
      // M19's measurement: the chrome's feed is the old seam's one feed, unchanged; the model's changes are added.
      console.log(`[feeds] ${scenario.name}: ${JSON.stringify(result.traffic)}`);
      expect(result.membership).toEqual([]);
      expect(result.unexplained).toEqual([]);
    });
  }
});
