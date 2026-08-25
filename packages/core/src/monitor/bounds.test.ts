import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_COLLECTION_LIMITS, boundMonitorCollection } from './bounds.js';

describe('monitor collection bounds', () => {
  it('publishes the ratified hard caps', () => {
    expect(AGENT_MONITOR_COLLECTION_LIMITS).toEqual({
      blockers: 64,
      usageSamples: 256,
      planSteps: 256,
      tasks: 512,
      subagents: 256,
      teammates: 256,
      workflows: 128,
      artifactRefs: 32,
      workflowActorRunKeys: 256,
      worktrees: 256,
      questions: 64,
      questionOptions: 128,
    });
  });

  it('preserves canonical input order and reports exact omission', () => {
    const tasks = Array.from({ length: 515 }, (_, index) => `task-${index}`);
    const bounded = boundMonitorCollection('tasks', tasks);
    expect(bounded.values).toEqual(tasks.slice(0, 512));
    expect(bounded.omitted).toBe(3);
  });

  it('copies an in-bound collection so consumers cannot mutate accumulator input', () => {
    const source = ['a', 'b'];
    const bounded = boundMonitorCollection('blockers', source);
    bounded.values.push('c');
    expect(source).toEqual(['a', 'b']);
    expect(bounded.omitted).toBe(0);
  });
});
