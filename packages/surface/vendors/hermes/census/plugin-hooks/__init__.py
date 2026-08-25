"""Isolated-home hook dumper for the Hermes Surface census."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOOKS = (
    "on_session_start",
    "on_session_end",
    "on_session_finalize",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "pre_tool_call",
    "post_tool_call",
    "pre_approval_request",
    "post_approval_response",
)


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(key): _jsonable(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [_jsonable(item) for item in value]
        return str(value)


def _record(event: str, **kwargs: Any) -> None:
    path = os.environ.get("CHOPSTICKS_HERMES_HOOK_LOG")
    if not path:
        return
    record = {
        "hook_event_name": event,
        "kwargs": _jsonable(kwargs),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, default=str) + "\n")


def register(ctx) -> None:
    for name in HOOKS:
        def make(event: str):
            def callback(**kwargs: Any) -> None:
                _record(event, **kwargs)

            return callback

        ctx.register_hook(name, make(name))
