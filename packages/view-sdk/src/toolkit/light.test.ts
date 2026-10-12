import { describe, expect, it } from 'vitest';
import { fixturePalette } from '../testing/fixtures.js';
import {
  DEFAULT_STATE_LIGHT,
  isLightTheme,
  luminance,
  parseCssColor,
  readableColour,
  resolveCssColor,
  rgbaCss,
  stateGlow,
  stateGround,
  vividColour,
  withAlpha,
  type Rgba,
} from './light.js';

describe('parseCssColor', () => {
  it('reads the hex forms the tokens use', () => {
    expect(parseCssColor('#ff9f0a')).toEqual([1, 159 / 255, 10 / 255, 1]);
    expect(parseCssColor('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseCssColor('#00000080')).toEqual([0, 0, 0, 128 / 255]);
    expect(parseCssColor('#12345')).toBeUndefined();
  });

  it('reads rgb() and rgba() with commas or slashes', () => {
    expect(parseCssColor('rgba(0, 0, 0, 0.022)')).toEqual([0, 0, 0, 0.022]);
    expect(parseCssColor('rgb(255 255 255 / 40%)')).toEqual([1, 1, 1, 0.4]);
    expect(parseCssColor('rgb(28 28 30 / 85%)')).toEqual([28 / 255, 28 / 255, 30 / 255, 0.85]);
  });

  it('reads the engine’s color(srgb) form and transparent', () => {
    expect(parseCssColor('color(srgb 1 0.5 0 / 0.5)')).toEqual([1, 0.5, 0, 0.5]);
    expect(parseCssColor('transparent')).toEqual([0, 0, 0, 0]);
  });

  it('leaves what only the engine can resolve undefined', () => {
    expect(parseCssColor('var(--vf-orange)')).toBeUndefined();
    expect(parseCssColor('color-mix(in srgb, red 50%, transparent)')).toBeUndefined();
  });
});

describe('resolveCssColor', () => {
  it('falls back to transparent with nothing to resolve against', () => {
    expect(resolveCssColor('color-mix(in srgb, red 50%, transparent)', undefined)).toEqual([0, 0, 0, 0]);
    expect(resolveCssColor('#30d158', undefined)).toEqual([48 / 255, 209 / 255, 88 / 255, 1]);
  });
});

describe('helpers', () => {
  it('scales alpha, tells a light ground from a dark one, and writes a 2D context’s rgba()', () => {
    expect(withAlpha([1, 1, 1, 0.5], 0.5)).toEqual([1, 1, 1, 0.25]);
    expect(luminance([1, 1, 1, 1])).toBeCloseTo(1, 6);
    expect(luminance([0.067, 0.067, 0.067, 1])).toBeLessThan(0.5);
    expect(isLightTheme([0.067, 0.067, 0.067, 1])).toBe(true);
    expect(isLightTheme([0.96, 0.96, 0.96, 1])).toBe(false);
    expect(rgbaCss([1, 0.5, 0, 0.5])).toBe('rgba(255, 128, 0, 0.5)');
    expect(rgbaCss([1, 0.5, 0, 0.5], 0.33333)).toBe('rgba(255, 128, 0, 0.1667)');
    expect(rgbaCss([1.2, -0.1, 0, 1])).toBe('rgba(255, 0, 0, 1)');
  });
});

describe('the state light (the swarm’s rules, which the timeline lights by)', () => {
  it('is tuned at the swarm’s defaults', () => {
    expect(DEFAULT_STATE_LIGHT).toEqual({ chroma: 1.22, glowLift: 0.55, groundLight: 0.45, groundDark: 0.5 });
  });

  it('takes a colour to its light by chroma, holding the brightest channel', () => {
    const vivid = vividColour([1, 0.6, 0.2, 1], 1.5);
    [1, 0.4, 0, 1].forEach((channel, index) => expect(vivid[index]).toBeCloseTo(channel, 12));
    expect(vividColour([0.5, 0.5, 0.5, 0.4])).toEqual([0.5, 0.5, 0.5, 0.4]);
  });

  it('lifts the light toward white only on a dark theme, and scales the ground toward the theme’s paper', () => {
    const hue: Rgba = [0.8, 0.4, 0, 1];
    expect(stateGlow(hue, true)).toBe(hue);
    expect(stateGlow(hue, false, { glowLift: 0.5 })).toEqual([0.9, 0.7, 0.5, 1]);
    expect(stateGround(hue, true, { groundLight: 0.5, groundDark: 0.5 })).toEqual([0.9, 0.7, 0.5, 1]);
    expect(stateGround(hue, false, { groundLight: 0.5, groundDark: 0.5 })).toEqual([0.4, 0.2, 0, 1]);
    expect(readableColour(hue, [0, 0, 0, 1], false)).toBe(hue);
    expect(readableColour(hue, [0, 0, 0, 1], true)).toEqual([0.8 * 0.55, 0.4 * 0.55, 0, 1]);
  });

  it('lights the palette’s orange and blue exactly as the swarm and the timeline drew them (pinned at MV-8)', () => {
    // The numbers both views drew at 8bf0276, read from the swarm's and the timeline's own copies before the fold.
    const pinned = {
      light: {
        orangeInk: [0.5480392156862746, 0.2396078431372549, 0.08058823529411764, 1],
        blueInk: [0.1080392156862745, 0.3194117647058824, 0.5162745098039216, 1],
        orangeGround: [0.9503921568627451, 0.5741058823529412, 0.45, 1],
        blueGround: [0.45, 0.6800078431372549, 0.9115686274509804, 1],
      },
      dark: {
        orangeInk: [0.9921568627450981, 0.49411764705882355, 0.0784313725490196, 1],
        blueInk: [0.30196078431372547, 0.6705882352941176, 0.9686274509803922, 1],
        orangeGround: [0.49607843137254903, 0.19227450980392158, 0, 1],
        blueGround: [0.0776470588235294, 0.30250980392156857, 0.4843137254901961, 1],
      },
    } as const;
    for (const scheme of ['light', 'dark'] as const) {
      const { swarm } = fixturePalette(scheme);
      const ink = resolveCssColor(swarm.ink, undefined);
      const light = isLightTheme(ink);
      expect(light).toBe(scheme === 'light');
      const orange = resolveCssColor(swarm.orange, undefined);
      const blue = resolveCssColor(swarm.blue, undefined);
      expect({
        orangeInk: readableColour(orange, ink, light),
        blueInk: readableColour(blue, ink, light),
        orangeGround: stateGround(vividColour(orange), light),
        blueGround: stateGround(vividColour(blue), light),
      }).toEqual(pinned[scheme]);
    }
  });
});
