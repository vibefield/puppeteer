import { describe, expect, it } from 'vitest';
import { dealPaneColours, EMPTY_PANE_COLOUR_LEDGER, paneColours } from './pane-colours.js';
import { DEFAULT_PROJECT_TINT, paneTint, projectTint } from './project-tint.js';

describe('pane colours', () => {
  it('deals panes in the order they open and never deals a number twice', () => {
    let ledger = dealPaneColours(EMPTY_PANE_COLOUR_LEDGER, ['a', 'b']);
    expect([...ledger.seqById]).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
    const same = dealPaneColours(ledger, ['a', 'b']);
    expect(same).toBe(ledger);
    ledger = dealPaneColours(ledger, ['b', 'c']);
    expect([...ledger.seqById]).toEqual([
      ['b', 1],
      ['c', 2],
    ]);
    // A reopened pane id is a new pane: the closed pane's number stays retired.
    ledger = dealPaneColours(ledger, ['b', 'c', 'a']);
    expect(ledger.seqById.get('a')).toBe(3);
  });

  it('colours every dealt pane from the pane wheel, apart from the project wheel', () => {
    const ledger = dealPaneColours(EMPTY_PANE_COLOUR_LEDGER, ['a', 'b']);
    const colours = paneColours(ledger, DEFAULT_PROJECT_TINT.light);
    expect(colours.get('a')).toBe(paneTint(0, DEFAULT_PROJECT_TINT.light));
    expect(colours.get('b')).toBe(paneTint(1, DEFAULT_PROJECT_TINT.light));
    expect(colours.get('a')).not.toBe(projectTint(0, DEFAULT_PROJECT_TINT.light));
  });
});
