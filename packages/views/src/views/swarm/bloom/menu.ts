// The spawn bloom's menu, read from the host's tree (`MonitorSpawnMenu`): what
// blooms, what the hub means, and what every bud is called. The prototype's
// "the menu, from the host's tree" and "the words" helpers, in the product's
// field names (label · isDefault · signedIn · word).
//
// The tree's reading is the SDK toolkit's since MV-4: the list's two-step menu
// reads the same tree and a ported view imports only the SDK, so it moved there
// with identical output. The bloom keeps its own bud word for a desktop.

import type { MonitorSpawnDevice } from '@vibecook/puppeteer-view-sdk';

export {
  blooms,
  budSub,
  defaultProfile,
  glyphName,
  hereWord,
  initials,
  menuOf,
  profileWord,
  ready,
  selfDevice,
  type BloomDeviceItem,
  type BloomGlyphName,
  type BloomHub,
  type BloomInstantMenu,
  type BloomMenu,
  type BloomMenuItem,
  type BloomOpenMenu,
  type BloomProfileItem,
} from '@vibecook/puppeteer-view-sdk/toolkit';

/** A desktop's name, as its bud and the words say it. */
export function deviceWord(device: MonitorSpawnDevice): string {
  return (device.label || 'device').toUpperCase();
}
