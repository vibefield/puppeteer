import { describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS } from './harness.mjs';
import { inspectHookEventInventory, parseSubagentStatusTiming } from './generate-model.mjs';

// Synthetic fragments with the minified shape of the 2.1.226-2.1.308 status
// scheduler: a one-shot kick first, then the self-rescheduling snapshot timer.
const scheduler = (kick, every, cap, constants) =>
  `${constants};function Xa(h,x){for(let{id:H,tokenCount:Z}of x){let ne=h.get(H);if(ne.push(Z),ne.length>${cap})ne.splice(0,ne.length-${cap})}}` +
  `if(ne===0){Ve();return}let Ge=Ce.setTimeout(Ve,${kick}),et=Ce.setTimeout(function lt(){try{Ve()}finally{et=Ce.setTimeout(lt,${every})}},${every});`;

describe('subagent status-line timing probe', () => {
  it('reads the recurring snapshot interval, not the one-shot kick that comes first', () => {
    expect(parseSubagentStatusTiming(scheduler('y6t', 'tYe', 'J2e', 'var J2e=16;var y6t=300,tYe=5000'))).toEqual({
      sampleLimit: 16,
      intervalMs: 5000,
    });
    expect(parseSubagentStatusTiming(scheduler('tgv', 'OXm', 'kXm', 'var kXm=16,tgv=300,OXm=5e3'))).toEqual({
      sampleLimit: 16,
      intervalMs: 5000,
    });
  });

  it('reports drift instead of guessing when the structure is missing', () => {
    const timing = parseSubagentStatusTiming('var a=300;setTimeout(b,a);');
    expect(Number.isNaN(timing.intervalMs)).toBe(true);
    expect(Number.isNaN(timing.sampleLimit)).toBe(true);
  });
});

describe('hook-event inventory probe', () => {
  const literal = (events) => Buffer.from(`xx;var Pd=${JSON.stringify(events)},Q=1;`);
  const ordered = [
    'PreToolUse',
    'PostToolUse',
    ...CLAUDE_HOOK_EVENTS.filter((event) => !/^P(?:re|ost)ToolUse$/.test(event)),
  ];

  it('accepts an executable whose inventory equals the census list', () => {
    const probe = inspectHookEventInventory(literal(ordered));
    expect(probe.events).toBe(33);
    expect(probe.arrays).toHaveLength(1);
    expect(probe.order).toEqual(ordered);
  });

  it('fails generation when upstream adds or removes an event', () => {
    expect(() => inspectHookEventInventory(literal([...ordered, 'PreThinking']))).toThrow(/added PreThinking/);
    expect(() => inspectHookEventInventory(literal(ordered.filter((event) => event !== 'PostModelSwitch')))).toThrow(
      /missing PostModelSwitch/,
    );
    expect(() => inspectHookEventInventory(Buffer.from('no inventory here'))).toThrow(/no recognizable/);
  });
});
