import { describe, expect, it } from 'vitest';
import type { RendererConfig } from '@vibecook/ghosttea-protocol';
import { GHOSTTEA_DARK_THEME, GHOSTTEA_LIGHT_THEME } from '../appearance-themes.js';
import {
  appearanceThemeFromRenderer,
  appearanceUpdateForMode,
  defaultAppearanceProfiles,
  parseAppearanceProfiles,
  replaceAppearanceProfile,
  serializeAppearanceProfiles,
} from './appearance-profiles.js';

function rendererFor(theme = GHOSTTEA_DARK_THEME): RendererConfig {
  const bytes = (color: string): [number, number, number] =>
    [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number];
  return {
    background: bytes(theme.background),
    foreground: bytes(theme.foreground),
    cursor: bytes(theme.cursor),
    cursorText: bytes(theme.cursorText),
    selectionBackground: bytes(theme.selection),
    selectionForeground: bytes(theme.selectionForeground),
    palette: theme.palette.map((color, index) => ({ index, color: bytes(color) })),
    backgroundOpacity: 0.64,
    backgroundOpacityCells: true,
    fontFamilies: [],
    fontSize: 13,
    paddingX: [0, 0],
    paddingY: [0, 0],
    postProcess: 'none',
    shaderEffects: ['ghosttea:crt'],
    customShaderPaths: [],
    customShaderAnimation: true,
  } satisfies RendererConfig;
}

describe('mode-specific appearance profiles', () => {
  it('starts with separate legacy light and dark selections', () => {
    const profiles = defaultAppearanceProfiles();
    expect(profiles.light.name).toBe('Ghosttea Light');
    expect(profiles.dark.name).toBe('Ghosttea Dark');
    expect(profiles.light.background).not.toBe(profiles.dark.background);
  });

  it('round-trips validated profile files', () => {
    const profiles = replaceAppearanceProfile(defaultAppearanceProfiles(), 'dark', {
      ...GHOSTTEA_DARK_THEME,
      name: 'Dark Choice',
    });
    expect(parseAppearanceProfiles(serializeAppearanceProfiles(profiles))).toEqual(profiles);
    expect(() => parseAppearanceProfiles('{"version":2}')).toThrow('Unsupported');
  });

  it('combines mode colors with profile-wide opacity and shaders', () => {
    expect(appearanceUpdateForMode(rendererFor(), GHOSTTEA_LIGHT_THEME)).toMatchObject({
      theme: { name: 'Ghosttea Light' },
      backgroundOpacity: 0.64,
      backgroundOpacityCells: true,
      shaderEffects: ['ghosttea:crt'],
      shaderAnimation: true,
    });
  });

  it('retains a named selection until Advanced changes one of its colors', () => {
    const renderer = rendererFor();
    expect(appearanceThemeFromRenderer(renderer, 'dark', GHOSTTEA_DARK_THEME)?.name).toBe('Ghosttea Dark');
    expect(
      appearanceThemeFromRenderer({ ...renderer, background: [1, 2, 3] }, 'dark', GHOSTTEA_DARK_THEME),
    ).toMatchObject({ name: 'Custom Dark', background: '#010203' });
  });

  it('does not invent a restorable profile from a sparse ANSI palette', () => {
    expect(
      appearanceThemeFromRenderer({ ...rendererFor(), palette: [] }, 'light', GHOSTTEA_LIGHT_THEME),
    ).toBeUndefined();
  });
});
