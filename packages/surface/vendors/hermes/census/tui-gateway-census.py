#!/usr/bin/env python3
"""Census sidecar around ``tui_gateway.entry``.

Default ``python -m tui_gateway.entry`` never calls
``agent.outbound_webhooks.register_from_config`` or ``discover_plugins``.
This wrapper is the isolated-home observation injection: it registers
``hooks.outbound`` and user plugins from the disposable ``HERMES_HOME``,
then runs the real stdio gateway. It is not a second agent.
"""

from __future__ import annotations

import runpy

from agent.outbound_webhooks import register_from_config
from hermes_cli.config import load_config
from hermes_cli.plugins import discover_plugins

register_from_config(load_config())
discover_plugins()
runpy.run_module("tui_gateway.entry", run_name="__main__")
