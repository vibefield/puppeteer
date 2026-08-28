# Antigravity capture sanitization

These fixtures were captured from the exact Antigravity CLI 1.1.12
darwin-arm64 executable through authorized print-mode survey oracles and
launch-scoped `.agents/hooks.json` observers.

These retained schemaVersion 1 fixtures are `legacy-privacy-projection`
records. They preserve event occurrence, ordering, joins, selected scalar
fields, and selected key inventories, but they do not preserve complete native
payload shapes. In particular, `hasTextDelta`, `hasOutput`, `hasResponse`,
`parameterKeys`, `argKeys`, `workspacePathCount`, and `contentChars` are
sanitizer-derived observations, not vendor fields.

Their raw inputs are unavailable, so they cannot be upgraded in place. The
repaired schemaVersion 2 sanitization workflow preserves every native JSON key,
container, and value type while redacting sensitive values in place. All future
captures must use `representation: type-preserving-redaction`; a generator or
audit must never use these legacy projections as an exact native schema.
