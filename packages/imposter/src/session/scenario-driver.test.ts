/**
 * The scenario driver is only worth showing an operator if the picture and the
 * behaviour cannot disagree, so the last test here walks every state and every
 * op and holds the two against each other. Everything above it is the shape of
 * a real turn, taken from the personas that ship.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPersona, personaDirectory } from '../persona/load.ts';
import { OP_NAMES } from '../persona/types.ts';
import { createImposterSession, type BehaviorDocument } from './session.ts';
import {
  createScenarioDriver,
  describeScenarioDriver,
  type ScenarioDriverSnapshot,
  type ScenarioDriverStateId,
} from './scenario-driver.ts';

const run = (ops: readonly string[]): ReturnType<typeof createScenarioDriver> => {
  const driver = createScenarioDriver();
  for (const op of ops) driver.send(op);
  return driver;
};

describe('the portable op scenario driver', () => {
  it('walks a claude turn from boot to ready with nothing off-model', () => {
    // personas/claude/persona.json boot + behavior/happy-turn.json ops.
    const driver = run([
      'session.start',
      'session.ready',
      'usage.refresh',
      'turn.start',
      'assistant.delta',
      'turn.end',
    ]);
    expect(driver.snapshot().state).toBe('ready');
    expect(driver.snapshot().offModel).toBe(0);
    expect(driver.snapshot().applied).toBe(6);
  });

  it('keeps protocol initialization distinct from session creation', () => {
    const driver = run(['session.initialize', 'session.start', 'session.ready']);
    expect(driver.snapshot()).toMatchObject({ state: 'ready', offModel: 0, applied: 3 });
  });

  it('reaches ready for a vendor that never announces readiness', () => {
    // Codex binds no `session.ready`; its reducer reaches ready on the first
    // completed turn, and the driver has to agree or every codex turn reads
    // as off-model.
    const driver = run(['session.start', 'turn.start', 'assistant.delta', 'turn.end']);
    expect(driver.snapshot().state).toBe('ready');
    expect(driver.snapshot().offModel).toBe(0);
  });

  it('suspends on an approval in both orders the personas actually use', () => {
    // claude: ask, then run the tool.
    const claude = run(['session.start', 'session.ready', 'turn.start', 'permission.ask']);
    expect(claude.snapshot().state).toBe('turn.approval');
    expect(claude.send('tool.start').snapshot.state).toBe('turn.tool');

    // codex: start the tool, then ask about it.
    const codex = run(['session.start', 'turn.start', 'tool.start', 'permission.ask']);
    expect(codex.snapshot().state).toBe('turn.approval');
    expect(codex.send('tool.end').snapshot.state).toBe('turn.thinking');
  });

  it('reports an out-of-order op without refusing it', () => {
    const driver = run(['session.start', 'session.ready']);
    const { handled, snapshot } = driver.send('tool.end');
    expect(handled).toBe(false);
    // Still counted, still applied, state untouched: adversarial scenarios
    // exist to send exactly this, so the driver reports rather than gates.
    expect(snapshot.state).toBe('ready');
    expect(snapshot.offModel).toBe(1);
    expect(snapshot.applied).toBe(3);
  });

  it('treats everything after session.end as off-model', () => {
    // What `late-after-exit` scripts.
    const driver = run(['session.start', 'session.ready', 'session.end']);
    expect(driver.snapshot().state).toBe('ended');
    expect(driver.send('turn.start').handled).toBe(false);
    expect(driver.snapshot().state).toBe('ended');
  });

  it('offers the ops the current state handles', () => {
    const driver = run(['session.start', 'session.ready']);
    // `usage.refresh` and `session.end` are handled at the root, so they are
    // enabled everywhere — that is what makes them globals in the picture.
    expect(driver.snapshot().enabled).toEqual(['session.end', 'turn.start', 'usage.refresh']);
    expect(run(['session.start']).snapshot().enabled).toContain('session.ready');
  });

  it('notifies subscribers on every op', () => {
    const driver = createScenarioDriver();
    const seen: string[] = [];
    const off = driver.subscribe((snapshot) => seen.push(snapshot.state));
    driver.send('session.start');
    driver.send('session.ready');
    off();
    driver.send('turn.start');
    expect(seen).toEqual(['booting', 'ready']);
  });
});

describe('the scenario driver inside a session', () => {
  const persona = loadPersona('claude');
  const behavior = JSON.parse(
    readFileSync(join(personaDirectory('claude'), 'behavior', 'happy-turn.json'), 'utf8'),
  ) as BehaviorDocument;
  const session = (onScenarioDriver?: (snapshot: ScenarioDriverSnapshot) => void) =>
    createImposterSession({
      persona,
      argv: [],
      env: {},
      cwd: process.cwd(),
      behavior,
      ...(onScenarioDriver ? { onScenarioDriver } : {}),
    });

  it('advances whether or not anyone is watching', async () => {
    // Scenario intent is a property of the session, not of having a subscriber.
    // Folded into an optional callback around `driver.send(op)` it was the
    // latter, because an optional call does not evaluate its arguments — so a
    // session with no callback booted straight to `starting`, forever.
    const unwatched = session();
    await unwatched.boot();
    expect(unwatched.scenarioDriver.state).toBe('ready');
    expect(unwatched.scenarioDriver.applied).toBe(3);

    const seen: string[] = [];
    const watched = session((snapshot) => seen.push(snapshot.state));
    await watched.boot();
    expect(watched.scenarioDriver.state).toBe('ready');
    // Both halves agree: the same three ops, reported and recorded.
    expect(seen).toEqual(['booting', 'ready', 'ready']);
  });

  it('reports a turn through the getter the control channel reads', async () => {
    const live = session();
    await live.boot();
    await live.turn('do a thing');
    expect(live.scenarioDriver.state).toBe('ready');
    expect(live.scenarioDriver.offModel).toBe(0);
  });
});

describe('the scenario-driver description', () => {
  const description = describeScenarioDriver();
  const states = description.nodes.map((node) => node.id);

  /** Shortest op sequence into a state, walked over the described edges. */
  function pathTo(target: ScenarioDriverStateId): string[] {
    const queue: Array<{ state: ScenarioDriverStateId; ops: string[] }> = [{ state: 'starting', ops: [] }];
    const seen = new Set<ScenarioDriverStateId>(['starting']);
    while (queue.length > 0) {
      const { state, ops } = queue.shift()!;
      if (state === target) return ops;
      for (const edge of description.edges) {
        if (edge.from !== state || seen.has(edge.to)) continue;
        seen.add(edge.to);
        queue.push({ state: edge.to, ops: [...ops, edge.op] });
      }
    }
    const global = description.globals.find((entry) => entry.to === target);
    if (global) return [global.op];
    throw new Error(`no described path reaches ${target}`);
  }

  it('describes a node for every state and no state twice', () => {
    expect(new Set(states).size).toBe(states.length);
    expect(states).toContain('starting');
    expect(states).toContain('ended');
  });

  it('places grouped nodes inside a declared group', () => {
    const groups = new Set(description.groups.map((group) => group.id));
    for (const node of description.nodes) {
      if (node.group) expect(groups.has(node.group), `${node.id} is in an undeclared group`).toBe(true);
    }
    expect(description.nodes.filter((node) => node.group === 'turn')).toHaveLength(3);
  });

  it('matches the driver edge for edge, in both directions', () => {
    // The picture is the operator's model of the imposter. If it can drift from
    // the driver, it is worse than no picture at all — so every described edge
    // must be a real transition, and every real transition must be described.
    const described = new Set(description.edges.map((edge) => `${edge.from} -${edge.op}-> ${edge.to}`));
    const globals = new Map(description.globals.map((entry) => [entry.op, entry.to]));
    const actual = new Set<string>();

    for (const state of states) {
      for (const op of OP_NAMES) {
        const driver = run(pathTo(state));
        expect(driver.snapshot().state, `pathTo(${state}) did not arrive`).toBe(state);
        const { handled, snapshot } = driver.send(op);
        if (!handled) continue;
        if (globals.has(op)) {
          // A global either lands where it says or changes nothing at all.
          expect(snapshot.state).toBe(globals.get(op) ?? state);
          continue;
        }
        actual.add(`${state} -${op}-> ${snapshot.state}`);
      }
    }

    expect([...actual].sort()).toEqual([...described].sort());
  });

  it('gives every op a place in the picture', () => {
    const drawn = new Set([...description.edges.map((edge) => edge.op), ...description.globals.map((g) => g.op)]);
    expect([...OP_NAMES].filter((op) => !drawn.has(op))).toEqual([]);
  });
});
