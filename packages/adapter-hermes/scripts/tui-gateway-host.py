#!/usr/bin/env python3
"""Puppeteer-owned Hermes tui_gateway WebSocket host.

The native TUI attaches with HERMES_TUI_GATEWAY_URL. This process owns the
one AIAgent for the session; it is not a second agent beside hermes --tui.
"""

import json
import socket
import sys


def enable_session_event_fanout() -> None:
    """Tee one session's events to the adapter and its native TUI viewer.

    Hermes 0.20.0 stores one transport on each live session. A second client
    that calls ``session.resume`` becomes that transport, which is correct for
    ordinary tab switching but would otherwise disconnect Puppeteer's observer
    when the native TUI attaches. This host is private to one Puppeteer session,
    so fan-out is confined to its adapter and TUI connections. RPC results stay
    request-local; only session-scoped event notifications are copied.
    """

    from tui_gateway import server
    from tui_gateway.ws import WSTransport

    original_write = WSTransport.write

    def fanout_write(self: WSTransport, frame: dict) -> bool:
        params = frame.get("params") if isinstance(frame, dict) else None
        session_event = (
            frame.get("method") == "event"
            and isinstance(params, dict)
            and bool(params.get("session_id"))
        )
        if not session_event:
            return original_write(self, frame)

        with server._live_transports_lock:
            targets = list(server._live_transports)
        if not targets:
            return original_write(self, frame)

        delivered = False
        for target in targets:
            try:
                delivered = bool(original_write(target, frame)) or delivered
            except Exception:
                # A closing viewer must not cut off the surviving observer.
                continue
        return delivered

    WSTransport.write = fanout_write


def main() -> None:
    from fastapi import FastAPI, WebSocket
    from tui_gateway.ws import handle_ws
    import uvicorn

    enable_session_event_fanout()

    app = FastAPI()

    @app.websocket("/api/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await handle_ws(websocket)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))

    # Importing tui_gateway.server intentionally redirects sys.stdout to
    # stderr to protect its JSON-RPC stdio mode. This host's one readiness
    # record belongs on the process's original stdout contract.
    print(
        json.dumps({"url": f"ws://127.0.0.1:{port}/api/ws"}),
        file=sys.__stdout__,
        flush=True,
    )
    server.run(sockets=[sock])


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover - startup failure is the contract
        print(json.dumps({"error": str(exc)}), file=sys.stderr, flush=True)
        raise
