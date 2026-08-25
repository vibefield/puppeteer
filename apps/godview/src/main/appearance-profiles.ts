import type { RendererConfig } from '@vibecook/ghosttea-protocol';
import { GODVIEW_TERMINAL_THEMES, type GodviewTerminalColorTheme, type GodviewTheme } from '../appearance-themes.js';
import { validateAppearanceTheme, type ManagedAppearanceUpdate } from './appearance-config.js';

export const APPEARANCE_PROFILES_VERSION = 1;

export interface AppearanceProfiles {
  version: typeof APPEARANCE_PROFILES_VERSION;
  light: GodviewTerminalColorTheme;
  dark: GodviewTerminalColorTheme;
}

const BUNDLED_SHADER_IDS = new Set([
  'ghosttea:better-crt',
  'ghosttea:crt',
  'ghosttea:vhs',
  'ghosttea:sparks-from-fire',
]);

function cloneTheme(theme: GodviewTerminalColorTheme): GodviewTerminalColorTheme {
  return { ...theme, palette: [...theme.palette] };
}

export function defaultAppearanceProfiles(): AppearanceProfiles {
  return {
    version: APPEARANCE_PROFILES_VERSION,
    light: cloneTheme(GODVIEW_TERMINAL_THEMES.light),
    dark: cloneTheme(GODVIEW_TERMINAL_THEMES.dark),
  };
}

export function parseAppearanceProfiles(contents: string): AppearanceProfiles {
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== 'object') throw new Error('Appearance profiles must be an object');
  const profiles = value as Record<string, unknown>;
  if (profiles.version !== APPEARANCE_PROFILES_VERSION) {
    throw new Error(`Unsupported appearance profiles version: ${String(profiles.version)}`);
  }
  return {
    version: APPEARANCE_PROFILES_VERSION,
    light: validateAppearanceTheme(profiles.light),
    dark: validateAppearanceTheme(profiles.dark),
  };
}

export function serializeAppearanceProfiles(profiles: AppearanceProfiles): string {
  return `${JSON.stringify(profiles, null, 2)}\n`;
}

export function replaceAppearanceProfile(
  profiles: AppearanceProfiles,
  mode: GodviewTheme,
  theme: GodviewTerminalColorTheme,
): AppearanceProfiles {
  return { ...profiles, [mode]: cloneTheme(theme) };
}

function colorHex(color: readonly number[]): string {
  return `#${color
    .slice(0, 3)
    .map((component) =>
      Math.max(0, Math.min(255, Math.round(component)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function sameAppearanceTheme(left: GodviewTerminalColorTheme, right: GodviewTerminalColorTheme): boolean {
  return (
    left.background === right.background &&
    left.foreground === right.foreground &&
    left.cursor === right.cursor &&
    left.cursorText === right.cursorText &&
    left.selection === right.selection &&
    left.selectionForeground === right.selectionForeground &&
    left.palette.length === right.palette.length &&
    left.palette.every((color, index) => color === right.palette[index])
  );
}

/** Capture a full effective palette so an Advanced edit survives mode switches. */
export function appearanceThemeFromRenderer(
  renderer: RendererConfig,
  mode: GodviewTheme,
  previous: GodviewTerminalColorTheme,
): GodviewTerminalColorTheme | undefined {
  const palette = new Map(
    (renderer.palette ?? [])
      .filter(({ index }) => index >= 0 && index <= 15)
      .map(({ index, color }) => [index, colorHex(color)]),
  );
  if (palette.size !== 16) return undefined;
  const captured: GodviewTerminalColorTheme = {
    name: previous.name,
    background: colorHex(renderer.background),
    foreground: colorHex(renderer.foreground),
    cursor: colorHex(renderer.cursor),
    cursorText: colorHex(renderer.cursorText ?? renderer.background),
    selection: colorHex(renderer.selectionBackground),
    selectionForeground: colorHex(renderer.selectionForeground),
    palette: Array.from({ length: 16 }, (_, index) => palette.get(index)!),
  };
  if (sameAppearanceTheme(captured, previous)) return previous;
  return { ...captured, name: `Custom ${mode === 'light' ? 'Light' : 'Dark'}` };
}

/** Combine one mode's colors with the profile-wide opacity and shader values. */
export function appearanceUpdateForMode(
  renderer: RendererConfig,
  theme: GodviewTerminalColorTheme,
): ManagedAppearanceUpdate {
  const shaderEffects =
    renderer.shaderEffects && renderer.shaderEffects.length > 0
      ? renderer.shaderEffects.filter((effect) => BUNDLED_SHADER_IDS.has(effect))
      : renderer.postProcess === 'better-crt'
        ? ['ghosttea:better-crt']
        : [];
  return {
    theme: cloneTheme(theme),
    backgroundOpacity: renderer.backgroundOpacity ?? 1,
    backgroundOpacityCells: renderer.backgroundOpacityCells ?? false,
    shaderEffects,
    shaderAnimation: renderer.customShaderAnimation ?? false,
  };
}
