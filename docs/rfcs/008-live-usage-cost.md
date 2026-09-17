# Live usage and estimated USD cost

Status: implemented

Puppeteer's usage ledger is independent of Rosetta and conversation transcripts.
Only live provider telemetry, usage protocol notifications, and explicit usage
hooks may contribute. Bootstrap, transcript, history, and resync observations
cannot add, replace, or retract usage. Corrections retain the original usage
identity and time. Context occupancy remains a separate metric.

The primary display is **estimated API-equivalent USD**, not the user's invoice
or subscription charge. Claude supplies a request-level estimate through its
local OTLP stream. Codex supplies native cumulative token counters; the adapter
prices only observed counter deltas, retaining the model for that interval.
For an attached/resumed thread, the first counter is a baseline. A proven new
thread starts from zero, so its first request is included. Resets, missing
buckets, unknown models, and ambiguous model transitions leave explicit gaps.
Every observed model or tier transition invalidates the interval, including a
switch away and back before the next counter.
Input includes cached input in Codex, and output includes reasoning: neither
subset may be charged twice.

Pricing uses a pinned, hashed subset of the MIT-licensed models.dev catalog and
a small local TypeScript calculator. There is no network lookup on the usage
path. Catalog estimates record their version; native estimates record their
provider source. The reference catalog uses standard API rates when the service
tier is unspecified. A known non-standard tier is left unpriced. The catalog is data,
not billing authority: unsupported service tiers or context pricing remain
unpriced. Native provider estimates take precedence over catalog calculation.
LiteLLM has wider billing logic but would introduce Python; Tokenlens adds little
when native counts and normalized buckets are already available.

Implementation sequence:

1. Enforce live-only provenance in the shared reducer, for both event and batch
   ingress, and mark transcript-only provider capabilities unavailable.
2. Carry pricing context on individual observations; calculate and freeze costs
   at runtime ingress using a versioned catalog. Project corrected totals,
   coverage, USD/minute, and fixed time buckets directly from those entries.
3. Wire Claude and Codex to those contracts. Never reprice earlier observations
   using a session's current model. Preserve independent child attribution.
4. Show USD in Godview and swarm sizing. Use the core time buckets for charts,
   rather than differencing UI snapshots; a correction cannot become new spend.
   Invalidate legacy token caches. Persist only observed USD display history,
   with explicit run identity so a restart cannot mistake a total for a delta.
5. Verify transcript/replay exclusion, duplicate delivery, corrections, cache and
   reasoning subsets, baseline/reset behavior, unknown pricing, mixed models,
   actor totals, rate expiry, and cache isolation; run repository checks.

Coverage describes observations available to Puppeteer, not completeness of a
provider account. Missing provider lanes are unavailable, never a zero-dollar
claim. The initial pricing integrations are Claude and Codex; other providers
require an independently verified live usage source before advertising support.
OpenCode SSE, Hermes gateway counters, and Grok's direct ACP notifications retain
their live token diagnostics; their dollar coverage is unavailable without pricing
metadata. Pi, Copilot, Kimi, and Grok journal counts are excluded. Rosetta remains
responsible for historical transcript accounting.

The optional Godview cache stores per-run USD totals and chart buckets, not an
invoice or a durable request audit log. Losing that cache loses prior observed
history; it never initiates transcript reconstruction. Core retains individual
observations, pricing context, and corrections for the lifetime of the live run.
Cache loads survive intervening live updates and finish before writes begin.
Conversation identity is independent of the terminal's visual identity. Saves
merge only authoritative live-run snapshots, with monitor revisions protecting
corrections from delayed saves. The size limit is enforced before writing.

To refresh prices, download `https://models.dev/api.json`, then run
`node scripts/update-usage-prices.mjs /path/to/api.json`. Review the generated
`packages/runtime/src/services/usage-prices.ts` diff, format it, and run the
pricing tests before committing it. No runtime update silently reprices history.

References: https://models.dev, https://github.com/anomalyco/models.dev,
https://code.claude.com/docs/en/monitoring-usage,
https://docs.litellm.ai/docs/completion/token_usage.
