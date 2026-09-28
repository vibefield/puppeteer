# Shared terminal deck interactions

Godview and VibeField use `@vibecook/puppeteer-views/deck` for pane chrome and
fullscreen choreography. Import `styles/deck-frame.css`, give the deck wrapper
`vf-deck-zoom`, and pass `useDeckZoom(...).toggle` to both the frame's zoom verb
and `GhostteaWorkspace.onTogglePaneZoom`. Ghosttea owns configured shortcuts;
the host does not synthesize or intercept them.

The controller animates the pane frame for 240 ms (120 ms with reduced motion)
while pinning the terminal content dimensions. It releases those dimensions
once at settlement, preserves the canvas, and keeps the home grid cell occupied.
Restore reads that live home cell, including after a window resize. Reversal,
pane removal and host disposal release markers, timers and pinned dimensions.
Empty shells and idle agents receive fullscreen whenever the host lends the verb.

`UnusedPaneSessions` is a receipt for fresh shells created through the host's
new-pane door. Seed receipts from the split override and from Ghosttea's
`sessionCreatedHere(id)` for its initial empty-workspace birth. Registration,
listing, restoring and attaching do not create receipts; repeated receipts never
reset evidence that a shell has been used.

Feed committed pane sessions into `update(sessions, isUsed)` on every attachment
change. It returns untouched shells that lost their last pane, including when a
bubble or a new terminal replaces a pane's session without closing the pane.
Input, agent ownership, foreground work and remote origin retain the shell;
another local pane keeps it attached. Use is remembered even if the work later
finishes. Do not feed an empty snapshot on host unmount or visibility changes.

Both hosts hide closing terminals immediately. VibeField publishes pending close
intent while its audited termination RPC runs, restores the bubble on refusal,
and retains accepted intents independently of stale inventory and the native
shutdown ladder. Duplicate requests share a promise; callbacks from a disposed
pool cannot undo a newer pool's intent.

During the source window, both apps resolve Ghosttea from `../ghosttea-0.11.2`.
Run its SDK and native-addon builds and build `ghosttead` in release mode before
building Godview. The app stages the daemon from the same linked checkout.
VibeField's `siblings.lock.json` pins the source revision; release versions are
not hand-bumped for this development window.
