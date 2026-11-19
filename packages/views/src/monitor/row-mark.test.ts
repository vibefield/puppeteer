import { describe, expect, it } from 'vitest';
import { agentViewFixture } from '@vibefield/puppeteer-view-sdk/testing';
import { rowName, rowSpoken } from './row-mark.js';

describe("a row's name under the host's mark", () => {
  it("prints the mark's name in the project's place and says its spoken words, each falling back", () => {
    const plain = agentViewFixture({ id: 'a', project: { name: 'vibe-field', seq: 1 } });
    expect([rowName(plain), rowSpoken(plain)]).toEqual(['vibe-field', 'vibe-field']);
    const named = { ...plain, mark: { name: 'Ada' } };
    expect([rowName(named), rowSpoken(named)]).toEqual(['Ada', 'Ada']);
    const spoken = { ...plain, mark: { name: 'Ada', spoken: 'Ada, a helper' } };
    expect([rowName(spoken), rowSpoken(spoken)]).toEqual(['Ada', 'Ada, a helper']);
    // an empty name is no name: the project's stands
    expect(rowName({ ...plain, mark: { name: '' } })).toBe('vibe-field');
  });
});
