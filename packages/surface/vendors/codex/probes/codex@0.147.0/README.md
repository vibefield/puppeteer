# Codex 0.147.0 exploratory probes

This directory preserves the final controller-owned-thread experiment cited by
the Codex observer. It is version-pinned method evidence, not a CI test. Running
it requires `node-pty` to be resolvable by the caller.

As first written, the script ran `codex` from `PATH` with the caller's whole
environment. Since 0.164.0 it runs the executable named by `PUPPETEER_CODEX_BIN`
(never `codex` on `PATH`) in a throwaway `HOME` and `CODEX_HOME` with the
census's allowlisted environment (`isolatedCodex`, `../../census/harness.mjs`).
