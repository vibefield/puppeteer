import { describe, expect, it } from 'vitest';
import { AGENT_MONITOR_COLLECTION_LIMITS, boundMonitorCollection } from './bounds.js';

describe('monitor collection bounds', () => {
  it('publishes the ratified hard caps', () => {
    expect(AGENT_MONITOR_COLLECTION_LIMITS).toEqual({
      blockers: 64,
      usageSamples: 256,
      subagents: 256,

      worktrees: 256,
      questions: 64,
      questionOptions: 128,
    });
  });

  it('preserves canonical input order and reports exact omission', () => {
    const subagents = Array.from({ length: 259 }, (_, index) => `child-${index}`);
    const bounded = boundMonitorCollection('subagents', subagents);
    expect(bounded.values).toEqual(subagents.slice(0, 256));
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
