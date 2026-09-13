import type { MonitorRemoteFacet } from './types.js';

/**
 * How a row may say who can type on a peer's session (ported from VibeField's
 * `monitor/remote-write.ts` — its GT-D7 / GT-D17 rulings and its review's 2b).
 *
 * What a mesh advertises is one boolean PER HOST, and the per-viewer answer
 * is decided at ATTACH, against the capability the viewer presents. So the
 * only honest pre-attach sentence is a sentence about the host — and it is
 * said in BOTH directions on purpose: marking only a refusing host made
 * silence mean "you can type", which is the claim a row cannot make. The
 * per-viewer truth arrives one click later, from the attach itself.
 */
export function remoteWriteLabel(remote: Pick<MonitorRemoteFacet, 'hostWritable'>): string {
  return remote.hostWritable ? 'writable host' : 'read-only host';
}

/** The same fact at length, for a hover that has room for it. */
export function remoteWriteTitle(remote: Pick<MonitorRemoteFacet, 'hostWritable'>): string {
  return remote.hostWritable
    ? 'this host allows writes — whether yours arrive is decided when you attach'
    : 'this host shares read-only — no viewer may type here';
}
