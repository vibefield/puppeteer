import { describe, expect, it } from 'vitest';
import {
  GHOSTTEA_DARK_THEME,
  GODVIEW_TERMINAL_THEMES,
  ONE_HALF_LIGHT_THEME,
  RETIRED_GHOSTTEA_LIGHT_THEME,
  withGodviewTerminalThemes,
} from './appearance-themes.js';

describe('Godview terminal themes', () => {
  it('draws light on One Half Light and dark on the Ghostty default', () => {
    expect(GODVIEW_TERMINAL_THEMES.light).toBe(ONE_HALF_LIGHT_THEME);
    expect(ONE_HALF_LIGHT_THEME).toMatchObject({
      name: 'One Half Light',
      background: '#fafafa',
      foreground: '#383a42',
    });
    expect(GHOSTTEA_DARK_THEME).toMatchObject({
      name: 'Ghosttea Dark',
      background: '#282c34',
      foreground: '#ffffff',
    });
    expect(ONE_HALF_LIGHT_THEME.palette).toHaveLength(16);
    expect(GHOSTTEA_DARK_THEME.palette).toHaveLength(16);
  });

  it('keeps the retired light preset only as something to recognise, never to offer', () => {
    expect(RETIRED_GHOSTTEA_LIGHT_THEME.background).toBe('#ece8dc');
    const result = withGodviewTerminalThemes([RETIRED_GHOSTTEA_LIGHT_THEME]);
    expect(result.map((theme) => theme.name)).toEqual(['One Half Light', 'Ghosttea Dark', 'Ghosttea Light']);
  });

  it('places each Godview preset once at the front of the settings catalog', () => {
    const result = withGodviewTerminalThemes([
      GHOSTTEA_DARK_THEME,
      { ...ONE_HALF_LIGHT_THEME, name: 'Other' },
      ONE_HALF_LIGHT_THEME,
    ]);
    expect(result.slice(0, 2).map((theme) => theme.name)).toEqual(['One Half Light', 'Ghosttea Dark']);
    expect(result.filter((theme) => theme.name === 'One Half Light')).toHaveLength(1);
    expect(result.filter((theme) => theme.name === 'Ghosttea Dark')).toHaveLength(1);
  });
});
