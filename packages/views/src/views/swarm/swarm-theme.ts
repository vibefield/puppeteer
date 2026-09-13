import type { SwarmPalette } from '../../monitor/palette.js';
import { luminance, resolveCssColor, type Rgba } from './gpu/color.js';
import type { SwarmTheme } from './gpu/swarm-renderer.js';

/**
 * The palette arrives as CSS; the GPU wants numbers. Resolved in `context`'s
 * own cascade so any syntax the tokens use resolves the way the DOM would
 * paint it. Shared by the view and the design lab, so both draw one theme.
 */
export function resolveSwarmTheme(palette: SwarmPalette, context: Element | undefined): SwarmTheme {
  const resolve = (value: string): Rgba => resolveCssColor(value, context);
  const panelBg = resolve(palette.panelBg);
  const light = luminance(panelBg) > 0.5;
  return {
    idle: { bg: resolve(palette.idleBg), text: resolve(palette.idleText) },
    working: {
      bg: resolve(palette.workingBg),
      text: resolve(palette.workingText),
      border: resolve(palette.workingBorder),
    },
    blocked: { bg: resolve(palette.blockedBg), text: resolve(palette.blockedText) },
    grid: resolve(palette.gridLine),
    textMain: resolve(palette.textMain),
    textMuted: resolve(palette.textMuted),
    panelBg,
    orange: resolve(palette.orange),
    green: resolve(palette.green),
    blue: resolve(palette.blue),
    // agent-bubble.css's pre-blurred layers: black on light, white on dark.
    shadow: light ? [0, 0, 0, 0.18] : [1, 1, 1, 0.12],
    shadowPeak: light ? [0, 0, 0, 0.34] : [1, 1, 1, 0.3],
  };
}
