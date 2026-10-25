# Codex 0.144.2 exploratory probes

These version-pinned scripts preserve the method behind the C6 findings in
[`../../findings.md`](../../findings.md). They are historical evidence, not CI
or current-version conformance tests.

The PTY probes require `node-pty` to be resolvable by the caller. Puppeteer no
longer owns a Node PTY package; production terminal ownership lives in Ghosttea.
The WebSocket-only probes use Node built-ins.

As first written, these scripts ran `codex` from `PATH` with the caller's whole
environment, so they used, and wrote into, whichever profile that was. Since
0.164.0 they run the executable named by `PUPPETEER_CODEX_BIN` (never `codex` on
`PATH`) in a throwaway `HOME` and `CODEX_HOME` with the census's allowlisted
environment (`isolatedCodex`, `../../census/harness.mjs`). A re-run therefore
has no sign-in, and a screen that depended on one may differ from the C6 notes.
