import { describe, expect, it } from 'vitest';
import { observesTurns } from './agent.js';

const WITNESSING = ['structured', 'native-hooks', 'native-log'] as const;
const NOT_WITNESSING = ['workspace-process', 'terminal-only'] as const;

describe('observesTurns', () => {
  it.each(WITNESSING)("reads %s as the agent's own word on its turns", (level) => {
    expect(observesTurns(level)).toBe(true);
  });

  it.each(NOT_WITNESSING)('reads %s as no word on its turns', (level) => {
    expect(observesTurns(level)).toBe(false);
  });
});
