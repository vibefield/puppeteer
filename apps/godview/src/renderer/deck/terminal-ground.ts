import { useEffect, useState } from 'react';
import type { ConfigSnapshot } from '@vibecook/ghosttea-protocol';
import { useGhostteaRuntime } from '@vibecook/ghosttea-react';
import { GODVIEW_TERMINAL_THEMES, type GodviewTheme } from '../../appearance-themes.js';

export interface TerminalGround {
  /** The terminal theme's background, as CSS colour text. */
  background: string;
  /** The terminal theme's foreground: the ink every frame figure is mixed from. */
  foreground: string;
}

function cssColor(color: readonly [number, number, number]): string {
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

/**
 * The deck draws on the terminal theme's own ground (record §07), so the
 * ground is read from the live configuration Ghosttea renders with rather than
 * restated as a token: a theme edited in Settings moves the deck with it. The
 * decided presets answer until the daemon's first snapshot arrives.
 */
export function useTerminalGround(theme: GodviewTheme): TerminalGround {
  const runtime = useGhostteaRuntime();
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | undefined>(() => runtime.configSnapshot);
  useEffect(() => {
    const update = (): void => setSnapshot(runtime.configSnapshot);
    runtime.addEventListener('config-changed', update);
    update();
    return () => runtime.removeEventListener('config-changed', update);
  }, [runtime]);
  const renderer = snapshot?.renderer;
  const preset = GODVIEW_TERMINAL_THEMES[theme];
  return {
    background: renderer ? cssColor(renderer.background) : preset.background,
    foreground: renderer ? cssColor(renderer.foreground) : preset.foreground,
  };
}
