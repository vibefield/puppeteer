# Claude Code 2.1.322 capture sanitization

This set holds one census lane, `turn-failure`, captured to measure what StopFailure's `last_assistant_message`
carries once the model has written words in the failing turn (`findings.md`, "Turn failure after words"). It is
evidence for that one question at this exact release. It is not an adaptation candidate: 2.1.311 remains the
verified version, and no model or ground truth is generated from this set.

```sh
node packages/surface/vendors/claude/census/harness.mjs \
  --artifact <claude 2.1.322> --version 2.1.322 --lanes turn-failure --sandbox none
node packages/surface/vendors/claude/sanitize-captures.mjs \
  packages/surface/vendors/claude/captures-raw/claude@2.1.322 \
  packages/surface/vendors/claude/captures/claude@2.1.322
node packages/surface/vendors/claude/sanitize-captures.mjs --check \
  packages/surface/vendors/claude/captures/claude@2.1.322
```

The lane ran on darwin-arm64 on 2026-11-12 from 03:29:27Z to 03:29:28Z. The artifact was the standalone
`2.1.322 (Claude Code)` executable with SHA-256 `a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450`.
It ran in a disposable HOME, `CLAUDE_CONFIG_DIR` and TMPDIR, with nothing inherited from the caller's environment and
the keychain stub first on PATH. Every request went to the loopback Messages API with the placeholder token; no
account, credential or billed model was involved.

macOS has no network-deny sandbox, so this set has no `sandbox.json`. Non-loopback egress was routed to the census
egress recorder, which refuses every attempt and fails the lane on any. It recorded none, loopback included.

Hook carriers are type-preserving redactions, as in every Claude set. `ordering.json` and `turn-failure.json` are
value-free projections: the second keeps only the verdicts of comparing each closing hook's `last_assistant_message`
with the lane's own sentinels and Claude's displayed and printed text, never a value. Raw payloads, print results and
logs stay in the gitignored `captures-raw` tree.
