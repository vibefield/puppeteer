# Codex 0.144.2 exploratory probes

These version-pinned scripts preserve the method behind the C6 findings in
[`../../findings.md`](../../findings.md). They are historical evidence, not CI
or current-version conformance tests.

The PTY probes require `node-pty` to be resolvable by the caller. Puppeteer no
longer owns a Node PTY package; production terminal ownership lives in Ghosttea.
The WebSocket-only probes use Node built-ins.
