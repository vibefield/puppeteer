# Grok capture sanitization

The retained Grok 1.0.0 fixtures are schemaVersion 1
`legacy-privacy-projection` records. They prove event occurrence, ordering,
cross-rail joins, and the selected fields they retain, but they are not complete
native payload schemas. Their raw inputs are unavailable.

The repaired schemaVersion 2 workflow preserves every native JSON key,
container, and value type and redacts sensitive values in place. Future Grok
captures must use `representation: type-preserving-redaction`; source-derived
fields must remain separately attributed because the installed binary's
reported revision is absent from the public mirror.
