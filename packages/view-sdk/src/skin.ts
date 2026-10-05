/**
 * The skin (L18): the instrument skin's shared vocabulary, the only custom
 * properties a view's stylesheet may read besides its own.
 *
 * Every host defines these on its stage (Godview's and VibeField's instrument
 * skins, under their theme classes), so a view's CSS reads them and nothing
 * else of the host's. Anything else a view's CSS needs it sets itself from its
 * input, as properties prefixed `--mv-<view id>-`: a row's colour, the row
 * height, the stage's insets, a palette colour.
 *
 * The list is finite on purpose: an isolated realm later copies exactly these
 * across. Adding a name is a contract change (L2). These are the names list and
 * rain read (MV-4); a later view that needs another asks.
 */
export const MONITOR_SKIN = Object.freeze([
  '--text-main',
  '--text-muted',
  '--text-faint',
  '--panel-bg',
  '--panel-border',
  '--control-hover-bg',
  '--control-hover-border',
  '--idle-bg',
  // M59.4 (with M57): the monitor's ground and the named easings, shared design tokens a view reads and never copies.
  '--monitor-bg',
  '--vf-ease-pop',
  '--vf-ease-lift',
  '--vf-ease-island',
] as const);

export type MonitorSkinName = (typeof MONITOR_SKIN)[number];
