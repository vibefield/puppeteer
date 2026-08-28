# Hermes capture sanitization

These fixtures were captured from Hermes Agent 0.20.0 (`v2026.8.3`) through
`python tui-gateway-census.py` (stdio `tui_gateway` plus isolated-home hook
registration) and a loopback OpenAI-compatible provider.

These retained schemaVersion 1 fixtures are legacy privacy projections. They
preserve occurrence, ordering, structural enums, and stable pseudonymous joins,
but they deliberately removed or renamed native payload fields and therefore
must not be used as native schemas. The pinned source reference supplies those
schemas for 0.20.0.

The repaired schemaVersion 2 sanitization workflow preserves every native key,
container, and JSON type while redacting sensitive values. New captures must
use that representation; the legacy fixtures remain only because their raw
inputs were intentionally not committed.

`gateway.stderr.log` stays in gitignored `captures-raw/` only.
