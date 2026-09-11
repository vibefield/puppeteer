import { describe, expect, it } from 'vitest';
import type { RendererConfig } from '@vibecook/ghosttea-protocol';
import {
  APPEARANCE_BLOCK_END,
  APPEARANCE_BLOCK_START,
  appearanceBlock,
  appearanceUpdateMismatches,
  patchAppearanceBlock,
  unappliedAppearanceKeys,
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

  it('does not read a key the daemon has not applied yet as shadowed by another layer', () => {
    const bytes = (color: string): [number, number, number] =>
      [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number];
    // The 0.7.0 ghosttead prebuild parsed palette and cursor-text without
    // applying them, so its projection carried the defaults whatever the block
    // asked for; the guard stays for any daemon that reports such keys.
    const renderer: RendererConfig = {
      background: bytes(update.theme.background),
      foreground: bytes(update.theme.foreground),
      cursor: bytes(update.theme.cursor),
      selectionBackground: bytes(update.theme.selection),
      selectionForeground: bytes(update.theme.selectionForeground),
      palette: [],
      backgroundOpacity: 0.73,
      backgroundOpacityCells: true,
      fontFamilies: [],
      fontSize: 13,
      paddingX: [2, 2],
      paddingY: [2, 2],
      postProcess: 'none',
      shaderEffects: ['ghosttea:crt', 'ghosttea:vhs'],
      customShaderAnimation: true,
      customShaderPaths: [],
    };
    expect(appearanceUpdateMismatches(renderer, update)).toEqual([
      'cursor-text',
      ...Array.from({ length: 16 }, (_, index) => `palette ${index}`),
    ]);
    const unapplied = unappliedAppearanceKeys([
      { severity: 'info', code: 'recognized-not-applied', message: '', key: 'cursor-text' },
      { severity: 'info', code: 'recognized-not-applied', message: '', key: 'palette' },
      { severity: 'error', code: 'unknown-key', message: '', key: 'palette' },
    ]);
    expect([...unapplied]).toEqual(['cursor-text', 'palette']);
    expect(appearanceUpdateMismatches(renderer, update, unapplied)).toEqual([]);
    expect(appearanceUpdateMismatches({ ...renderer, background: [0, 0, 0] }, update, unapplied)).toEqual([
      'background',
    ]);
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
