import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_BLOCK_END,
  APPEARANCE_BLOCK_START,
  appearanceBlock,
  patchAppearanceBlock,
  validateAppearanceUpdate,
} from './appearance-config.js';

const update = {
  theme: {
    name: 'Godview Test',
    background: '#101112',
    foreground: '#f0f1f2',
    cursor: '#abcdef',
    cursorText: '#010203',
    selection: '#202122',
    selectionForeground: '#e0e1e2',
    palette: Array.from({ length: 16 }, (_, index) => `#${index.toString(16).padStart(2, '0').repeat(3)}`),
  },
  backgroundOpacity: 0.73,
  backgroundOpacityCells: true,
  shaderEffects: ['ghosttea:crt', 'ghosttea:vhs'],
  shaderAnimation: true,
};

describe('Godview managed terminal appearance', () => {
  it('validates and normalizes the renderer-owned update', () => {
    const result = validateAppearanceUpdate({
      ...update,
      theme: { ...update.theme, background: '#AABBCC' },
      shaderEffects: ['ghosttea:crt', 'ghosttea:crt'],
    });
    expect(result.theme?.background).toBe('#aabbcc');
    expect(result.shaderEffects).toEqual(['ghosttea:crt']);
  });

  it('rejects unknown shaders and config injection through theme names', () => {
    expect(() => validateAppearanceUpdate({ ...update, shaderEffects: ['file:///tmp/shader.glsl'] })).toThrow(
      'unknown effect',
    );
    expect(() =>
      validateAppearanceUpdate({ ...update, theme: { ...update.theme, name: 'bad\nforeground = red' } }),
    ).toThrow('Theme name is invalid');
  });

  it('keeps one managed block last without rewriting surrounding CRLF text', () => {
    const original = 'font-size = 14\r\n\r\n# user tail\r\n';
    const first = patchAppearanceBlock(original, appearanceBlock(update));
    const second = patchAppearanceBlock(first, appearanceBlock({ ...update, backgroundOpacity: 0.5 }));
    expect(second).toContain('font-size = 14\r\n\r\n# user tail\r\n\r\n');
    expect(second).toContain('background-opacity = 0.50\r\n');
    expect(second.split(APPEARANCE_BLOCK_START)).toHaveLength(2);
    expect(second.trimEnd().endsWith(APPEARANCE_BLOCK_END)).toBe(true);
  });
});
