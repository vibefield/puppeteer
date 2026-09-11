export type GodviewTheme = 'light' | 'dark';

export interface GodviewTerminalColorTheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  cursorText: string;
  selection: string;
  selectionForeground: string;
  palette: string[];
}

// These are Ghostty's default ANSI colors. Godview's former viewer-local
// daylight/midnight themes changed the six UI colors while leaving the default
// ANSI palette alone, so keeping it here preserves their out-of-box appearance
// when the palettes become durable Ghostty-compatible settings.
const GHOSTTY_DEFAULT_ANSI_PALETTE = [
  '#1d1f21',
  '#cc6566',
  '#b6bd68',
  '#f0c674',
  '#82a2be',
  '#b294bb',
  '#8abeb7',
  '#c4c8c6',
  '#666666',
  '#d54e53',
  '#b9ca4b',
  '#e7c547',
  '#7aa6da',
  '#c397d8',
  '#70c0b1',
  '#eaeaea',
];

/**
 * The light terminal theme, decided 2026-09-10 (design-system record §07):
 * One Half Light, byte for byte as Ghosttea's theme catalog ships it
 * (mbadolato/iTerm2-Color-Schemes). The deck draws on this ground.
 */
export const ONE_HALF_LIGHT_THEME: GodviewTerminalColorTheme = {
  name: 'One Half Light',
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#a5b4e5',
  cursorText: '#383a42',
  selection: '#bfceff',
  selectionForeground: '#383a42',
  palette: [
    '#383a42',
    '#e45649',
    '#50a14f',
    '#c18401',
    '#0184bc',
    '#a626a4',
    '#0997b3',
    '#bababa',
    '#4f525e',
    '#e06c75',
    '#98c379',
    '#d8b36e',
    '#61afef',
    '#c678dd',
    '#56b6c2',
    '#ffffff',
  ],
};

/**
 * Godview's original light terminal colors. Retired on 2026-09-10 in favour of
 * One Half Light; kept only so a profile file persisted with this exact preset
 * can be recognised and moved to the decided theme (`migrateRetiredAppearanceProfiles`).
 */
export const RETIRED_GHOSTTEA_LIGHT_THEME: GodviewTerminalColorTheme = {
  name: 'Ghosttea Light',
  background: '#ece8dc',
  foreground: '#1e2227',
  cursor: '#1c599e',
  cursorText: '#ece8dc',
  selection: '#2e73b8',
  selectionForeground: '#1e2227',
  palette: [...GHOSTTY_DEFAULT_ANSI_PALETTE],
};

/** Ghostty's own default colors, exposed as a named preset; the dark theme is unchanged. */
export const GHOSTTEA_DARK_THEME: GodviewTerminalColorTheme = {
  name: 'Ghosttea Dark',
  background: '#282c34',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorText: '#282c34',
  selection: '#ffffff',
  selectionForeground: '#282c34',
  palette: [...GHOSTTY_DEFAULT_ANSI_PALETTE],
};

export const GODVIEW_TERMINAL_THEMES: Record<GodviewTheme, GodviewTerminalColorTheme> = {
  light: ONE_HALF_LIGHT_THEME,
  dark: GHOSTTEA_DARK_THEME,
};

/** Put Godview's presets first without duplicating an already-augmented list. */
export function withGodviewTerminalThemes(catalog: readonly GodviewTerminalColorTheme[]): GodviewTerminalColorTheme[] {
  const names = new Set(Object.values(GODVIEW_TERMINAL_THEMES).map((theme) => theme.name));
  return [ONE_HALF_LIGHT_THEME, GHOSTTEA_DARK_THEME, ...catalog.filter((theme) => !names.has(theme.name))];
}
