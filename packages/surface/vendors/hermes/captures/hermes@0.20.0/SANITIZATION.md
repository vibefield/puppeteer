# Hermes capture sanitization

These fixtures were captured from Hermes Agent 0.20.0 (`v2026.8.3`) through
`python tui-gateway-census.py` (stdio `tui_gateway` plus isolated-home hook
registration) and a loopback OpenAI-compatible provider.

Prompts, model output, tool arguments, approval command text, home paths, and
provider request bodies are redacted. JSON-RPC methods, event types, webhook
event names, tool names, approval choices, and cross-record session/tool ids
are preserved as stable pseudonyms.

`gateway.stderr.log` stays in gitignored `captures-raw/` only.
