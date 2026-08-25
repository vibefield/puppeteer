# OpenCode Imposter persona

This persona impersonates OpenCode 1.18.16 on its native loopback REST and SSE
surface. Native paths and operation ids live in `http-serve.json`; the shared
transport contains no OpenCode route names. All requests, successful results,
SSE properties, and complete `{id,type,properties}` carriers validate against
the Surface-owned ASM before delivery.

Start the backend with the same invocation shape as the real binary:

```sh
OPENCODE_SERVER_PASSWORD='<secret>' \
  ai --opencode serve --hostname 127.0.0.1 --port 0 --pure
```

Readiness is the native `opencode server listening on http://…` stdout line.
The default username is `opencode`; setting no password disables authentication,
matching the upstream server. Durable HTTP state is stored below
`CHOPSTICKS_IMPOSTER_HOME` when that isolated root is supplied.

The shared viewer attaches to the exact existing session without creating a
second one:

```sh
OPENCODE_SERVER_PASSWORD='<secret>' \
  ai --opencode attach http://127.0.0.1:PORT \
  --dir /workspace --session ses_ID --pure
```

SSE reconnect intentionally replays nothing. The viewer and future adapter
rehydrate messages and session state through REST, reflecting the behavior of
the pinned native server rather than inventing a cursor.
