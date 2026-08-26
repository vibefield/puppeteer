# Surface adaptation and promotion

**Status:** Current operational guide

This guide defines where provider truth lives and how a captured candidate becomes supported. Use [adapting-an-agent.md](adapting-an-agent.md) for the full implementation workflow and [RFC-004](../rfcs/004-layered-agent-runtime.md) for package-layer ownership.

## One authority per provider version

Each captured provider version has one runtime authority:

```text
packages/surface/vendors/<vendor>/model/<vendor>@<version>/groundtruth.json
```

The neighboring manifest, evidence, event, behavior, detection, channel, and capture files are authoring inputs. `groundtruth.json` is the deterministic projection consumers name and digest-lock. Never copy those inputs into an adapter or Imposter persona.

## Ownership

- `packages/surface` owns vendor artifacts, sanitized captures, evidence indexes, native behavior models, ground-truth generation, and drift audits.
- `packages/adapter-<vendor>` owns the native-to-Core mapping. Its `groundtruth-map.json` records exactly which promoted or staged ground truth the mapping implements.
- `packages/imposter` owns synthetic execution and persona scenarios derived from Surface. It does not define provider truth.
- `support/agents.json` owns support status and the current/candidate pointers.
- Root scripts and protected workflows own acquisition, verification, reconciliation, and promotion mechanics.

Production adapters do not import Surface. Surface remains a development, generation, conformance, and promotion input, so a runtime deployment does not carry capture data.

## Candidate flow

```text
detect release
  -> acquire and hash exact artifacts
  -> capture native rails in isolation
  -> sanitize and index evidence
  -> generate canonical ground truth
  -> update adapter mapping and Imposter persona
  -> replay, audit, and run conformance
  -> verify every required platform
  -> protected promotion updates support/agents.json
```

Detection is read-only. Candidate analysis may prepare a reviewable change, but only the protected promotion workflow may change the supported pointer or generated README badges.

## Evidence rules

- Capture exact provider versions and platform artifacts; do not generalize across unobserved versions.
- Commit sanitized, shape-faithful evidence only. Raw captures stay in ignored `captures-raw/` paths.
- Preserve provenance from each modeled claim to its evidence and artifact identity.
- Keep unknown native records when they may be semantically meaningful.
- Never infer portable semantics from terminal text.
- A candidate with incomplete platform or native-interactive evidence remains `baseline-pending`; it is not a support claim.

## Required checks

Run the narrow checks while iterating, then the repository gate:

```sh
pnpm surface:audit
pnpm surface:groundtruth:check
pnpm groundtruth:mapping:check
pnpm support:check
pnpm test
```

When authoring inputs intentionally change, regenerate with:

```sh
pnpm surface:groundtruth:write
pnpm groundtruth:mapping:write
pnpm support:write
```

Review generated diffs. Generation proves determinism, not that a native claim is correct.

## Repository hygiene

- Keep the flat `packages/*` topology: each direct child is a real publishable package.
- Keep real-vendor captures and models only under `packages/surface/vendors/`.
- Keep adapter normalization, services, transport, observation, and launch code under their named responsibility folders.
- Keep Imposter scenarios under `packages/imposter/personas/<vendor>/`.
- Use `pnpm agent-devkit` for native-surface and normalization inspection.
- Use `pnpm packages:clean` for declared build output; dependency directories belong to pnpm.

The completed ownership migration and rollout rationale are preserved in [the archived refactor plan](../archive/SURFACE-ADAPTATION-REFACTOR.md).
