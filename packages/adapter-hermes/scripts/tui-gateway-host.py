#!/usr/bin/env python3
"""Chopsticks-owned Hermes tui_gateway WebSocket host.

The native TUI attaches with HERMES_TUI_GATEWAY_URL. This process owns the
one AIAgent for the session; it is not a second agent beside hermes --tui.
"""

from __future__ import annotations

import json
import socket
import sys


def main() -> None:
    from fastapi import FastAPI, WebSocket
    from tui_gateway.ws import handle_ws
    import uvicorn

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    app = FastAPI()

    @app.websocket("/api/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await handle_ws(websocket)

    print(json.dumps({"url": f"ws://127.0.0.1:{port}/api/ws"}), flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover - startup failure is the contract
        print(json.dumps({"error": str(exc)}), file=sys.stderr, flush=True)
        raise
