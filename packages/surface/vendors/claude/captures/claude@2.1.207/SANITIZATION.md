# Sanitized Claude 2.1.207 surface fixtures

These JSONL files preserve the observed event names, payload shapes, primitive types, known structural enums, ordering, and deterministic cross-line pseudonyms. Interaction text, nested free-form values, identifiers, URLs, and workstation paths are redacted conservatively.

Verbatim captures belong in the gitignored `packages/surface/vendors/claude/captures-raw/claude@2.1.207/` directory or an access-controlled artifact store. Before updating these fixtures, run:

```sh
node packages/surface/vendors/claude/sanitize-captures.mjs packages/surface/vendors/claude/captures-raw/claude@2.1.207 packages/surface/vendors/claude/captures/claude@2.1.207
pnpm run surface:audit
```
