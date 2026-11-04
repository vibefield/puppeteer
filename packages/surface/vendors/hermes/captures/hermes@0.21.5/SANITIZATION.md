# Hermes capture sanitization

These fixtures were captured from Hermes Agent 0.21.5 (`v2026.9.24`) through
`python tui-gateway-census.py` (stdio `tui_gateway` plus isolated-home hook
registration) and a loopback OpenAI-compatible provider, on `linux-x64`.

They are schemaVersion 2 type-preserving redactions: every native key,
container, JSON type, and record order survives, while prompts, responses,
commands, tool arguments and previews, paths, and identifiers are redacted in
place. Identifiers are pseudonymized consistently, so request/result ids, live
and stored session ids, and webhook `X-Hermes-Delivery` headers still join their
bodies. Server→client request ids (`srq-<12 hex>`) are pseudonymized like client
ids and lose their prefix.

Frames marked `"direction": "client"` are the census client's own outbound
frames (requests, and the response to the `approval` server request); the
marker is not a native field.

`resume-turn/rejections.jsonl` is negative evidence kept out of the native
stream: a `session.resume` that carried the undeclared `cwd` 0.20.0 ignored,
and the gateway's error 4000 refusal.

`gateway.stderr.log` stays in gitignored `captures-raw/` only.
