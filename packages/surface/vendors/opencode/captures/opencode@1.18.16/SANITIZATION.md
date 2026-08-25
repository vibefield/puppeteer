# OpenCode capture sanitization

These fixtures were captured from OpenCode 1.18.16 with the hermetic fake-provider census.
Native identifiers are stable pseudonyms; paths, clocks, prompts, model output, tool input/output,
question text, answers, and permission patterns are redacted. Protocol enums, payload structure,
ordering, and cross-record identity joins are preserved.

Only JSONL protocol carriers are promoted. Raw logs and the generated OpenAPI document remain
gitignored and are not part of this fixture set.
