import { describe, expect, it } from 'vitest';
import { GHOSTTEA_DARK_THEME, GHOSTTEA_LIGHT_THEME, withGodviewTerminalThemes } from './appearance-themes.js';

describe('Godview terminal themes', () => {
  it('retains the legacy light and dark terminal colors as named presets', () => {
    expect(GHOSTTEA_LIGHT_THEME).toMatchObject({
      name: 'Ghosttea Light',
      background: '#ece8dc',
      foreground: '#1e2227',
    });
    expect(GHOSTTEA_DARK_THEME).toMatchObject({
      name: 'Ghosttea Dark',
      background: '#282c34',
      foreground: '#ffffff',
    });
    expect(GHOSTTEA_LIGHT_THEME.palette).toHaveLength(16);
    expect(GHOSTTEA_DARK_THEME.palette).toHaveLength(16);
  });

  it('places each Godview preset once at the front of the settings catalog', () => {
    const result = withGodviewTerminalThemes([
      GHOSTTEA_DARK_THEME,
      { ...GHOSTTEA_LIGHT_THEME, name: 'Other' },
      GHOSTTEA_LIGHT_THEME,
    ]);
    expect(result.slice(0, 2).map((theme) => theme.name)).toEqual(['Ghosttea Light', 'Ghosttea Dark']);
    expect(result.filter((theme) => theme.name === 'Ghosttea Light')).toHaveLength(1);
    expect(result.filter((theme) => theme.name === 'Ghosttea Dark')).toHaveLength(1);
  });
});
