/**
 * The skin (L18): the instrument skin's shared vocabulary, the only custom
 * properties a view's stylesheet may read besides its own.
 *
 * The skin carries the shared design tokens a view draws with — colours and
 * the named easings — that every host defines on its stage (Godview's and
 * VibeField's instrument skins: the colours under their theme classes, the
 * easings once for every theme), so a view's CSS reads them and nothing else
 * of the host's. A design value stays a token, never a copied literal (M57).
 * Anything else a view's CSS needs it sets itself from its input, as
 * properties prefixed `--mv-<view id>-`: a row's colour, the row height, the
 * stage's insets, a palette colour.
 *
 * The list is finite on purpose: an isolated realm later copies exactly these
 * across. Adding a name is a contract change (L2). These are the names list and
 * rain read (MV-4), and the island easing the timeline's owed ring moves on
 * (MV-6, M57); a later view that needs another asks.
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
  '--vf-ease-island',
] as const);

export type MonitorSkinName = (typeof MONITOR_SKIN)[number];
