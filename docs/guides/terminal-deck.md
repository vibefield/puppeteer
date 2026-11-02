# Shared terminal deck interactions

Godview and VibeField use `@vibefield/puppeteer-views/deck` for pane chrome and
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

`UnusedPaneSessions` tracks delivery responsibility for eligible shells that lose their
last pane. The host supplies eligibility; the helper never grants permission to kill.
`created` registers eligibility, `placed` records a successful replacement before React
publishes it, and `release` discharges responsibility after owner acknowledgement or
observed lifetime use. Detach and failed delivery retain the receipt. A host must not
feed an empty attachment list merely because its view unmounted.

`CompletedAgentPanes` creates one successor for a clean native exit or an accepted
host termination, then compares the old session against current pane attachments.
Placement commits; cleanup uses `exited` for the predecessor and `unused` for an
unplaced successor. Failed cleanup retries independently, never repeating placement
or creation. Failed births remain visible for explicit recovery rather than retrying
a non-idempotent create. Failed native exits keep their diagnostic panes.

VibeField supplies native lifetime input facts, correlated creation IDs, and a durable
conditional-release outbox and owner queue. Native attachment and input checks decide
whether cleanup is allowed. Godview's main process instead owns disposal of detached
plain terminals through its tab attachment ledger; the renderer's closing set is only
a presentation hint. Neither host may treat the shared helper as PTY authority.

Pane Pause and Stop are separate host ports. Pause cancels the current turn while
keeping the process open; Stop ends the process. The host owns their execution policy.

During the source window, both apps resolve Ghosttea from `../ghosttea-0.11.2`.
Run its SDK and native-addon builds and build `ghosttead` in release mode before
building Godview. The app stages the daemon from the same linked checkout.
VibeField's `siblings.lock.json` pins the source revision; release versions are
not hand-bumped for this development window.
