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
new-pane door. On close, retain a session with local input, agent ownership,
foreground work, a remote origin, or another pane. An untouched fresh shell can
be terminated when its final pane detaches; restored and externally attached
sessions never acquire a fresh-shell receipt. VibeField publishes the accepted
close intent separately from the native floor's asynchronous shutdown ladder,
so a stale inventory cannot restore the closed bubble.

During the source window, both apps resolve Ghosttea from `../ghosttea-0.11.2`.
Run its SDK and native-addon builds and build `ghosttead` in release mode before
building Godview. The app stages the daemon from the same linked checkout.
VibeField's `siblings.lock.json` pins the source revision; release versions are
not hand-bumped for this development window.
