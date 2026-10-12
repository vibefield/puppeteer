import { describe, expect, it } from 'vitest';
import { keyLegend } from './keys.js';

describe('a key’s legend (MV-D8)', () => {
  it('prints each key as the keyboard’s legend, else its character', () => {
    expect(
      ['Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', '-', '=', 'k', 'F5'].map(
        keyLegend,
      ),
    ).toEqual(['⎋', '↵', '↑', '↓', '←', '→', '↖', '↘', '−', '=', 'K', 'F5']);
  });
});
