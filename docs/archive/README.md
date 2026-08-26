# Archived design material

These documents preserve implementation rationale and historical evidence. They
are not the current source of truth:

- `EMULATOR.md` and `IMPOSTER.md` explain the evolution into Surface and the
  current Imposter package.
- `DESIGN.md` is the original native-TUI runtime baseline. RFC-004 supersedes
  its repository architecture and ownership model.
- `INITIAL-IMPLEMENTATION-PLAN.md` records the first host/runtime milestone plan.
- `MONITOR.md` was superseded by RFC-001.
- `RFC-001-IMPLEMENTATION-PLAN.md` records the completed monitor rollout,
  including now-retired feature flags and shadow comparison.
- `RFC-001-EVIDENCE-BACKED-RUNTIME-OBSERVATION.md` preserves the original,
  superseded monitor/Spaghetti proposal; current RFC-001 contains only the
  implemented evidence and three-state monitor contract.
- `SURFACE-ADAPTATION-REFACTOR.md` records the completed Surface ownership and
  promotion-pipeline migration; the current workflow is in `docs/guides/`.
- `parity-matrix.html` is the four-adapter brainstorming snapshot from
  2026-08-03; current vendor truth lives under `packages/surface/vendors/`.

Current architecture lives under `docs/rfcs/`; active workflows and adaptation
plans live under `draft/` until their work is complete.
